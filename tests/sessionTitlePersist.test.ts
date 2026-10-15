import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const MAIN = read('src', 'main', 'index.ts');
const ACP = read('src', 'renderer', 'hooks', 'useAcp.ts');
const PRELOAD = read('src', 'main', 'preload.ts');

describe('会话标题要落盘', () => {
  test('改名不再只改内存 —— 一刷新就退回 New Chat', () => {
    /*
      实测：SFDC 那个 project 下四条会话（一条主会话 + 三条 worker）在磁盘上**全都叫 New Chat**，
      而侧栏上它们显示着步骤名。重启之后你看到的就是一排分不清谁是谁的「New Chat」——
      「这个 project 里面还是有一条没用的 new chat」有一半是这个造成的。
    */
    const fn = ACP.slice(ACP.indexOf('const renameSession = useCallback'));
    assert.match(fn.slice(0, 1400), /void window\.kiroApi\.renameSessionOnDisk\?\.\(sessionId, title\)/);
  });

  test('走 patchRecord —— flow worker 的记录是第一次 prompt 才创建的，而改名在那之前', () => {
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:rename-session'"));
    assert.match(h.slice(0, 700), /store\.patchRecord\(sessionId, \{ title: next \} as any\)/);
    assert.match(h.slice(0, 700), /deferred: where === 'pending'/);
  });

  test('空标题不写 —— 空字符串会把一条会话变成没有名字', () => {
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('acp:rename-session'"));
    assert.match(h.slice(0, 700), /if \(!next\) return \{ ok: false, error: 'empty title' \}/);
  });

  test('preload 和类型声明都补上了', () => {
    assert.match(PRELOAD, /renameSessionOnDisk: \(sessionId: string, title: string\)/);
    assert.match(read('src', 'renderer', 'App.tsx'), /renameSessionOnDisk\?: \(sessionId: string, title: string\)/);
  });
});
