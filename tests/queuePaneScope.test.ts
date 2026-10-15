import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 队列操作必须认**格子的会话**，不是焦点会话。
 *
 * 实测：分屏时按 Enter，打的字和附件一起静默消失。原因是 `handleSteerMessage` 用 `currentQueue`
 * （按 `currentSessionId` 算）判断「队列非空」，却对 `paneSid || currentSessionId` 那条会话动手：
 *
 *   焦点会话队列非空 → 分支成立 → tailId 是焦点会话的卡片 id
 *   → 在这一格的队列里找不到它 → 什么都没改 → clearAttachments → return（消息没了）
 *
 * 这个仓库为取消/编辑/移动修过同一类 bug，注释就写在 `handleCancelQueuedMessage` 上方：
 * 「in split view the pane you clicked in is NOT necessarily the focused chat」。这一处漏了。
 */
const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');

const steer = (() => {
  const at = APP.indexOf('const handleSteerMessage = useCallback');
  assert.ok(at > 0, 'handleSteerMessage 必须存在');
  const rest = APP.slice(at);
  return rest.slice(0, rest.indexOf('\n  }, ['));
})();

describe('并进队尾这一步认的是哪条会话', () => {
  test('读格子自己的队列，用 ref', () => {
    assert.match(steer, /const paneQueue = queuesBySessionRef\.current\[sessionId\] \|\| \[\];/);
    assert.match(steer, /if \(paneQueue\.length > 0\)/);
    assert.match(steer, /const tailId = paneQueue\[paneQueue\.length - 1\]\.id;/);
  });

  test('不再读按焦点会话算的队列', () => {
    // 只看代码：注释里正当地提到了这个被删掉的变量，用来解释为什么不能那样读。
    const code = steer.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /currentQueue/,
      '任何按焦点会话算的队列都会重新引入那次消息静默消失');
  });

  test('写回的仍然是这一格的会话 —— 判据和落笔必须是同一条会话', () => {
    assert.match(steer, /\[sessionId\]: \(prev\[sessionId\] \|\| \[\]\)\.map\(/);
    assert.match(steer, /clearAttachments\(sessionId\)/);
  });
});

describe('那个按焦点会话算的变量已经彻底移除', () => {
  test('整个 App.tsx 里不再有 currentQueue 这个标识符', () => {
    // 注释里可以提它（解释为什么删），代码里不行。
    const code = APP.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bcurrentQueue\b/);
  });
});
