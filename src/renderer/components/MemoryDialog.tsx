import React, { useEffect, useState } from 'react';

interface MemoryDialogProps {
  projectId?: string; // current session's project (undefined = unassigned)
  sessionId?: string; // current session (undefined = none open)
  onClose: () => void;
}

type Scope = 'global' | 'project' | 'session';

export const MemoryDialog: React.FC<MemoryDialogProps> = ({ projectId, sessionId, onClose }) => {
  const [tab, setTab] = useState<Scope>('global');
  const [text, setText] = useState<Record<Scope, string>>({ global: '', project: '', session: '' });
  const [paths, setPaths] = useState<Record<Scope, string | null>>({ global: '', project: null, session: null });
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Scope | null>(null);

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

  const save = async (scope: Scope) => {
    await window.kiroApi.writeMemory(scope, projectId, sessionId, text[scope]);
    setSaved(scope);
    setTimeout(() => setSaved((s) => (s === scope ? null : s)), 1500);
  };

  const tabs: { scope: Scope; label: string; enabled: boolean; hint: string }[] = [
    { scope: 'global', label: 'Global', enabled: true, hint: 'Applies to all chats everywhere' },
    { scope: 'project', label: projectId ? `Project: ${projectId}` : 'Project (none)', enabled: !!projectId, hint: `Applies to all chats in project "${projectId}"` },
  ];

  const active = tabs.find((t) => t.scope === tab)!;

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="settings-dialog" style={{ width: 640, maxWidth: '92vw' }}>
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
          {loading ? (
            <p className="settings-preview">Loading…</p>
          ) : !active.enabled ? (
            <p className="settings-preview">
              {tab === 'project'
                ? "This chat isn't assigned to a project."
                : 'No chat is open.'}
            </p>
          ) : (
            <div className="settings-item" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
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
          <p className="settings-preview" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Injected as a cascade (global → project → this-chat); more-specific wins. Chat-specific memory is managed by the agent. Edits apply on the next message.
          </p>
        </div>
      </div>
    </>
  );
};
