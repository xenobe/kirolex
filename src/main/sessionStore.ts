import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentProfile } from './config';

/**
 * Durable session store (design §4, §7). Foundation contract — DO NOT break:
 *  1. transcript.jsonl is append-only during normal chat, one JSON object per
 *     complete message. Explicit edit-and-rerun is the sole operation that
 *     atomically truncates it before an earlier user message.
 *     Readers ignore unknown fields, so new per-message fields are additive.
 *  2. record.json is VERSIONED metadata (schemaVersion) — the only thing that
 *     migrates. Small, rewritable.
 *  3. Memory lives in a SEPARATE store (~/.kirolex/memory/), never here.
 *
 * Asymmetric durability: user messages persist the instant they are sent;
 * assistant messages persist ONLY when fully complete; in-flight assistant
 * output is discarded, never written.
 */

export const SESSION_SCHEMA_VERSION = 1;

export type MessageRole = 'user' | 'assistant';

export interface StoredFileDiff {
  path: string;
  oldText?: string;
  newText: string;
}

export interface StoredToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
  kind?: string;
  locations?: string[];
  diffs?: StoredFileDiff[];
}

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  ts: number;
  /** Append-only event: materialize this text into an earlier user message. */
  mergeIntoMessageId?: string;
  /** File-changing tool calls produced during this assistant turn. */
  toolCalls?: StoredToolCall[];
  /** Files/images the user attached to THIS message. Persisted so the chips
   *  survive a restart AND so history priming can re-point a fresh backend at
   *  them (otherwise an image sent earlier is forgotten entirely). */
  attachments?: { id?: string; name: string; path: string; isImage?: boolean }[];
  /** Pasted text blobs shown as `[ 粘贴 #N · M 行 ]` placeholders in `content`.
   *  The bytes live in ~/.kirolex/pastes; this is the ONLY record of where. */
  pastes?: { seq: number; lines: number; chars: number; path: string }[];
  /**
   * **这条是 KiroLex 自己说的话，不是对话** ——「这他妈什么玩意，为什么按照会话发出去了」。
   *
   * 「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」「♻️ 已经换成新的后端会话」「⏳ 已排队」这些都是
   * KiroLex 对**你**说的，原来却以 `role: 'user'` 落进 transcript —— 于是：
   *   · 看起来像你自己说的话；
   *   · 而且**真的会发给模型**：ride-along 快照和 history.md 都是从 transcript 建的，
   *     模型下一轮就读到"我现在跑在 gpt-5.6-sol 上"当成你的指令。
   *
   * 标上这个之后，界面照旧显示（那是你要的可见性），但每一条**发给模型**的路径都跳过它
   * （`historyLine` 那侧的过滤，见 `readTranscript` 的调用点）。
   */
  kirolex?: true;
  // additive: future fields (model, etc.) may be appended safely
}

export type ExecutorState =
  | 'detached'
  | 'attaching'
  | 'attached'
  | 'disconnected' // remote link lost, process may still be alive (later PRs)
  | 'error';

