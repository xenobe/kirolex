import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { launchLogName, logsToPrune, LAUNCH_LOGS_KEPT } from '../src/main/logger.ts';

/**
 * ONE LOG FILE PER LAUNCH — 「日志你有没有按不同启动分文件，这个功能要加一下」.
 *
 * Everything used to append to a single `main.log`, rotated only when it passed 2 MB. Reading it meant
 * finding where the last start was, and the boundary that matters most when something breaks is exactly
 * "this run versus the previous one" — a restart was the fix for three separate problems this week.
 *
 * The name sorts chronologically as a string, which is what makes pruning a sort rather than a stat call,
 * and pruning is not optional: a file per launch on a machine that restarts the app twenty times a day is
 * the disk problem this project already has enough of.
 */
describe('a launch gets its own log file', () => {
  test('the name carries the launch time, sorted-friendly', () => {
    // Built from LOCAL components on purpose: the stamp is in the reader's own clock, so asserting a
    // UTC instant would only pass in one timezone.
    const at = new Date(2026, 7, 14, 9, 15, 30).getTime();
    assert.equal(launchLogName(at, 0), 'main-20260814-091530.log');
  });

  test('two launches in the same second do not share a file', () => {
    const at = new Date(2026, 7, 14, 9, 15, 30).getTime();
    assert.notEqual(launchLogName(at, 0), launchLogName(at, 1));
  });

  test('names sort in launch order as plain strings', () => {
    const early = launchLogName(new Date('2026-08-14T09:15:30Z').getTime(), 0);
    const late = launchLogName(new Date('2026-08-14T11:02:01Z').getTime(), 0);
    const nextDay = launchLogName(new Date('2026-08-15T00:00:00Z').getTime(), 0);
    assert.deepEqual([late, nextDay, early].sort(), [early, late, nextDay]);
  });
});

describe('old launches are pruned, because one file per launch adds up', () => {
  const names = (n: number) => Array.from({ length: n }, (_, i) =>
    launchLogName(new Date(`2026-08-${String(i + 1).padStart(2, '0')}T09:00:00Z`).getTime(), 0));

  test('the newest N are kept and the rest named for deletion', () => {
    const all = names(15);
    const gone = logsToPrune(all, 10);
    assert.equal(gone.length, 5);
    assert.deepEqual(gone, all.slice(0, 5), '删的是最旧的那几个');
  });

  test('under the limit nothing is deleted', () => {
    assert.deepEqual(logsToPrune(names(3), 10), []);
  });

  test('别人的文件不动；**旧命名的自己的**要删', () => {
    /*
      `dev-hot.log` 是 dev supervisor 写的，生命周期归它管（而且只有 92K）。
      `main.log` / `main.log.1` 曾经也被划在"不是我们的"里 —— 那是错的：它们是**这个 logger
      上一套命名方案**写的，换方案时没人管，于是永远清不掉。实测 912K + 2.0MB = 日志总量的 85%，
      内容是一个多月前的代码路径。判据见 `LEGACY_LOG`。
    */
    const mixed = [...names(12), 'dev-hot.log', 'main.log', 'main.log.1'];
    const gone = logsToPrune(mixed, 10);
    assert.ok(!gone.includes('dev-hot.log'), 'dev-hot.log 不是我们的');
    assert.ok(gone.includes('main.log') && gone.includes('main.log.1'), '旧命名的要清掉');
  });

  test('the default kept count is a real number, not a guess at call sites', () => {
    assert.ok(LAUNCH_LOGS_KEPT >= 5);
    assert.deepEqual(logsToPrune(names(LAUNCH_LOGS_KEPT), LAUNCH_LOGS_KEPT), []);
  });
});

/*
 * 「你看下 kirolex 是不是堆积了很多陈旧日志，今天之前的日志实际上已经没啥用了」。
 *
 * 日志本身早就有保留策略（一次启动一份、留 10 份），但**旧命名方案的两个文件永远清不掉**：
 * 换成 `main-<时间戳>.log` 之前是一个不断长的 `main.log` + 满 2MB 轮转的 `main.log.1`，
 * 而 `LAUNCH_LOG` 那条正则匹配不上它们。实测 912K + 2.0MB = 日志总量的 85%，
 * 记的是一个多月前那些早就不成立的代码路径。
 */
describe('旧命名的日志也要清掉', () => {
  test('`main.log` / `main.log.N` 一律删 —— 它们不可能是这次启动的', () => {
    const gone = logsToPrune(['main.log', 'main.log.1', 'main.log.12', 'main-20260911-111224.log'], 10);
    assert.deepEqual(gone.sort(), ['main.log', 'main.log.1', 'main.log.12']);
  });

  test('`dev-hot.log` 不动 —— 那是别人写的，不是这个 logger 的东西', () => {
    assert.deepEqual(logsToPrune(['dev-hot.log', 'main-20260911-111224.log'], 10), []);
  });

  test('两类同时存在时都处理：这套的留最近 N，旧的全删', () => {
    const names = Array.from({ length: 12 }, (_, i) => `main-2026091${i % 10}-${String(100000 + i)}.log`).sort();
    const gone = logsToPrune([...names, 'main.log'], 10);
    /* 12 份里删掉最老的 2 份，外加那个遗留的 */
    assert.equal(gone.length, 3);
    assert.ok(gone.includes('main.log'));
  });
});
