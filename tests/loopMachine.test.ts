import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOLERATED_RETRY_FLOOR_SEC,
  advance,
  beginIteration,
  canReachSuccess,
  createRun,
  endWith,
  fingerprintVerdict,
  legacySpec,
  levelLabel,
  LEVEL0_TERMINALS,
  nextPromptText,
  noEvidenceVerdict,
  normalizeVerifierOutput,
  shouldReportTerminal,
  terminalSummary,
  truncateVerdictOutput,
  validateSpec,
  verdictFromCommand,
  type LoopRun,
  type LoopSpec,
  type LoopTerminal,
} from '../src/renderer/loopMachine.ts';

/* The UI-shape assertions that used to live here were removed with loop mode itself: the
   🔁 entry point, the goal/verifier dialog and the renderer-side driver no longer exist.
   `loopMachine.ts` stays because the flow subsystem still uses its verdict/terminal
   vocabulary, so what remains here tests the pure machine only.
   Scheduling, which replaced loop mode, is covered by tests/schedule*.test.ts. */

/** A verified spec with the bounds spelled out; `over` tweaks one thing at a time. */
function spec(over: Partial<LoopSpec> = {}): LoopSpec {
  return {
    prompt: '把失败的测试修好',
    goal: 'npm test 全绿',
    verifier: { level: 1, kind: 'command', command: 'npm test', timeoutSec: 300 },
    everySec: 0,
    stop: { maxIterations: 5, maxNoProgressRounds: 3, successStreak: 1, maxUnrunnableRounds: 3 },
    ...over,
  };
}

/** Run `rounds` through the machine, one verdict each, and report where it landed. */
function drive(s: LoopSpec, rounds: { exit: number | null; output: string }[]): { run: LoopRun; terminal: LoopTerminal | null } {
  let run = createRun('sid', s, 0);
  let terminal: LoopTerminal | null = null;
  // Mirrors the driver: a round that only re-checks does NOT call beginIteration
  // again, because nothing was re-sent. Without this the helper would charge a model
  // turn the real loop does not spend.
  let recheckOnly = false;
  for (const round of rounds) {
    if (!recheckOnly) {
      const begun = beginIteration(run, 0);
      run = begun.run;
      if (begun.terminal) return { run, terminal: begun.terminal };
    }
    const verdict = s.verifier.level === 0
      ? noEvidenceVerdict(0)
      : round.exit === null
        // `exit: null` stands for "the check could not run at all" (ssh blip,
        // ConnectTimeout, main's still-running guard).
        ? verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: round.output }, 0)
        : verdictFromCommand(1, { ran: true, exitCode: round.exit, output: round.output }, 0);
    const stepped = advance(run, verdict, 0);
    run = stepped.run;
    terminal = stepped.terminal;
    recheckOnly = stepped.retryVerifierOnly === true;
    if (terminal) break;
  }
  return { run, terminal };
}

describe('the spec is a declaration, separable from the run', () => {
  test('a run is JSON-serializable, so it holds no timer', () => {
    const run = createRun('sid', spec(), 1000);
    // The old type welded `timer` and `stopped` into the same object as the user's
    // text, which is why the spec could not be stored or reused at all.
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(run)));
    assert.deepEqual(JSON.parse(JSON.stringify(run)).spec, spec());
    assert.ok(!('timer' in run) && !('stopped' in run));
  });

  test('a round cap is mandatory, and no default is invented', () => {
    assert.deepEqual(validateSpec(spec({ stop: { maxIterations: 0, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 } })),
      ['必须填写轮数上限（≥ 1）']);
    // legacySpec exists to express the OLD entry point, not to restore its
    // unboundedness: the cap is a required argument.
    assert.equal(legacySpec('x', 10, 7).stop.maxIterations, 7);
    assert.equal(legacySpec('x', 10, 7).verifier.level, 0);
    assert.equal(validateSpec(legacySpec('x', 10, 0)).length, 1);
  });

  test('an unusable spec is rejected with reasons, not silently ignored', () => {
    const bad = validateSpec(spec({ verifier: { level: 1, kind: 'command', command: '  ', timeoutSec: 0 } }));
    assert.deepEqual(bad, ['校验命令为空', '校验超时必须 ≥ 1 秒']);
    assert.equal(validateSpec(spec()).length, 0);
  });
});

