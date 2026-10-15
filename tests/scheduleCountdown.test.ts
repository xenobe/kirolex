import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { countdownText, sessionScheduleSummary, type ScheduleView } from '../src/renderer/scheduleView.ts';

/**
 * "WHEN DOES THIS FIRE NEXT" — the two places a scheduled chat has to say so.
 *
 * A schedule the user cannot see is indistinguishable from one that silently stopped.
 * Both surfaces are computed here rather than in JSX so the awkward cases are pinned:
 * a job that is due right now, one that is paused, one that is finished, and several jobs
 * on a single chat.
 *
 * The countdown is deliberately COARSE (minutes, not seconds, past a minute). A
 * per-second tick on a Monday-morning job re-renders the sidebar 86,400 times to convey
 * nothing, and the surrounding rows are memoised precisely to avoid that kind of churn.
 */

function view(over: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id: 'sched_1',
    sessionId: 'sess-1',
    prompt: '生成本周周报',
    describe: '每周一 09:00',
    runs: 0,
    maxRuns: 20,
    paused: false,
    terminal: null,
    lastRunAt: null,
    lastError: null,
    nextRunAt: 1_000_000 + 3600_000,
    ...over,
  };
}

describe('the countdown reads as a duration, not a timestamp', () => {
  test('minutes and hours are rounded to something a person can act on', () => {
    assert.equal(countdownText(1_000_000 + 45_000, 1_000_000), '45 秒后');
    assert.equal(countdownText(1_000_000 + 90_000, 1_000_000), '2 分钟后');
    assert.equal(countdownText(1_000_000 + 3600_000, 1_000_000), '1 小时 0 分后');
    assert.equal(countdownText(1_000_000 + 5400_000, 1_000_000), '1 小时 30 分后');
  });

  test('anything beyond a day is a date, because "37 小时后" is not useful', () => {
    const now = Date.parse('2026-08-12T10:00:00');
    const text = countdownText(Date.parse('2026-08-17T09:00:00'), now);
    assert.doesNotMatch(text, /秒后|分钟后/);
    assert.match(text, /\d/);
  });

  test('a job due now says so instead of showing a negative number', () => {
    // The ticker runs every 20s, so "due" and "started" are not the same instant. A
    // countdown that goes negative looks broken.
    assert.equal(countdownText(1_000_000, 1_000_000), '即将运行');
    assert.equal(countdownText(1_000_000 - 5000, 1_000_000), '即将运行');
  });

  test('no next run is stated as such, never as a fake time', () => {
    assert.equal(countdownText(null, 1_000_000), null);
  });
});

describe('one chat, one line — even with several jobs', () => {
  test('a single job reports its schedule and its countdown', () => {
    const summary = sessionScheduleSummary([view()], 1_000_000);
    assert.equal(summary!.count, 1);
    assert.match(summary!.text, /每周一 09:00/);
    assert.match(summary!.text, /1 小时 0 分后/);
    assert.equal(summary!.paused, false);
  });

  test('the SOONEST job is the one shown', () => {
    // Several jobs can target one chat, so the line has to pick the next thing that will
    // actually happen rather than whichever was created first.
    const summary = sessionScheduleSummary([
      view({ id: 'a', describe: '每天 18:00', nextRunAt: 1_000_000 + 7200_000 }),
      view({ id: 'b', describe: '每天 09:00', nextRunAt: 1_000_000 + 600_000 }),
    ], 1_000_000);
    assert.match(summary!.text, /每天 09:00/);
    assert.equal(summary!.count, 2);
  });

  test('a paused job is not counted as upcoming, and is said to be paused', () => {
    // Otherwise the banner promises a run that will never come.
    const summary = sessionScheduleSummary([view({ paused: true })], 1_000_000);
    assert.equal(summary!.paused, true);
    assert.match(summary!.text, /已暂停/);
    assert.doesNotMatch(summary!.text, /小时|分钟/);
  });

  test('a finished job is not shown as pending', () => {
    // `terminal` set, or the budget spent -- either way there is no next run.
    assert.equal(sessionScheduleSummary([view({ terminal: 'exhausted', nextRunAt: null })], 1_000_000), null);
    assert.equal(sessionScheduleSummary([view({ runs: 20, maxRuns: 20, nextRunAt: null })], 1_000_000), null);
  });

  test('a chat with no jobs gets no banner at all', () => {
    assert.equal(sessionScheduleSummary([], 1_000_000), null);
  });

  test('a live job alongside a finished one still shows the live one', () => {
    const summary = sessionScheduleSummary([
      view({ id: 'old', terminal: 'exhausted', nextRunAt: null }),
      view({ id: 'live', describe: '每天 09:00', nextRunAt: 1_000_000 + 60_000 }),
    ], 1_000_000);
    assert.match(summary!.text, /每天 09:00/);
    assert.equal(summary!.count, 1, '已结束的任务不该算进"还有几个"');
  });

  test('the run budget is part of the line, so a job about to expire is visible', () => {
    const summary = sessionScheduleSummary([view({ runs: 19, maxRuns: 20 })], 1_000_000);
    assert.match(summary!.text, /19\/20/);
  });

  test('a failing job surfaces its error rather than looking healthy', () => {
    // A daily job that has errored every morning for a week must not read the same as one
    // that has been working.
    const summary = sessionScheduleSummary([view({ lastError: '会话未连接', runs: 3 })], 1_000_000);
    assert.match(summary!.text, /会话未连接/);
    assert.equal(summary!.hasError, true);
  });
});
