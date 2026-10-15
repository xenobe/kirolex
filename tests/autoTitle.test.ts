import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Auto-naming has now regressed twice, both times the same way: the logic itself was
 * fine, but it was attached to ONE of the three ways a message reaches the backend.
 *
 * Source-structure assertions: this runner has no DOM and no Electron, so these pin
 * WHERE the naming hangs rather than simulating a turn.
 */
const root = path.join(import.meta.dirname, '..');
const acp = fs.readFileSync(path.join(root, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src', 'renderer', 'App.tsx'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');

describe('a chat names itself no matter how the message was delivered', () => {

  test('naming hangs off the shared turn-end choke point', () => {
    // `finishStreamingTurn` is the one function every delivery path calls in its
    // `finally` -- plain send, queue drain, and the turn a steer merged into -- and its
    // token guard means it fires once per turn.
    const fn = acp.slice(acp.indexOf('const finishStreamingTurn = ('));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    assert.match(body, /maybeAutoTitle\(sid\)/,
      'naming must run at turn end, not inside one particular send function');
  });

  test('exactly one place asks the model for a title', () => {
    // Two call sites is how the paths drifted apart before: one got the retry policy
    // and the other kept a crude truncation.
    const calls = acp.match(/generateTitle\?\.\(/g) || [];
    assert.equal(calls.length, 1, 'title generation must have a single caller');
  });

  test('the queue path does not name the chat itself', () => {
    // It used to set `title: text.slice(0, 40)` the moment a queued message was
    // delivered. That is not a title, and worse: it made the chat stop being called
    // "New Chat", which is the ONLY trigger for real naming -- so any chat whose first
    // message went through the queue was permanently stuck with the truncation.
    assert.doesNotMatch(acp, /title: text\.slice\(0, 40\)/);
    const fn = acp.slice(acp.indexOf('const sendQueuedMessage = useCallback('));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    assert.doesNotMatch(body, /setSessions\([^)]*title:/,
      'the queue drain must leave naming to maybeAutoTitle');
  });

  test('the trigger stays "still called New Chat", and truncation is only a last resort', () => {
    const fn = acp.slice(acp.indexOf('const maybeAutoTitle = ('));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    assert.match(body, /\/\^New Chat\\b\/\.test/, 'one trigger: the name is still New Chat');
    // A generation failure must leave the name alone so the next turn can retry.
    assert.match(body, /if \(tries \+ 1 < MAX_TITLE_TRIES\) return;/);
    assert.match(body, /const tries = titleTriesRef\.current\.get\(sid\) \|\| 0;/);
    // A name the user typed themselves must never be overwritten by an in-flight call.
    assert.match(body, /if \(!stillNew\(\)\) return;/);
  });

  test('flow-owned chats keep their structural names', () => {
    const fn = acp.slice(acp.indexOf('const maybeAutoTitle = ('));
    const body = fn.slice(0, fn.indexOf('\n  };'));
    for (const purpose of ['skill', 'flow-main', 'flow-worker']) {
      assert.match(body, new RegExp(`'${purpose}'`),
        `${purpose} sessions are named by KiroLex, not by the model`);
    }
  });

  test('a send is target-addressed, so a background pane names its OWN chat', () => {
    // handleSendMessage computes `sid` from paneSid and must forward it; without it
    // sendMessage falls back to whatever chat is focused.
    const fn = app.slice(app.indexOf('const handleSendMessage = useCallback('));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    const call = body.slice(body.indexOf('await sendMessage('));
    assert.match(call, /sid \|\| undefined,/, 'the pane session id must reach sendMessage');
  });

  test('the title handler leaves a trace on every branch', () => {
    // It logged NOTHING before -- including the silent `{ error: 'empty' }` branch --
    // which is why "chats stopped naming themselves" was undiagnosable twice.
    const fn = main.slice(main.indexOf("ipcMain.handle('app:generate-title'"));
    const body = fn.slice(0, fn.indexOf('\n  });'));
    assert.match(body, /logger\.info\('title', `generated/);
    assert.match(body, /logger\.warn\('title'/);
    assert.match(body, /logger\.info\('title', 'skipped/);
  });
});
