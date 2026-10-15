/**
 * 会话记忆的自动维护 —— PURE，「你在 memory 里加一个 session memory，你看看怎么弄」。
 *
 * 先说清已经有的东西,免得重复造:三层记忆(全局 ⊕ project ⊕ 这个会话)早就在了 —— 文件在
 * `~/.kirolex/memory/sessions/<id>/memory.md`,每一轮都会被注入(`buildMemoryInjection`),对话框里也有
 * 那个 tab。缺的是**没人写它**:它是一个手填的文本框,而没有人会在聊天中途停下来去写笔记。
 *
 * 所以这里补的不是存储,是维护:一轮结束、攒够了新消息,就用便宜的一次性调用(`runLiteOneShot`,和生成标题
 * 同一条路)把这段对话压成几行事实,写回那个文件。下一轮的注入就带着它 —— 于是长会话被压缩过之后,
 * 「我们之前定了什么」不再依赖模型还记不记得。
 *
 * 三条克制,都是为了不让它变成负担:
 *   有门槛      每 CONSOLIDATE_EVERY 条新消息才做一次;一句「好」不值得一次模型调用
 *   有上限      记忆本身不许无限长(MAX_CHARS)—— 它每一轮都要被注入,长了就是每一轮都在付钱
 *   只留事实    提示词明说要「决定、约束、路径、名字」,不要过程叙述:注入的是事实,不是日记
 */
export interface SessionMemoryState {
  /** 现在这个会话有多少条消息 */
  messages: number;
  /** 上一次压缩时是多少条（没压缩过就是 0） */
  consolidatedAt?: number;
  /** 正在压缩 —— 一次就够，重入只会写坏同一个文件 */
  inFlight?: boolean;
}

/** 每 12 条新消息压一次。一次调用几分钱，但每一轮的注入都要带着它，所以宁疏不密。 */
export const CONSOLIDATE_EVERY = 12;
/** 会话记忆的上限：它每一轮都要被注入，长了就是每一轮都在付钱。 */
export const MAX_CHARS = 1200;

export function shouldConsolidate(state: SessionMemoryState): boolean {
  if (!state || state.inFlight) return false;
  const now = Math.max(0, Number(state.messages) || 0);
  const then = Math.max(0, Number(state.consolidatedAt) || 0);
  return now - then >= CONSOLIDATE_EVERY;
}

/**
 * 压缩用的提示词。要的是**能在下一轮直接当事实用**的东西,所以点名了该留什么、不该留什么。
 *
 * 带上现有的记忆,并要求「合并而不是重写」:否则每次压缩都会把上一次留下的结论丢掉 —— 那才是最贵的信息,
 * 它们往往来自更早、已经不在这段最近对话里的地方。
 */
export function buildConsolidationPrompt(recent: string, existing: string): string {
  return [
    'Condense this chat into a short memory note that a future turn can rely on as FACT.',
    '',
    'Keep only what stays true: decisions made, constraints agreed, file paths, names, ids, numbers,',
    'and anything the user asked to be remembered. Drop narration, pleasantries, and anything already',
    'obvious from the code. No headings, no preamble — one fact per line, at most 12 lines.',
    'Write the lines in the language the user used.',
    '',
    existing.trim()
      ? `MERGE with the note below — keep every line that is still true, drop what has been superseded:\n${existing.trim()}`
      : 'There is no note yet.',
    '',
    `Recent conversation:\n${recent}`,
  ].join('\n');
}

/**
 * 合并结果并封顶 —— 模型可能什么也没给（那就保持原样，而不是把已有的记忆清成空）。
 *
 * 超长时从**后面**截:一份记忆里越靠前的通常越是早就定下来的约束,而它正是最不该被丢掉的部分。
 */
export function mergeSessionMemory(existing: string, produced: string, cap = MAX_CHARS): string {
  const next = String(produced || '').trim();
  if (!next) return String(existing || '');
  const lines = next
    .split('\n')
    .map((line) => line.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const joined = lines.map((line) => `- ${line}`).join('\n');
  return joined.length <= cap ? joined : `${joined.slice(0, cap).replace(/\n[^\n]*$/, '')}`;
}
