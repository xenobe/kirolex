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

/** A stored flex value, or 1 when it is absent or not a usable number.
 *
 *  Needed because `carrySplitSizes` returns stored sizes UNTOUCHED on an exact shape
 *  match, so a corrupted ui-state.json reaches the readers below unvalidated: indexing
 *  a string `rows` yields a character, and a character in `flexGrow` silently collapses
 *  a row to nothing. */
const flexOr1 = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 1);

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

/**
 * Flex grow per pane, per row. The panes divide their row BETWEEN THEM: free capacity
 * to the right of a row is a slim strip of fixed width, not a share of the row.
 *
 * Which shape the free space takes is the one design rule here, and it splits on
 * whether a whole ROW is free or only a CELL:
 *   - a free CELL in a row that already holds a chat is a SLIM STRIP, so the chat in
 *     that row uses the full width. Consequence, accepted deliberately: filling that
 *     cell later halves the pane, and until then the bottom pane's right edge does not
 *     line up with the divider above it.
 *   - a free ROW reserves its real height instead (see `emptyRowFlex`), because half a
 *     window of empty space is what that capacity will actually occupy, and reserving
 *     it means the next chat lands there without moving the rows above.
 *
 * Dragged values are matched by index and inherited from the row above when a row has
 * none of its own, so a divider dragged in the top row stays lined up below.
 *
 * @param rowsOfPanes Rows of pane ids.
 * @param sizes Dragged sizes to read from, already carried for this layout.
 * @returns One array of flex-grow values per row, in pane order.
 */
export function computePaneFlex(rowsOfPanes: PaneRow[], sizes: SplitSizes | null): number[][] {
  return rowsOfPanes.map((row, r) => row.map((_, c) => flexOr1(
    sizes?.cols?.[r]?.[c]
    ?? (r > 0 ? sizes?.cols?.[r - 1]?.[c] : undefined),
  )));
}

/**
 * Free capacity is a slim strip of FIXED size, on both axes -- there is deliberately no
 * function here that sizes it.
 *
 * A previous version gave a fully empty row a real row's height, so that a chat added
 * later landed exactly on the placeholder and the rows above it never resized. That is
 * true, and it was still wrong: with two chats in a 2x2 it turned the bottom half of
 * the window into an empty box. Reserving space for a chat that is not there costs more
 * than the alignment it buys, so the panes on screen always get the whole window and
 * the placeholder stays a hint.
 */
