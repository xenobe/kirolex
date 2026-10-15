import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { filterEntries, filterNote } from '../workspaceFilter';
import { useT } from '../hooks/useLang';
import {
  IconArrowUp,
  IconClose,
  IconFile,
  IconFolder,
  IconRefresh,
} from './Icons';

interface WorkspaceEntry {
  name: string;
  isDir: boolean;
}

interface WorkspaceListing {
  path: string;
  parent: string;
  entries: WorkspaceEntry[];
}

interface WorkspacePanelProps {
  /** OPTIONAL hint only: when a chat is connected its cwd becomes the default
   *  directory. The browser is NOT tied to a session -- it lists local disk, so it
   *  must work with no chat open, a dormant chat, or while one is still attaching. */
  sessionId: string | null;
  onClose: () => void;
  /** Hand the file to the app's single shared file viewer (right-hand tabbed
   *  panel). Non-previewable types are routed to the OS default app in there,
   *  so this panel no longer needs a preview modal of its own. */
  onOpenFile: (path: string) => void;
}

/** Remembering where the user was browsing is a GLOBAL app preference (not
 *  per session), so it lives in ~/.kirolex/config.json via IPC rather than in
 *  origin-scoped localStorage. */

/** The location being browsed, held for the whole app run and mirrored to disk.
 *
 *  Module scope on purpose. The panel unmounts whenever it is closed, and it used to
 *  re-seed itself from disk on every remount AND on every chat switch. Since the disk
 *  write is fire-and-forget, that re-read could land before the last write did and put
 *  the user back in the previous directory. Reading this first makes a remount exact
 *  within a run; disk is only consulted for the first mount after a restart. */
let lastBrowsedDir: string | null = null;

/** Record the current location both in memory and on disk. */
function remember(dir: string): void {
  lastBrowsedDir = dir;
  void window.kiroApi.setWorkspaceDir?.(dir);
}

export const WorkspacePanel: React.FC<WorkspacePanelProps> = ({ sessionId, onClose, onOpenFile }) => {
  const t = useT();
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 当前目录里的过滤词。**不跨目录保留** —— 见换目录时清空它的那一处。 */
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const load = useCallback((directory?: string) => {
    setLoading(true);
    setError(null);
    window.kiroApi.workspaceList(sessionId, directory)
      .then((result) => {
        setListing(result);
        remember(result.path);
      })
      .catch((loadError: any) => {
        // A remembered directory can disappear (deleted, or a session whose cwd
        // cannot reach it). Fall back to the session default instead of showing
        // an error the user cannot act on.
        if (directory) {
          setError(null);
          window.kiroApi.workspaceList(sessionId)
            .then((result) => {
              setListing(result);
              remember(result.path);
            })
            .catch((e: any) => setError(e?.message || 'Failed to list directory.'))
            .finally(() => setLoading(false));
          return;
        }
        setError(loadError?.message || 'Failed to list directory.');
      })
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Seed ONCE per mount. The deps used to be [sessionId, load], so every chat
      // switch re-ran this and re-derived the location from disk -- your place in the
      // tree was lost just for switching chats, and a switch that raced the
      // fire-and-forget write could even restore the PREVIOUS directory. In-memory
      // first, disk only for the first mount after a restart.
      const remembered = lastBrowsedDir
        ?? (await window.kiroApi.getWorkspaceDir?.().catch(() => null));
      if (!cancelled) load(remembered || undefined);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openEntry = useCallback((entry: WorkspaceEntry) => {
    if (!listing) return;
    const fullPath = listing.path.endsWith('/')
      ? `${listing.path}${entry.name}`
      : `${listing.path}/${entry.name}`;
    if (entry.isDir) {
      /*
        进目录就**清掉过滤词**。留着它的话新目录一开就是过滤后的样子 —— 而你刚换了地方,
        看到的却是个残缺列表,最容易被读成「这个目录里只有这些东西」。
      */
      setQuery('');
      load(fullPath);
      return;
    }
    onOpenFile(fullPath);
  }, [listing, load, onOpenFile]);

  /** 过滤只作用于**当前目录已经拿到的那份列表**,不发 IPC。 */
  const entries = listing?.entries || [];
  const shown = useMemo(() => filterEntries(entries, query), [entries, query]);
  const note = filterNote({ query, shown: shown.length, total: entries.length });

  return (
    <aside className="workspace-panel" aria-label="Workspace files">
      <div className="workspace-header">
        <h3><IconFolder size={17} /> {t('Workspace')}</h3>
        <button className="settings-close" onClick={onClose} title={t('Close workspace')}>
          <IconClose size={16} />
        </button>
      </div>

      {/* No `!sessionId` branch: the old "Open a chat to browse its workspace."
          placeholder (and the IPC refusal behind it) made a plain directory listing
          conditional on a backend that has nothing to do with reading disk. */}
      <div className="workspace-path" title={listing?.path}>
        <button
          className="workspace-up"
          disabled={!listing || listing.parent === listing.path}
          onClick={() => listing && load(listing.parent)}
          title={t('Up one level')}
        >
          <IconArrowUp size={15} />
        </button>
        <span className="workspace-path-text">{listing?.path || '…'}</span>
        <button className="workspace-up" onClick={() => load(listing?.path)} title={t('Refresh')}>
          <IconRefresh size={14} />
        </button>
      </div>

      {/*
        文件搜索 —— 「浏览文件的界面也要单独有搜索功能」。
        它和聊天里那个 Cmd+F 是两件事:这里过滤的是**条目列表**（改变列出什么),
        那里是在已渲染的文字里找词（不改变列出什么）。所以两者不共用状态,也不互相打断。
      */}
      <div className="ws-search">
        <input
          ref={searchRef}
          className="ws-search-input"
          placeholder={t('Filter in this directory…')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Esc 先清词,已经空了才让它冒泡出去关面板 —— 不然一次 Esc 同时干两件事
            if (e.key === 'Escape') {
              if (query) { e.preventDefault(); e.stopPropagation(); setQuery(''); return; }
              return;
            }
            // 唯一一个命中时 Enter 直接打开它:搜到底就是为了打开那一个
            if (e.key === 'Enter' && shown.length === 1) {
              e.preventDefault();
              openEntry(shown[0]);
            }
          }}
        />
        {query && (
          <button className="ws-search-x" onClick={() => { setQuery(''); searchRef.current?.focus(); }} title={t('Clear (Esc)')}>✕</button>
        )}
      </div>
      {!!note && <div className="ws-search-note">{note}</div>}

      <div className="workspace-body">
        <div className="workspace-tree">
          {loading && <div className="workspace-hint">{t('Loading…')}</div>}
          {error && <div className="workspace-error">⚠️ {error}</div>}
          {!loading && !error && entries.length === 0 && (
            <div className="workspace-hint">{t('(empty directory)')}</div>
          )}
          {/* 目录非空但过滤后为 0：说明写在上面那行 `note` 里,这里不再摆一个会被读成「空目录」的提示 */}
          {!loading && !error && shown.map((entry) => (
            <button
              key={entry.name}
              className="workspace-entry"
              onClick={() => openEntry(entry)}
              title={entry.name}
            >
              <span className="workspace-entry-icon">
                {entry.isDir ? <IconFolder size={15} /> : <IconFile size={15} />}
              </span>
              <span className="workspace-entry-name">{entry.name}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
};
