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

function dirFor(id: string): string {
  return path.join(baseDir, id);
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

function ensureDir(id: string): string {
  const d = dirFor(id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Create + persist a new session record. */
export function createSession(id: string, profile: AgentProfile, title = 'New Chat'): SessionRecord {
  ensureDir(id);
  const now = Date.now();
  const rec: SessionRecord = {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id,
    createdAt: now,
    updatedAt: now,
    title,
    profile,
    executorState: 'detached',
  };
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
