/**
 * **一次发送失败，把"当时到底发了什么"整包留下来** ——「这个问题很严重必须修好」。
 *
 * 为什么需要它：这次查到最后卡在一件事上 —— **同一时间同一模型，kiro-cli 里好的，KiroLex 里不好**
 * （「是我后来换成 kiro-cli 才好了」）。那就说明两边发出去的请求有差别，而 KiroLex 手里
 * 只有一句 `Internal error`：请求体是 kiro-cli 拼的，工具调用是通知（没有返回值可拦），
 * 事后 transcript 里也只留成功那一轮的东西。于是每次都只能靠猜，而故障又不能按需复现
 * （实测那 25 分钟过去之后，同样的 ACP 路径、同样的 opus-5、同样 16KB 注入，一次就过）。
 *
 * 所以失败的那一刻把四样东西落盘，下一次犯的时候可以**对着差异看**，而不是再猜一轮：
 *   1. `prompt.txt`      —— KiroLex 这一轮实际发出去的全部文本（含随行快照 + memory 注入）
 *   2. `cli-session.json(l)` —— kiro-cli **自己**存的那份会话状态和历史
 *      （`~/.kiro/sessions/cli/<id>`；这次才发现它是存盘的），里面有 model_info、
 *      `context_usage_percentage`、每一条 toolUse/toolResult
 *   3. `kiro-log.txt`    —— kiro-cli 日志在失败前后那一段（`err=EmptyResponse` 那行就在这儿）
 *   4. `meta.json`       —— 模型、pid、这一轮的工具数/最大工具输出、错误原文
 *
 * 每条会话只留最近 `KEEP_PER_SESSION` 次，且同一条会话 `COOLDOWN_MS` 内不重复落盘 ——
 * 诊断不能变成磁盘负担（一次连着失败 6 次就会写 6 份几乎一样的东西）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export const KEEP_PER_SESSION = 5;
export const COOLDOWN_MS = 60_000;

export interface BundleInput {
  sessionId: string;
  cliSessionId?: string;
  /** 这一轮发出去的文本块（KiroLex 侧的原样）。 */
  promptText: string;
  error: string;
  model?: string;
  pid?: number;
  toolsThisTurn?: number;
  maxToolOutput?: number;
  /** kiro-cli 日志的路径，注入进来是为了可测。 */
  cliLogPath: string;
  /** kiro-cli 开了 trace 时日志涨得极快，512KB 可能只盖住一秒 —— 那时多抄一些。 */
  cliLogTailBytes?: number;
  home?: string;
  now?: number;
}

export function bundleRoot(home = os.homedir()): string {
  return path.join(home, '.kirolex', 'failures');
}

/** 只留最近 N 个目录，其余删掉 —— 返回删掉的那些，方便日志说清。 */
export function prunable(dirs: string[], keep = KEEP_PER_SESSION): string[] {
  return [...dirs].sort().slice(0, Math.max(0, dirs.length - keep));
}

const lastWrite = new Map<string, number>();

/** 落一包。返回目录路径；被冷却挡下或写不成功时返回 null（诊断永远不能让发送失败）。 */
export function writeFailureBundle(input: BundleInput): string | null {
  const now = input.now ?? Date.now();
  const prev = lastWrite.get(input.sessionId) || 0;
  if (now - prev < COOLDOWN_MS) return null;
  lastWrite.set(input.sessionId, now);
  try {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const dir = path.join(bundleRoot(input.home), input.sessionId, stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'prompt.txt'), input.promptText ?? '');
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      at: new Date(now).toISOString(),
      sessionId: input.sessionId,
      cliSessionId: input.cliSessionId,
      model: input.model,
      pid: input.pid,
      toolsThisTurn: input.toolsThisTurn ?? 0,
      maxToolOutput: input.maxToolOutput ?? 0,
      promptChars: (input.promptText || '').length,
      error: String(input.error || '').slice(0, 2000),
    }, null, 2));
    /* kiro-cli 自己那份会话（状态 + 历史）—— 这是唯一能看到"后端手里是什么"的东西 */
    if (input.cliSessionId) {
      const base = path.join(input.home ?? os.homedir(), '.kiro', 'sessions', 'cli', input.cliSessionId);
      copyIfExists(base + '.json', path.join(dir, 'cli-session.json'));
      copyTail(base + '.jsonl', path.join(dir, 'cli-session.jsonl'), 2 * 1024 * 1024);
    }
    copyTail(input.cliLogPath, path.join(dir, 'kiro-log.txt'), input.cliLogTailBytes ?? 512 * 1024);
    /* 只留最近几包 */
    const parent = path.join(bundleRoot(input.home), input.sessionId);
    const kids = fs.readdirSync(parent).filter((d) => !d.startsWith('.'));
    for (const old of prunable(kids)) {
      fs.rmSync(path.join(parent, old), { recursive: true, force: true });
    }
    return dir;
  } catch {
    return null;
  }
}

function copyIfExists(from: string, to: string): void {
  try { fs.copyFileSync(from, to); } catch { /* 没有就算了 */ }
}

function copyTail(from: string, to: string, bytes: number): void {
  try {
    const fd = fs.openSync(from, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - bytes);
      const len = size - start;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      fs.writeFileSync(to, b);
    } finally { fs.closeSync(fd); }
  } catch { /* 没有就算了 */ }
}

/** 测试用：清掉冷却记录。 */
export function _resetCooldown(): void { lastWrite.clear(); }
