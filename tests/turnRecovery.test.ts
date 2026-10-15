import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decideTurnRecovery, adoptedMessages, type TurnPeek } from '../src/renderer/turnRecovery.ts';

/**
 * ADOPTING AN IN-FLIGHT TURN INSTEAD OF RESENDING IT.
 *
 * When the window reloads (or the app restarts) mid-turn, the backend does NOT stop: main holds
 * the ACP connection, keeps accumulating the reply in `assistantBuf`, and flushes it to the
 * transcript when the turn ends. The renderer, however, only knows the chats it can see are
 * "not streaming", so it treated the unanswered question as interrupted and RESENT it -- paying
 * for the same answer twice and risking two replies to one question.
 *
 * The decision is extracted here because it is the part that must be exactly right: every wrong
 * branch either bills a duplicate turn, or leaves a question that never gets answered at all.
 */

const peek = (over: Partial<TurnPeek> = {}): TurnPeek =>
  ({ live: true, messageId: 'a_1', text: 'partial…', startedAt: 1000, ...over });

const base = {
  peek: null as TurnPeek | null,
  busyReason: null as string | null,
  streaming: false,
  cancelled: false,
  attempts: 0,
  maxAttempts: 3,
};

describe('a turn that is still running is adopted, never resent', () => {
  test('a live turn is adopted even though the renderer sees no stream', () => {
    // The exact situation after a reload: main is mid-turn, the renderer is not.
    const out = decideTurnRecovery({ ...base, peek: peek(), busyReason: 'turn' });
    assert.equal(out.action, 'adopt');
    assert.equal(out.text, 'partial…');
    assert.equal(out.messageId, 'a_1');
  });

  test('a live turn that has produced NOTHING yet is still adopted', () => {
    // Adoption is about ownership, not about having text: a turn one second old has an empty
    // buffer, and resending it is the most expensive possible mistake.
    const out = decideTurnRecovery({ ...base, peek: peek({ text: '' }), busyReason: 'turn' });
    assert.equal(out.action, 'adopt');
    assert.equal(out.text, '');
  });

  test('adoption does NOT consume a resend attempt', () => {
    // The counted de-dup exists to bound RESENDS. Charging adoption against it would mean a
    // chat reloaded three times mid-turn could never be recovered again.
    const out = decideTurnRecovery({ ...base, peek: peek(), busyReason: 'turn', attempts: 2, maxAttempts: 3 });
    assert.equal(out.action, 'adopt');
  });

  test('a turn that has ENDED is resent, as before', () => {
    const out = decideTurnRecovery({ ...base, peek: peek({ live: false, text: '' }) });
    assert.equal(out.action, 'resend');
  });
});

describe('the cases where nothing should be sent', () => {
  test('the user cancelled the recovery: stand down', () => {
    const out = decideTurnRecovery({ ...base, cancelled: true, peek: peek() });
    assert.equal(out.action, 'stand-down');
  });

  test('the attempt budget is spent: stand down rather than loop', () => {
    const out = decideTurnRecovery({ ...base, peek: peek({ live: false }), attempts: 3, maxAttempts: 3 });
    assert.equal(out.action, 'stand-down');
  });

  test('the renderer is ALREADY streaming this chat: nothing to recover', () => {
    const out = decideTurnRecovery({ ...base, streaming: true, peek: peek() });
    assert.equal(out.action, 'stand-down');
  });

  test('busy for a reason that is not a turn: wait, do not resend into it', () => {
    // Attaching / rebuilding history / compacting. Prompting then is rejected by the backend
    // ("wait for the active turn"), which is how a raw IPC error ended up in the chat.
    for (const reason of ['attaching', 'priming', 'reconfiguring']) {
      const out = decideTurnRecovery({ ...base, busyReason: reason, peek: peek({ live: false }) });
      assert.equal(out.action, 'wait', `${reason} should make it wait`);
    }
  });

  test('the auto-resend OPT-OUT does not block adoption', () => {
    // "重启后自动重发未完成的提问" is a setting about SENDING. Someone who turned it off did so
    // to avoid surprise billable turns -- adopting shows them an answer they have ALREADY paid
    // for, so gating it behind that switch would hide their own turn's output from them.
    const out = decideTurnRecovery({ ...base, resendDisabled: true, peek: peek(), busyReason: 'turn' });
    assert.equal(out.action, 'adopt');
  });

  test('with the opt-out on and no live turn, nothing is sent', () => {
    const out = decideTurnRecovery({ ...base, resendDisabled: true, peek: peek({ live: false }) });
    assert.equal(out.action, 'stand-down');
  });

  test('an older main that cannot be asked falls back to the old behaviour, never to adopt', () => {
    // `peek: null` means the IPC is absent. Adopting on a guess would paint a reply that is
    // not coming; resending is at least self-correcting.
    const out = decideTurnRecovery({ ...base, peek: null });
    assert.equal(out.action, 'resend');
  });
});

