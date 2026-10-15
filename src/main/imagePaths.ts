/**
 * Image-path rewriting for outgoing text. Pure: no Electron, no filesystem, so the
 * pattern that caused a day of Bedrock rejections is directly testable
 * (see tests/imagePaths.test.ts) instead of only observable through a live turn.
 *
 * Background: Bedrock rejects an entire request when ANY image in the conversation
 * exceeds 2000px on a side, and because the whole history is replayed every turn, one
 * oversized image poisons that backend session permanently -- shrinking the file on
 * disk afterwards does not help. KiroLex therefore rewrites every image path it is
 * about to hand over so it points at a downscaled copy. The subtle part is *finding*
 * the paths: they appear not only in attachment refs but in prose and, crucially, in
 * replayed TOOL-CALL records ("[read] Reading image /…/x.png"), which the model
 * happily re-reads.
 */

/** Every ABSOLUTE image path in a text, POSIX or Windows.
 *
 *  Matching is deliberately liberal: real paths here contain spaces and CJK, e.g.
 *  `/tmp/…/支付行业 GenAI 落地方案（AWS风格重构版）_contact.png`. That is safe because
 *  the mapper passed to rewriteImagePaths returns its input unchanged for anything that
 *  is not an existing, decodable, oversized image -- so an over-eager match is a no-op.
 *
 *  Two alternatives, POSIX (`/…`) and Windows drive (`C:\\…`). The Windows branch is
 *  not decorative: without it the whole mechanism silently did nothing on Windows,
 *  because every path in a prompt, a history snapshot or a tool-call record starts with
 *  a drive letter there rather than a slash. */
export const IMAGE_PATH_IN_TEXT_RE =
  /(?:[A-Za-z]:\\[^\n\r\t"'<>|?*]+?|\/(?:[^\n\r\t"'<>|?*]+?))\.(?:png|jpe?g|webp|gif|bmp)(?=$|[\s"'`)\],;:]|$)/giu;

/** True when a text could possibly contain a path at all.
 *
 *  Must accept BOTH separators, or the Windows branch of the pattern could never fire
 *  (a `C:\\…` path contains no forward slash). This guard exists only to skip the regex
 *  on the overwhelming majority of texts that mention no path. */
export function mayContainPath(text: string): boolean {
  return !!text && (text.includes('/') || text.includes('\\'));
}

/**
 * Rewrite every image path in `text` through `mapper`.
 *
 * @param text Arbitrary outgoing text: a prompt, a steer, or a rendered history line.
 * @param mapper Given a matched path, return the path to use instead. Returning the
 *   input unchanged is the correct answer for anything that needs no capping, which is
 *   what makes liberal matching safe.
 * @returns The text with every matched path replaced.
 */
export function rewriteImagePaths(text: string, mapper: (p: string) => string): string {
  if (!mayContainPath(text)) return text;
  return text.replace(IMAGE_PATH_IN_TEXT_RE, (match) => mapper(match));
}
