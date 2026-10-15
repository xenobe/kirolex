import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  carrySplitSizes,
  computeRowCells,
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

/** Each cell's share of its row, in percent, rounded -- what the user actually sees. */
function widths(cells: { paneFlex: number[]; emptyFlex: number }): number[] {
  const total = cells.paneFlex.reduce((a, b) => a + b, 0) + cells.emptyFlex;
  const out = cells.paneFlex.map((f) => Math.round((100 * f) / total));
  if (cells.emptyFlex) out.push(Math.round((100 * cells.emptyFlex) / total));
  return out;
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

describe('computeRowCells: an empty slot is a real cell, not a sliver', () => {
  test('2x2, one pane: only one row, so the row is split in half', () => {
    const cells = computeRowCells(rows(1, 1), { stripRight: true, splitCols: 2, sizes: null });
    assert.deepEqual(widths(cells[0]), [50, 50]);
  });

  test('2x2, three panes: the bottom pane keeps ONE column, not the whole row', () => {
    const cells = computeRowCells(rows(3, 2), { stripRight: true, splitCols: 2, sizes: null });
    assert.deepEqual(widths(cells[0]), [50, 50]);
    assert.deepEqual(widths(cells[1]), [50, 50], 'pane + empty cell, each half');
  });

  test('2x2, 3 -> 4 panes moves nothing: the newcomer lands on the placeholder', () => {
    const three = computeRowCells(rows(3, 2), { stripRight: true, splitCols: 2, sizes: null });
    const four = computeRowCells(rows(4, 2), { stripRight: false, splitCols: 2, sizes: null });
    assert.deepEqual(widths(four[0]), widths(three[0]));
    // The empty half becomes the 4th pane, so both rows read the same before and after.
    assert.deepEqual(widths(four[1]), widths(three[1]));
  });

  test('a dragged top row is inherited by the row below, so the divider lines up', () => {
    const sizes: SplitSizes = { shape: '2x2:3:r', rows: [1, 1], cols: [[1.3, 0.7]] };
    const cells = computeRowCells(rows(3, 2), { stripRight: true, splitCols: 2, sizes });
    assert.deepEqual(widths(cells[0]), [65, 35]);
    assert.deepEqual(widths(cells[1]), [65, 35], 'inherited from the row above');
  });

  test("a row's own dragged values win over the inherited ones", () => {
    const sizes: SplitSizes = { shape: 's', rows: [1, 1], cols: [[1.3, 0.7], [0.5, 1.5]] };
    const cells = computeRowCells(rows(4, 2), { stripRight: false, splitCols: 2, sizes });
    assert.deepEqual(widths(cells[0]), [65, 35]);
    assert.deepEqual(widths(cells[1]), [25, 75]);
  });

  test('a full grid has no empty cell at all', () => {
    const cells = computeRowCells(rows(4, 2), { stripRight: false, splitCols: 2, sizes: null });
    for (const c of cells) assert.equal(c.emptyFlex, 0);
  });

  test('the placeholder spans EVERY remaining column of the row', () => {
    // 3 columns, 4 panes: row 1 holds one pane and two free columns.
    const sizes: SplitSizes = { shape: 's', rows: [1, 1], cols: [[1.5, 0.8, 0.7]] };
    const cells = computeRowCells(rows(4, 3), { stripRight: true, splitCols: 3, sizes });
    assert.deepEqual(widths(cells[0]), [50, 27, 23]);
    // The pane keeps column 0's width; the placeholder covers columns 1 and 2.
    assert.deepEqual(widths(cells[1]), [50, 50]);
  });
});
