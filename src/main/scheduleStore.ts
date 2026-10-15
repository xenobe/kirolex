/**
 * SCHEDULED TASKS ON DISK, one JSON file per job.
 *
 * A schedule that dies with the window is a timer, not a schedule. "Every Monday 9am"
 * has to survive closing the app, restarting it, and crashing — which is exactly what the
 * old loop could not do (its state lived in the renderer's `loopsRef`, so a reload reset
 * it).
 *
 * `home` is a PARAMETER, as in flowStore/loopStore: a module that reads `os.homedir()`
 * internally can only be tested by writing into the user's real data.
 */

import fs from 'fs';
import path from 'path';
import type { ScheduleState } from './schedule.ts';

export interface StoredSchedule {
  id: string;
  state: ScheduleState;
  updatedAt: number;
}

export function scheduleDir(home: string): string {
  return path.join(home, '.kirolex', 'schedules');
}

function scheduleFile(id: string, home: string): string {
  return path.join(scheduleDir(home), `${encodeURIComponent(id)}.json`);
}

/** Atomic: temp + rename. A partially written job could otherwise read back with a lower
 *  run count and hand itself budget it had already spent. */
export function writeSchedule(id: string, state: ScheduleState, home: string): void {
  const dir = scheduleDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = scheduleFile(id, home);
  const tmp = `${file}.tmp`;
  const payload: StoredSchedule = { id, state, updatedAt: Date.now() };
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

/** Null when absent or unparseable. A truncated file must NOT read as a fresh job at run
 *  0, which would restart something that had already spent its budget. */
export function readSchedule(id: string, home: string): StoredSchedule | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(scheduleFile(id, home), 'utf-8')) as StoredSchedule;
    if (!parsed?.state?.spec || typeof parsed.state.runs !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Every job on disk. This is how the app finds its schedules after a restart — nothing
 *  survives in memory, so enumeration is the only entry point. */
export function listSchedules(home: string): StoredSchedule[] {
  let names: string[];
  try { names = fs.readdirSync(scheduleDir(home)); } catch { return []; }
  const out: StoredSchedule[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const job = readSchedule(decodeURIComponent(name.slice(0, -'.json'.length)), home);
    if (job) out.push(job);
  }
  return out.sort((a, b) => a.state.createdAt - b.state.createdAt);
}

export function removeSchedule(id: string, home: string): void {
  try { fs.rmSync(scheduleFile(id, home), { force: true }); } catch { /* already gone */ }
}
