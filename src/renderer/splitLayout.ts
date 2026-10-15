/**
 * Split-pane geometry. Pure functions, no React and no Electron, so the rules can be
 * exercised directly in tests (see tests/splitLayout.test.ts) instead of by dragging
 * dividers in a running app.
 */

/** Dragged proportions for one layout. `rows` is per row, `cols[r]` per cell in row r. */
export type SplitSizes = { shape: string; rows: number[]; cols: number[][] };

/** A row of panes; a cell is a session id, or null for a placeholder row. */
export type PaneRow = (string | null)[];

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

/**
 * Carry dragged proportions across a layout change instead of discarding them.
 *
 * Sizes used to be all-or-nothing: the stored object was honoured only when its
 * `shape` key matched EXACTLY, and that key includes the pane count. So opening a 4th
 * chat in a 2x2 grid ('2x2:3:r' -> '2x2:4:-') threw away every divider the user had
 * dragged -- including the ones whose structure had not changed at all. Going 3 -> 4
 * there still has two rows, and the top row still holds the same two panes; only the
 * bottom row genuinely gains a column. Resetting the row heights and the top row's
 * split as well was pure collateral damage.
 *
 * So: match by INDEX. Rows and columns that still exist keep their exact flex; a newly
 * appeared column takes the average of the ones already in its row, so a row going from
 * one pane to two lands on 50/50.
 *
 * @param stored Previously dragged sizes, or null when nothing was ever dragged.
 * @param shape The current layout key (see the caller's `splitShape`).
 * @param rowsOfPanes The current rows, which decide the output dimensions.
 * @returns Sizes stamped with `shape`, or null when there was nothing to carry.
 */
export function carrySplitSizes(
  stored: SplitSizes | null,
  shape: string,
  rowsOfPanes: PaneRow[],
): SplitSizes | null {
  if (!stored) return null;
  if (stored.shape === shape) return stored;
  const storedRows = Array.isArray(stored.rows) ? stored.rows : [];
  const storedCols = Array.isArray(stored.cols) ? stored.cols : [];
  return {
    shape,
    rows: rowsOfPanes.map((_, r) => storedRows[r] ?? avg(storedRows)),
    cols: rowsOfPanes.map((row, r) => {
      const prev = Array.isArray(storedCols[r]) ? storedCols[r] : [];
      const fill = avg(prev);
      return row.map((_, c) => prev[c] ?? fill);
    }),
  };
}

/** One row's cell widths: the panes, plus the trailing empty cell when it has one. */
export interface RowCells {
  /** Flex grow per pane, in row order. */
  paneFlex: number[];
  /** Flex grow of the trailing empty cell; 0 when the row has none. */
  emptyFlex: number;
}

/**
 * Per-row cell widths, INCLUDING the trailing empty cell when the row has one.
 *
 * The empty slot used to be a fixed 56px sliver, which is what made every added pane
 * shove the existing ones: the thinner the sliver, the more the real panes spread out,
 * so the next pane had that much more to take back. With 3 chats in a 2x2 the bottom
 * pane spanned the whole row and then halved the moment a 4th arrived, and its edge
 * never lined up with the row above it.
 *
 * So an empty slot is a REAL CELL that takes the rest of its row, and its width comes
 * from the ROW ABOVE -- a pane added later therefore lands exactly on the cell the
 * placeholder occupied and nothing else moves. With no row above to copy, the row is
 * split evenly. Own dragged values always win over inherited ones.
 *
 * @param rowsOfPanes Rows of pane ids.
 * @param opts.stripRight True when the LAST row has free capacity to its right.
 * @param opts.splitCols Columns in the chosen grid, e.g. 2 for `2x2`.
 * @param opts.sizes Dragged sizes to read from, already carried for this layout.
 */
export function computeRowCells(
  rowsOfPanes: PaneRow[],
  opts: { stripRight: boolean; splitCols: number; sizes: SplitSizes | null },
): RowCells[] {
  const { stripRight, splitCols, sizes } = opts;
  return rowsOfPanes.map((row, r) => {
    const wantsEmpty = stripRight && r === rowsOfPanes.length - 1;
    const aboveLen = r > 0 ? (rowsOfPanes[r - 1]?.length ?? 0) : 0;
    // How many grid columns this row spans: match the row above when there is one,
    // otherwise just the panes plus the single empty cell.
    const cols = wantsEmpty
      ? Math.max(row.length + 1, Math.min(splitCols, aboveLen || row.length + 1))
      : row.length;
    const flexOf = (c: number): number => (
      sizes?.cols?.[r]?.[c]
      ?? (r > 0 ? sizes?.cols?.[r - 1]?.[c] : undefined)
      ?? 1
    );
    let emptyFlex = 0;
    for (let c = row.length; c < cols; c++) emptyFlex += flexOf(c);
    return {
      paneFlex: row.map((_, c) => flexOf(c)),
      emptyFlex: wantsEmpty ? (emptyFlex || 1) : 0,
    };
  });
}