export interface SessionRecord {
  schemaVersion: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  profile: AgentProfile;
  /** The kiro-cli-assigned session id for this KiroLex session's executor.
   *  KiroLex owns `id` (dir key); this maps to the backend session for resume.
   *  Absent on legacy records where id WAS the kiro-cli id (treat id as fallback). */
  cliSessionId?: string;
  /** Memory injection bookkeeping (design §6.4). */
  lastMemoryInjection?: { charCount: number; at: number };
  /** Runtime lifecycle; on load, live states are treated as detached. */
  executorState: ExecutorState;
  lastExecutorError?: string;
  /** User-archived: hidden from the main list, never eager-attached. Not deleted. */
  archived?: boolean;
  /** User-pinned: sorts to the top of its group. Renderer mirror of session.pinned;
   *  persisted here so it survives restart AND renderer-origin (localStorage) changes. */
  pinned?: boolean;
  /**
   * WHAT THIS CHAT IS FOR — `flow-main` is a flow's own thread, `skill` a transient canvas session.
   *
   * PERSISTED, unlike its predecessor. `Session.purpose` lived only in renderer memory, so after a restart the
   * old project main session was no longer marked: the code that 「never touches the main session」 could not
   * find it, and a second one was created next time. A protection that evaporates on restart is not one.
   */
  purpose?: string;
  /**
   * 上一次压缩会话记忆时，这个会话有多少条消息 —— 门槛就靠它算（`sessionMemory.shouldConsolidate`）。
   * 存条数而不是时间戳：贵的是消息量，一个开着三天没说话的会话不该被时间推着去压缩。
   */
  memoryConsolidatedAt?: number;
  /** Which flow a `flow-main` chat belongs to. A title is display; this is identity. */
  flow?: string;
  /** Which kiro-cli backend id KiroLex has actually fed this chat's history into.
   *  A successful `session/load` does NOT imply the resumed backend holds any
   *  conversation -- it can resume an id that was itself created empty in an
   *  earlier run -- so this is the only reliable "context is present" signal.
   *  Absent = unknown (chats predating this field); those are never auto-replayed
   *  because some transcripts here are 3MB / 5000+ messages. */
  contextEstablishedFor?: string;
  /** OS pid of the kiro-cli process that holds that context. Verified: kiro-cli
   *  does NOT persist ACP sessions -- none of this chat's five backend ids exist
   *  in ~/Library/Application Support/kiro-cli/data.sqlite3, while its own
   *  `--no-interactive` conversations do. An ACP session lives only in that
   *  child process's memory, and `session/load` accepts a known id by simply
   *  starting an EMPTY session for it. So the id alone is not proof of context:
   *  after a restart the same id resolves to a blank backend. Pairing it with
   *  the pid makes the marker expire exactly when the process does. */
  contextEstablishedPid?: number;
  /** How this chat's context is restored onto a fresh backend.
   *  'snapshot' (default): ONE prompt carrying the artifact manifest, the most
   *  recent turns verbatim, and the path of the fully rendered history file, which
   *  the model reads on demand. Nothing is discarded -- the complete text is on
   *  disk and the prompt says so and where -- and a 78-chunk chat becomes one turn.
   *  'full': replay every chunk verbatim. Exact, but costs one model turn per
   *  chunk on every restart, because kiro-cli cannot restore an ACP session. */
  primeMode?: 'snapshot' | 'full';
}

const baseDir = path.join(os.homedir(), '.kirolex', 'sessions');

/**
 * 会话 id 只能是这个形状 —— `s_<毫秒>_<随机>`，外加历史上几种前缀。
 *
 * 原来 `dirFor` 是裸的 `path.join(baseDir, id)`：id 里带 `/` 就会把目录建到布局之外，带 `../` 就能
 * 写出 sessions 目录。实测撞出来一个 —— 一次调用把 cwd 传成了 id（参数顺序错了一位），于是磁盘上多了
 * `sessions/Users/keyinan/work/record.json` 这么一棵树：一条 app 永远看不见、清扫也永远碰不到的会话。
 *
 * 参数顺序错一位这种事一定会再发生，而它的代价不该是"往任意路径写文件"。所以判据放在**落盘的唯一入口**。
 */
const ID_SHAPE = /^[A-Za-z0-9_-]{1,120}$/;

function safeId(id: string): string {
  const s = String(id ?? '');
  if (!ID_SHAPE.test(s)) {
    throw new Error(`会话 id 不合法：${JSON.stringify(s.slice(0, 80))} —— 只允许字母、数字、下划线和短横`);
  }
  return s;
}

function dirFor(id: string): string {
  return path.join(baseDir, safeId(id));
}
function recordPath(id: string): string {
  return path.join(dirFor(id), 'record.json');
}
function transcriptPath(id: string): string {
  return path.join(dirFor(id), 'transcript.jsonl');
}
/** Exposed so the attach path can size its session/load budget by how much
 *  history kiro-cli actually has to read back. */
