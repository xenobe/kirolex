import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards for the context-restore invariants, checked against the SOURCE.
 *
 * Be clear about what these are: structural assertions, not behavioural tests. The
 * logic they protect lives inside `ipcMain.handle` bodies in the Electron main
 * process and depends on a live kiro-cli child, so it cannot be exercised in this
 * runner without either mocking the whole ACP transport or extracting handlers that
 * are heavily entangled with executor state. What CAN be pinned down cheaply is the
 * ORDER and the GUARDS whose absence caused each of these bugs — every one of them
 * was a line sitting in the wrong place, not a wrong computation.
 *
 * Each test names the failure it prevents, so a future edit that reintroduces it
 * fails here with the reason rather than silently shipping.
 */

const root = path.resolve(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
const preload = fs.readFileSync(path.join(root, 'src/main/preload.ts'), 'utf-8');
const useAcp = fs.readFileSync(path.join(root, 'src/renderer/hooks/useAcp.ts'), 'utf-8');

/** The body of `sendPromptOnce`, so ordering assertions cannot match elsewhere. */
function sendPromptOnceBody(): string {
  const start = main.indexOf('async function sendPromptOnce(');
  assert.ok(start > 0, 'sendPromptOnce not found — this guard needs updating');
  const end = main.indexOf("ipcMain.handle('acp:cancel'", start);
  assert.ok(end > start, 'end of sendPromptOnce not found');
  return main.slice(start, end);
}

describe('ride-along snapshot must not be able to enter the transcript', () => {
  test('the snapshot is prepended AFTER the user message is persisted', () => {
    const body = sendPromptOnceBody();
    const persist = body.indexOf('store.appendMessage(sessionId, {');
    const prepend = body.indexOf('if (rideAlongBlock) prompt = [{ type: \'text\', text: rideAlongBlock }');
    assert.ok(persist > 0, 'the user-message write disappeared');
    assert.ok(prepend > 0, 'the deferred ride-along prepend disappeared');
    assert.ok(
      prepend > persist,
      'The snapshot is prepended BEFORE the transcript write again. `promptText` is '
      + 'derived from `prompt`, and it is the fallback used whenever display.displayText '
      + 'is absent — so the whole history snapshot would be stored as the user\'s own '
      + 'message, then rendered into history.md, then carried by the NEXT snapshot.',
    );
  });

  test('promptText (the fallback that would capture it) is still derived from prompt', () => {
    // If this ever stops being true the ordering above no longer matters — but it
    // also means the fallback changed shape, which this guard should be told about.
    assert.match(sendPromptOnceBody(), /const promptText = Array\.isArray\(prompt\)/);
  });
});

describe('the ride-along "context established" marker is withdrawn on every failure', () => {
  test('the marker write is paired with the unconfirmed flag', () => {
    const body = sendPromptOnceBody();
    const mark = body.indexOf('markContextEstablished(sessionId, entry);');
    const flag = body.indexOf('entry.rideAlongUnconfirmed = true;');
    assert.ok(mark > 0 && flag > mark, 'the marker is written without flagging it unconfirmed');
  });

  test('acp:prompt withdraws it when the send throws before the streaming try', () => {
    const start = main.indexOf("ipcMain.handle('acp:prompt'");
    const end = main.indexOf('async function sendPromptOnce(', start);
    const handler = main.slice(start, end);
    assert.match(handler, /catch \(err\)/, 'acp:prompt no longer catches');
    assert.match(handler, /rideAlongUnconfirmed/);
    assert.match(handler, /clearContextEstablished\(sessionId\)/);
    assert.match(handler, /throw err/, 'the error must still reach the renderer');
  });

  test('a successful turn confirms it against the CURRENT executor (model swap)', () => {
    const body = sendPromptOnceBody();
    const confirm = body.indexOf('if (rideAlong && entry.rideAlongUnconfirmed) {');
    assert.ok(confirm > 0, 'nothing confirms the marker after a successful send');
    const send = body.indexOf('await entry.client.sendPrompt(entry.cliSessionId, prompt)');
    assert.ok(confirm > send, 'the marker is confirmed before the send is accepted');
  });
});

describe('KiroLex issues exactly one kind of prompt the user did not type', () => {
  test('the only self-issued prompt is the history rebuild, and it is suppressed', () => {
    const start = main.indexOf("client.on('update'");
    assert.match(
      main.slice(start, start + 1200),
      /if \(entry\.priming\) return;/,
      'the priming guard is gone: a rebuild\'s "OK" replies would reach the screen '
      + 'and the transcript',
    );
    // Every sendPrompt in main, so a new self-issued command cannot slip in without
    // this guard being reconsidered. Expected exactly two: the rebuild (prime) and
    // the real user turn.
    //
    // A THIRD one existed briefly -- a hidden `/clear` behind a 「清除历史」 menu
    // entry -- and it leaked its reply into the renderer and into the next turn's
    // transcript entry precisely because it was not covered here. That whole feature
    // is gone: `/clear` is something the USER types, and it travels as an ordinary
    // turn. Nothing in KiroLex deletes a stored transcript any more.
    const sends = (main.match(/\.client\.sendPrompt\(/g) || []).length;
    assert.equal(
      sends,
      2,
      'a new client.sendPrompt appeared. If it sends something the user did not type, '
      + 'it must suppress its own output the way primeHistoryNow does (set the flag '
      + 'wireSession checks, and clear assistantBuf/fileChanges afterwards).',
    );
  });

  test('the clear-history feature is gone, everywhere', () => {
    assert.doesNotMatch(main, /acp:clear-history/, 'the IPC handler is back');
    assert.doesNotMatch(preload, /clearHistory/, 'the preload bridge is back');
    const storeSrc = fs.readFileSync(path.join(root, 'src/main/sessionStore.ts'), 'utf-8');
    assert.doesNotMatch(storeSrc, /clearTranscript/, 'the transcript eraser is back');
    const sidebar = fs.readFileSync(path.join(root, 'src/renderer/components/Sidebar.tsx'), 'utf-8');
    assert.doesNotMatch(sidebar, /onClearHistory/, 'the sidebar menu entry is back');
    // `/clear` must still reach the backend as an ordinary message -- removing the
    // feature must not have removed the user's own way to reset the context.
    const app = fs.readFileSync(path.join(root, 'src/renderer/App.tsx'), 'utf-8');
    assert.match(app, /if \(text\.trim\(\) === '\/clear'\) \{/);
    assert.match(app, /sendMessage\(\[\{ type: 'text', text: '\/clear' \}\]\)/);
    assert.doesNotMatch(app, /clearHistory/, 'App still calls the removed bridge');
  });
});

describe('a consumed steer reaches the durable transcript', () => {
  test('main exposes the writer and merges into the turn\'s user message', () => {
    const start = main.indexOf("ipcMain.handle('acp:persist-steer'");
    assert.ok(start > 0, 'acp:persist-steer is gone — consumed steers would vanish from disk again');
    const handler = main.slice(start, start + 1600);
    assert.match(handler, /store\.appendMessage\(sessionId, \{/);
    assert.match(handler, /mergeIntoMessageId: mergeInto/, 'the steer no longer folds into its turn');
    assert.match(handler, /entry\?\.currentUserMessageId/);
  });

  test('sendPromptOnce records the merge target', () => {
    assert.match(sendPromptOnceBody(), /entry\.currentUserMessageId = userMessageId;/);
  });

  test('the bridge is exposed and called from the CONSUMED branch only', () => {
    assert.match(preload, /persistSteer: \(sessionId: string, text: string/);
    const start = useAcp.indexOf("case 'steer_consumed'");
    const end = useAcp.indexOf("case 'steer_cleared'", start);
    assert.ok(start > 0 && end > start, 'the steer_consumed branch moved');
    const branch = useAcp.slice(start, end);
    assert.match(branch, /persistSteer\?\.\(targetSid, item\.content, item\.msgId\)/);
    // Anywhere else would double-write: an un-consumed steer is re-sent through
    // acp:prompt, which persists it on that path.
    const calls = (useAcp.match(/persistSteer\?\./g) || []).length;
    assert.equal(calls, 1, 'persistSteer is called from more than one place — steers would be duplicated');
  });
});

describe('replacing the executor does not cost a rebuild turn in snapshot mode', () => {
  test('both switches go through one shared decision, not their own copy', () => {
    // There were two copies of the same wrong policy (model + Agent), and a third
    // place -- acp:ensure-context -- with the RIGHT one. Collapsing the two onto one
    // function is what keeps them from drifting apart again.
    assert.match(main, /function restoreContextAfterExecutorSwap\(sessionId: string, trigger: string\)/);
    assert.match(main, /restoreContextAfterExecutorSwap\(sessionId, 'switch-model'\)/);
    assert.match(main, /restoreContextAfterExecutorSwap\(sessionId, 'switch-agent'\)/);
  });

  test('neither switch marks the debt or primes directly any more', () => {
    // The bug was not "an extra turn": `!entry.needsHistoryPrime` is a ride-along
    // PRECONDITION, and marking the debt is the first thing markContextOwedIfUnverified
    // does -- so doing it here foreclosed the zero-cost path and forced the locked,
    // failure-prone rebuild instead.
    for (const trigger of ['switch-model', 'switch-agent']) {
      assert.equal(
        main.includes(`markContextOwedIfUnverified(sessionId, '${trigger}')`),
        false,
        `${trigger} still marks the rebuild owed directly; it must go through restoreContextAfterExecutorSwap`,
      );
    }
  });

  test('only verbatim mode still rebuilds after a swap', () => {
    // 'full' is one turn PER CHUNK by definition, so it cannot ride along on a single
    // message and keeps the real rebuild.
    const body = main.slice(main.indexOf('function restoreContextAfterExecutorSwap'));
    const fn = body.slice(0, body.indexOf('\n}\n') + 3);
    assert.match(fn, /primeMode === 'full'/);
    assert.match(fn, /primeHistoryNow\(sessionId\)/);
    // …and the snapshot branch does nothing but log.
    assert.match(fn, /context RIDES ALONG after/);
  });

  test('the ride-along precondition this depended on is still in place', () => {
    // If `needsHistoryPrime` ever stops gating the ride-along, the reasoning above
    // (and the fix) no longer holds.
    assert.match(main, /const rideAlong = isFeatureEnabled\('rideAlongContext'\)[\s\S]{0,400}?!entry\.needsHistoryPrime/);
  });
});