describe('painting the adopted turn into the transcript', () => {
  const user = { id: 'u1', role: 'user' as const, content: '写周报', timestamp: 1 };

  test('the partial reply is appended under the unanswered question', () => {
    const out = adoptedMessages([user], peek());
    assert.equal(out.length, 2);
    assert.equal(out[1].role, 'assistant');
    assert.equal(out[1].id, 'a_1');            // main's id, so `assistant-final` can patch it
    assert.equal(out[1].content, 'partial…');
  });

  test('nothing is painted for a turn with no output yet', () => {
    // An empty assistant bubble reads as "the model replied with nothing".
    const out = adoptedMessages([user], peek({ text: '' }));
    assert.deepEqual(out, [user]);
  });

  test('re-adopting the same turn EXTENDS its bubble instead of duplicating it', () => {
    const once = adoptedMessages([user], peek({ text: 'abc' }));
    const twice = adoptedMessages(once, peek({ text: 'abcdef' }));
    assert.equal(twice.length, 2);
    assert.equal(twice[1].content, 'abcdef');
  });

  test('an adopted bubble is never shrunk by a later, shorter peek', () => {
    // Chunks that arrive between the peek and the state update are dropped by the chunk
    // handler (it gates on `streamingIds`), so the buffer can legitimately lag the screen.
    const once = adoptedMessages([user], peek({ text: 'abcdef' }));
    const twice = adoptedMessages(once, peek({ text: 'abc' }));
    assert.equal(twice[1].content, 'abcdef');
  });

  test('a live-only 💭 thinking segment does not absorb the reply', () => {
    // Mirrors the chunk handler: reply text must start a fresh message rather than append to
    // a thinking segment.
    const thinking = { id: 't1', role: 'assistant' as const, content: '💭 想…', timestamp: 2 };
    const out = adoptedMessages([user, thinking], peek({ text: '正文' }));
    assert.equal(out.length, 3);
    assert.equal(out[2].content, '正文');
  });

  test('the seeded bubble inherits NOTHING from the message above it', () => {
    // `...last` was the lazy way to build it, and it copied the user message's own fields --
    // including `steer`, which the recovery walk-back uses to find a turn's base message. An
    // assistant bubble marked as a steer would corrupt that walk on the next interruption.
    const steered = { id: 'u2', role: 'user' as const, content: '再改一版', timestamp: 4, steer: true, attachments: ['a.png'] };
    const out = adoptedMessages([steered], peek({ text: '好' }));
    assert.equal(out.length, 2);
    assert.equal(out[1].role, 'assistant');
    assert.equal((out[1] as any).steer, undefined, 'steer leaked into the assistant bubble');
    assert.equal((out[1] as any).attachments, undefined, 'attachments leaked in');
  });

  test('a chat that already has a complete reply is left alone', () => {
    // Defence in depth: the caller checks this too, but painting a second bubble under a
    // finished turn is the failure that would be hardest to explain.
    const done = { id: 'a_0', role: 'assistant' as const, content: '写好了', timestamp: 3 };
    const out = adoptedMessages([user, done], peek({ live: false, text: 'x' }));
    assert.deepEqual(out, [user, done]);
  });
});

