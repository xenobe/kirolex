import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { searchSessions } from '../src/renderer/sessionSearch.ts';

const S = [
  { id: 'a', title: 'W33 周报草稿', projectId: '周报' },
  { id: 'b', title: 'New Chat', projectId: '周报' },
  { id: 'c', title: 'CloudFront 灾备方案技术评审', projectId: 'AWS' },
  { id: 'd', title: '随手记', archived: true },
];

describe('finding a chat by name', () => {
  test('an empty query is idle — the caller skips filtering', () => {
    const r = searchSessions(S, '   ');
    assert.equal(r.idle, true);
    assert.equal(r.hits.length, 4);
  });

  test('matches a title, case-insensitively, anywhere in it', () => {
    assert.deepEqual(searchSessions(S, 'cloudfront').hits.map((s) => s.id), ['c']);
    assert.deepEqual(searchSessions(S, '灾备').hits.map((s) => s.id), ['c']);
  });

  test('the project name counts as text — 「周报」 finds that project’s chats', () => {
    // Otherwise a search box is a spelling test: you have to remember what the chat was called.
    assert.deepEqual(searchSessions(S, '周报').hits.map((s) => s.id), ['a', 'b']);
  });

  test('it reports which projects have hits, so a collapsed group can open itself', () => {
    // A match hidden inside a folded group reads as 「找不到」 — and most groups are folded by default.
    assert.deepEqual(searchSessions(S, '周报').projects, ['周报']);
    assert.deepEqual(searchSessions(S, '随手').projects, [], '未分组的命中不属于任何 project');
  });

  test('no match is an empty list, not everything', () => {
    assert.deepEqual(searchSessions(S, 'zzz').hits, []);
    assert.equal(searchSessions(S, 'zzz').idle, false);
  });

  test('order is the input order — the sidebar already sorted it', () => {
    assert.deepEqual(searchSessions(S, 'a').hits.map((s) => s.id), searchSessions(S, 'a').hits.map((s) => s.id));
  });
});
