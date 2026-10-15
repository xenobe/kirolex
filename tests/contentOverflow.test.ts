import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * WIDE CONTENT MUST NOT PUSH A PANE'S TEXT OUT OF VIEW.
 *
 * Measured in the running app, in a 2x1 split (each pane ~446px wide):
 *
 *   .chat-messages   scrollWidth 540 vs clientWidth 440   -> 100px of text off-screen
 *   a rendered table  791px wide inside a 275px container -> 516px past its box
 *   inline <code>     up to 415px past its parent
 *
 * Two causes, both of which have to be fixed for the symptom to go away:
 *
 *   1. `table { width: 100% }` with the default `table-layout: auto` does NOT bound a
 *      table. Auto layout sizes columns to their content first and only then honours
 *      the declared width, so a table whose cells do not fit simply grows past 100%.
 *      A table needs `display: block; overflow-x: auto` on a wrapper (so it scrolls
 *      inside its own box) or `table-layout: fixed` plus wrapping cells.
 *   2. Inline `<code>` has no wrapping rule, and a long unbroken token (a file path,
 *      an identifier) is a single unbreakable word. `overflow-wrap` on the container
 *      does not help, because the default `overflow-wrap: normal` only breaks at
 *      existing break opportunities -- of which a path has none.
 *
 * The container hides the result (`.chat-messages` pins `overflow-x: hidden`, on
 * purpose -- see its comment), which is why this presents as "text is cut off" rather
 * than as a scrollbar. Hiding the overflow is right; producing it is the bug.
 *
 * Source-structure assertions, like scrollIsolation.test.ts: the layout needs a real
 * browser to measure, so these pin the RULES that keep it bounded.
 */
/** Comments STRIPPED first. These rules are explained by long `/* ... *\/` blocks that
 *  contain braces of their own, so a naive brace scan ends a rule early -- which made a
 *  declaration that was already present read as missing. */
const CSS = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector list contains `needle`. */
function ruleFor(needle: string): string {
  const index = CSS.indexOf(needle);
  if (index === -1) return '';
  const open = CSS.indexOf('{', index);
  const close = CSS.indexOf('}', open);
  return open === -1 || close === -1 ? '' : CSS.slice(open + 1, close);
}

describe('a rendered table stays inside its pane', () => {
  test('tables are bounded, not merely asked to be 100% wide', () => {
    // `width: 100%` alone is what the code had, and it is exactly the declaration that
    // does not work under `table-layout: auto`.
    const table = ruleFor('.message.assistant .message-content table');
    assert.notEqual(table, '', 'no table rule found');
    const bounded = /table-layout:\s*fixed/.test(table) || /max-width:\s*100%/.test(table);
    assert.ok(bounded, 'a table declares width:100% but nothing that actually bounds it');
  });

  test('a table too wide to fit scrolls inside its own box', () => {
    // The escape hatch matters: a 5-column table in a 275px pane cannot be made
    // readable by wrapping alone, so it must be scrollable rather than clipped by the
    // transcript's `overflow-x: hidden`.
    const wrapper = ruleFor('.message.assistant .message-content .md-table-scroll');
    assert.notEqual(wrapper, '', 'no scroll wrapper rule for wide tables');
    assert.match(wrapper, /overflow-x:\s*auto/);
    assert.match(wrapper, /max-width:\s*100%/);
  });

  test('the wrapper is actually emitted, not just styled', () => {
    // react-markdown renders a bare <table>, so a CSS rule for `.md-table-scroll` is
    // dead unless the components map produces that wrapper. A style with no element is
    // the same as no fix.
    const chat = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
    assert.match(chat, /table:\s*\(/, 'MD_COMPONENTS has no table override');
    assert.match(chat, /md-table-scroll/);
  });

  test('cells wrap instead of forcing the table wider', () => {
    const cells = ruleFor('.message.assistant .message-content th,');
    assert.notEqual(cells, '', 'no th/td rule found');
    // Long words inside a narrow column have no break opportunity of their own.
    assert.match(cells, /overflow-wrap:\s*(anywhere|break-word)|word-break:\s*break-word/);
  });
});

describe('long inline tokens wrap instead of spilling', () => {
  test('inline code may break mid-token', () => {
    // A file path or an identifier is one unbreakable word: `overflow-wrap: normal`
    // (the default) finds no break opportunity and lets it run past the container.
    const code = ruleFor('.message.assistant .message-content code');
    assert.notEqual(code, '', 'no inline code rule found');
    assert.match(code, /overflow-wrap:\s*(anywhere|break-word)|word-break:\s*break-\w+/);
  });

  test('the clickable file-path chip wraps too', () => {
    // `.md-file-link` was measured at 444px inside a 275px parent -- it is the widest
    // single offender, because a path is exactly the shape that never breaks.
    const link = ruleFor('.md-file-link');
    assert.notEqual(link, '', 'no md-file-link rule found');
    assert.match(link, /overflow-wrap:\s*(anywhere|break-word)|word-break:\s*break-\w+/);
  });

  test('the transcript still refuses a horizontal scrollbar', () => {
    // Pinned so a future "fix" does not simply reveal the overflow as a draggable
    // scrollbar under every pane. Bounding the content is the fix; hiding what is left
    // is deliberate, and its reasoning is recorded in the CSS.
    assert.match(ruleFor('.chat-messages'), /overflow-x:\s*hidden/);
  });
});
