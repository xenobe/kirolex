import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The memory block goes out on EVERY turn.
 *
 * It used to be sent only when its CONTENT changed. That is right for background facts
 * and wrong for the rules people actually write in there: 「每次回复的结尾都必须打印本轮
 * 最终生成物的完整路径」 has to hold for every reply, but it was stated once and never
 * repeated. Measured on one chat: a single injection (1357 chars, 17:07) followed by 7
 * turns carrying nothing, at 66.5% context -- and because the block is deliberately kept
 * out of the transcript and history.md, nothing restates it after a compaction either.
 */
const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');

describe('layered memory is delivered per turn', () => {
  const region = main.slice(main.indexOf('// Inject layered memory'), main.indexOf('// DEFERRED PREPEND'));

  test('nothing gates the injection except the feature flag', () => {
    assert.match(region, /const block = isFeatureEnabled\('memoryInjection'\)/);
    assert.match(region, /if \(block\) \{/, 'the only condition may be "there is a block"');
    // The content-comparison gate is what made a standing rule a one-off.
    assert.doesNotMatch(region, /block !== entry\.lastInjectedMemory/);
  });

  test('the bookkeeping that made it conditional is gone, not just bypassed', () => {
    // Leaving these behind would tell the next reader the decision still exists.
    for (const dead of ['lastInjectedMemory', 'injectedProjectId', 'memoryInjected']) {
      assert.equal(main.includes(dead), false, `${dead} is back: there is no per-executor injection decision any more`);
    }
  });

  test('it sits closest to the user text, after the history snapshot', () => {
    // Both are PREPENDED, so whichever is prepended LAST ends up first in the array.
    // Memory must be prepended first => it lands after the ride-along block, i.e. as
    // near the user's own message as possible. A standing instruction placed in front of
    // a 19k-char history dump is in the position least likely to be honoured.
    const memAt = main.indexOf("prompt = [{ type: 'text', text: block }, ...prompt]");
    const rideAt = main.indexOf("if (rideAlongBlock) prompt = [{ type: 'text', text: rideAlongBlock }, ...prompt]");
    assert.ok(memAt > 0 && rideAt > 0);
    assert.ok(memAt < rideAt, 'prepend memory BEFORE the ride-along block');
  });

  test('every delivery is observable', () => {
    // Answering "was it actually delivered?" previously required reading record.json,
    // and only covered the most recent turn.
    assert.match(region, /logger\.info\('memory', `injected sessionId=\$\{sessionId\} chars=\$\{block\.length\}/);
    assert.match(region, /rec\.lastMemoryInjection = \{ charCount: block\.length, at: Date\.now\(\) \}/);
  });

  test('it still never reaches the transcript', () => {
    // The block is prepended AFTER the user message is persisted; promptText (the
    // transcript fallback) is derived before that. Both blocks depend on this order.
    const persistAt = main.indexOf('store.appendMessage(sessionId, {');
    const memAt = main.indexOf("prompt = [{ type: 'text', text: block }, ...prompt]");
    assert.ok(persistAt > 0 && memAt > persistAt, 'memory must be prepended after the user message is stored');
  });
});