export function transcriptFileSize(id: string): number {
  try { return fs.statSync(transcriptPath(id)).size; } catch { return 0; }
}

/** The chat's whole history rendered as one readable document. It exists so a
 *  rebuilt backend can be handed a PATH instead of 78 replayed turns: the model
 *  reads whichever part it needs. Regenerated from the transcript at rebuild
 *  time, so it can never drift from the source of truth. */
export function historyFilePath(id: string): string {
  return path.join(dirFor(id), 'history.md');
}

/** Does the rendered history exist? Used to refresh it only for chats whose
 *  backend was actually handed that path, instead of creating it for every chat. */
export function hasHistoryFile(id: string): boolean {
  try { return fs.existsSync(historyFilePath(id)); } catch { return false; }
}
export function writeHistoryFile(id: string, text: string): string {
  const target = historyFilePath(id);
  ensureDir(id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, target);
  return target;
}

/** The CONTEXT SNAPSHOT the last send actually carried.
 *
 *  Diagnostics, not protocol. The snapshot is derived from the transcript AT SEND TIME,
 *  so once the conversation moves on it cannot be reconstructed — it has to be captured
 *  as it goes out. Overwritten on every send (one file per chat), so it stays bounded
 *  however long the chat runs.
 *
 *  Memory layers are excluded on purpose: they are editable in their own tabs, and
 *  duplicating them here only buried the part that cannot be seen anywhere else. */
export function lastInjectionPath(id: string): string {
  return path.join(dirFor(id), 'last-injection.md');
}

export function writeLastInjection(id: string, snapshot: string): void {
  ensureDir(id);
  const target = lastInjectionPath(id);
  const header = '# 上一次发送实际带给模型的上下文快照\n'
    + `# 会话 ${id}\n`
    + `# 发送时间 ${new Date().toISOString()}\n`
    + `# ${snapshot.length} 字符（不含 global / project 记忆，那些在各自的标签页里看）\n`
    + `${'='.repeat(70)}\n\n`;
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, header + snapshot, 'utf-8');
  fs.renameSync(tmp, target);
}

export function readLastInjection(id: string): { text: string; at: number } | null {
  try {
    const p = lastInjectionPath(id);
    return { text: fs.readFileSync(p, 'utf-8'), at: fs.statSync(p).mtimeMs };
  } catch {
    return null;   // nothing has been injected for this chat yet
  }
}

/** A HAND-EDITED context block that replaces the generated one for this chat.
 *
 *  Separate file from `last-injection.md` on purpose: that one is an ARCHIVE of what
 *  already went out (rewritten by every send, and editing it would change nothing —
 *  those bytes are in the backend's conversation already). This one is an INPUT, so
 *  it must survive the next send instead of being overwritten by it.
 *
 *  It is sticky until removed, which is the risk: a curated block does not grow with
 *  the conversation, so it goes stale exactly the way a frozen `history.md` did. The
 *  dialog therefore states which of the two is in effect and offers one click back to
 *  the generated one. */
export function contextOverridePath(id: string): string {
  return path.join(dirFor(id), 'context-override.md');
}

export function readContextOverride(id: string): { text: string; at: number } | null {
  try {
    const p = contextOverridePath(id);
    const text = fs.readFileSync(p, 'utf-8');
    if (!text.trim()) return null;      // an empty file is not an override
    return { text, at: fs.statSync(p).mtimeMs };
  } catch {
    return null;
  }
}

export function writeContextOverride(id: string, text: string): void {
  ensureDir(id);
  const target = contextOverridePath(id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, target);
}

/** Back to the generated snapshot. Returns false when there was nothing to remove. */
export function clearContextOverride(id: string): boolean {
  try {
    fs.unlinkSync(contextOverridePath(id));
    return true;
  } catch {
    return false;
  }
}

