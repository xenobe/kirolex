import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import {
  planRetry, retryDelayMs, isRetryableSendError, retriesExhaustedNote, MAX_AUTO_RETRIES,
} from '../src/main/promptRetry.ts';

const INTERNAL = 'Internal error — Kiro failed to generate a response';
const base = { error: INTERNAL, attempt: 0, producedText: false, toolsRan: 0 };

/**
 * 「你难道不能让它自动重试吗，挂了你他妈也不管啊」。
 *
 * 实测（`s_1789711578033_nc0s4j`，07:46–07:56）：同一条会话连着 5 次
 * `Internal error — Kiro failed to generate a response`，换了三个后端会话之后才通。
 * 恢复手段本来就有效，只是每次用户发送只肯自救一次 —— 于是"换三次"被摊到三次手动重发上。
 */
describe('一轮挂了要不要自己重发', () => {
  test('什么都没产出 + 是可重试的错 → 重发', () => {
    assert.equal(planRetry(base).retry, true);
  });

  test('已经流出过文字 → 不重发（否则同一个问题答两遍）', () => {
    const p = planRetry({ ...base, producedText: true });
    assert.equal(p.retry, false);
    assert.equal(p.reason, 'produced');
  });

  /* 这一条是这个模块存在的主要理由：实测挂掉那一轮跑了 13 个工具调用，含 `aws ssm send-command`。 */
  test('**已经跑过工具 → 不重发**，哪怕一个字都没输出', () => {
    const p = planRetry({ ...base, toolsRan: 13 });
    assert.equal(p.retry, false);
    assert.equal(p.reason, 'side-effects');
  });

  test('工具跑过这条闸比"值得重试"优先 —— 顺序不能反', () => {
    /* 传输层抖动是最"值得"重试的一类，它也得让路 */
    const p = planRetry({ ...base, error: 'dispatch failure', toolsRan: 1 });
    assert.equal(p.reason, 'side-effects');
  });

  test('预算用光就停 —— 真故障下循环重发只是风扇噪音', () => {
    assert.equal(planRetry({ ...base, attempt: MAX_AUTO_RETRIES }).retry, false);
    assert.equal(planRetry({ ...base, attempt: MAX_AUTO_RETRIES }).reason, 'budget');
    assert.equal(planRetry({ ...base, attempt: MAX_AUTO_RETRIES - 1 }).retry, true);
  });

  test('间隔递增：瞬时故障立刻重试还是同一个结果', () => {
    assert.deepEqual([0, 1, 2].map(retryDelayMs), [1200, 3000, 8000]);
    assert.equal(retryDelayMs(99), 8000);
  });
});

describe('哪些错算"重发有可能好"', () => {
  test('传输层抖动算', () => {
    assert.equal(isRetryableSendError('An unknown error occurred: dispatch failure'), true);
    assert.equal(isRetryableSendError('ECONNRESET'), true);
  });

  test('kiro-cli 的笼统 Internal error 算 —— 实测重发（换会话后）确实会通', () => {
    assert.equal(isRetryableSendError(INTERNAL), true);
  });

  test('`prompt already in progress` 不算 —— 那是并发保护，重发只会再撞一次', () => {
    assert.equal(isRetryableSendError('Internal error: prompt already in progress'), false);
  });

  test('模型不可用不算 —— 那条路是换模型，不是重发', () => {
    assert.equal(isRetryableSendError("The model 'claude-opus-5' is not available."), false);
  });
});

describe('接线（src/main/index.ts）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('工具调用按轮计数，每轮清零，只数新开的调用', () => {
    assert.match(M, /entry\.toolsThisTurn = 0;/);
    assert.match(M, /if \(u\?\.sessionUpdate === 'tool_call'\) entry\.toolsThisTurn = \(entry\.toolsThisTurn \|\| 0\) \+ 1;/);
  });

  test('三条恢复路径共用同一个判据 —— 硬闸不能只在其中一条上生效', () => {
    const at = M.indexOf('const plan = planRetry({');
    assert.ok(at > 0);
    const body = M.slice(at, at + 300);
    assert.match(body, /producedText: !!entry\.assistantBuf,/);
    assert.match(body, /toolsRan: entry\.toolsThisTurn \|\| 0,/);
  });

  test('换完后端会话：跑过工具的那种轮**只换不重发**', () => {
    const at = M.indexOf("if (made && !plan.retry && (plan.reason === 'side-effects'");
    assert.ok(at > 0);
    const body = M.slice(at, at + 800);
    assert.match(body, /没有自动重发/);
    assert.match(body, /点重跑或者再发一条就会落在新会话上/);
  });

  test('重发时不再往 transcript 里追加同一条用户消息', () => {
    assert.match(M, /if \(attempt > 0\) \{\s*\n\s*\/\* 这一条早就在盘上了/);
  });

  test('重试次数说给用户听 —— 不然看着像"它就是不行"', () => {
    assert.match(M, /retriesExhaustedNote\(errText, attempt\)/);
    assert.match(retriesExhaustedNote(INTERNAL, 3), /重发了 3 次/);
  });
});

