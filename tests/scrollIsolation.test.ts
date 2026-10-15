import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A pane must never scroll anything outside itself.
 *
 * `element.scrollIntoView()` scrolls EVERY scrollable ancestor, and `overflow: hidden`
 * does not opt an element out -- such a container is still programmatically scrollable.
 * In split view the chain above a transcript (`.chat-main` -> `.chat-row` ->
 * `.chat-grid`) is shared with the other panes and entirely `overflow: hidden`, so one
 * pane's scrollIntoView displaced the whole grid, with no scrollbar to undo it.
 *
 * These are source-structure assertions: the behaviour lives in a React component that
 * needs a DOM, which this runner does not have. They pin the rule, not the pixels.
 */
const SRC = path.join(import.meta.dirname, '..', 'src', 'renderer');

/** Every .ts/.tsx file under src/renderer, with comment lines dropped. */
function rendererSources(): { file: string; code: string }[] {
  const out: { file: string; code: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        const code = fs.readFileSync(full, 'utf8')
          .split('\n')
          // Drop line comments and the body of block comments, so the explanations of
          // WHY scrollIntoView is banned do not trip the ban itself.
          .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l))
          .join('\n');
        out.push({ file: path.relative(SRC, full), code });
      }
    }
  };
  walk(SRC);
  return out;
}

describe('a pane scrolls only itself', () => {
  test('no renderer code calls scrollIntoView', () => {
    const offenders = rendererSources()
      .filter(({ code }) => /\.scrollIntoView\s*\(/.test(code))
      .map(({ file }) => file);
    assert.deepEqual(offenders, [], 'use scrollContainerToBottom / revealInContainer instead: '
      + 'scrollIntoView also scrolls the shared overflow:hidden grid above the pane');
  });

  test('the jump-to-latest button scrolls this transcript, instantly', () => {
    const src = fs.readFileSync(path.join(SRC, 'components', 'ChatArea.tsx'), 'utf8');
    const jump = src.slice(src.indexOf('const jumpToBottom'), src.indexOf('const jumpToBottom') + 1800);
    assert.match(jump, /scrollContainerToBottom\(chatMessagesRef\.current/);
    // Not smooth: a smooth scroll from high up in the transcript fires scroll events
    // that trigger loadOlder(), whose scroll-compensating write then cancels the
    // animation -- the view stopped mid-transcript instead of at the latest message.
    assert.doesNotMatch(jump, /behavior:\s*'smooth'/);
  });

  test('the bottom-scroll helper re-asserts once, under a guard', () => {
    const src = fs.readFileSync(path.join(SRC, 'components', 'ChatArea.tsx'), 'utf8');
    const helper = src.slice(src.indexOf('function scrollContainerToBottom'));
    const body = helper.slice(0, helper.indexOf('\n}') + 2);
    // Late-settling content (markdown, highlighting, images) grows the height after
    // the first write, so one write alone leaves the view short of the bottom.
    assert.match(body, /requestAnimationFrame/);
    assert.match(body, /if \(stillWanted\(\)\)/, 'the second write must not yank back a user who scrolled away');
  });
});
