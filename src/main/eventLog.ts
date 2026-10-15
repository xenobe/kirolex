/**
 * Per-session RUN EVENT LOG: an append-only record of what actually happened during
 * a turn, with timestamps.
 *
 * Why this exists. `transcript.jsonl` is the CONVERSATION -- messages, and the tool
 * calls that touched files, with one timestamp per message. That is the right shape
 * for replaying a chat and the wrong shape for answering "where did the time go":
 *   - a StoredToolCall has NO timestamp, so a turn that ran 73 tool calls is one
 *     opaque block;
 *   - permission requests are not persisted at all, so the single most common answer
 *     to "why did this take 20 minutes" -- it was waiting for a human -- is
 *     unrecoverable after a restart;
 *   - retries and model swaps leave no durable trace of WHEN they happened.
 *
 * So this is a second, separate file. It is NOT a second copy of the conversation:
 * no message text, no tool output, no diffs. Just typed, timestamped facts that the
 * timeline and the event-stream view are computed from.
 *
 * Deliberately NOT a full ACP replay log. Every `tool_call_update` would make the
 * file proportional to streaming chatter rather than to real work (one chat here
 * produced 254 `execute` calls, each with several updates). Only the FIRST and LAST
 * update of a tool call are recorded, which is exactly what a duration needs. A
 * frame-accurate scrubber over the raw notification stream would need full fidelity
 * and is a different feature.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

/** Keep this in sync with `RunEvent` in src/renderer/runTimeline.ts.
 *
 *  It cannot be imported: main's tsconfig pins `rootDir: ./src/main`, so a shared
 *  module would move the whole emit layout. The duplication is pinned by
 *  tests/runTimeline.test.ts instead -- the same arrangement as DEFAULT_MODEL. */
export type RunEventType =
  | 'prompt_start'
  | 'prompt_end'
  | 'prompt_error'
  | 'tool_start'
  | 'tool_end'
  | 'permission_request'
  | 'permission_response'
  | 'context_injected'
  | 'model_swap';

export interface RunEvent {
  ts: number;
  type: RunEventType;
  /** The turn this belongs to: the user message id, so events can be grouped
   *  without relying on arrival order. */
  turn?: string;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  /** Duration, on the `*_end` events only. Measured here rather than derived in the
   *  reader so a rotated-away start event cannot silently produce a wrong span. */
  ms?: number;
  model?: string;
  stopReason?: string;
  produced?: boolean;
  chars?: number;
  optionId?: string;
  detail?: string;
}

/** Rotation threshold. One file, rotated once: a long-lived chat must not grow an
 *  unbounded log, and nothing here is worth keeping forever -- the conversation
 *  itself lives in transcript.jsonl. */
export const MAX_EVENT_LOG_BYTES = 4 * 1024 * 1024;

const sessionsBaseDir = path.join(os.homedir(), '.kirolex', 'sessions');

export function eventLogPath(sessionId: string): string {
  return path.join(sessionsBaseDir, sessionId, 'events.jsonl');
}

/** Append one event. NEVER throws: this is instrumentation, and a failure to record
 *  what happened must not change what happens. */
export function appendEvent(sessionId: string, event: RunEvent): void {
  if (!sessionId) return;
  try {
    const file = eventLogPath(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > MAX_EVENT_LOG_BYTES) {
        // Rotate rather than trim: rewriting a multi-megabyte file on the main
        // process's thread to drop its head is the kind of pause this log exists to
        // measure, not to cause.
        fs.renameSync(file, `${file}.1`);
      }
    } catch { /* no file yet */ }
    fs.appendFileSync(file, `${JSON.stringify(event)}\n`);
  } catch { /* instrumentation must never break a turn */ }
}

/** Read the most recent `limit` events, tolerant of a partial last line (the file is
 *  appended to while it is being read). */
export function readEvents(sessionId: string, limit = 4000): { events: RunEvent[]; path: string; truncated: boolean } {
  const file = eventLogPath(sessionId);
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((line) => line.trim().length > 0);
    const slice = lines.length > limit ? lines.slice(lines.length - limit) : lines;
    const events: RunEvent[] = [];
    for (const line of slice) {
      try { events.push(JSON.parse(line) as RunEvent); } catch { /* partial tail line */ }
    }
    return { events, path: file, truncated: lines.length > slice.length || fs.existsSync(`${file}.1`) };
  } catch {
    return { events: [], path: file, truncated: false };
  }
}
