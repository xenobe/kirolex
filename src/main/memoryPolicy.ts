/**
 * 分层记忆的容量策略 —— PURE，**不许 import node 内置模块**。
 *
 * 单独一个文件而不是塞进 `memory.ts`，是因为渲染进程也要用同一份阈值和同一句提示词，而
 * `memory.ts` 引了 `fs`/`os`/`path`：把它拉进渲染层就等于把 node 内置模块拖进 Vite 的包里。
 * 这里是两侧共用的那一份，`memory.ts` 反过来从这里取常量。
 *
 * 它要解决的问题：`buildMemoryInjection` 拼出的块**每一轮都发**，而三层里只有会话层有上限
 * （`sessionMemory.ts` 的 `MAX_CHARS = 1200`，且只约束自动压缩那条路，手写和 agent 直接写文件
 * 都绕过它）。实测某个项目的 memory.md 到过 74 KB，25 分钟内又长 8 KB，而 index.ts 里的预期写的是
 * 「~1.3k chars (~300 tokens) per turn」—— 偏离 55 倍，并且完全无声。
 */

export type MemoryScope = 'global' | 'project' | 'session';

/**
 * 每层的报警阈值，单位是**字节**不是字符：中文 UTF-8 是 3 字节/字，用字符数会低估三倍
 * （实测一个 11,239 字符的文件是 19,612 字节）。
 *
 * 三个数不同，因为每字节的代价不同：
 *
 *   global   8 KB —— 它注入进**每一个**会话，同一个字节被付的次数最多，所以阈值必须最严
 *   project 16 KB —— 只影响这个项目下的会话
 *   session  4 KB —— 会话层本来就有 1200 字符（中文约 3.6 KB）的设计上限，超过 4 KB 说明有人
 *                    绕开了自动压缩在手写，这本身就是该看一眼的信号
 */
export const MEMORY_WARN_BYTES: Record<MemoryScope, number> = {
  global: 8 * 1024,
  project: 16 * 1024,
  session: 4 * 1024,
};

/** 压缩前保留的备份份数。 */
export const MEMORY_BACKUPS = 3;

export interface MemoryWarning {
  scope: MemoryScope;
  bytes: number;
  /** 横幅上的名字。项目层用项目名（同时有好几个项目时才分得清是哪个）。 */
  label: string;
}

export interface MemoryBytes {
  global: number;
  project: number;
  session: number;
}

/**
 * 哪些层需要报警。
 *
 * 顺序固定为 global → project → session，和 `buildMemoryInjection` 的级联同序（least→most
 * specific）：横幅的排列因此和它们实际被注入的顺序一致，读起来不用换脑子。
 *
 * 没有 projectId / sessionId 的层直接跳过 —— 那条会话根本没有那一层，报了也无从下手。
 * 阈值用 `>` 而不是 `>=`：正好卡在线上时不出声，省掉一个反复闪的边界。
 */
export function memoryWarnings({ projectId, sessionId, bytes }: {
  projectId?: string;
  sessionId?: string;
  bytes: MemoryBytes;
}): MemoryWarning[] {
  const out: MemoryWarning[] = [];
  if (bytes.global > MEMORY_WARN_BYTES.global) {
    out.push({ scope: 'global', bytes: bytes.global, label: '全局记忆' });
  }
  if (projectId && bytes.project > MEMORY_WARN_BYTES.project) {
    out.push({ scope: 'project', bytes: bytes.project, label: `项目记忆「${projectId}」` });
  }
  if (sessionId && bytes.session > MEMORY_WARN_BYTES.session) {
    out.push({ scope: 'session', bytes: bytes.session, label: '本会话记忆' });
  }
  return out;
}

/** 横幅只需要量级，所以 KB 不给小数；不足 1 KB 显示字节，避免出现「0 KB」这种没信息的话。 */
export function formatMemoryBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** 每层被注入到哪里 —— 写进提示词，让模型知道压这个文件的影响范围有多大。 */
const SCOPE_REACH: Record<MemoryScope, string> = {
  global: '这个文件会被注入到**所有会话**的每一轮，所以它是三层里最贵的，也是压错了影响最大的',
  project: '这个文件会被注入到该项目下**每条会话**的每一轮',
  session: '这个文件只影响当前这条会话，但同样是每一轮都发',
};

/**
 * 点【压缩】发出去的那句固定提示词。
 *
 * 四条都是为了「压缩」不变成「丢东西」：给绝对路径（否则模型得先猜文件在哪）；说明影响范围；明说
 * 只合并去重、不删仍然成立的事实；点名路径/ID/命令/数字要保留原文 —— 这些正是被概括一次就再也
 * 复原不了的东西。
 */
export function compactMemoryPrompt({ scope, filePath, bytes }: {
  scope: MemoryScope;
  filePath: string;
  bytes: number;
}): string {
  return [
    `压缩记忆文件 ${filePath}（当前 ${formatMemoryBytes(bytes)}）。${SCOPE_REACH[scope]}。`,
    '',
    '- 只做合并与去重，不要删除任何仍然成立的事实',
    '- 路径、ID、命令、数字、专有名词一律保留原文，不要概括',
    '- 删除过程叙述、寒暄，以及已经被后来的结论推翻的内容',
    '- 同一主题的多条合并成一条',
    '- 写回同一个文件，完成后只报告压缩前后的字节数',
  ].join('\n');
}
