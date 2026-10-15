/**
 * WHAT A PASTE MEANS — PURE. No DOM, no IPC.
 *
 * Extracted from the composer's paste handler because the condition in it was wrong in a way that
 * could not be seen by reading it: `if (hasImage && !plain)` took the image ONLY when no text came
 * with it. Every paste from a browser, Word, Excel or a chat app carries an image AND its alt
 * text / URL / cell content, so all of those images were dropped in silence — the user saw only
 * the text arrive and reasonably concluded the image FORMAT was unsupported.
 *
 * The old condition was protecting something real: its comment said that preventing the default
 * and then failing to save the image would silently eat the text. That protection survives here
 * without the either/or — when text is present the default is NOT prevented, so the text lands the
 * ordinary way and the image is attached on top of it. Neither can be lost.
 */

export interface PasteInput {
  /** Is there an image flavour on the clipboard? */
  hasImage: boolean;
  /** `text/plain`, verbatim. */
  plain: string;
  /** Clipboard files that carry a real on-disk path (a Finder copy, not an in-memory bitmap). */
  filesWithPaths: number;
}

export interface PasteDecision {
  kind: 'files' | 'image' | 'text';
  /** Attach the clipboard bitmap via `saveClipboardImage`. */
  attachImage: boolean;
  /**
   * Suppress the browser's own paste.
   *
   * FALSE whenever text came along, and that is the whole point: the text must land even if
   * saving the image fails.
   */
  preventDefault: boolean;
}

export function decidePaste(input: PasteInput): PasteDecision {
  // A copied FILE carries its path and is attached by reference — better than re-encoding a
  // bitmap, which loses the original name.
  if (input.filesWithPaths > 0) {
    return { kind: 'files', attachImage: false, preventDefault: true };
  }
  if (input.hasImage) {
    // Whitespace is not text: a trailing newline beside a screenshot must not be treated as
    // content worth protecting, or every screenshot paste leaves a blank line behind.
    const hasText = input.plain.trim().length > 0;
    return { kind: 'image', attachImage: true, preventDefault: !hasText };
  }
  return { kind: 'text', attachImage: false, preventDefault: false };
}