/* ─────────────────────────── the wiring ───────────────────────────
 * Structural assertions: this path needs a live executor and an Electron window, so what is
 * pinned here is which side owns what, and the two things that must never happen -- adopting a
 * turn KiroLex issued on its own behalf, and resending one that is still running.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
const SRC2 = path.join(import.meta.dirname, '..', 'src');
const rd = (...p: string[]) => fs.readFileSync(path.join(SRC2, ...p), 'utf8');
const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const MAIN2 = noComments(rd('main', 'index.ts'));
const PRELOAD2 = noComments(rd('main', 'preload.ts'));
const HOOK2 = noComments(rd('renderer', 'hooks', 'useAcp.ts'));

describe('main can be asked what a session is doing right now', () => {
  test('the peek reads LIVE executor state, not the transcript on disk', () => {
    assert.match(MAIN2, /ipcMain\.handle\('acp:peek-turn'/, 'no peek handler');
    const body = MAIN2.slice(MAIN2.indexOf("ipcMain.handle('acp:peek-turn'"));
    assert.match(body.slice(0, 900), /sessionClients\.get\(/, 'the peek does not read the live entry');
    assert.match(body.slice(0, 900), /assistantBuf/, 'the peek does not report what was produced');
  });

  test('a PRIMING turn is never offered for adoption', () => {
    // A history-rebuild turn is KiroLex's own prompt. Its output is suppressed everywhere else
    // (main forwards nothing, accumulates nothing, persists nothing); a peek that reported it
    // live would paint that internal reply into the user's chat.
    const body = MAIN2.slice(MAIN2.indexOf("ipcMain.handle('acp:peek-turn'"), MAIN2.indexOf("ipcMain.handle('acp:peek-turn'") + 900);
    assert.match(body, /priming/, 'the peek does not exclude a priming turn');
  });

  test('the renderer can reach it', () => {
    assert.match(PRELOAD2, /peekTurn/, 'preload does not expose the peek');
    assert.match(PRELOAD2, /'acp:peek-turn'/);
  });
});

describe('the recovery path adopts instead of resending', () => {
  test('the opt-out is passed to the decision, not acted on before the peek', () => {
    // An early `return` on the setting made the peek unreachable, so a live turn could never be
    // adopted in a window with auto-resend switched off.
    const start = HOOK2.indexOf('const recoverInterruptedTurn');
    const body = HOOK2.slice(start, HOOK2.indexOf('const rerunFromMessageRef', start));
    assert.doesNotMatch(body, /recoverInterruptedTurns === false\) return/,
      'the setting still short-circuits before the peek');
    assert.match(body, /resendDisabled/, 'the decision is not told about the opt-out');
  });

  test('the decision is delegated, not re-derived in the hook', () => {
    assert.match(HOOK2, /decideTurnRecovery/, 'the hook still decides for itself');
    assert.match(HOOK2, /peekTurn\?\.\(/, 'the hook never asks main');
  });

  test('an adopted turn is marked streaming and painted, and is NOT resent', () => {
    // The region is `adoptTurn` + `recoverInterruptedTurn`: the decision dispatches, the helper
    // immediately above it does the painting. Slicing from `recoverInterruptedTurn` alone would
    // pin WHERE the code sits rather than what it does.
    const start = HOOK2.indexOf('const adoptTurn');
    const body = HOOK2.slice(start, HOOK2.indexOf('const rerunFromMessageRef', start));
    assert.ok(start > 0 && body.length > 0, 'adoptTurn / recoverInterruptedTurn moved — update this guard');
    const adopt = body.indexOf("'adopt'");
    assert.ok(adopt > 0, 'the adopt branch is missing');
    assert.match(body, /adoptedMessages/, 'the partial output is never painted');
    assert.match(body, /addStreaming\(/, 'an adopted chat is not marked streaming, so chunks are dropped');
    // The resend must be reachable ONLY when the decision loop did NOT adopt. Pin that gate
    // itself rather than a character distance between two tokens.
    assert.match(body, /if \(adopted\) return;[\s\S]{0,700}rerunFromMessageRef/,
      'the resend is not gated behind adoption');
    assert.ok(body.indexOf('if (adopted) return;') < body.indexOf('rerunFromMessageRef.current?.('),
      'the gate must come before the resend');
  });

  test('the wait no longer claims the previous turn is wrapping up', () => {
    // It cannot be: a live turn is ADOPTED before this branch is reachable, so the only things
    // left to wait for are an attach, a history rebuild or a reconfigure. Keeping the old
    // wording would describe a state that can no longer occur.
    const start = HOOK2.indexOf('const waitForIdle');
    const body = HOOK2.slice(start, start + 1400);
    assert.ok(start > 0, 'waitForIdle moved — update this guard');
    assert.doesNotMatch(body, /上一轮仍在收尾/, 'the wait still blames the previous turn');
  });

  test('the wrapping-up wait no longer ends in a blind resend', () => {
    // The old shape: poll `getBusyMap` for 60s, then resend regardless of whether the turn it
    // was waiting on had produced the answer already.
    const start = HOOK2.indexOf('const recoverInterruptedTurn');
    const body = HOOK2.slice(start, HOOK2.indexOf('const rerunFromMessageRef', start));
    assert.doesNotMatch(body, /if \(!\(await waitForIdle\(\)\)\)[\s\S]{0,200}setAutoResent/,
      'the unconditional wait-then-resend is still there');
  });
});

describe('an adopted stream is closed by main, since the renderer has no promise to await', () => {
  test('the busy event ends the adopted stream', () => {
    // A normal turn's `streamingIds` entry is cleared when its own `acp:prompt` invoke
    // resolves. An adopted turn was started by a WINDOW THAT IS GONE, so there is no such
    // promise here: without this the chat would stream forever and its composer stay locked.
    assert.match(HOOK2, /adoptedTurnsRef/, 'adopted sessions are not tracked');
    const start = HOOK2.indexOf('onSessionBusy?.(');
    const body = HOOK2.slice(start, start + 2600);
    assert.ok(start > 0, 'onSessionBusy moved — update this guard');
    assert.match(body, /adoptedTurnsRef[\s\S]{0,300}removeStreaming\(/,
      'the idle signal does not release an adopted stream');
  });
});
