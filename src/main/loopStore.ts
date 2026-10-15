/**
 * DURABLE LOOP RUNS: the round counter, owned by main and written to disk.
 *
 * The problem this fixes. `LoopRun` was deliberately built to be JSON-serializable, but
 * the live copy lived in the renderer's `loopsRef` — so the counter existed only inside
 * one window. Closing that window, or reloading it, reset the count to zero. A loop
 * declared "at most 20 rounds" therefore had no durable budget at all: every restart
 * handed it a fresh 20, which is precisely the unbounded-loop failure the round cap
 * exists to prevent.
 *
 * The four properties a loop needs to be called durable (Orkes/Conductor's list) are:
 *
 *   1. the counter is owned by the runtime, not the process   <- this file
 *   2. every round is checkpointed before the next begins     <- this file
 *   3. iteration boundaries are idempotent
 *   4. termination is explicit                                <- already in loopMachine
 *
 * `beginRound` delivers 1 and 2 together, and the order matters: the round is charged
 * and FLUSHED before it is handed back to be sent. Charging on completion instead would
 * mean a process that dies mid-round forgets it paid — the shape of a crash loop that
 * bills a model turn per restart, forever.
 *
 * WHAT THIS IS NOT. It is not the loop driver. The send path still lives in the
 * renderer, where the streaming state, attach bookkeeping and message list are; moving
 * that here is a separate change. What moved is the thing that must not be lost: the
 * count, the budget decision, and the record of why a run ended.
 *
 * `home` is a PARAMETER for the same reason as in flowStore: a module that reads
 * `os.homedir()` internally can only be tested by writing into the user's real data.
 */

import fs from 'fs';
import path from 'path';

/** Structurally `LoopRun` from the renderer's loopMachine, kept as a loose shape on
 *  purpose. main's tsconfig pins `rootDir: ./src/main`, so importing the renderer's
 *  type would move the emit layout; and this module owns the COUNTER and the file, not
 *  the machine's semantics. The fields it actually reads are pinned by the tests. */
export interface StoredLoopRun {
  spec: {
    everySec?: number;
    stop: {
      maxIterations: number;
      maxWallClockSec?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  sessionId: string;
  iteration: number;
  startedAt: number;
  terminal: string | null;
  [key: string]: unknown;
}

interface Envelope {
  run: StoredLoopRun;
  updatedAt: number;
}

function loopDir(home: string): string {
  return path.join(home, '.kirolex', 'loop-runs');
}

export function loopRunPath(sessionId: string, home: string): string {
  // One file per session: a chat has at most one loop, and a new loop supersedes the
  // old one (`superseded`), so the session id is the natural key.
  return path.join(loopDir(home), `${encodeURIComponent(sessionId)}.json`);
}

/** Atomic write: temp + rename, as everywhere else in this codebase. A partially
 *  written counter is worse than none — it would read as a smaller number and hand the
 *  loop rounds it had already spent. */
export function writeLoop(sessionId: string, run: StoredLoopRun, home: string): void {
  const dir = loopDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = loopRunPath(sessionId, home);
  const tmp = `${file}.tmp`;
  const envelope: Envelope = { run, updatedAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** Null when absent or unparseable. A truncated record must NOT present as a fresh
 *  loop at iteration 0: that would restart a run which had already spent its budget. */
export function readLoop(sessionId: string, home: string): StoredLoopRun | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(loopRunPath(sessionId, home), 'utf-8')) as Envelope;
    if (!parsed?.run || typeof parsed.run.iteration !== 'number' || !parsed.run.spec?.stop) return null;
    return parsed.run;
  } catch {
    return null;
  }
}

/**
 * Charge one round and flush it, or refuse.
 *
 * This is `beginIteration` from the state machine, made durable: the same two budget
 * checks, but against the PERSISTED counter and start time, and with the result written
 * to disk before it is returned. The terminal is persisted too, so the reason a run
 * ended is not lost with the process that decided it.
 */
export function beginRound(
  sessionId: string,
  home: string,
  now: number,
): { run: StoredLoopRun | null; terminal: string | null; error?: string } {
  const run = readLoop(sessionId, home);
  if (!run) return { run: null, terminal: null, error: '没有找到这个会话的循环记录' };
  // Already over: report the recorded reason rather than inventing a new one.
  if (run.terminal) return { run, terminal: run.terminal };

  const settle = (terminal: string) => {
    const ended = { ...run, terminal };
    writeLoop(sessionId, ended, home);
    return { run: ended, terminal };
  };

  if (run.iteration >= run.spec.stop.maxIterations) return settle('exhausted');
  const budget = run.spec.stop.maxWallClockSec;
  if (budget && now - run.startedAt >= budget * 1000) return settle('exhausted');

  // Charge, then FLUSH, then hand back. A round that is only recorded once it finishes
  // is a round a killed process does not know it paid for.
  const charged = { ...run, iteration: run.iteration + 1 };
  writeLoop(sessionId, charged, home);
  return { run: charged, terminal: null };
}

/** Every loop still running. The way to find a loop that was in flight when the app
 *  died — without it, an orphaned record leaves a session looking busy forever. */
export function listLiveLoops(home: string): StoredLoopRun[] {
  let names: string[];
  try { names = fs.readdirSync(loopDir(home)); } catch { return []; }
  const out: StoredLoopRun[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const run = readLoop(decodeURIComponent(name.slice(0, -'.json'.length)), home);
    if (run && !run.terminal) out.push(run);
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

export function clearLoop(sessionId: string, home: string): void {
  try { fs.rmSync(loopRunPath(sessionId, home), { force: true }); } catch { /* already gone */ }
}
