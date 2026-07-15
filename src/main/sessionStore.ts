import fs from 'fs';
import os from 'os';
import path from 'path';
import { AgentProfile } from './config';

/**
 * Durable session store (design §4, §7). Foundation contract — DO NOT break:
 *  1. transcript.jsonl is APPEND-ONLY, one JSON object per complete message.
 *     Readers ignore unknown fields, so new per-message fields are always
 *     additive. A crash can never corrupt a mid-write JSON file.
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

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  ts: number;
  // additive: future fields (toolCalls, model, etc.) may be appended safely
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
      try { out.push(JSON.parse(t)); } catch { /* skip a torn final line */ }
    }
    return out;
  } catch {
    return [];
  }
}

export function deleteSession(id: string): void {
  const d = dirFor(id);
  if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
}