describe('the next round is a function of the last one', () => {
  test('round 1 sends the prompt as written', () => {
    const run = beginIteration(createRun('sid', spec(), 0), 0).run;
    assert.equal(nextPromptText(run), '把失败的测试修好');
  });

  test('later rounds carry the goal and the verifier output', () => {
    // THE point of the rewrite: without this the loop re-sends one sentence and
    // verification only adds a stop condition.
    let run = beginIteration(createRun('sid', spec(), 0), 0).run;
    run = advance(run, verdictFromCommand(1, { ran: true, exitCode: 1, output: '2 failing: auth, cache' }, 0), 0).run;
    run = beginIteration(run, 0).run;
    const text = nextPromptText(run);
    assert.match(text, /把失败的测试修好/);
    assert.match(text, /npm test 全绿/);
    assert.match(text, /未通过（exit=1）/);
    assert.match(text, /2 failing: auth, cache/);
    assert.match(text, /第 2 轮/);
  });

  test('at level 0 every round is byte-identical, and the text admits it', () => {
    const s = spec({ verifier: { level: 0, kind: 'none' } });
    let run = beginIteration(createRun('sid', s, 0), 0).run;
    run = advance(run, noEvidenceVerdict(0), 0).run;
    run = beginIteration(run, 0).run;
    assert.equal(nextPromptText(run), s.prompt);
  });

  test('the fed-back output is bounded, tail-first', () => {
    const long = 'A'.repeat(50) + 'THE FAILURES ARE HERE';
    const cut = truncateVerdictOutput(long, 30);
    assert.ok(cut.length < long.length);
    assert.match(cut, /THE FAILURES ARE HERE$/);
  });
});