function ensureDir(id: string): string {
  const d = dirFor(id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 记录还不存在时先记下来，等它出现再写进去 —— 「flow 会话又被加进分屏」的最后一环。
 *
 * 时序事实（实测日志）：`newSession` 一返回，renderer 就标记 purpose，但**记录是第一次 prompt 时才创建的**：
 *   03:53:52 会话创建 → 03:53:54 `purpose LOST … 等了 2s 记录还没出现` → 03:53:59 `prompt received`（此时才有记录）
 * 所以「读记录 → 改 → 写」这条路在会话最年轻的那几秒必然失败，而那几秒恰恰是身份最需要被记下的时候
 * （分屏的自动播种/领养就在这中间跑）。上一版让 handler 等 2 秒，方向就错了：等多久都是赌落盘时刻。
 *
 * 改成异步补写：记录在就直接改，不在就挂起，`createSession` 一建记录立刻应用。挂起项只活在内存里 ——
 * 它代表「这一次运行里刚发生的一个意图」，落盘反而会在下次启动时把陈旧意图写到别的会话上。
 */
const pendingPatches = new Map<string, Partial<SessionRecord>>();

/** 合并一份挂起补丁 —— PURE，便于测试：只覆盖补丁里出现过的键。 */
export function mergePending(rec: SessionRecord, patch: Partial<SessionRecord> | undefined): SessionRecord {
  if (!patch) return rec;
  return { ...rec, ...patch };
}

/**
 * 写一个字段，不管记录现在有没有。返回它是立刻写进去了，还是挂起等记录。
 */
export function patchRecord(id: string, patch: Partial<SessionRecord>): 'written' | 'pending' {
  const rec = readRecord(id);
  if (rec) {
    writeRecord(mergePending(rec, patch));
    pendingPatches.delete(id);
    return 'written';
  }
  pendingPatches.set(id, { ...(pendingPatches.get(id) || {}), ...patch });
  return 'pending';
}

/** 有没有挂起的补丁 —— 只给日志和测试用。 */
export function pendingPatchFor(id: string): Partial<SessionRecord> | undefined {
  return pendingPatches.get(id);
}

/** Create + persist a new session record. */
export function createSession(id: string, profile: AgentProfile, title = 'New Chat'): SessionRecord {
  ensureDir(id);
  const now = Date.now();
  const base: SessionRecord = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    title,
    profile,
    executorState: 'detached',
  };
  // 会话创建之前就到达的那些标记（purpose / flow / primeMode）在这里落地
  const rec = mergePending(base, pendingPatches.get(id));
  pendingPatches.delete(id);
  writeRecord(rec);
  // touch transcript so the file exists
  if (!fs.existsSync(transcriptPath(id))) fs.writeFileSync(transcriptPath(id), '');
  return rec;
}

/** Overwrite record.json (metadata is small + rewritable). */
export function writeRecord(rec: SessionRecord): void {
  ensureDir(rec.id);
  rec.updatedAt = Date.now();
  const tmp = recordPath(rec.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, recordPath(rec.id)); // atomic replace
}

export function readRecord(id: string): SessionRecord | null {
  try {
    const raw = fs.readFileSync(recordPath(id), 'utf-8');
    // Return the RAW persisted record. executorState is write-only metadata that
    // main keeps accurate via attach/detach writes; it is NOT normalized here,
    // because callers do read-modify-write (memory injection, projectId) and a
    // read-time mutation would silently persist 'detached' onto a live executor.
    // Stale 'attached' left by a crash is reset once at startup (see
    // markAllExecutorsDetached) — nothing branches on it at runtime.
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

/** One-time startup sweep: after a restart no executor is alive, so any record
 *  left in a live state (attached/attaching) is stale — reset it to detached.
 *  Writes the file directly to PRESERVE updatedAt (so session ordering, which
 *  sorts by updatedAt, is not scrambled). */
export function markAllExecutorsDetached(): void {
  if (!fs.existsSync(baseDir)) return;
  for (const id of fs.readdirSync(baseDir)) {
    const rec = readRecord(id);
    if (rec && (rec.executorState === 'attached' || rec.executorState === 'attaching')) {
      rec.executorState = 'detached';
      try {
        const tmp = recordPath(id) + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(rec, null, 2)); // no updatedAt bump
        fs.renameSync(tmp, recordPath(id));
      } catch { /* best-effort */ }
    }
  }
}

/**
 * 会话记录上的 flow 引用跟着重命名走 —— 返回改了几条。
 *
 * `record.flow` 是身份（主会话删除保护、画布装载、复用判据全靠它），标题只是显示 —— 但 `titleFlow` 会用标题
 * 兜底认人，所以两样都得迁。`retitle` 由调用方注入，这个模块不该反向依赖调用方。
 */
export function renameFlowInRecords(from: string, to: string, retitle: (title: string) => string): number {
  if (!fs.existsSync(baseDir)) return 0;
  const want = (from || '').trim();
  const next = (to || '').trim();
  if (!want || !next || want === next) return 0;
  let changed = 0;
  for (const id of fs.readdirSync(baseDir)) {
    const rec = readRecord(id);
    if (!rec || (rec.flow || '').trim() !== want) continue;
    writeRecord({ ...rec, flow: next, title: retitle(rec.title) });
    changed += 1;
  }
  return changed;
}

export function listSessions(): SessionRecord[] {
  if (!fs.existsSync(baseDir)) return [];
  const out: SessionRecord[] = [];
  for (const id of fs.readdirSync(baseDir)) {
    const rec = readRecord(id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Append ONE complete message to the durable transcript. Append-only, atomic
 * line write. Callers MUST only call this for complete messages (a user message
 * the instant it is sent; an assistant message only once fully received).
 */
export function appendMessage(id: string, msg: StoredMessage): void {
  ensureDir(id);
  fs.appendFileSync(transcriptPath(id), JSON.stringify(msg) + '\n');
  const rec = readRecord(id);
  if (rec) writeRecord(rec); // bump updatedAt
}

/** Read the full transcript (tolerant of unknown fields + partial last line). */
export function readTranscript(id: string): StoredMessage[] {
  try {
    const raw = fs.readFileSync(transcriptPath(id), 'utf-8');
    const out: StoredMessage[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        const message = JSON.parse(t) as StoredMessage;
        if (message.mergeIntoMessageId) {
          const target = out.find((candidate) => candidate.id === message.mergeIntoMessageId);
          if (target?.role === 'user') {
            target.content = `${target.content}
${message.content}`;
            continue;
          }
        }
        out.push(message);
      } catch { /* skip a torn final line */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** Atomically keep only raw transcript events before `messageId`. */
export function truncateTranscriptBefore(id: string, messageId: string): StoredMessage[] {
  const file = transcriptPath(id);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const targetIndex = lines.findIndex((line) => {
    try { return (JSON.parse(line) as StoredMessage).id === messageId; }
    catch { return false; }
  });
  if (targetIndex < 0) throw new Error(`Message ${messageId} was not found in the durable transcript.`);

  ensureDir(id);
  const tmp = `${file}.tmp`;
  const kept = lines.slice(0, targetIndex);
  fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '');
  fs.renameSync(tmp, file);
  const rec = readRecord(id);
  if (rec) writeRecord(rec);
  return readTranscript(id);
}

export function deleteSession(id: string): void {
  const d = dirFor(id);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}

/** Atomically overwrite the transcript with exactly the given messages. Robust
 *  alternative to truncateTranscriptBefore for edit-and-rerun: the renderer knows
 *  precisely which messages to retain, so no id lookup (which fails for un-persisted
 *  messages like mid-turn steers) is needed. */
export function rewriteTranscript(id: string, messages: StoredMessage[]): void {
  ensureDir(id);
  const file = transcriptPath(id);
  const tmp = `${file}.tmp`;
  const body = messages.map((m) => JSON.stringify(m)).join('\n');
  fs.writeFileSync(tmp, body ? `${body}\n` : '');
  fs.renameSync(tmp, file);
  const rec = readRecord(id);
  if (rec) writeRecord(rec);
}
