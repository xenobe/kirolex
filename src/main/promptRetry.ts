/**
 * **一轮发送挂了，要不要 KiroLex 自己重发** ——「你难道不能让它自动重试吗，挂了你他妈也不管啊」。
 *
 * ## 实测的形状（`s_1789711578033_nc0s4j`，2026-09-18 07:46–07:56）
 *
 * ```
 * 07:46:34  0 工具  → Internal error — Kiro failed to generate a response
 * 07:46:50  0 工具  → 同一句（连续第 2 次 → 换了后端会话 9a74213c）
 * 07:47:05 13 工具  → 跑了 3 分钟 aws 调用，最后生成回答时又挂
 * 07:52:28  → 又挂（第 3 个后端会话 f45ba8b6）
 * 07:54:41  → 这一次通了（produced=true）
 * ```
 *
 * 也就是说**恢复手段是有效的**（换后端会话 + 上下文随行），只是原来每次用户发送只肯自救一次，
 * 于是"要换三次才通"这件事被摊到了三次手动重发上 —— 人看到的就是"总是断，也没人管"。
 *
 * ## 所以判据要回答两个问题
 *
 * 1. **这个错值得重发吗** —— 只认两类：传输层抖动（`dispatch failure` 等）和 kiro-cli 的
 *    `Internal error`（"生成不出回答"那一族）。模型不可用、权限、`prompt already in progress`
 *    各有各的处理路径，重发只会掩盖它们。
 * 2. **这一轮重发安全吗** —— 这是硬闸，比"值得"重要得多：
 *    · 已经流出过文字（`producedText`）→ 不重发。那半个回答留在 transcript 里，重发的那份接在
 *      后面，同一个问题答两遍。
 *    · **已经跑过工具（`toolsRan > 0`）→ 不重发。** 上面那条 13 工具的轮里有
 *      `aws ssm send-command`，闭着眼睛重发等于把它再执行一遍。这一条是这个模块存在的主要理由：
 *      "自动重试"最容易犯的错就是把"重发一句话"和"重做一串副作用"当成同一件事。
 *
 * 预算 `MAX_AUTO_RETRIES` 次，间隔递增：瞬时故障的特点是立刻重试还是同一个结果，而真故障下
 * 循环重发只会变成风扇噪音。
 */

import { isTransientTransportError } from './transientError.ts';
import { isBareInternalError } from './staleSession.ts';

/** 一次用户发送里，KiroLex 最多自己重发几次。3 次 —— 实测"换三个后端会话才通"是真实发生过的上限。 */
export const MAX_AUTO_RETRIES = 3;

export interface RetryInput {
  /** 后端回的错误文本（已经拼上 detail）。 */
  error: string;
  /** 这一次用户发送里已经自动重发过几次。0 = 还没有。 */
  attempt: number;
  /** 这一轮已经流出过助手文字。 */
  producedText: boolean;
  /** 这一轮后端开过几个工具调用。>0 表示可能已经产生副作用。 */
  toolsRan: number;
}

export interface RetryPlan {
  retry: boolean;
  /** 等多久再发（毫秒）。 */
  delayMs: number;
  /** 不重发时的原因，用于日志/界面说明；重发时为 undefined。 */
  reason?: 'produced' | 'side-effects' | 'not-retryable' | 'budget';
}

/** 第 n 次重发前等多久：1.2s → 3s → 8s。 */
export function retryDelayMs(attempt: number): number {
  return [1200, 3000, 8000][Math.min(Math.max(attempt, 0), 2)];
}

/** 这个错本身属于"重发有可能好"的那一类吗。 */
export function isRetryableSendError(text: string): boolean {
  const t = String(text || '');
  if (/prompt already in progress/i.test(t)) return false;  // 并发保护，重发只会再撞一次
  return isTransientTransportError(t) || isBareInternalError(t);
}

export function planRetry(input: RetryInput): RetryPlan {
  /* 顺序是有意的：先判"安全"再判"值得"，这样日志里给出的理由总是那个更重要的。 */
  if (input.producedText) return { retry: false, delayMs: 0, reason: 'produced' };
  if ((input.toolsRan || 0) > 0) return { retry: false, delayMs: 0, reason: 'side-effects' };
  if (!isRetryableSendError(input.error)) return { retry: false, delayMs: 0, reason: 'not-retryable' };
  if (input.attempt >= MAX_AUTO_RETRIES) return { retry: false, delayMs: 0, reason: 'budget' };
  return { retry: true, delayMs: retryDelayMs(input.attempt) };
}

/** 重试都用光之后给用户看的那句话 —— 要说清试过几次、以及该看哪儿。 */
export function retriesExhaustedNote(errText: string, attempts: number): string {
  const head = String(errText || '').slice(0, 160);
  return `${head}\n\n（KiroLex 已经自己重发了 ${attempts} 次，都是同一个结果。`
    + '这一轮什么都没产出，所以重发是安全的、也确实做了；到这一步说明问题在后端而不是这条消息 ——'
    + '可以点重跑再试，或者把这一轮拆小一点再发。）';
}
