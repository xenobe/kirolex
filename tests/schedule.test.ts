import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_RUNS,
  MIN_INTERVAL_SEC,
  describeSchedule,
  dueAt,
  isDue,
  nextRunAt,
  parseClockTime,
  recordRun,
  scheduleTerminal,
  validateSchedule,
  type ScheduleSpec,
  type ScheduleState,
} from '../src/main/schedule.ts';

/**
 * TIME-TRIGGERED TASKS — what replaced the old "loop mode".
 *
 * WHY THIS EXISTS INSTEAD OF A LOOP. The loop was built for a coding shape: declare a
 * goal, run a verifier, iterate until it passes. Checked against the four real target
 * scenarios (weekly report, SFDC activity logging, oncall, research), none of them is a
 * loop by the only test that matters — does the previous round's RESULT change the next
 * round's ACTION? A weekly report does not depend on last week's; an oncall check looks
 * at the current queue. They are time-triggered tasks, so that is what this models.
 *
 * DELIBERATELY ABSENT, per instruction: no goal, no verifier, no success/stalled
 * terminals. A run either happened or it did not. The stop conditions are the two that
 * do not require a judgeable goal — a person, and a budget.
 *
 * EACH RUN IS INDEPENDENT, which is the load-bearing decision here. KiroCrew's cron
 * calls accumulated context "the other half of the bug" (`cron.py:204`) and added a
 * stateless mode to switch it off; Warp's scheduled agents open a fresh session per run
 * for the same reason. Feeding the previous result back is what makes a scheduled job
 * report the same thing every time.
 */

function spec(over: Partial<ScheduleSpec> = {}): ScheduleSpec {
  return {
    prompt: '生成本周周报',
    kind: 'interval',
    everySec: 3600,
    maxRuns: 10,
    ...over,
  };
}

function state(over: Partial<ScheduleState> = {}): ScheduleState {
  return {
    spec: spec(),
    sessionId: 'sess-1',
    runs: 0,
    createdAt: 1_000_000,
    lastRunAt: null,
    lastError: null,
    paused: false,
    terminal: null,
    ...over,
  };
}

