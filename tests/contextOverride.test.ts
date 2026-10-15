import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The Snapshot tab is an editor now, and that turns one file into two roles.
 *
 * `last-injection.md` is an ARCHIVE of what a send already carried -- editing it changes
 * nothing, because those bytes are already in the backend's conversation. A block the
 * user curates is an INPUT for the NEXT send, so it lives in its own file
 * (`context-override.md`) that a send does not overwrite. Confusing the two is the only
 * way this feature can badly mislead someone, so both the storage split and the label
 * that names which one is in force are pinned here.
 */
const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
const store = fs.readFileSync(path.join(ROOT, 'src', 'main', 'sessionStore.ts'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.ts'), 'utf8');
const dialog = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'MemoryDialog.tsx'), 'utf8');

describe('a hand-edited context block is stored apart from the archive', () => {
  test('the override has its own file, which a send never rewrites', () => {
    assert.match(store, /export function contextOverridePath\(id: string\): string \{/);
    assert.match(store, /'context-override\.md'/);
    // The archive is still written on every send; the override must not be in that path.
    const writer = store.slice(store.indexOf('export function writeLastInjection'));
    assert.equal(
      writer.slice(0, writer.indexOf('\n}')).includes('contextOverridePath'),
      false,
      'a send must not touch the override, or the curated block would be lost on the next message',
    );
  });

  test('an empty override file is not an override', () => {
    // Otherwise "select all, delete, save" would send an empty context instead of
    // falling back to the generated snapshot.
    const reader = store.slice(store.indexOf('export function readContextOverride'));
    assert.match(reader.slice(0, reader.indexOf('\n}\n')), /if \(!text\.trim\(\)\) return null;/);
    assert.match(main, /if \(!text\.trim\(\)\) \{[\s\S]{0,300}?clearContextOverride\(sessionId\)/);
  });
});

describe('the override is what actually goes out, and it cannot lose the hand-off', () => {
  test('the ride-along prefers the override and uses it verbatim', () => {
    const fn = main.slice(main.indexOf('function buildHistoryRideAlong'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /store\.readContextOverride\(sessionId\)/);
    // Preferred BEFORE the transcript is read, i.e. it replaces the generated block
    // rather than being appended to it.
    assert.ok(
      body.indexOf('readContextOverride') < body.indexOf('readTranscript'),
      'the override must short-circuit the generated snapshot',
    );
  });

  test('the hand-off line is restored if it was edited away', () => {
    // Without it the model answers the restored history instead of the message that
    // follows it, which reads as "Kiro answered something I never asked".
    assert.match(main, /const RIDE_ALONG_HANDOFF = /);
    const fn = main.slice(main.indexOf('function buildHistoryRideAlong'));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')), /if \(!text\.includes\('请正常回答它'\)\) \{[\s\S]{0,200}?RIDE_ALONG_HANDOFF/);
  });

  test('the archive header is stripped, and only when it really is a header', () => {
    // The tab shows last-injection.md verbatim, so an edited block arrives with the
    // `# …` preamble. A conversation that merely contains a row of `=` must survive.
    assert.match(main, /function stripArchiveHeader\(text: string\): string \{/);
    const fn = main.slice(main.indexOf('function stripArchiveHeader'));
    assert.match(fn.slice(0, fn.indexOf('\n}\n')), /allComments/);
  });
});

describe('the tab says which of the two blocks the next message will carry', () => {
  test('the reader reports the override state, not just the text', () => {
    assert.match(main, /override: !!override,/);
    assert.match(preload, /writeContextOverride: \(sessionId: string, text: string\)/);
    assert.match(preload, /clearContextOverride: \(sessionId: string\)/);
  });

  test('the editor is no longer read-only and has both actions', () => {
    const tab = dialog.slice(dialog.indexOf("tab === 'snapshot'"));
    const body = tab.slice(0, 4000);
    assert.equal(/readOnly/.test(body), false, 'the snapshot editor must be editable');
    // 文案走 i18n（`t('Save and pin')` / `t('Restore auto-generated')`），中文在 i18n.ts 的
    // 字典里，由 tests/i18n.test.ts 钉住。这里断言的是**那两个动作还在**。
    assert.match(body, /t\('Save and pin'\)/);
    assert.match(body, /t\('Restore auto-generated'\)/);
    // The label distinguishes pinned from generated -- the whole point.
    assert.match(body, /snapshot\?\.override[\s\S]{0,260}?Hand-edited context \(pinned\)/);
  });
});
