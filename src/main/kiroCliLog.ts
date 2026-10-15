/**
 * **kiro-cli 自己的日志里那句真话** ——「还是不知道为什么会断」。
 *
 * KiroLex 从 ACP 上拿到的错误是 kiro-cli 的万能包装：`-32603 Internal error — Kiro failed to
 * generate a response`。而同一时刻 kiro-cli 自己的日志（`$TMPDIR/kiro-log/kiro-chat.log`，
 * 默认就是 ERROR 级别、一直在写）里写的是**具体哪一层坏了**：
 *
 * ```
 * ERROR agent::agent: response stream encountered an error err=EmptyResponse loop_id=…
 * ```
 *
 * 实测统计（11 个 KiroLex 日志、29 次发送失败）：
 *   · 15 次 `EmptyResponse` —— 服务端把流开了，一个 token 都没发
 *   ·  11 次 `dispatch failure` —— 连不上（网络/VPN）
 *   ·  1 次模型退役、1 次历史里有超限图片、1 次 kiro-cli 进程自己退出
 * 这五件事在界面上长得一模一样，都是"Internal error"。所以这个模块只干一件事：
 * **把 kiro-cli 那一行捞出来，贴到用户看得见的地方。**
 *
 * 为什么不改成让 kiro-cli 说清楚：那是它的包装层，不在 KiroLex 里；而这条日志是它**已经**写下的。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

/** kiro-cli 把 chat 日志写在 TMPDIR 下（实测 macOS：`$TMPDIR/kiro-log/kiro-chat.log`）。 */
export function kiroCliLogPath(env: NodeJS.ProcessEnv = process.env): string {
  const tmp = env.TMPDIR || os.tmpdir();
  return path.join(tmp, 'kiro-log', 'kiro-chat.log');
}

/** 日志带 ANSI 颜色（`ERROR` 是红的），不脱掉的话任何匹配都会漏。 */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

export interface CliLogLine {
  ts: number;
  level: string;
  target: string;
  message: string;
}

/** 只读文件**尾部**：这个文件实测 5MB 起，而我们要的是刚刚那几行。 */
const TAIL_BYTES = 256 * 1024;

export function readTailErrors(file: string, sinceMs: number, now = Date.now()): CliLogLine[] {
  let buf = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - TAIL_BYTES);
      const len = size - start;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      buf = b.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];   // 没有这个文件（换过平台/清理过）就当没有 —— 诊断永远不能让发送失败
  }
  const out: CliLogLine[] = [];
  for (const raw of buf.split('\n')) {
    const line = stripAnsi(raw);
    const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(ERROR|WARN)\s+(\S+):\s*(?:\d+:\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!Number.isFinite(ts) || ts < now - sinceMs || ts > now + 60_000) continue;
    out.push({ ts, level: m[2], target: m[3].replace(/:$/, ''), message: m[4].trim() });
  }
  return out;
}

/**
 * 把 kiro-cli 的原话翻译成"这是哪一层的问题、我该干什么"。
 *
 * 不认识的形状**原样带出来**：这个模块的价值就是不再把话吞掉，宁可露出一行陌生的英文，
 * 也比再给一句"Internal error"强。
 */
export function explainCliError(lines: CliLogLine[]): string {
  /* LSP / MCP 那些启动噪音跟发送失败无关，挡掉它们，否则每次都把它们当成原因 */
  const noise = /workspace_manager|language server|Failed to start LSP|tool_manager|TransportClosed|opentelemetry/i;
  const rel = lines.filter((l) => !noise.test(l.target + ' ' + l.message));
  if (rel.length === 0) return '';
  const last = rel[rel.length - 1];
  const t = last.message;
  if (/EmptyResponse/.test(t)) {
    /*
      措辞是**实测校准过的**：一度写成"换个后端会话往往就过了"，但 kiro-cli 存的会话状态否掉了
      这句话 —— 换出来的新会话上下文只占 3.82%（几乎空的）照样连着失败，而最后成功的那个反而是
      最大的 9.11%；失败按时间聚堆（25 分钟里 13 失败 1 成功，之后 9 成功 1 失败）。
      也就是说这是**服务端那一段时间在返空响应**，跟你的消息、跟这条对话都没关系。
    */
    return 'kiro-cli 的日志里是 `err=EmptyResponse`：服务端把回复流开了，但一个 token 都没发过来。'
      + '这跟你的消息、跟这条对话的历史都没关系（实测：换一个几乎空的新会话照样失败，而上下文'
      + '更满的那个反而好了；失败是按时间段聚堆的）。KiroLex 会按退避自己重发；'
      + '整段时间都这样就换个模型，或者过几分钟再来。';
  }
  if (/dispatch failure|ConnectorError|timeout/i.test(t)) {
    return `kiro-cli 的日志里是连接层错误（${t.slice(0, 90)}）：连不上后端。看网络/VPN。`;
  }
  if (/Throttl|429|TooManyRequests/i.test(t)) {
    return `被限流了（${t.slice(0, 90)}）：等一下再发，或者换个模型。`;
  }
  if (/ValidationException|exceed|too large|max allowed/i.test(t)) {
    return `服务端判这次请求不合法（${t.slice(0, 120)}）：通常是历史里有超限的东西（图片、过长的一段）。`;
  }
  return `kiro-cli 的日志里是：${t.slice(0, 160)}`;
}