describe('terminals: every ending has a recorded reason', () => {
  test('a pass on round 1 is no-op, not success', () => {
    // "Already satisfied" and "fixed by the loop" are different facts.
    assert.equal(drive(spec(), [{ exit: 0, output: 'ok' }]).terminal, 'no-op');
  });

  test('a pass after work is success', () => {
    const r = drive(spec(), [{ exit: 1, output: '2 failing' }, { exit: 0, output: 'ok' }]);
    assert.equal(r.terminal, 'success');
    assert.equal(r.run.iteration, 2);
  });

  test('successStreak must be met before success is claimed', () => {
    const s = spec({ stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 3, maxUnrunnableRounds: 3 } });
    const two = drive(s, [{ exit: 1, output: 'x' }, { exit: 0, output: 'ok' }, { exit: 0, output: 'ok' }]);
    assert.equal(two.terminal, null);
    const three = drive(s, [{ exit: 1, output: 'x' }, { exit: 0, output: 'a' }, { exit: 0, output: 'b' }, { exit: 0, output: 'c' }]);
    assert.equal(three.terminal, 'success');
  });

  test('a streak is not cut short by the stall rule', () => {
    // A passing verifier prints the same thing every time, so counting no-progress
    // on passes would end a 3-streak as "stalled" at threshold 2.
    const s = spec({ stop: { maxIterations: 6, maxNoProgressRounds: 2, successStreak: 3, maxUnrunnableRounds: 3 } });
    const r = drive(s, [
      { exit: 1, output: 'fail' },
      { exit: 0, output: 'identical' }, { exit: 0, output: 'identical' }, { exit: 0, output: 'identical' },
    ]);
    assert.equal(r.terminal, 'success');
  });

  test('repeated identical failures are stalled', () => {
    const r = drive(spec(), [
      { exit: 1, output: 'same' }, { exit: 1, output: 'same' },
      { exit: 1, output: 'same' }, { exit: 1, output: 'same' },
    ]);
    assert.equal(r.terminal, 'stalled');
    assert.equal(r.run.noProgressRounds, 3);
  });

  test('changing failures are progress, so the run is exhausted rather than stalled', () => {
    const r = drive(spec({ stop: { maxIterations: 3, maxNoProgressRounds: 2, successStreak: 1, maxUnrunnableRounds: 3 } }), [
      { exit: 1, output: '5 failing' }, { exit: 1, output: '3 failing' }, { exit: 1, output: '1 failing' },
    ]);
    assert.equal(r.terminal, 'exhausted');
  });

  test('a verifier that cannot RUN is not a failing round', () => {
    // Otherwise the loop grinds against a check that never had a chance to pass.
    const verdict = verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'ssh: connect failed' }, 0);
    assert.equal(verdict.unrunnable, true);
    const run = beginIteration(createRun('sid', spec(), 0), 0).run;
    const stepped = advance(run, verdict, 0);
    assert.match(stepped.run.lastVerdict!.output, /ssh: connect failed/);
    // ...and not the end of the loop either, until it keeps happening -- see the
    // dedicated suite below.
    assert.equal(stepped.terminal, null);
  });

  test('the budget is charged BEFORE the round is sent', () => {
    const run = { ...createRun('sid', spec({ stop: { maxIterations: 2, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 } }), 0), iteration: 2 };
    assert.equal(beginIteration(run, 0).terminal, 'exhausted');
    // ...and wall clock, when set.
    const timed = createRun('sid', spec({ stop: { maxIterations: 99, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3, maxWallClockSec: 60 } }), 0);
    assert.equal(beginIteration(timed, 59_000).terminal, null);
    assert.equal(beginIteration(timed, 60_000).terminal, 'exhausted');
  });

  test('the terminal is written into the run, and the first one wins', () => {
    const done = { ...createRun('sid', spec(), 0), terminal: 'success' as LoopTerminal };
    // endLoop calls this on a run the machine already settled; a caller's guess
    // ("aborted", because Stop happened to be pressed) must not overwrite it.
    assert.equal(endWith(done, 'aborted').terminal, 'success');
    assert.equal(endWith(createRun('sid', spec(), 0), 'aborted').terminal, 'aborted');
  });

  test('every terminal is reported except the deleted chat', () => {
    for (const t of ['success', 'no-op', 'blocked', 'stalled', 'exhausted', 'aborted', 'superseded', 'torn-down'] as LoopTerminal[]) {
      assert.equal(shouldReportTerminal(t), true, t);
    }
    assert.equal(shouldReportTerminal('discarded'), false);
  });

  test('the summary always states the level, so an unchecked run cannot read as a result', () => {
    const l0 = drive(spec({ verifier: { level: 0, kind: 'none' }, stop: { maxIterations: 1, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 } }), [{ exit: 0, output: '' }]);
    const text = terminalSummary(l0.run, 'exhausted', 65_000);
    assert.match(text, /L0 无校验/);
    assert.match(text, /没有任何校验运行过/);
    assert.match(text, /1 分 5 秒/);
    assert.match(terminalSummary(drive(spec(), [{ exit: 1, output: 'x' }, { exit: 0, output: 'y' }]).run, 'success', 0), /L1 确定性断言/);
  });
});

describe('level 0 cannot claim what it did not measure', () => {
  test('success, no-op and stalled are unreachable', () => {
    assert.equal(canReachSuccess(spec({ verifier: { level: 0, kind: 'none' } })), false);
    for (const forbidden of ['success', 'no-op', 'stalled'] as LoopTerminal[]) {
      assert.ok(!LEVEL0_TERMINALS.includes(forbidden), forbidden);
    }
    // Driven, not just declared: ten identical rounds end on the round cap.
    const s = spec({ verifier: { level: 0, kind: 'none' }, stop: { maxIterations: 4, maxNoProgressRounds: 2, successStreak: 1, maxUnrunnableRounds: 3 } });
    const r = drive(s, Array.from({ length: 4 }, () => ({ exit: 0, output: '' })));
    assert.equal(r.terminal, 'exhausted');
    assert.equal(r.run.noProgressRounds, 0);
    assert.equal(r.run.consecutivePasses, 0);
  });

  test('a level-0 round is "no evidence", never "the check failed"', () => {
    const v = noEvidenceVerdict(0);
    assert.equal(v.noEvidence, true);
    assert.equal(fingerprintVerdict(v), null);
  });
});

