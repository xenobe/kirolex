import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { idleProjects, sessionsToWarm, warmProject, warmedProject, projectsToCollapse, IDLE_DAYS } from '../src/renderer/projectActivity.ts';

/**
 * A PROJECT NOBODY HAS TOUCHED FOR A WEEK COSTS NOTHING AT STARTUP.
 *
 * 「如果7天project没有活动就自动折叠，不用每次启动都预热了，等用户点开project再创建连接」.
 *
 * Every launch spawned an executor for up to `cap - 1` sessions — a kiro-cli process of roughly 0.4 GB
 * each — ordered only so the last-used chat stayed inside the cut. On a machine with twenty sessions
 * across old projects that is most of a RAM budget spent on conversations nobody is going to open.
 *
 * `now` is a PARAMETER. A module that reads the clock itself can only be tested by waiting a week, which
 * is the same rule that already bit `dueAt` (a daily 09:00 job fired at 09:38 because it read Date.now).
 *
 * The activity field is `timestamp` and is REQUIRED. Two near-miss names got this wrong without failing to
 * compile: `project` (read undefined → every chat looked ungrouped) and an optional `updatedAt` (read 0 →
 * every project looked idle, so nothing would have been warmed at all).
 */
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 7, 14, 9, 0, 0).getTime();
const s = (id: string, projectId: string | undefined, daysAgo: number, extra: Record<string, unknown> = {}) =>
  ({ id, projectId, timestamp: NOW - daysAgo * DAY, ...extra });

describe('which projects count as idle', () => {
  test('a project whose newest chat is older than a week is idle', () => {
    const sessions = [s('a', 'W31 周报', 9), s('b', 'W31 周报', 12), s('c', '在做的', 1)];
    assert.deepEqual(idleProjects(sessions, NOW), ['W31 周报']);
  });

  test('one recent chat keeps the whole project awake', () => {
    // Activity is the project's, not the session's: an old chat in a live project is still context.
    const sessions = [s('a', 'P', 30), s('b', 'P', 2)];
    assert.deepEqual(idleProjects(sessions, NOW), []);
  });

  test('exactly at the boundary is not yet idle', () => {
    assert.deepEqual(idleProjects([s('a', 'P', IDLE_DAYS)], NOW), []);
    assert.deepEqual(idleProjects([s('a', 'P', IDLE_DAYS + 0.1)], NOW), ['P']);
  });

  test('ungrouped chats are not a project and are never reported as one', () => {
    assert.deepEqual(idleProjects([s('a', undefined, 40), s('b', '', 40)], NOW), []);
  });
});

describe('what gets an executor at startup', () => {
  const live = [s('l1', '在做的', 0), s('l2', '在做的', 1)];
  const old = [s('o1', '去年的', 40), s('o2', '去年的', 44)];

  test('sessions in idle projects are not warmed', () => {
    const warm = sessionsToWarm([...live, ...old], { now: NOW, limit: 10 });
    assert.deepEqual(warm.sort(), ['l1', 'l2']);
  });

  test('the chat being landed on is warmed even if its project is idle', () => {
    // It is the one session guaranteed to be looked at, so refusing it would break the opening screen.
    const warm = sessionsToWarm([...live, ...old], { now: NOW, limit: 10, keepId: 'o1' });
    assert.ok(warm.includes('o1'));
  });

  test('the cap still applies, and the kept chat survives it', () => {
    const many = Array.from({ length: 12 }, (_, i) => s(`m${i}`, '在做的', 0));
    const warm = sessionsToWarm([...many, ...old], { now: NOW, limit: 3, keepId: 'm11' });
    assert.equal(warm.length, 3);
    assert.ok(warm.includes('m11'));
  });

  test('pending and archived sessions are never warmed', () => {
    const junk = [s('pending_x', '在做的', 0), s('arch', '在做的', 0, { archived: true })];
    const warm = sessionsToWarm([...live, ...junk], { now: NOW, limit: 10 });
    assert.deepEqual(warm.sort(), ['l1', 'l2']);
  });

  test('ungrouped chats are ALWAYS warmed — Unassigned is not a project you open', () => {
    // Judged by their own age they mostly fell outside a week, so the whole of Unassigned went cold —
    // 「为什么unassigned不预热了」. There is no click at which their cost could land instead.
    const warm = sessionsToWarm([s('u-new', undefined, 1), s('u-old', undefined, 300)], { now: NOW, limit: 10 });
    assert.deepEqual(warm.sort(), ['u-new', 'u-old']);
  });

  test('an idle project stays cold even next to warm ungrouped chats', () => {
    const warm = sessionsToWarm([s('u', undefined, 300), s('p', '去年的', 40)], { now: NOW, limit: 10 });
    assert.deepEqual(warm, ['u']);
  });
});