/** 一步到位：这次失败前后 `windowMs` 内 kiro-cli 自己记了什么。 */
export function cliErrorContext(windowMs = 30_000, now = Date.now(), env = process.env): string {
  return explainCliError(readTailErrors(kiroCliLogPath(env), windowMs, now));
}

/**
 * **kiro-cli 自己那几个日志没有任何上限，得有人管** ——「这些进程仍持有已经删除的
 * kiro-chat.log、lsp.log，共占 21.72GB」。
 *
 * 实测一个执行器进程手里就攥着 `kiro-chat.log` 7.86 GB + `lsp.log` 5.60 GB。kiro-cli 不轮转它们，
 * 而 KiroLex 只轮转自己 `~/.kirolex/logs` 那一份 —— 于是这两个文件只会一直长，长到把盘塞满。
 *
 * ## 为什么是**截断**而不是删掉
 *
 * 这正是那 21.72 GB 的成因：上一次清理是把文件**删了**，而十几个进程还持着写 fd ——
 * 路径消失了、inode 还活着，空间一点没回来，直到进程退出。`truncate` 走的是同一个 inode：
 * 空间当场回收，正在写的进程下一次 append 从 0 开始（O_APPEND 的偏移跟着文件长度走），
 * 谁都不用重启。
 *
 * 阈值给得宽（默认 200 MB）：这些日志偶尔是**唯一**能解释一次故障的东西（`EmptyResponse` 那次就是
 * 从 `kiro-chat.log` 里读出来的），所以不追求小，只拦住"失控"。
 */
export const CLI_LOG_MAX_BYTES = 200 * 1024 * 1024;

/** 哪些该截断（纯判断，给测试用）。 */
export function logsToTrim(
  files: { name: string; bytes: number }[],
  maxBytes: number = CLI_LOG_MAX_BYTES,
): string[] {
  return (files || [])
    .filter((f) => f && typeof f.name === 'string' && Number(f.bytes) > maxBytes)
    .map((f) => f.name);
}

/** 扫一遍 kiro-cli 的日志目录，超限的**就地截断**。返回清掉了多少字节。 */
export function trimHugeCliLogs(maxBytes: number = CLI_LOG_MAX_BYTES, env: NodeJS.ProcessEnv = process.env): {
  trimmed: { name: string; bytes: number }[];
  freed: number;
} {
  const out: { name: string; bytes: number }[] = [];
  let freed = 0;
  try {
    const dir = path.dirname(kiroCliLogPath(env));
    const entries = fs.readdirSync(dir).filter((n) => n.endsWith('.log'));
    const sized = entries.map((name) => {
      let bytes = 0;
      try { bytes = fs.statSync(path.join(dir, name)).size; } catch {}
      return { name, bytes };
    });
    for (const name of logsToTrim(sized, maxBytes)) {
      const full = path.join(dir, name);
      const before = sized.find((f) => f.name === name)?.bytes || 0;
      try {
        /* 就地截断 —— 删掉的话正在写它的进程会把空间一直攥着（见上面那段） */
        fs.truncateSync(full, 0);
        out.push({ name, bytes: before });
        freed += before;
      } catch {}
    }
  } catch {}
  return { trimmed: out, freed };
}
