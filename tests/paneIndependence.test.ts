import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * What a split pane shows must depend on its CHAT, never on which pane has focus.
 *
 * Anything read from the focused chat's state only is mounted in one pane and unmounted
 * in another on every focus switch, so both transcripts change height in the same frame
 * -- the flash seen when clicking between panes. `usage`, `stall`, `activity` and
 * `activeTool` were already mirrored per pane; `plan` and the error banner were not.
 *
 * Source-structure assertions: this runner has no DOM, so they pin the wiring rule
 * rather than the pixels.
 */
const SRC = path.join(import.meta.dirname, '..', 'src', 'renderer');
const app = fs.readFileSync(path.join(SRC, 'App.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(SRC, 'hooks', 'useAcp.ts'), 'utf8');

describe('a pane renders its chat, not the focus', () => {
  test('every focus-dependent pane prop falls back to that pane\'s own mirror', () => {
    // `focused ? X : <mirror>` is fine; `focused ? X : <constant>` is the bug, because
    // the constant means "this pane shows nothing while another pane has focus".
    //
    // One documented exception: `commands` feeds the `/` autocomplete popover, which
    // only ever opens while the user is TYPING in that pane's composer -- and typing
    // there focuses the pane first, so an unfocused pane can never need the list. It
    // renders nothing either way, so it cannot change a pane's height.
    const ALLOWED = new Set(['commands']);
    const offenders = [...app.matchAll(/(\w+)=\{focused \? \w+ : ([A-Z_]+|null)\}/g)]
      .filter((m) => !ALLOWED.has(m[1]))
      .map((m) => `${m[1]} -> ${m[2]}`);
    assert.deepEqual(offenders, [], 'this prop blanks out when the pane loses focus, '
      + 'so it mounts/unmounts on every focus switch. Mirror it in PaneView instead '
      + '(see plan/usage/stall) and read view?.<field> in the else branch');
  });

  test('the plan panel comes from the pane view when not focused', () => {
    assert.match(app, /plan=\{focused \? plan : \(view\?\.plan \|\| EMPTY_PLAN\)\}/);
    assert.match(hook, /plan: PlanEntry\[\];/, 'PaneView must carry the plan');
    assert.match(hook, /plan: planMapRef\.current\.get\(id\) \|\| EMPTY_PANE_PLAN/,
      'a pane must be seeded with its own plan');
    assert.match(hook, /patchPane\(targetSid, \{ plan: entries \}\)/,
      'plan updates must reach the pane mirror, not only the focused chat');
  });

  test('the error banner is keyed by chat, and nothing writes an app-wide one', () => {
    assert.match(app, /connectionError=\{\(sid \? errorBySession\[sid\] : errorBySession\[APP_ERROR_KEY\]\) \|\| null\}/);
    // The old app-wide string was written in ~19 places, which is exactly why it
    // outlived the states it described.
    assert.equal((hook.match(/setConnectionError\(/g) || []).length, 0,
      'use noteError(sid, msg) so the banner belongs to the chat that failed');
    assert.match(hook, /const noteError = useCallback\(/);
  });

  test('a stop-reason notice is no longer gated on the chat being focused', () => {
    // It used to be dropped entirely unless the chat happened to be in front, so a
    // background pane's turn could end abnormally and say nothing.
    assert.doesNotMatch(hook, /if \(notice && \w+ === currentSessionRef\.current\)/);
    assert.match(hook, /if \(notice\) noteError\(/);
  });

  test('deleting or clearing a chat takes its banner and plan with it', () => {
    const del = hook.slice(hook.indexOf('const deleteSession'));
    assert.match(del.slice(0, 2000), /noteError\(sessionId, null\)/);
    const clear = hook.slice(hook.indexOf('planMapRef.current.delete(sid)'));
    assert.match(clear.slice(0, 800), /patchPane\(sid, \{ messages: \[\], plan: EMPTY_PANE_PLAN \}\)/);
  });
});

describe('clicking another pane must not re-render the transcripts', () => {
  const chatArea = fs.readFileSync(path.join(SRC, 'components', 'ChatArea.tsx'), 'utf8');
  /** The props of the two MEMOISED message items, as written in the JSX. */
  const itemProps = (): string[] => {
    const out: string[] = [];
    for (const tag of ['<UserGroupItem', '<MessageItem']) {
      const at = chatArea.indexOf(tag);
      out.push(chatArea.slice(at, chatArea.indexOf('/>', at)));
    }
    return out;
  };

  test('no message-item prop is an inline function', () => {
    // An inline arrow is a new identity on every render, so `memo` bails out and every
    // rendered group re-renders -- markdown and syntax highlighting included -- on any
    // app re-render, including a chunk arriving in a different pane.
    const offenders = itemProps()
      .flatMap((jsx) => [...jsx.matchAll(/(on[A-Z]\w*)=\{\s*(\([^)]*\)|async)\s*=>/g)])
      .map((m) => m[1]);
    assert.deepEqual(offenders, [], 'hoist it into a useCallback (see openLoopSetup) or '
      + 'take a stable one from App (see paneMessageCallbacks)');
  });

  test('App hands the panes stable fork/rerun callbacks', () => {
    assert.match(app, /onForkMessage=\{messageCallbacks\.onFork\}/);
    assert.match(app, /onRerunMessage=\{messageCallbacks\.onRerun\}/);
    assert.match(app, /const paneMessageCallbacks = useCallback\(/);
    // Read through a ref, so a stable wrapper can never call a stale closure.
    assert.match(app, /latestMessageApiRef\.current = \{ handleForkMessage, handleRerunMessage \}/);
  });

  test('the group list stays identity-stable while messages do', () => {
    // If these recomputed on every render the items would re-render regardless of the
    // callbacks, because `base`/`steers`/`segments` would be new objects each time.
    assert.match(chatArea, /const orderedMessages = useMemo<Message\[\]>\([\s\S]*?\}, \[messages\]\);/);
    assert.match(chatArea, /const renderGroups = useMemo<RenderGroup\[\]>\([\s\S]*?\}, \[orderedMessages\]\);/);
  });

  test('a pane losing focus never falls back to an empty transcript', () => {
    // MEASURED root cause: pane views are seeded from an effect, so for one commit the
    // outgoing pane had no view and rendered `[]` -- every row unmounted and came back
    // as a new node. Before: 12 added / 12 removed / 0 surviving node objects on a
    // 10-row chat. After: 0 mutations, all nodes surviving, both directions.
    assert.match(app, /paneViews\[sid\] \|\| paneFallback\(sid\)/,
      'a missing pane view must fall back to the live refs, not to []');
    assert.match(hook, /const paneFallback = useCallback\(/);
    assert.doesNotMatch(app, /view\?\.messages \|\| \[\]/,
      'an inline [] fallback re-introduces the blank frame');
  });

  test('the outgoing chat keeps the very array it was rendering', () => {
    // Content-equal but identity-different was still expensive: every memo bailed and
    // highlight.js re-ran over the whole transcript (measured 554 `code` + 60 `pre`
    // attribute mutations with identical message ids before and after).
    const sw = hook.slice(hook.indexOf('const switchSession = useCallback'));
    const head = sw.slice(0, 2600);
    assert.match(head, /const outgoing = currentSessionRef\.current;/);
    assert.match(head, /messages: carried/, 'seed with focusedMessagesRef, not the cache');
    // Must be seeded BEFORE focus moves, or the blank commit happens anyway.
    assert.ok(head.indexOf('const outgoing') < head.indexOf('setCurrentSessionId(sessionId)'),
      'the outgoing pane view must be seeded before the focus change');
  });
});