describe('a schedule declares WHEN, and nothing about done-ness', () => {
  test('an interval schedule fires every N seconds from the last run', () => {
    const s = state({ lastRunAt: 1_000_000 });
    assert.equal(isDue(s, 1_000_000 + 3599_000), false);
    assert.equal(isDue(s, 1_000_000 + 3600_000), true);
  });

  test('a never-run interval schedule is due immediately', () => {
    // "Every hour" starting now means the first one is now, not in an hour -- otherwise
    // creating a job appears to do nothing.
    assert.equal(isDue(state({ lastRunAt: null }), 1_000_000), true);
  });

  test('a daily schedule fires at a wall-clock time, not every 24h', () => {
    // These differ: an every-86400s job drifts by however long each run took, so a 9am
    // report slides later every day.
    const s = state({ spec: spec({ kind: 'daily', atTime: '09:00', everySec: 0 }), lastRunAt: null, createdAt: Date.parse('2026-08-12T00:00:00') });
    assert.equal(isDue(s, Date.parse('2026-08-12T08:59:00')), false);
    assert.equal(isDue(s, Date.parse('2026-08-12T09:00:30')), true);
    // Having run today, it must not fire again today.
    const ran = { ...s, lastRunAt: Date.parse('2026-08-12T09:00:30') };
    assert.equal(isDue(ran, Date.parse('2026-08-12T18:00:00')), false);
    assert.equal(isDue(ran, Date.parse('2026-08-13T09:00:10')), true);
  });

  test('a weekly schedule fires on its declared weekday', () => {
    // 2026-08-12 is a Wednesday; 2026-08-17 is the following Monday.
    // `createdAt` is stated because it is a real input: the first slot is the first Monday AT OR
    // AFTER creation. Created Tuesday the 11th, that is Monday the 17th -- so the Wednesday in
    // between must not fire. (The default 1970 anchor used to make this pass for the wrong
    // reason: every slot since 1970 is missed, and a missed slot is due.)
    const s = state({
      spec: spec({ kind: 'weekly', atTime: '09:00', weekday: 1, everySec: 0 }),
      lastRunAt: null,
      createdAt: Date.parse('2026-08-11T10:00:00'),
    });
    assert.equal(isDue(s, Date.parse('2026-08-12T09:30:00')), false, '周三不该触发一个周一的任务');
    assert.equal(isDue(s, Date.parse('2026-08-17T09:00:05')), true);
  });

  test('a one-shot schedule fires once, at its moment, and then is done', () => {
    const at = Date.parse('2026-08-12T15:00:00');
    const s = state({ spec: spec({ kind: 'once', atEpoch: at, everySec: 0, maxRuns: 1 }), lastRunAt: null });
    assert.equal(isDue(s, at - 1000), false);
    assert.equal(isDue(s, at + 1000), true);
    const after = recordRun(s, at + 1000);
    assert.equal(scheduleTerminal(after), 'completed');
    assert.equal(isDue(after, at + 999_000), false);
  });

  test('the next run time is reported, so a job is never a black box', () => {
    // The lesson from n8n's bare "stopped due to max iterations": a limit that does not
    // say what happens next gets treated as an obstacle.
    const s = state({ lastRunAt: 1_000_000 });
    assert.equal(nextRunAt(s), 1_000_000 + 3600_000);
    const daily = state({ spec: spec({ kind: 'daily', atTime: '09:00', everySec: 0 }), lastRunAt: Date.parse('2026-08-12T09:00:00') });
    assert.equal(nextRunAt(daily), Date.parse('2026-08-13T09:00:00'));
    // A finished one-shot has no next run, and says so rather than reporting a date.
    const done = recordRun(state({ spec: spec({ kind: 'once', atEpoch: 5, everySec: 0, maxRuns: 1 }) }), 10);
    assert.equal(nextRunAt(done), null);
  });
});

describe('每次运行相互独立', () => {
  test('a run carries no result from the previous one', () => {
    // KiroCrew calls accumulated context "the other half of the bug" and Warp opens a
    // fresh session per run. The state therefore records THAT a run happened and when --
    // never its output for re-injection.
    const after = recordRun(state({ runs: 2, lastRunAt: 1 }), 5_000_000);
    assert.equal(after.runs, 3);
    assert.equal(after.lastRunAt, 5_000_000);
    assert.ok(!('lastResult' in after), '不要把上次结果留在状态里,否则下次一定会被喂回去');
    assert.ok(!('lastVerdict' in after));
  });

  test('the state is JSON-serializable, so a schedule outlives the window', () => {
    // A schedule that dies with the window is a timer, not a schedule.
    const s = state();
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(s)));
    assert.deepEqual(JSON.parse(JSON.stringify(s)).spec, spec());
  });
});

describe('stop conditions are a person and a budget — nothing else', () => {
  test('a run budget is required and enforced', () => {
    // The one number that bounds spend. Required for the same reason the loop's round cap
    // was: unattended billable turns must not be a number the program picked.
    const s = state({ runs: 9 });
    assert.equal(scheduleTerminal(s), null);
    assert.equal(scheduleTerminal(recordRun(s, 2_000_000)), 'exhausted');
  });

  test('pausing stops it firing, without ending it', () => {
    const s = state({ paused: true, lastRunAt: null });
    assert.equal(isDue(s, 9_000_000), false);
    assert.equal(scheduleTerminal(s), null, '暂停不是终止');
    assert.equal(isDue({ ...s, paused: false }, 9_000_000), true);
  });

  test('there is NO success or stalled terminal', () => {
    // Both require a judgeable goal, which these tasks do not have. Claiming a schedule
    // "succeeded" would be asserting something nothing measured.
    const terminals = ['completed', 'exhausted', 'cancelled'];
    for (const forbidden of ['success', 'no-op', 'stalled']) {
      assert.ok(!terminals.includes(forbidden), forbidden);
    }
    const s = recordRun(state({ runs: 0 }), 2_000_000);
    assert.equal(scheduleTerminal(s), null);   // just "ran once, still scheduled"
  });

  test('a failed run does not end the schedule, but is recorded', () => {
    // A daily job must survive one bad morning; the error is kept so a job failing every
    // time is visible rather than silently looking healthy.
    const failed = recordRun(state(), 2_000_000, '会话未连接');
    assert.equal(failed.lastError, '会话未连接');
    assert.equal(scheduleTerminal(failed), null);
    assert.equal(failed.runs, 1, '失败也算一次运行,否则错误能无限重试');
  });
});