describe('progress fingerprinting is a proxy, and says so', () => {
  test('timestamps, durations, pids and home paths do not count as progress', () => {
    // Without normalization the stall rule never fires against any runner that
    // prints a duration -- every round looks like a change.
    const a = 'ran 42 tests in 1.83s at 2026-08-11T02:31:00Z (pid=1234) /Users/alice/p/x.ts';
    const b = 'ran 42 tests in 9.10s at 2026-08-11T09:04:11Z (pid=9999) /home/bob/p/x.ts';
    assert.equal(normalizeVerifierOutput(a), normalizeVerifierOutput(b));
    const fa = fingerprintVerdict(verdictFromCommand(1, { ran: true, exitCode: 1, output: a }, 0));
    assert.equal(fa, fingerprintVerdict(verdictFromCommand(1, { ran: true, exitCode: 1, output: b }, 0)));
  });

  test('the exit code is part of the fingerprint', () => {
    const same = 'output';
    assert.notEqual(
      fingerprintVerdict(verdictFromCommand(1, { ran: true, exitCode: 1, output: same }, 0)),
      fingerprintVerdict(verdictFromCommand(1, { ran: true, exitCode: 2, output: same }, 0)),
    );
  });
});

describe('a transient verifier outage does not kill the run', () => {
  const flake = { exit: null, output: 'ssh: connect to host 10.0.0.1 port 22: Operation timed out' };

  test('one flake is tolerated and the loop keeps going', () => {
    // The bug this fixes: `ran: false` -> unrunnable -> blocked, immediately. A
    // twenty-round loop ended because the network hiccupped once.
    const r = drive(spec(), [{ exit: 1, output: '3 failing' }, flake, { exit: 0, output: 'ok' }]);
    assert.equal(r.terminal, 'success');
    assert.equal(r.run.unrunnableRounds, 0);      // reset by the real verdict
  });

  test('a tolerated round is transparent: no progress, no failure, no broken streak', () => {
    const s = spec({ stop: { maxIterations: 8, maxNoProgressRounds: 2, successStreak: 3, maxUnrunnableRounds: 3 } });
    // Two genuine passes, a flake in between, then a third pass: the streak survives,
    // because the verifier did not disagree -- it never spoke.
    const r = drive(s, [
      { exit: 1, output: 'fail' },
      { exit: 0, output: 'a' }, flake, { exit: 0, output: 'b' }, { exit: 0, output: 'c' },
    ]);
    assert.equal(r.terminal, 'success');
    // ...and the same flake does not count as a stalled round either.
    const stalling = drive(spec({ stop: { maxIterations: 9, maxNoProgressRounds: 2, successStreak: 1, maxUnrunnableRounds: 5 } }), [
      { exit: 1, output: 'same' }, flake, { exit: 1, output: 'same' },
    ]);
    assert.equal(stalling.run.noProgressRounds, 1);   // not 2 -- the flake is skipped
    assert.equal(stalling.terminal, null);
  });

  test('a genuinely broken verifier still blocks, at the declared tolerance', () => {
    const r = drive(spec(), [flake, flake, flake]);
    assert.equal(r.terminal, 'blocked');
    assert.equal(r.run.unrunnableRounds, 3);
    // Tolerance of 1 = the old behaviour, still expressible.
    assert.equal(drive(spec({ stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 1 } }), [flake]).terminal, 'blocked');
  });

  test('an outage is bounded by the tolerance, not by the round budget', () => {
    // This used to assert the opposite ("tolerated rounds still cost iterations"), and
    // that was the bug: it made an SSH outage spend model turns. A blip now retries the
    // check on the same round, so the bound has to come from maxUnrunnableRounds --
    // which is the number that actually describes "the checker is broken".
    const r = drive(spec({ stop: { maxIterations: 2, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 10 } }), [flake, flake, flake]);
    assert.equal(r.terminal, null);           // 3 blips, tolerance 10: still going
    assert.equal(r.run.iteration, 1);         // ...on the first round, having spent one turn
    assert.equal(r.run.unrunnableRounds, 3);
    // With a tolerance it can actually reach, the outage ends the run as `blocked` --
    // never as `exhausted`, which would report a budget that was not spent.
    const bounded = drive(spec({ stop: { maxIterations: 2, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 2 } }), [flake, flake, flake]);
    assert.equal(bounded.terminal, 'blocked');
  });

  test('a flake retries the CHECK, not the model turn', () => {
    // `iterate()` used to be "send prompt -> verify", so a tolerated unrunnable round
    // restarted from the top and re-sent the prompt: one SSH hiccup cost a full model
    // turn, for a failure that has nothing to do with the model's output. Conductor's
    // rule is the reference -- retry lands on the step that failed, and the LLM is not
    // called again.
    const s = spec({ stop: { maxIterations: 5, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 } });
    let run = beginIteration(createRun('sid', s, 0), 0).run;
    const flaked = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'blip' }, 0), 0);
    assert.equal(flaked.terminal, null);
    // The machine has to SAY which of the two it wants, or the driver cannot tell a
    // retry apart from a fresh round.
    assert.equal(flaked.retryVerifierOnly, true);
    // ...and a real verdict does not ask for that.
    const real = advance(beginIteration(flaked.run, 0).run, verdictFromCommand(1, { ran: true, exitCode: 1, output: 'x' }, 0), 0);
    assert.notEqual(real.retryVerifierOnly, true);
  });

  test('a flake on the LAST round asks for a re-check instead of reporting exhausted', () => {
    // The sharp edge of the old design: on the final round, `outOfRounds()` turned a
    // network blip into "预算用尽" -- a budget report for a round that was never spent,
    // and worse, the run ends without ever learning whether the work passed.
    const s = spec({ stop: { maxIterations: 1, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 } });
    const run = beginIteration(createRun('sid', s, 0), 0).run;
    assert.equal(run.iteration, 1);                       // the cap is now reached
    const stepped = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'blip' }, 0), 0);
    assert.equal(stepped.terminal, null);
    assert.equal(stepped.retryVerifierOnly, true);
    // And re-checking that same round can still succeed on its own merits.
    assert.equal(advance(stepped.run, verdictFromCommand(1, { ran: true, exitCode: 0, output: 'ok' }, 0), 0).terminal, 'no-op');
  });

  test('a re-checked round does not consume the round budget', () => {
    // The round cap is a budget for MODEL TURNS. Charging a network blip against it
    // means an outage eats the work the user paid for; the flake is bounded by
    // maxUnrunnableRounds, which is the limit that actually describes it.
    const s = spec({ stop: { maxIterations: 2, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 4 } });
    let run = beginIteration(createRun('sid', s, 0), 0).run;
    assert.equal(run.iteration, 1);
    run = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'blip' }, 0), 0).run;
    // Still round 1: nothing was re-sent, so nothing was re-charged.
    assert.equal(run.iteration, 1);
    assert.equal(run.unrunnableRounds, 1);
    // Two more blips, then the checker recovers -- and the loop still has its second
    // round to spend on actual work.
    run = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'blip' }, 0), 0).run;
    const recovered = advance(run, verdictFromCommand(1, { ran: true, exitCode: 1, output: 'real' }, 0), 0);
    assert.equal(recovered.terminal, null);
    assert.equal(recovered.run.iteration, 1);
    assert.equal(recovered.run.unrunnableRounds, 0);
    assert.equal(beginIteration(recovered.run, 0).terminal, null);
  });

  test('the tolerance still bounds an outage, without a round cap to lean on', () => {
    // Now that blips do not consume iterations, maxUnrunnableRounds is the ONLY thing
    // standing between a permanent outage and an infinite retry loop.
    const s = spec({ stop: { maxIterations: 99, maxNoProgressRounds: 0, successStreak: 1, maxUnrunnableRounds: 3 } });
    let run = beginIteration(createRun('sid', s, 0), 0).run;
    let terminal: LoopTerminal | null = null;
    for (let i = 0; i < 3; i++) {
      const stepped = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'down' }, 0), 0);
      run = stepped.run;
      terminal = stepped.terminal;
    }
    assert.equal(terminal, 'blocked');
    assert.equal(run.iteration, 1);
  });

  test('a tolerated flake does not wipe the feedback the next round carries', () => {
    // The whole value of this module is that round N's result changes round N+1's
    // action. Tolerating a flake is supposed to PRESERVE progress, so rendering the
    // ssh error as "上一轮校验结果" throws away the one thing being tolerated for.
    // Same shape as Conductor's `${think.output.draft}` trap: when accumulated state
    // has to cross a mid-run failure, refer to the last COMMITTED output explicitly.
    let run = beginIteration(createRun('sid', spec(), 0), 0).run;
    run = advance(run, verdictFromCommand(1, { ran: true, exitCode: 1, output: '3 failing: auth, cache, db' }, 0), 0).run;
    run = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'ssh: connect failed' }, 0), 0).run;
    run = beginIteration(run, 0).run;
    const text = nextPromptText(run);
    assert.match(text, /3 failing: auth, cache, db/);
    assert.match(text, /未通过（exit=1）/);
    assert.doesNotMatch(text, /无法执行/);
    assert.doesNotMatch(text, /ssh: connect failed/);
  });

  test('the last measured verdict survives a flake, while lastVerdict stays truthful', () => {
    // Two different questions -- "what did the checker last SAY" and "what happened
    // on the most recent attempt" -- so they are two fields. Collapsing them is what
    // produced the bug above.
    let run = beginIteration(createRun('sid', spec(), 0), 0).run;
    run = advance(run, verdictFromCommand(1, { ran: true, exitCode: 1, output: 'real failure' }, 0), 0).run;
    run = advance(run, verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'blip' }, 0), 0).run;
    assert.equal(run.lastVerdict!.unrunnable, true);
    assert.equal(run.lastMeasuredVerdict!.output, 'real failure');
    assert.equal(run.lastMeasuredVerdict!.unrunnable, undefined);
  });

  test('an SSH error is never mistaken for verifier output', () => {
    // Hashing it would let a repeated connection failure register as progress or as a
    // stall, both of which are claims about work that was never checked.
    assert.equal(fingerprintVerdict(verdictFromCommand(1, { ran: false, exitCode: null, output: '', error: 'x' }, 0)), null);
  });

  test('the summary reports how many attempts could not run', () => {
    const r = drive(spec(), [flake, flake, flake]);
    assert.match(terminalSummary(r.run, 'blocked', 0), /连续 3 轮校验无法执行/);
  });



});

describe('the level a loop claims is chosen, not assumed', () => {
  test('all three command levels survive into the spec', () => {
    for (const level of [1, 2, 3] as const) {
      const s = spec({ verifier: { level, kind: 'command', command: 'x', timeoutSec: 10 } });
      assert.equal(validateSpec(s).length, 0);
      assert.equal(s.verifier.level, level);
      // The badge must name the CLAIM, not just the number: it sits next to the
      // picker, so "L3 命令校验" would say less than the option the user chose.
      assert.match(levelLabel(level), new RegExp(`^L${level} `));
      assert.equal(levelLabel(level), { 1: 'L1 确定性断言', 2: 'L2 规则检查', 3: 'L3 延迟真值' }[level]);
    }
  });



});
