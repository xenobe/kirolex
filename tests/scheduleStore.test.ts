import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchedule, recordRun, type ScheduleSpec } from '../src/main/schedule.ts';
import { listSchedules, readSchedule, removeSchedule, scheduleDir, writeSchedule } from '../src/main/scheduleStore.ts';

const HOMES: string[] = [];
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-sched-'));
  HOMES.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

const SPEC: ScheduleSpec = { prompt: '生成周报', kind: 'weekly', everySec: 0, atTime: '09:00', weekday: 1, maxRuns: 20 };

describe('a schedule outlives the window that created it', () => {
  test('what is written is read back', () => {
    const home = tempHome();
    writeSchedule('job-1', createSchedule('sess-1', SPEC, 1000), home);
    const back = readSchedule('job-1', home);
    assert.deepEqual(back!.state.spec, SPEC);
    assert.equal(back!.state.sessionId, 'sess-1');
  });

  test('the run count survives a restart, so the budget is real', () => {
    // The old loop kept this in the renderer, so a reload reset it to zero and a declared
    // cap silently became a fresh cap every time.
    const home = tempHome();
    let state = createSchedule('sess-1', SPEC, 1000);
    state = recordRun(state, 2000);
    state = recordRun(state, 3000);
    writeSchedule('job-1', state, home);
    assert.equal(readSchedule('job-1', home)!.state.runs, 2);
  });

  test('a half-written file reads as absent, not as a fresh job', () => {
    const home = tempHome();
    writeSchedule('job-1', recordRun(createSchedule('sess-1', SPEC, 1000), 2000), home);
    const file = path.join(scheduleDir(home), 'job-1.json');
    const whole = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    assert.equal(readSchedule('job-1', home), null);
  });

  test('every job is discoverable without knowing its id', () => {
    // After a restart nothing remembers the ids, so enumeration is the only way back in.
    const home = tempHome();
    writeSchedule('job-a', createSchedule('s1', SPEC, 1000), home);
    writeSchedule('job-b', createSchedule('s2', SPEC, 2000), home);
    assert.deepEqual(listSchedules(home).map((j) => j.id), ['job-a', 'job-b']);
  });

  test('junk in the directory does not break enumeration', () => {
    const home = tempHome();
    writeSchedule('job-a', createSchedule('s1', SPEC, 1000), home);
    fs.writeFileSync(path.join(scheduleDir(home), 'notes.txt'), 'hi');
    fs.writeFileSync(path.join(scheduleDir(home), 'broken.json'), '{oops');
    assert.deepEqual(listSchedules(home).map((j) => j.id), ['job-a']);
  });

  test('no temp files are left behind to be read as jobs', () => {
    const home = tempHome();
    writeSchedule('job-a', createSchedule('s1', SPEC, 1000), home);
    writeSchedule('job-a', recordRun(createSchedule('s1', SPEC, 1000), 5000), home);
    assert.deepEqual(fs.readdirSync(scheduleDir(home)).filter((f) => f.endsWith('.tmp')), []);
    assert.equal(readSchedule('job-a', home)!.state.runs, 1);
  });

  test('a removed job is gone', () => {
    const home = tempHome();
    writeSchedule('job-a', createSchedule('s1', SPEC, 1000), home);
    removeSchedule('job-a', home);
    assert.equal(readSchedule('job-a', home), null);
    assert.deepEqual(listSchedules(home), []);
  });
});