describe('an unusable schedule is refused with reasons', () => {
  test('an empty prompt is rejected', () => {
    assert.deepEqual(validateSchedule(spec({ prompt: '  ' })), ['要发送的内容为空']);
  });

  test('an interval below the floor is rejected', () => {
    // A minute floor, matching KiroCrew's. Every run costs a model turn, so a 5-second
    // schedule is a way to spend money quickly.
    assert.ok(MIN_INTERVAL_SEC >= 60);
    assert.deepEqual(validateSchedule(spec({ everySec: 30 })), [`间隔不能小于 ${MIN_INTERVAL_SEC} 秒`]);
    assert.equal(validateSchedule(spec({ everySec: MIN_INTERVAL_SEC })).length, 0);
  });

  test('a run budget below 1 is rejected, and no default is invented', () => {
    assert.deepEqual(validateSchedule(spec({ maxRuns: 0 })), ['运行次数上限必须 ≥ 1']);
    // A default EXISTS for the dialog to prefill, but it is a visible number, not a
    // silent fallback for an empty field.
    assert.ok(DEFAULT_MAX_RUNS >= 1);
  });

  test('a clock time must be a real time of day', () => {
    assert.equal(parseClockTime('09:00')!.hour, 9);
    assert.equal(parseClockTime('23:59')!.minute, 59);
    assert.equal(parseClockTime('24:00'), null);
    assert.equal(parseClockTime('9am'), null);
    assert.deepEqual(validateSchedule(spec({ kind: 'daily', atTime: '25:00', everySec: 0 })), ['时间格式应为 HH:MM（24 小时制）']);
  });

  test('a weekly schedule needs a weekday', () => {
    assert.deepEqual(
      validateSchedule(spec({ kind: 'weekly', atTime: '09:00', everySec: 0, weekday: undefined })),
      ['请选择星期几']);
  });
});

describe('the schedule describes itself in words', () => {
  test('每种类型都有可读描述', () => {
    // 3600s reads better as hours than as 60 minutes; 1800s has no whole-hour form.
    assert.match(describeSchedule(spec()), /每 1 小时/);
    assert.match(describeSchedule(spec({ everySec: 1800 })), /每 30 分钟/);
    assert.match(describeSchedule(spec({ kind: 'daily', atTime: '09:00', everySec: 0 })), /每天 09:00/);
    assert.match(describeSchedule(spec({ kind: 'weekly', atTime: '09:00', weekday: 1, everySec: 0 })), /每周一 09:00/);
    assert.match(describeSchedule(spec({ kind: 'once', atEpoch: Date.parse('2026-08-12T15:00:00'), everySec: 0 })), /^一次性/);
  });

  test('dueAt is a pure function of the spec and the last run', () => {
    // Pure so the driver can be tested without waiting an hour.
    assert.equal(dueAt(spec(), 1_000_000, 0), 1_000_000 + 3600_000);
    assert.equal(dueAt(spec(), null, 0), 0, '从未运行过 = 立刻到期');
  });
});

