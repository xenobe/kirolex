import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Composer rules that are easy to break silently, both of them asked for directly.
 *
 * Source-structure assertions: the composer is a React component that needs a DOM,
 * which this runner does not have, so these pin the wiring rather than the pixels.
 */
const CHAT_AREA = path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx');
const src = fs.readFileSync(CHAT_AREA, 'utf8');
const main = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
const css = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8');

describe('the commands panel folds itself when the turn ends', () => {
  const panel = src.slice(src.indexOf('const CommandsPanel = memo'));
  const body = panel.slice(0, panel.indexOf('\nconst FileChangesPanel'));

  test('open while the turn runs, closed once it is over', () => {
    // A pure function of `live`, not an effect syncing state: an effect can fall out of
    // step with the turn it is meant to follow, this cannot.
    assert.match(body, /const \[pinned, setPinned\] = useState<boolean \| null>\(null\);/);
    assert.match(body, /const collapsed = pinned \?\? !live;/);
    // A click pins THIS panel's choice and stops the automatic rule fighting the user.
    assert.match(body, /onClick=\{\(\) => setPinned\(!collapsed\)\}/);
    // `live` must mean "this turn is the running one", not "some turn is running".
    assert.match(src, /<CommandsPanel fileChanges=\{turnFileChanges\} live=\{isStreaming && isLastAssistant\} \/>/);
  });

  test('collapsed shows exactly one line: the first line of the first command', () => {
    assert.match(body, /const preview = commandFirstLine\(cmds\[0\]\.title\);/);
    assert.match(body, /\{collapsed && \(\s*\n\s*<span className="commands-preview"/);
    assert.match(body, /\{cmds\.length > 1 \? ` … \+\$\{cmds\.length - 1\}` : ''\}/);
  });

  test('an entry is one line by default, and the whole command stays reachable', () => {
    // Measured live on a real 29-command turn: every row 1 line, 23 of them multi-line
    // underneath (heredocs), so the old pre-wrap rendering made the panel enormous.
    assert.match(body, /\{open \? commandLabel\(c\.title\) : head\}/);
    assert.match(body, /\{open \? t\('Collapse'\) : `\+\$\{more\} 行`\}/,
      'a multi-line command must offer its remaining lines, not hide them in a tooltip');
    assert.match(src, /function commandFirstLine\(title: string\): \{ head: string; more: number \}/);
  });

  test('the header cannot wrap, or the label steals the preview\'s space', () => {
    // Measured: as an anonymous flex item the bare label wrapped character by character
    // when the preview competed for width -- a 30px header became 58px.
    assert.match(css, /\.turn-panel-head \{[\s\S]*?white-space: nowrap;[\s\S]*?\}/);
    assert.match(css, /\.turn-panel-label \{ flex: 0 0 auto; \}/);
    assert.match(src, /<span className="turn-panel-label">\{t\('⚡ Commands run'\)\}<\/span>/);
    // The preview is the only part allowed to shrink, and it clips instead of wrapping.
    assert.match(css, /\.commands-preview \{[\s\S]*?white-space: nowrap;[\s\S]*?text-overflow: ellipsis;[\s\S]*?\}/);
  });
});

describe('a recorded command does not claim to be running', () => {
  test('the backend "Running:" prefix is stripped for display', () => {
    // Verified from the logs of a real interrupt: the command completed in 0.2s at
    // 01:46:40 and the turn was cut at 01:51:19 with no tool open -- both statements
    // were true, but the panel still read "Running: ls -laht ..." next to the notice
    // saying no tool was running, which reads as a contradiction.
    assert.match(src, /function commandLabel\(title: string\): string/);
    assert.match(src, /replace\(\/\^\\s\*\(\?:running\|executing\|running command\)\\s\*:\\s\*\/i, ''\)/);
    // Reached through commandFirstLine (collapsed / first-line form) and directly in the
    // expanded form -- what matters is that no display path shows the raw title.
    assert.match(src, /function commandFirstLine\(title: string\)[\s\S]*?const text = commandLabel\(title\);/);
    assert.match(src, /\{open \? commandLabel\(c\.title\) : head\}/, 'the panel must render the cleaned label');
  });

  test('live state comes from the status, not from the title text', () => {
    assert.match(src, /function commandStillRunning\(status\?: string\): boolean/);
    assert.match(src, /commandStillRunning\(c\.status\) && <span className="stat-add">\{t\('Running'\)\}<\/span>/);
  });
});

describe('prompt suggestions are multi-select', () => {
  test('the strip does not hide once the composer has text', () => {
    const gate = src.slice(src.indexOf('featureFlags.promptSuggestions !== false'));
    const line = gate.slice(0, gate.indexOf('&& (') + 4);
    // This exact condition is what made a multi-select control single-select: the first
    // chip filled the composer, which unmounted the strip holding the other chips.
    assert.doesNotMatch(line, /input\.trim\(\) === ''/,
      'the chips must stay up while the user is picking');
    // Still scoped to the right moment: nothing is offered while a turn runs.
    assert.match(line, /!isStreaming && !isLooping && suggestions\.length > 0/);
  });

  test('a picked chip is APPENDED, and picking twice removes it', () => {
    const fn = src.slice(src.indexOf('const toggleSuggestion'));
    const body = fn.slice(0, fn.indexOf('}, []);') + 7);
    assert.match(body, /lines\.splice\(at, 1\)/, 'a second click must remove just that line');
    assert.match(body, /`\$\{base\}\\n\$\{pick\}`/, 'a new pick appends instead of replacing');
    // The old version rebuilt the box from the selected set, discarding typed text.
    assert.doesNotMatch(body, /suggestions\.filter/);
  });

  test('chip highlighting is derived from the composer, so it cannot desync', () => {
    assert.match(src, /const selectedSuggestions = useMemo\(/);
    assert.equal((src.match(/setSelectedSuggestions/g) || []).length, 0,
      'no separate selection state: derive it from the text');
  });
});

describe('a composer draft lasts exactly one run', () => {

  test('kept on disk, so nothing within a run can lose it', () => {
    // Not a module variable: a layout change remounts the composer and an HMR reload
    // replaces the whole module, and typed text must survive both.
    assert.match(src, /const COMPOSER_DRAFTS_KEY = 'kirolex-composer-drafts';/);
    assert.match(src, /uiGet\(COMPOSER_DRAFTS_KEY\)/, 'a reload must find the draft again');
    const stash = src.slice(src.indexOf('function stashComposerDraft'));
    assert.match(stash.slice(0, 500), /uiSet\(COMPOSER_DRAFTS_KEY/);
  });

  test('wiped at boot by MAIN, so it never survives a restart', () => {
    // Only main can tell a fresh launch from a reload of the same run; to the renderer
    // both are just a new page, which is why the renderer must not try.
    assert.match(main, /const RUN_SCOPED_UI_STATE_KEYS = new Set\(\['kirolex-composer-drafts'\]\)/);
    assert.match(main, /try \{ clearRunScopedUiState\(\); \} catch \{\}/);
    // uiSet also mirrors into the file:// origin's localStorage, and the boot migration
    // sweep imports every kirolex-* key from there -- so without this the draft would
    // come straight back after being cleared.
    assert.match(main, /if \(RUN_SCOPED_UI_STATE_KEYS\.has\(k\)\) \{ skipped\.push\(k\); continue; \}/);
  });

  test('switching chats still keeps each chat its own draft', () => {
    assert.match(src, /stashComposerDraft\(previous, inputRef\.current\)/);
    assert.match(src, /composerDrafts\[sessionId\] \|\| ''/);
  });
});

describe('the shortcut hint survives a split pane', () => {
  // Reported live: no pane in split view showed the hint, so `MOD+Enter queue` became
  // undiscoverable. The pane container query had inherited 900px from the window-width
  // @media rule, but 1200px window - 240px sidebar, halved, is ~476px -- every pane.

  test('no pane breakpoint hides the hint above a genuinely tiny width', () => {
    // Pull each `@container pane (max-width: Npx)` block and check which ones kill it.
    const blocks = [...css.matchAll(/@container pane \(max-width: (\d+)px\) \{([^}]*(?:\}[^@]*?)*?)\n\}/g)];
    assert.ok(blocks.length >= 3, 'the pane breakpoints should still be there');
    for (const [, width, body] of blocks) {
      if (/\.composer-shortcut\s*\{\s*display:\s*none/.test(body) || /\.composer-shortcut,/.test(body)) {
        assert.ok(Number(width) <= 400,
          `a ${width}px pane still shows the hint; only a genuinely tiny pane may drop it`);
      }
    }
  });

  test('window width does not hide it a second time', () => {
    // The container queries already cover a narrow window, and this rule re-broke it.
    const media = css.slice(css.indexOf('@media (max-width: 900px) {'));
    const body = media.slice(0, media.indexOf('\n}'));
    assert.doesNotMatch(body, /\.composer-shortcut,/);
    assert.doesNotMatch(body, /\.composer-shortcut\s*\{\s*display:\s*none/);
  });

  test('a squeezed pane shortens the hint instead of clipping the queue half', () => {
    // The queue shortcut is the LAST token, so ellipsis would remove exactly it.
    assert.match(css, /\.composer-shortcut-short \{ display: none; \}/);
    assert.match(css, /\.composer-shortcut-full \{ display: none; \}/);
    assert.match(css, /\.composer-shortcut-short \{ display: inline; \}/);
    // And it must be able to shrink at all: a nowrap span with min-width:auto pushes
    // the send button off instead of ellipsizing.
    const rule = css.slice(css.indexOf('.composer-shortcut {'));
    assert.match(rule.slice(0, 400), /min-width: 0;/);
  });

  test('both variants name the queue shortcut', () => {
    const full = src.slice(src.indexOf('<span className="composer-shortcut-full">'));
    assert.match(full.slice(0, 600), /\$\{MOD_KEY\}\+Enter queue/);
    const short = src.slice(src.indexOf('<span className="composer-shortcut-short">'));
    assert.match(short.slice(0, 400), /\$\{MOD_KEY\}\+Enter queue/);
  });
});