describe('只热上一个活跃的 project', () => {
  /*
    「默认只预热上一个活跃的project和unassigned中的会话」。

    原来的判据是"7 天内动过的 project 全预热"。它解决的是几个月前的项目还在吃内存，但没解决**同时在做
    几件事**：三个都活跃的 project 就是三份 0.4 GB 的 kiro-cli，而你一次只看一个。
  */
  const A = [s('a1', '在写周报', 0), s('a2', '在写周报', 2)];
  const B = [s('b1', '另一个活的', 1), s('b2', '另一个活的', 3)];

  test('两个 project 都活跃 —— 只热你落在的那个', () => {
    const warm = sessionsToWarm([...A, ...B], { now: NOW, limit: 20, keepId: 'b1' });
    assert.deepEqual(warm.sort(), ['b1', 'b2']);
  });

  test('没有 keepId 就退回活动时间最新的那个', () => {
    const warm = sessionsToWarm([...A, ...B], { now: NOW, limit: 20 });
    assert.deepEqual(warm.sort(), ['a1', 'a2']);
  });

  test('keepId 比时间戳权威 —— 后台 flow 刚写完一步不代表你人在那个 project 里', () => {
    // A 的时间戳更新（0 天前），但你落在 B 上
    assert.equal(warmProject([...A, ...B], 'b2'), '另一个活的');
    assert.equal(warmProject([...A, ...B], null), '在写周报');
  });

  test('落在一条 ungrouped 会话上 —— 没有哪个 project 是"上一个"，只热 unassigned', () => {
    const warm = sessionsToWarm([...A, ...B, s('u', undefined, 5)], { now: NOW, limit: 20, keepId: 'u' });
    assert.deepEqual(warm.sort(), ['u']);
  });

  test('unassigned 照旧一律热，和是哪个 project 无关', () => {
    const warm = sessionsToWarm([...A, ...B, s('u', undefined, 300)], { now: NOW, limit: 20, keepId: 'a1' });
    assert.deepEqual(warm.sort(), ['a1', 'a2', 'u']);
  });

  test('上一个 project 自己凉了（一周没动）就一个都不热 —— 回来一次的开销落在点击上', () => {
    const cold = [s('c1', '上个月的', 20), s('c2', '上个月的', 25)];
    assert.deepEqual(sessionsToWarm(cold, { now: NOW, limit: 20 }), []);
    // 但落在它上面的那一条还是要热：开屏那条会话必须能读
    assert.deepEqual(sessionsToWarm(cold, { now: NOW, limit: 20, keepId: 'c1' }), ['c1']);
  });

  test('空输入不炸', () => {
    assert.equal(warmProject([], null), '');
    assert.deepEqual(sessionsToWarm([], { now: NOW, limit: 5 }), []);
  });
});

describe('侧栏：点开一个 project 才预热它', () => {
  const SIDEBAR = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'Sidebar.tsx'), 'utf8',
  );

  test('判据是折叠 → 展开的**跃变**，不是"此刻展开着"', () => {
    /*
      按"此刻展开着"跑的话，每次启动都会把所有没折叠的 project 各预热一遍 —— 正好抵消启动那侧的收紧。
      而拿"此刻展开着"去记"已处理"也不行：setCollapsed 是异步的，第一遍看到的 collapsed 还是空集，
      那样每个 project 都会被记成已处理，之后点开一个折叠的它也不会预热了。
    */
    const at = SIDEBAR.indexOf('const warmed = useRef<Set<string>>(new Set());');
    assert.ok(at > 0, '找不到那段');
    const block = SIDEBAR.slice(at, at + 900);
    assert.match(block, /prevCollapsed/);
    assert.match(block, /if \(!prev\) return;/, '第一次看到折叠状态时什么都不热');
    assert.match(block, /for \(const project of prev\)/, '只看上一次折叠着、现在不折叠了的那些');
  });
});

describe('折起来 = 冷的，展开 = 热的（同一份答案）', () => {
  /*
    「为什么不预热的project不折叠啊」。折叠原来按 7 天判，而预热收紧到"只热上一个活跃的"之后，
    中间多出一类**展开着但是冷的**：没到 7 天所以不折，但也不预热了，点上去一片灰点。
    两个判据必须是同一份答案，否则这个不变量在两处各算一遍的那一刻就破了。
  */
  const A = [s('a1', '在写周报', 0), s('a2', '在写周报', 2)];
  const B = [s('b1', '另一个活的', 1)];
  const C = [s('c1', '上个月的', 30)];
  const all = [...A, ...B, ...C, s('u', undefined, 4)];

  test('热的那个不折，别的全折 —— 包括没到 7 天的那些', () => {
    assert.deepEqual(projectsToCollapse(all, { now: NOW, keepId: 'b1' }), ['上个月的', '在写周报']);
  });

  test('折叠集合和预热集合互补 —— 没有一个 project 同时被折起来又被预热', () => {
    for (const keep of [null, 'a1', 'b1', 'c1', 'u']) {
      const warm = new Set(sessionsToWarm(all, { now: NOW, limit: 20, keepId: keep }));
      const cold = new Set(projectsToCollapse(all, { now: NOW, keepId: keep }));
      for (const sess of all) {
        const p = (sess.projectId || '').trim();
        if (!p || !warm.has(sess.id) || sess.id === keep) continue;
        assert.ok(!cold.has(p), `keepId=${keep}: ${p} 既被预热又被折起来`);
      }
    }
  });

  test('上一个 project 自己凉了 —— 一个都不留展开（那时候确实一个都不热）', () => {
    assert.equal(warmedProject(C, { now: NOW }), '');
    assert.deepEqual(projectsToCollapse(C, { now: NOW }), ['上个月的']);
  });

  test('unassigned 不在折叠名单里 —— 它没有可折的组头，而且一律预热', () => {
    assert.ok(!projectsToCollapse(all, { now: NOW, keepId: 'u' }).includes(''));
  });
});
