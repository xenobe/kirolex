import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  carrySplitSizes,
  computePaneFlex,
  type SplitSizes,
  type PaneRow,
} from '../src/renderer/splitLayout.ts';

/** Rows for `n` panes laid out in `cols` columns, as App.tsx builds them. */
function rows(n: number, cols: number): PaneRow[] {
  const panes = Array.from({ length: n }, (_, i) => `p${i}`);
  const out: PaneRow[] = [];
  for (let i = 0; i < panes.length; i += cols) out.push(panes.slice(i, i + cols));
  return out.length ? out : [[null]];
}

/** Each pane's share of its row, in percent, rounded -- what the user actually sees. */
function widths(paneFlex: number[]): number[] {
  const total = paneFlex.reduce((a, b) => a + b, 0);
  return paneFlex.map((f) => Math.round((100 * f) / total));
}

describe('carrySplitSizes', () => {
  test('nothing stored carries nothing', () => {
    assert.equal(carrySplitSizes(null, '2x2:4:-', rows(4, 2)), null);
  });

  test('an exact shape match is returned untouched', () => {
    const stored: SplitSizes = { shape: '2x2:4:-', rows: [1.4, 0.6], cols: [[1.3, 0.7], [1, 1]] };
    assert.equal(carrySplitSizes(stored, '2x2:4:-', rows(4, 2)), stored);
  });

  test('3 -> 4 panes keeps the row heights and the untouched row', () => {
    const stored: SplitSizes = { shape: '2x2:3:r', rows: [1.4, 0.6], cols: [[1.3, 0.7], [1]] };
    const carried = carrySplitSizes(stored, '2x2:4:-', rows(4, 2))!;
    assert.deepEqual(carried.rows, [1.4, 0.6], 'row heights must not move');
    assert.deepEqual(carried.cols[0], [1.3, 0.7], 'the unchanged row must not move');
    // The bottom row genuinely gains a column; the newcomer takes the row average.
    assert.deepEqual(carried.cols[1], [1, 1]);
    assert.equal(carried.shape, '2x2:4:-');
  });

  test('a row that loses a column simply drops it', () => {
    const stored: SplitSizes = { shape: '2x2:4:-', rows: [1.4, 0.6], cols: [[1.3, 0.7], [1.2, 0.8]] };
    const carried = carrySplitSizes(stored, '2x2:3:r', rows(3, 2))!;
    assert.deepEqual(carried.cols[1], [1.2]);
    assert.deepEqual(carried.rows, [1.4, 0.6]);
  });

  test('a brand-new row falls back to the average of the existing ones', () => {
    const stored: SplitSizes = { shape: '1x2:2:-', rows: [2], cols: [[1, 1]] };
    const carried = carrySplitSizes(stored, '2x2:3:r', rows(3, 2))!;
    assert.deepEqual(carried.rows, [2, 2]);
  });

  test('malformed stored data does not throw', () => {
    const junk = { shape: 'x', rows: undefined, cols: 'nope' } as unknown as SplitSizes;
    const carried = carrySplitSizes(junk, '2x2:4:-', rows(4, 2))!;
    assert.deepEqual(carried.rows, [1, 1]);
    assert.deepEqual(carried.cols, [[1, 1], [1, 1]]);
  });
});

describe('computePaneFlex: panes divide their row, the free cell beside them does not', () => {
  test('2x2, three panes: the bottom pane takes the WHOLE row', () => {
    const flex = computePaneFlex(rows(3, 2), null);
    assert.deepEqual(widths(flex[0]), [50, 50]);
    // One flexible child, so it takes the row minus the fixed-width strip. This is the
    // rule Yinan asked for: free capacity to the right is a sliver, not half a row.
    assert.deepEqual(flex[1].length, 1);
    assert.deepEqual(widths(flex[1]), [100]);
  });

  test('a dragged top row is inherited by the row below, so the divider lines up', () => {
    const sizes: SplitSizes = { shape: '2x2:4:-', rows: [1, 1], cols: [[1.3, 0.7]] };
    const flex = computePaneFlex(rows(4, 2), sizes);
    assert.deepEqual(widths(flex[0]), [65, 35]);
    assert.deepEqual(widths(flex[1]), [65, 35], 'inherited from the row above');
  });

  test("a row's own dragged values win over the inherited ones", () => {
    const sizes: SplitSizes = { shape: 's', rows: [1, 1], cols: [[1.3, 0.7], [0.5, 1.5]] };
    const flex = computePaneFlex(rows(4, 2), sizes);
    assert.deepEqual(widths(flex[0]), [65, 35]);
    assert.deepEqual(widths(flex[1]), [25, 75]);
  });

  test('one pane per row still gets a flex value, so nothing collapses', () => {
    const flex = computePaneFlex(rows(2, 1), null);
    assert.deepEqual(flex, [[1], [1]]);
  });
});

