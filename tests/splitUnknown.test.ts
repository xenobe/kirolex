import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 「为什么现在分屏选不了第二个会话了」。
 *
 * 实测：`splitSessionIds` 里有一条 `s_…s1xgc0` —— 磁盘上有 record、`projectId` 是「周报」，
 * 但 transcript 是 **0 字节**（在 project 里点了 New Chat 没发过消息），所以它不进侧栏列表。
 * 那一格渲染不出任何东西、却照样占着容量：看起来只有一格，再点别的会话就把可见那一格顶掉。
 */
const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
const fn = APP.slice(APP.indexOf('const notForSplit = useCallback'), APP.indexOf('const toggleSplitSession'));

describe('列表里没有的会话不占分屏格子', () => {
  test('`notForSplit` 拒绝不在 sessions 里的 id', () => {
    assert.match(fn, /if \(sessions\.length > 0 && !session\) return true;/);
  });

  test('判据在 notForSplit 里，不在 panes 里 —— panes 只管渲染谁，容量是 splitSessionIds 算的', () => {
    // 只改渲染的话那一格永远是空的，但仍然吃掉一格容量
    const cleanup = APP.slice(APP.indexOf('哪些会话**不该占分屏格子**'), APP.indexOf('const toggleSplitSession'));
    assert.match(cleanup, /splitSessionIds\.filter\(\(id\) => !notForSplit\(id\)\)/);
  });

  test('列表为空时不判 —— 否则会把从 ui-state 恢复出来的分屏整个清空', () => {
    /*
      hydrate 完成之前 `sessions` 是空的，那时候"不在列表里"对每一条都成立。
      能判断"它不在列表里"的前提本来就是列表里已经有东西。
    */
    assert.match(fn, /sessions\.length > 0 && !session/);
    assert.match(fn, /hydrate 完成之前/);
  });

  test('原来那几条判据都还在 —— 这一条是加的，不是换的', () => {
    /*
      flow 那几条判据（`flowSessionIds` / `isFlowSession` / 画布会话 / 标题兜底）随 flow 一起
      搬到了 feature/flow 分支上，这一版没有 flow，所以只剩「归档」和「不在列表里」这两条。
      两条都是**非 flow** 的原因，一条都不许丢 —— 它们各自对应一次实测过的缺陷。
    */
    assert.match(fn, /session\?\.archived/);
    assert.match(fn, /sessions\.length > 0 && !session/);
  });
});
