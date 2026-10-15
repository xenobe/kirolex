/**
 * FINDING A CHAT BY NAME — pure, so the sidebar's filtering can be reasoned about without a DOM.
 *
 * Two rules that are not obvious until you use it:
 *
 *   A GROUP WITH A HIT OPENS ITSELF. Most projects are collapsed (untouched for a week, see `projectActivity`),
 *   and a search that leaves the match hidden inside a folded group reads as "found nothing".
 *   THE PROJECT NAME COUNTS as text. Typing 「周报」 to find that project's chats is the same intent as typing a
 *   chat's title, and requiring the exact title turns a search box into a spelling test.
 */
export interface Searchable {
  id: string;
  title: string;
  projectId?: string;
  archived?: boolean;
}

export interface SearchResult<T> {
  /** Matching sessions, order preserved from the input. */
  hits: T[];
  /** Projects that contain a hit — the sidebar opens these while a query is active. */
  projects: string[];
  /** True when no query is active, so callers can skip filtering entirely. */
  idle: boolean;
}

export function searchSessions<T extends Searchable>(sessions: T[], query: string): SearchResult<T> {
  const q = (query || '').trim().toLowerCase();
  if (!q) return { hits: sessions, projects: [], idle: true };
  const hits = sessions.filter((s) => {
    const title = (s.title || '').toLowerCase();
    const project = (s.projectId || '').toLowerCase();
    return title.includes(q) || project.includes(q);
  });
  return {
    hits,
    projects: Array.from(new Set(hits.map((s) => (s.projectId || '').trim()).filter(Boolean))),
    idle: false,
  };
}