/*
 * 「好像 curl 那个大 json 的时候断掉了」。
 *
 * 那条会话一轮里跑了 109 个工具调用，含整段 `aws ec2 describe-*` 的 JSON，最后后端回的是
 * `EmptyResponse`（模型自己在 kiro-cli 日志里读到的原话）。发给模型的那份输出是 kiro-cli
 * 攥着的、没裁过，所以"这一轮最大的一次工具输出多大"是唯一能指向原因的数字。
 */
describe('失败时要说出这一轮的规模', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('记的是**裁剪之前**的原始长度', () => {
    assert.match(M, /if \(output\.length > \(entry\.maxToolOutputThisTurn \|\| 0\)\) entry\.maxToolOutputThisTurn = output\.length;/);
    assert.match(M, /entry\.maxToolOutputThisTurn = 0;/, '每轮清零');
  });

  test('小输出不提 —— 否则变成每条错误后面的废话', () => {
    assert.match(M, /if \(n < 20000\) return '';/);
  });

  test('规模跟着错误一起进日志', () => {
    const at = M.indexOf('logger.warn(\'prompt\', `error sessionId=');
    assert.ok(at > 0);
    assert.match(M.slice(at, at + 400), /最大工具输出=\$\{entry\.maxToolOutputThisTurn \|\| 0\}字符/);
  });

  test('提示里给的是下一步该做什么，不是"出错了"', () => {
    const at = M.indexOf('function bigOutputHint');
    assert.match(M.slice(at, at + 900), /--query/);
    assert.match(M.slice(at, at + 900), /head/);
  });
});

/*
 * 「首先换成 sol 没好。是我后来换成 kiro-cli 才好了。」「这个问题很严重必须修好」。
 *
 * 那 25 分钟里换后端会话换了三个都没用（新会话上下文只占 3.8% 照样失败）—— 也就是说这种故障
 * 要动的是**模型**，不是会话。而原来只有 kiro-cli 明说"这个模型不可用"才会换模型，
 * 它对空响应从来不这么说，于是 KiroLex 只会一遍遍换会话。
 */
describe('连着被拒绝生成 → 换模型重发', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
  const at = M.indexOf('const bareStreak = bareFailStreak.get(sessionId) || 0;');
  const body = M.slice(at, at + 2200);

  test('计数按 KiroLex 会话记，跨换后端会话累计 —— cliFailStreak 会被换会话清零，永远推不到阈值', () => {
    assert.match(M, /const bareFailStreak = new Map<string, number>\(\);/);
    assert.match(M, /bareFailStreak\.set\(sessionId, \(bareFailStreak\.get\(sessionId\) \|\| 0\) \+ 1\)/);
    assert.match(M, /bareFailStreak\.delete\(sessionId\);/, '成功一轮要清零');
  });

  test('阈值复用 POISONED_AFTER —— 单次 Internal error 不值得付换模型那 30 秒', () => {
    assert.ok(at > 0);
    assert.match(body, /bareStreak >= POISONED_AFTER/);
  });

  test('**这一轮产出过东西就不换** —— 换模型重发等于把副作用再做一遍', () => {
    assert.match(body, /!producedThisTurn/);
    assert.match(M, /const producedThisTurn = !!entry\.assistantBuf \|\| \(entry\.toolsThisTurn \|\| 0\) > 0;/);
  });

  test('一轮最多换一次 —— 整段时间都在返空响应时走完整条回退链就是几分钟静默', () => {
    assert.match(body, /emptySwaps < 1/);
    assert.match(M, /let emptySwaps = 0;/);
  });

  test('复用 model-unavailable 那套机器（换执行器 + 原样重发），并在会话里说一句', () => {
    assert.match(body, /swapSessionModel\(sessionId, failedModel/);
    assert.match(body, /acp:turn-restart/);
    assert.match(body, /noteInSession\(sessionId, `🔀/);
    assert.match(body, /换后端会话对这种情况没用/);
  });
});

/*
 * 这一版差点带着语法错误上线：`npm test` 只把 `src/main/index.ts` 当**文本**匹配（没有测试
 * import 它），而我一直用 `tsc -p tsconfig.json` 自查 —— 那个 project 是渲染进程的，
 * 根本不包含 src/main。于是一个漏掉的 `}` 一路过了类型检查和 3401 个测试，直到启动才炸。
 */
describe('主进程必须真的能编译', () => {
  test('tsc -p tsconfig.main.json 干净通过', () => {
    const { status, stdout, stderr } = spawnSync('npx', ['tsc', '-p', 'tsconfig.main.json', '--noEmit'], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 180_000,
    });
    assert.equal(status, 0, `主进程编译失败：\n${stdout}\n${stderr}`);
  });
});
