import React, { useEffect, useState } from 'react';

interface MemoryDialogProps {
  projectId?: string; // current session's project (undefined = unassigned)
  sessionId?: string; // current session (undefined = none open)
  onClose: () => void;
}

type Scope = 'global' | 'project' | 'session';
/** The editable scopes plus a read-only view of what the last send really carried. */
type Tab = Scope | 'snapshot';

export const MemoryDialog: React.FC<MemoryDialogProps> = ({ projectId, sessionId, onClose }) => {
  const [tab, setTab] = useState<Tab>(() => (projectId ? 'project' : 'global'));
  const [text, setText] = useState<Record<Scope, string>>({ global: '', project: '', session: '' });
  const [paths, setPaths] = useState<Record<Scope, string | null>>({ global: '', project: null, session: null });
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Scope | null>(null);
  const [snapshot, setSnapshot] = useState<{ text: string; at: number | null; path: string | null } | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);

  // The selected chat determines the default scope each time the dialog opens
  // or the active session changes while it is open.
  useEffect(() => {
    setTab(projectId ? 'project' : 'global');
  }, [projectId, sessionId]);

  useEffect(() => {
    let alive = true;
    window.kiroApi.readMemory(projectId, sessionId).then((m) => {
      if (!alive) return;
      setText({ global: m.global, project: m.project, session: m.session });
      setPaths({ global: m.globalPath, project: m.projectPath, session: m.sessionPath });
      setLoading(false);
    }).catch(() => setLoading(false));
    return () => { alive = false; };
  }, [projectId, sessionId]);

  // Re-read on every switch to the tab: the archive is rewritten by each send, so a
  // cached copy would go stale the moment another message goes out.
  useEffect(() => {
    if (tab !== 'snapshot') return;
    let alive = true;
    setSnapshotLoading(true);
    window.kiroApi.readLastInjection?.(sessionId)
      .then((r) => { if (alive) { setSnapshot(r); setSnapshotLoading(false); } })
      .catch(() => { if (alive) setSnapshotLoading(false); });
    return () => { alive = false; };
  }, [tab, sessionId]);

  const save = async (scope: Scope) => {
    await window.kiroApi.writeMemory(scope, projectId, sessionId, text[scope]);
    setSaved(scope);
    setTimeout(() => setSaved((s) => (s === scope ? null : s)), 1500);
  };

  const tabs: { scope: Tab; label: string; enabled: boolean; hint: string }[] = [
    { scope: 'global', label: 'Global', enabled: true, hint: 'Applies to all chats everywhere' },
    { scope: 'project', label: projectId ? `Project: ${projectId}` : 'Project (none)', enabled: !!projectId, hint: `Applies to all chats in project "${projectId}"` },
    { scope: 'snapshot', label: '📦 Snapshot', enabled: !!sessionId, hint: '上一次发送实际带给模型的上下文（只读）' },
  ];

  const active = tabs.find((t) => t.scope === tab)!;

  return (
    <>
      <div className="overlay" onClick={onClose} />
      {/* Wider and taller than Settings: this dialog is a TEXT EDITOR with one
          full-width field, not a grid of small controls. `.settings-body` is a
          2-column grid, so every item here also spans both columns — otherwise the
          editor sat in the left half with the right half empty. */}
      <div className="settings-dialog memory-dialog" style={{ width: 'min(960px, 94vw)', height: 'min(78vh, 860px)' }}>
        <div className="settings-header">
          <h3>🧠 Memory</h3>
          <button className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 6, padding: '8px 16px 0' }}>
          {tabs.map((t) => (
            <button
              key={t.scope}
              className={`memory-tab ${tab === t.scope ? 'active' : ''}`}
              onClick={() => setTab(t.scope)}
              disabled={!t.enabled}
              title={t.enabled ? t.hint : 'Not available for this chat'}
            >{t.label}</button>
          ))}
        </div>

        <div className="settings-body">
          {tab === 'snapshot' ? (
            snapshotLoading ? (
              <p className="settings-preview settings-item-wide">Loading…</p>
            ) : (
              <div className="settings-item settings-item-wide" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                <label className="settings-label" style={{ marginBottom: 6 }}>
                  {snapshot?.at
                    ? `上一次发送实际带给模型的上下文 · ${new Date(snapshot.at).toLocaleString()}`
                    : '这个会话还没有注入过上下文'}
                </label>
                <textarea
                  className="memory-textarea"
                  value={snapshot?.text || '（还没有记录：上下文只在实际注入时写入，发一条消息后就会出现）'}
                  readOnly
                  spellCheck={false}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>{(snapshot?.text || '').length} 字符</span>
                  <span style={{ marginLeft: 'auto' }}>{snapshot?.path}</span>
                </div>
              </div>
            )
          ) : loading ? (
            <p className="settings-preview settings-item-wide">Loading…</p>
          ) : !active.enabled ? (
            <p className="settings-preview settings-item-wide">
              {tab === 'project'
                ? "This chat isn't assigned to a project."
                : 'No chat is open.'}
            </p>
          ) : (
            <div className="settings-item settings-item-wide" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <label className="settings-label" style={{ marginBottom: 6 }}>{active.hint}</label>
              <textarea
                className="memory-textarea"
                value={text[tab]}
                onChange={(e) => setText((prev) => ({ ...prev, [tab]: e.target.value }))}
                spellCheck={false}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <button className="rename-popup-btn confirm" onClick={() => save(tab)}>Save</button>
                {saved === tab && <span style={{ color: '#3fb950', fontSize: 12 }}>Saved ✓</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{paths[tab]}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
