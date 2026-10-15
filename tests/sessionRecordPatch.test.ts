import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(import.meta.dirname, rel), 'utf8');
const store = read('../src/main/sessionStore.ts');
const main = read('../src/main/index.ts');

/*
  为什么是源码断言而不是 import：`sessionStore.ts` 里 `import … from './config'`（无扩展名），
  node 的 ESM 解析器过不去，所以这个模块在 `node --test` 下不可直接加载。它也硬编码 `os.homedir()`，
  真跑 `createSession` 会写进用户自己的 ~/.kirolex。
*/

/**
 * A MARK THAT ARRIVES BEFORE THE RECORD EXISTS MUST NOT BE LOST — 「flow 会话又被加进分屏」的最后一环。
 *
 * 实测同一条「修改 flow · 周报」会话的时间线：
 *   03:53:52 会话创建 → 03:53:54 `purpose LOST … 等了 2s 记录还没出现` → 03:53:59 `prompt received`
 * 记录是**第一次 prompt** 才写的，所以「读记录 → 改 → 写」在这中间必然失败；而这几秒恰恰是分屏的自动播种和
 * 领养在跑的时候。上一版让 handler 等 2 秒是在赌落盘时刻 —— 挂起不赌。
 */
describe('a record patch that arrives too early is queued, not dropped', () => {
  test('there is a queue, and it lives in memory only', () => {
    assert.match(store, /const pendingPatches = new Map<string, Partial<SessionRecord>>\(\)/);
    // 落盘记账会在下次启动把陈旧意图写到别的会话上，比不记账更糟
    const fn = store.slice(store.indexOf('export function patchRecord'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(!/writeFileSync|JSON\.stringify/.test(body), '挂起项不落盘');
  });

  test('record present → write through; absent → queue', () => {
    const fn = store.slice(store.indexOf('export function patchRecord'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /if \(rec\) \{[\s\S]*writeRecord\(mergePending\(rec, patch\)\)/);
    assert.match(body, /pendingPatches\.set\(id, \{ \.\.\.\(pendingPatches\.get\(id\) \|\| \{\}\), \.\.\.patch \}\)/);
    assert.match(body, /return 'pending'/);
  });

  test('createSession applies whatever was queued for that id, then clears it', () => {
    const fn = store.slice(store.indexOf('export function createSession'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /mergePending\(base, pendingPatches\.get\(id\)\)/);
    assert.match(body, /pendingPatches\.delete\(id\)/);
  });

  test('merging only overwrites the keys the patch carries', () => {
    const fn = store.slice(store.indexOf('export function mergePending'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.match(body, /if \(!patch\) return rec;/);
    assert.match(body, /\{ \.\.\.rec, \.\.\.patch \}/);
  });
});

describe('the two IPCs that mark a young session use the queue', () => {
  test('purpose no longer polls, and no longer reports it as LOST', () => {
    const handler = main.slice(main.indexOf("ipcMain.handle('acp:mark-session-purpose'"));
    const body = handler.slice(0, handler.indexOf('});'));
    assert.match(body, /store\.patchRecord\(sessionId/);
    assert.ok(!/attempt < 10/.test(body), '轮询等落盘是上一版的错误修法');
    assert.ok(!/purpose LOST/.test(body));
  });

  test('prime mode too — it is set in the same breath as the brief', () => {
    // 不按 `});` 切：`store.patchRecord(sessionId, { primeMode: mode });` 自己就含这三个字符。
    const body = main.slice(main.indexOf("ipcMain.handle('acp:set-prime-mode'"), main.indexOf("ipcMain.handle('acp:set-prime-mode'") + 900);
    assert.match(body, /store\.patchRecord\(sessionId, \{ primeMode: mode \}\)/);
    assert.ok(!/if \(!rec\) return \{ ok: false, error: 'no record' \}/.test(body), '读不到记录就放弃正是丢失的原因');
  });

  test('both log where the value went, so a silent loss cannot come back', () => {
    assert.match(main, /purpose \$\{sessionId\}[\s\S]{0,120}\(\$\{where\}\)/);
    assert.match(main, /primeMode=\$\{mode\} \(\$\{where\}\)/);
  });
});
