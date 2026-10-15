/**
 * PULLING THE JSON OUT OF A MODEL'S REPLY — pure, and the reason two whole turns were silently lost.
 *
 * The old version was one line: `text.match(/```(?:json)?\s*([\s\S]*?)```/)` and then `JSON.parse`. Both
 * real failures came from it:
 *
 *   · A reply with TWO fenced blocks (an explanation, then the structure) matched the FIRST — `*?` stops at
 *     the first closing fence — so a fragment reached JSON.parse and threw 「Unexpected end of JSON input」.
 *     That reads exactly like a truncated reply, and I went looking for an output-length problem that was
 *     not there. The weekly-report structure had been complete all along.
 *   · A reply whose fence was never closed matched nothing, so the entire text went to JSON.parse.
 *
 * So fences are ignored entirely. Every `{` is a candidate start; from each, walk forward with a depth
 * counter that understands strings and escapes, and return the first BALANCED object that parses. A reply
 * that really is cut off returns null — and the caller says 「被截断了」 rather than showing nothing.
 */

/** The balanced object starting at `from`, or null if it never closes. */
function balancedFrom(text: string, from: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(from, i + 1);
    }
  }
  return null;
}

export function extractJson(text: string): unknown | null {
  const raw = String(text || '');
  for (let i = raw.indexOf('{'); i >= 0; i = raw.indexOf('{', i + 1)) {
    const candidate = balancedFrom(raw, i);
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // A balanced but invalid object (a stray fence marker inside, say) — keep looking.
    }
  }
  return null;
}
