import React, { useCallback, useEffect, useState } from 'react';
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
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      load(fullPath);
      return;
    }
    onOpenFile(fullPath);
  }, [listing, load, onOpenFile]);

  return (
    <aside className="workspace-panel" aria-label="Workspace files">
      <div className="workspace-header">
        <h3><IconFolder size={17} /> Workspace</h3>
        <button className="settings-close" onClick={onClose} title="Close workspace">
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
          title="Up one level"
        >
          <IconArrowUp size={15} />
        </button>
        <span className="workspace-path-text">{listing?.path || '…'}</span>
        <button className="workspace-up" onClick={() => load(listing?.path)} title="Refresh">
          <IconRefresh size={14} />
        </button>
      </div>

      <div className="workspace-body">
        <div className="workspace-tree">
          {loading && <div className="workspace-hint">Loading…</div>}
          {error && <div className="workspace-error">⚠️ {error}</div>}
          {!loading && !error && listing?.entries.length === 0 && (
            <div className="workspace-hint">(empty directory)</div>
          )}
          {!loading && !error && listing?.entries.map((entry) => (
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
