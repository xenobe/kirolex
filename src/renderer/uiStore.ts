/**
 * ONE shared UI state store, on disk, owned by the main process.
 *
 * Why this exists: localStorage is ORIGIN-SCOPED, and KiroLex loads the renderer
 * from two different origins -- `file://…/index.html` when started normally, and
 * `http://localhost:5173` in dev (Vite HMR). So every switch between `npm start`
 * and `npm run dev:hot` swapped the entire UI state: project groups vanished, the
 * split layout collapsed, fonts and fold settings reset. Verified in Electron's own
 * leveldb, which holds BOTH origins side by side.
 *
 * This is the same class of bug that once made whole CHATS disappear; that was
 * fixed by moving sessions/pinned/archived onto disk. These keys were the gap.
 *
 * API is deliberately localStorage-shaped (`uiGet`/`uiSet`/`uiRemove`, string
 * values, synchronous) so call sites port over one-for-one and existing
 * `useState(() => …)` initializers keep working.
 */

/**
 * `file://` is the AUTHORITATIVE origin: that is where the real, current state
 * lives (the dev origin holds a stale copy from whenever dev mode last ran).
 *
 * So seeding the shared store is one-directional -- only the file:// origin may
 * adopt its localStorage into the shared copy. In dev we read the shared copy and
 * never look at localStorage, otherwise a stale dev value would overwrite good
 * state simply because dev happened to start first.
 */
const AUTHORITATIVE_ORIGIN = (() => {
  try { return window.location.protocol === 'file:'; } catch { return false; }
})();

/** Snapshot handed over synchronously by preload at startup. */
const memory: Record<string, string> = (() => {
  try {
    const initial = (window as any).kiroUiState?.initial;
    if (initial && typeof initial === 'object') return { ...initial } as Record<string, string>;
  } catch {}
  return {};
})();

function persist(key: string, value: string | null): void {
  try { (window as any).kiroUiState?.set?.(key, value); } catch {}
}

export function uiGet(key: string): string | null {
  if (Object.prototype.hasOwnProperty.call(memory, key)) {
    const v = memory[key];
    return v === undefined || v === null ? null : v;
  }
  // Per-key adoption, authoritative origin only.
  if (!AUTHORITATIVE_ORIGIN) return null;
  let legacy: string | null = null;
  try { legacy = localStorage.getItem(key); } catch {}
  if (legacy !== null && legacy !== '') {
    memory[key] = legacy;
    persist(key, legacy);
    return legacy;
  }
  return null;
}

export function uiSet(key: string, value: string): void {
  memory[key] = value;
  persist(key, value);
  // Mirror to the authoritative origin's localStorage as well, so a build without
  // this shim (or an older packaged app) still finds the state. Never mirror from
  // dev: that namespace is the stale one and must not be treated as a source.
  if (AUTHORITATIVE_ORIGIN) {
    try { localStorage.setItem(key, value); } catch {}
  }
}

export function uiRemove(key: string): void {
  delete memory[key];
  persist(key, null);
  if (AUTHORITATIVE_ORIGIN) {
    try { localStorage.removeItem(key); } catch {}
  }
}

/** Everything currently known, for diagnostics. */
export function uiSnapshot(): Record<string, string> {
  return { ...memory };
}

/** True when this window may seed the shared store from its own localStorage. */
export function isAuthoritativeOrigin(): boolean {
  return AUTHORITATIVE_ORIGIN;
}