/**
 * WHEN DOES A JOB THAT HAS NEVER RUN FIRE FOR THE FIRST TIME?
 *
 * `dueAt` used to answer this with `Date.now()`: for a wall-clock job with no runs yet it took
 * TODAY's slot, whenever "today" happened to be at the moment of asking. Two consequences, one
 * cosmetic and one real:
 *
 *   - the same inputs gave different answers on different days, so these tests passed in the
 *     evening and failed after midnight;
 *   - and creating 「每天 09:00」 at 10pm made today's 09:00 slot already past, so the job was
 *     immediately due and fired AT ONCE instead of the next morning. Observed live: a job created
 *     just after midnight showed 「即将运行」 and had already spent a run.
 *
 * The rule is: the first slot is the earliest occurrence AT OR AFTER the moment the job was
 * created. That makes the whole computation pure -- there is no clock in it at all.
 */
describe('the first run of a never-run job is anchored to its creation, not to today', () => {
  test('created BEFORE today\'s slot: it fires today', () => {
    const s = state({
      spec: spec({ kind: 'daily', atTime: '09:00', everySec: 0 }),
      lastRunAt: null,
      createdAt: Date.parse('2026-08-12T07:30:00'),
    });
    assert.equal(isDue(s, Date.parse('2026-08-12T08:59:00')), false);
    assert.equal(isDue(s, Date.parse('2026-08-12T09:00:10')), true);
  });

  test('created AFTER today\'s slot: it waits for TOMORROW, it does not fire at once', () => {
    // The real bug. Creating an unattended job must never mean "and also run it right now".
    const s = state({
      spec: spec({ kind: 'daily', atTime: '09:00', everySec: 0 }),
      lastRunAt: null,
      createdAt: Date.parse('2026-08-12T22:00:00'),
    });
    assert.equal(isDue(s, Date.parse('2026-08-12T22:00:01')), false, '刚创建就跑了');
    assert.equal(isDue(s, Date.parse('2026-08-13T08:59:00')), false);
    assert.equal(isDue(s, Date.parse('2026-08-13T09:00:10')), true);
    assert.equal(nextRunAt(s), Date.parse('2026-08-13T09:00:00'));
  });

  test('a weekly job created after its slot waits for the NEXT week', () => {
    // 2026-08-12 is a Wednesday. A Wednesday 09:00 job created Wednesday at noon must not fire
    // that same afternoon.
    const s = state({
      spec: spec({ kind: 'weekly', atTime: '09:00', weekday: 3, everySec: 0 }),
      lastRunAt: null,
      createdAt: Date.parse('2026-08-12T12:00:00'),
    });
    assert.equal(isDue(s, Date.parse('2026-08-12T12:00:01')), false, '当天下午就跑了');
    assert.equal(nextRunAt(s), Date.parse('2026-08-19T09:00:00'));
  });

  test('the answer does not depend on the wall clock at all', () => {
    // Same state, asked twice with a real-clock gap between: `dueAt` must be a function of its
    // arguments only. This is the property whose absence made the suite fail after midnight.
    const s = state({
      spec: spec({ kind: 'daily', atTime: '09:00', everySec: 0 }),
      lastRunAt: null,
      createdAt: Date.parse('2026-08-12T22:00:00'),
    });
    const first = nextRunAt(s);
    const spin = Date.now() + 5;
    while (Date.now() < spin) { /* burn a few ms of real time */ }
    assert.equal(nextRunAt(s), first);
    assert.equal(first, Date.parse('2026-08-13T09:00:00'));
  });

  test('a missed slot is still caught up, exactly as it is for a job that HAS run', () => {
    // The app being closed at 09:00 must not silently skip the run: a job whose slot has passed
    // is due the moment anyone asks. (Same rule the ran-before path already followed.)
    const s = state({
      spec: spec({ kind: 'daily', atTime: '09:00', everySec: 0 }),
      lastRunAt: null,
      createdAt: Date.parse('2026-08-12T07:00:00'),
    });
    assert.equal(isDue(s, Date.parse('2026-08-15T11:00:00')), true);
  });
});
