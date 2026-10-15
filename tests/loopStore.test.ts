import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  beginRound,
  clearLoop,
  listLiveLoops,
  loopRunPath,
  readLoop,
  writeLoop,
} from '../src/main/loopStore.ts';

const HOMES: string[] = [];
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-loopstore-'));
  HOMES.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of HOMES.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

/** A minimal LoopRun-shaped record. The store is deliberately agnostic about the
 *  machine's fields -- it owns the counter and the file, not the semantics. */
function run(over: Record<string, any> = {}): any {
  return {
    spec: {
      prompt: '修好失败的测试',
      goal: '',
      verifier: { level: 1, kind: 'command', command: 'npm test', timeoutSec: 60 },
      everySec: 0,
      stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 },
    },
    sessionId: 'sess-1',
    iteration: 0,
    consecutivePasses: 0,
    noProgressRounds: 0,
    lastVerdict: null,
    lastMeasuredVerdict: null,
    lastFingerprint: null,
    unrunnableRounds: 0,
    startedAt: 1000,
    terminal: null,
    ...over,
  };
}

describe('the round counter belongs to the runtime, not to a window', () => {
  test('a run written down is read back identically', () => {
    const home = tempHome();
    writeLoop('sess-1', run({ iteration: 3 }), home);
    assert.equal(readLoop('sess-1', home)!.iteration, 3);
  });

  test('the counter survives losing the window that started it', () => {
    // THE durability property. The counter used to live in the renderer's loopsRef, so
    // closing the window reset it to zero -- and a 20-round budget silently became
    // unbounded across restarts.
    const home = tempHome();
    writeLoop('sess-1', run(), home);
    assert.equal(beginRound('sess-1', home, 2000).run!.iteration, 1);
    assert.equal(beginRound('sess-1', home, 2000).run!.iteration, 2);
    // Simulate the window dying: nothing in memory, only the file.
    assert.equal(readLoop('sess-1', home)!.iteration, 2);
    assert.equal(beginRound('sess-1', home, 2000).run!.iteration, 3);
  });

  test('the budget is enforced by the OWNER of the counter', () => {
    // If the renderer decided this, a restart would hand the loop a fresh budget.
    const home = tempHome();
    writeLoop('sess-1', run({ iteration: 4, spec: { ...run().spec, stop: { ...run().spec.stop, maxIterations: 5 } } }), home);
    assert.equal(beginRound('sess-1', home, 2000).terminal, null);
    const spent = beginRound('sess-1', home, 2000);
    assert.equal(spent.terminal, 'exhausted');
    // ...and it stays spent: re-asking does not buy another round.
    assert.equal(beginRound('sess-1', home, 2000).terminal, 'exhausted');
  });

  test('each round is checkpointed before it starts, not after it ends', () => {
    // A round charged only on completion is a round an interrupted process forgets it
    // paid for -- which is how a crash loop bills a turn per restart forever.
    const home = tempHome();
    writeLoop('sess-1', run(), home);
    beginRound('sess-1', home, 2000);
    // On disk ALREADY, before any verdict has been folded in.
    const onDisk = JSON.parse(fs.readFileSync(loopRunPath('sess-1', home), 'utf-8'));
    assert.equal(onDisk.run.iteration, 1);
    assert.equal(onDisk.run.lastVerdict, null);
  });

  test('the wall clock is enforced too, from the persisted start time', () => {
    const home = tempHome();
    const spec = { ...run().spec, stop: { ...run().spec.stop, maxWallClockSec: 60 } };
    writeLoop('sess-1', run({ spec, startedAt: 1000 }), home);
    assert.equal(beginRound('sess-1', home, 1000 + 59_000).terminal, null);
    writeLoop('sess-1', run({ spec, startedAt: 1000 }), home);
    assert.equal(beginRound('sess-1', home, 1000 + 60_000).terminal, 'exhausted');
  });

  test('beginning a round on a run that already ended is refused', () => {
    const home = tempHome();
    writeLoop('sess-1', run({ terminal: 'aborted' }), home);
    const result = beginRound('sess-1', home, 2000);
    assert.equal(result.terminal, 'aborted');
    assert.equal(readLoop('sess-1', home)!.iteration, 0);
  });

  test('a loop with no record cannot begin a round', () => {
    const result = beginRound('sess-1', tempHome(), 2000);
    assert.equal(result.run, null);
    assert.match(result.error!, /没有/);
  });

  test('a half-written file reads as absent rather than as a fresh loop', () => {
    // A truncated record must not present as "iteration 0", which would restart a loop
    // that had already spent its budget.
    const home = tempHome();
    writeLoop('sess-1', run({ iteration: 3 }), home);
    const file = loopRunPath('sess-1', home);
    const whole = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, whole.slice(0, Math.floor(whole.length / 2)));
    assert.equal(readLoop('sess-1', home), null);
  });

  test('a finished loop is cleared, and live loops are discoverable after a restart', () => {
    // Enumeration is how the app finds a loop that was running when it died -- without
    // it, an orphaned record would keep a session looking busy forever.
    const home = tempHome();
    writeLoop('sess-1', run(), home);
    writeLoop('sess-2', run({ sessionId: 'sess-2' }), home);
    writeLoop('sess-3', run({ sessionId: 'sess-3', terminal: 'success' }), home);
    assert.deepEqual(listLiveLoops(home).map((l) => l.sessionId).sort(), ['sess-1', 'sess-2']);
    clearLoop('sess-1', home);
    assert.equal(readLoop('sess-1', home), null);
    assert.deepEqual(listLiveLoops(home).map((l) => l.sessionId), ['sess-2']);
  });
});