describe('free capacity never takes space from the panes on screen', () => {
  test('there is no sizing function for the empty slot, on either axis', async () => {
    // A fully empty row briefly reserved a real row's height (so a third chat would
    // land exactly on the placeholder). With two chats that made the bottom half of the
    // window an empty box, which is not worth the alignment. Both axes are a fixed slim
    // strip now, so the panes always get the whole window -- assert the sizing helpers
    // are gone rather than trusting a comment.
    const mod = await import('../src/renderer/splitLayout.ts');
    assert.equal('emptyRowFlex' in mod, false, 'an empty row must not be given a height');
    assert.equal('freeRowIsSliver' in mod, false, 'no exception: the strip is always slim');
  });

  test('the panes divide the whole row between them', () => {
    // Two panes in a row: 50/50, with no third share held back for a placeholder.
    const flex = computePaneFlex(rows(2, 2), null);
    assert.deepEqual(widths(flex[0]), [50, 50]);
  });
});

describe('closing the last pane returns to the opening screen, keeping the grid setting', () => {
  const app = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'),
    'utf8',
  );
  const hook = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'),
    'utf8',
  );

  test('removing the last pane does not rewrite the grid setting', () => {
    // It used to do `setSettings(cur => ({ ...cur, splitGrid: '1x1' }))`, so one
    // action ("remove this pane") silently changed the layout setting too, and getting
    // back meant re-picking both the grid and the chats.
    const fn = app.slice(app.indexOf('const toggleSplitSession'));
    const body = fn.slice(0, fn.indexOf('\n  }, ['));
    assert.equal(
      /splitGrid: '1x1'/.test(body),
      false,
      'closing the last pane must leave split mode ON with an empty grid',
    );
    assert.match(body, /setSplitSessionIds\(\[\]\);\s*\n\s*setLastActiveSessionId\(currentSessionId\);\s*\n\s*unfocusSession\(\);/);
  });

  test('the sidebar keeps highlighting the chat you were in', () => {
    // The focus is dropped, but "where I was" must not be: the row stays highlighted so
    // one click reopens it (and re-splits). Driven by a separate value rather than by
    // currentSessionId, which has to stay null -- see the two effects that would
    // otherwise refill the grid.
    assert.match(app, /const highlightSessionId = currentSessionId \|\| lastActiveSessionId;/);
    assert.match(app, /currentSessionId=\{highlightSessionId\}/);
    // …and it is dropped again as soon as anything is focused, so it cannot go stale.
    assert.match(app, /if \(currentSessionId && lastActiveSessionId\) setLastActiveSessionId\(null\);/);
  });

  test('it also drops the focus, or the grid refills itself', () => {
    // "Focused" and "on screen" are the same thing in a single pane but not in a grid:
    // a chat left focused while unassigned is adopted straight back into a slot by the
    // layout effects, which is what made the split collapse instead of emptying.
    assert.match(hook, /const unfocusSession = useCallback\(\(\) => \{/);
    assert.match(hook, /unfocusSession,/);          // exported
    // The two effects that would refill it both bail without a focused chat.
    assert.match(app, /if \(splitSessionIds\.length === 0 && currentSessionId/);
    assert.match(app, /if \(!currentSessionId \|\| splitSessionIds\.length === 0\) return;/);
  });

  test('an empty split lands on the ordinary opening screen', () => {
    // NOT a grid of placeholders: with nothing assigned there is no grid to draw, and
    // the fallback below resolves to null (no assignment, no focus), which is exactly
    // the screen a fresh launch shows. An earlier attempt rendered a full-area "add a
    // chat here" strip instead -- it kept the grid on screen, but the app is supposed
    // to look like it does at start.
    assert.match(app, /const splitActive = splitCapacity > 1 && splitSessionIds\.length > 0;/);
    assert.match(app, /renderPane\(panes\[0\] \|\| currentSessionId, true, false\)/);
    assert.equal(
      /renderAddStrip\(false, \{ flexGrow: 1/.test(app),
      false,
      'the empty state is the opening screen, not a full-area add placeholder',
    );
  });

  test('the grid SETTING survives, so putting a chat back re-splits', () => {
    // The setting is the only thing that must not be touched: with it intact, the seed
    // effect puts the next focused chat into slot 1 and the grid returns by itself.
    assert.match(app, /if \(splitSessionIds\.length === 0 && currentSessionId/);
    const fn = app.slice(app.indexOf('const toggleSplitSession'));
    assert.equal(/splitGrid: '1x1'/.test(fn.slice(0, fn.indexOf('\n  }, ['))), false);
  });
});
