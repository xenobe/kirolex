import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * An occupied backend makes a message WAIT. It never makes it fail.
 *
 * kiro-cli owns an ACP session from one process only, so an attach and a model/Agent
 * switch cannot both hold it. The original resolution was asymmetric: a switch waited for
 * an in-flight attach (`awaitAttachIdle`), while an attach REJECTED outright during a
 * switch. Since sending a message attaches on demand, that rejection surfaced as a raw
 * `Error invoking remote method 'acp:load-session'` attached to the user's own message --
 * for a condition that clears by itself in a few seconds and ends with the chat ready.
 */
const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');

describe('an attach waits for a model/Agent switch instead of failing', () => {
  test('the wait helper exists and is bounded', () => {
    assert.match(main, /async function awaitReconfigureIdle\(sessionId: string, timeoutMs = \d+\)/);
    // Bounded: a switch that never finishes must not hang every later attach forever.
    const body = main.slice(main.indexOf('async function awaitReconfigureIdle'));
    assert.match(body.slice(0, 1200), /Date\.now\(\) < deadline/);
  });

  test('nothing rejects an attach just because a switch is running', () => {
    // The exact message that used to reach the user's message bubble.
    assert.equal(main.includes("throw new Error('会话正在切换模型/Agent，稍后会自动重连。')"), false);
    // Both directions now wait: the switch for the attach, the attach for the switch.
    assert.match(main, /await awaitAttachIdle\(sessionId\)/);
    assert.match(main, /await awaitReconfigureIdle\(sessionId\)/);
  });

  test('the send path waits too, and re-reads the executor afterwards', () => {
    // The renderer queues on the pushed 'reconfiguring' state, but that state travels
    // over IPC -- a send fired in the same instant must not be answered with an error.
    assert.equal(
      main.includes('Wait for the model, Agent, or permission change to finish before sending a message.'),
      false,
    );
    // A switch installs a NEW executor for the same session, so the entry captured
    // before the wait is stale.
    assert.match(main, /const afterSwitch = sessionClients\.get\(sessionId\);/);
  });
});

describe('the composer queues on every occupying reason except a running turn', () => {
  test('the send gate is not limited to the rebuild states', () => {
    // 'reconfiguring' and 'attaching' are in OCCUPYING_BUSY_REASONS, and used to fall
    // through this gate into an on-demand attach.
    assert.match(hook, /OCCUPYING_BUSY_REASONS = new Set\(\[[^\]]*'reconfiguring'[^\]]*'attaching'/);
    assert.equal(
      app.includes("(busyBySession[sid] === 'prime-pending' || busyBySession[sid] === 'priming')"),
      false,
      'the send gate must cover every occupying reason, not just the two rebuild states',
    );
    assert.match(
      app,
      /isBackendOccupied\(busyBySession\[sid\]\)\s*\n\s*&& busyBySession\[sid\] !== 'turn'/,
    );
  });

  test("a running turn still steers rather than queueing", () => {
    // Enter during a turn means "steer", and that must survive the widened gate above.
    assert.match(app, /busyBySession\[sid\] === 'turn'\) \{\s*\n\s*void handleSteerMessageRef/);
  });

  test('the drain waits on the same predicate, so a queued message leaves by itself', () => {
    assert.match(app, /isBackendOccupied\(busyBySession\[sessionId\]\) \|\|/);
  });
});
