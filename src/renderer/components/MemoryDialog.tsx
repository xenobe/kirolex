import React, { useEffect, useState } from 'react';
import { useT } from '../hooks/useLang';

interface MemoryDialogProps {
  projectId?: string; // current session's project (undefined = unassigned)
  sessionId?: string; // current session (undefined = none open)
  onClose: () => void;
}

type Scope = 'global' | 'project' | 'session';
/** The editable scopes plus a read-only view of what the last send really carried. */
type Tab = Scope | 'snapshot';

export const MemoryDialog: React.FC<MemoryDialogProps> = ({ projectId, sessionId, onClose }) => {
  const t = useT();
  const [tab, setTab] = useState<Tab>(() => (projectId ? 'project' : 'global'));
  const [text, setText] = useState<Record<Scope, string>>({ global: '', project: '', session: '' });
  const [paths, setPaths] = useState<Record<Scope, string | null>>({ global: '', project: null, session: null });
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Scope | null>(null);
  const [snapshot, setSnapshot] = useState<{
    text: string; at: number | null; path: string | null;
    override?: boolean; overridePath?: string | null; sentText?: string;
  } | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  /** The editor's own copy, so typing does not fight the loader. `null` = untouched. */
  const [snapshotDraft, setSnapshotDraft] = useState<string | null>(null);
  const [snapshotSaved, setSnapshotSaved] = useState<string | null>(null);

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
      .then((r) => { if (alive) { setSnapshot(r); setSnapshotDraft(null); setSnapshotLoading(false); } })
      .catch(() => { if (alive) setSnapshotLoading(false); });
    return () => { alive = false; };
  }, [tab, sessionId]);

  /** Reload the tab from disk, discarding the local draft. */
  const reloadSnapshot = async () => {
    const r = await window.kiroApi.readLastInjection?.(sessionId);
    setSnapshot(r);
    setSnapshotDraft(null);
  };

  /** Pin what is in the editor as this chat's context block. */
  const saveSnapshot = async () => {
    if (!sessionId) return;
    await window.kiroApi.writeContextOverride?.(sessionId, snapshotDraft ?? snapshot?.text ?? '');
    await reloadSnapshot();
    setSnapshotSaved('saved');
    setTimeout(() => setSnapshotSaved((s) => (s === 'saved' ? null : s)), 1800);
  };

  /** Throw the hand-edited block away and go back to the generated snapshot. */
  const revertSnapshot = async () => {
    if (!sessionId) return;
    await window.kiroApi.clearContextOverride?.(sessionId);
    await reloadSnapshot();
    setSnapshotSaved('reverted');
    setTimeout(() => setSnapshotSaved((s) => (s === 'reverted' ? null : s)), 1800);
  };

  const save = async (scope: Scope) => {
    await window.kiroApi.writeMemory(scope, projectId, sessionId, text[scope]);
    setSaved(scope);
    setTimeout(() => setSaved((s) => (s === scope ? null : s)), 1500);
  };

  const tabs: { scope: Tab; label: string; enabled: boolean; hint: string }[] = [
    { scope: 'global', label: 'Global', enabled: true, hint: 'Applies to all chats everywhere' },
    { scope: 'project', label: projectId ? `Project: ${projectId}` : 'Project (none)', enabled: !!projectId, hint: `Applies to all chats in project "${projectId}"` },
    /*
      会话这一层原来**没有 tab** —— 「我让你加一个 session 级别的 memory，这个加了吗，主界面看不了啊」。
      文件、分层注入（全局 ⊕ project ⊕ 会话）和 readMemory 里的 session 字段一直都在，只有这一行漏了：
      于是它是一份写得进、读不出的记忆。现在它可编辑，而且说清了它会被自动维护（每攒够 12 条消息压一次），
      所以你手写的东西可能被下一次压缩合并 —— 不说这句，人会以为自己写的被吞了。
    */
    { scope: 'session', label: 'This chat', enabled: !!sessionId, hint: '只作用于这个会话，并且每一轮都会注入。它由 KiroLex 自动维护（每攒够 12 条消息压一次），你手写的内容会被下一次压缩合并进去' },
    { scope: 'snapshot', label: '📦 Snapshot', enabled: !!sessionId, hint: '这个会话下一条消息会带给模型的上下文；可以直接编辑并保存' },
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
          <h3>{`🧠 ${t('Memory')}`}</h3>
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
              <p className="settings-preview settings-item-wide">{t('Loading…')}</p>
            ) : (
              <div className="settings-item settings-item-wide" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {/* Which of the two blocks is in force has to be the first thing on
                    screen: the tab shows an ARCHIVE of what already went out until it
                    is saved, at which point the same text becomes an INPUT for the next
                    send. Reading the same characters with the wrong one of those two
                    meanings is the only way to be badly misled here. */}
                <label className="settings-label" style={{ marginBottom: 6 }}>
                  {snapshot?.override
                    ? t('⚙︎ Hand-edited context (pinned) · the next message sends this verbatim instead of the auto snapshot')
                    : snapshot?.at
                      ? `自动生成的快照 · 上一次发送于 ${new Date(snapshot.at).toLocaleString()}（下一次发送会按当时的对话重新生成）`
                      : t('No context has been injected into this chat yet')}
                </label>
                <textarea
                  className="memory-textarea"
                  value={snapshotDraft ?? snapshot?.text ?? ''}
                  placeholder={t('(Nothing recorded yet: context is written when it is actually injected, so it appears after you send a message. You can also write one here — save it and the next message uses it.)')}
                  onChange={(e) => setSnapshotDraft(e.target.value)}
                  spellCheck={false}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                  <button
                    className="rename-popup-btn confirm"
                    onClick={() => void saveSnapshot()}
                    disabled={!sessionId}
                    title={'保存后这份文本会原样作为上下文块，跟着你的下一条消息一起发出。\n'
                      + '它是固定的：不会随对话增长而更新，所以聊得久了它会越来越旧 —— 想回到自动生成的快照就点右边那个按钮。\n'
                      + '如果你删掉了结尾那句「下面是用户这一条新消息，请正常回答它」，发送时会自动补回去，否则模型会去回答这段历史本身。'}
                  >{t('Save and pin')}</button>
                  {snapshot?.override && (
                    <button
                      className="rename-popup-btn"
                      onClick={() => void revertSnapshot()}
                      title={t('Drop the hand-edited copy and go back to the snapshot generated from the current conversation.')}
                    >{t('Restore auto-generated')}</button>
                  )}
                  {snapshotDraft !== null && snapshotDraft !== (snapshot?.text ?? '') && (
                    <button className="rename-popup-btn" onClick={() => setSnapshotDraft(null)}>放弃修改</button>
                  )}
                  {snapshotSaved === 'saved' && <span style={{ color: '#3fb950', fontSize: 12 }}>{`${t('Pinned')} ✓`}</span>}
                  {snapshotSaved === 'reverted' && <span style={{ color: '#3fb950', fontSize: 12 }}>{`${t('Back to auto-generated')} ✓`}</span>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span>{(snapshotDraft ?? snapshot?.text ?? '').length} 字符</span>
                  <span style={{ marginLeft: 'auto' }}>{snapshot?.override ? snapshot?.overridePath : snapshot?.path}</span>
                </div>
              </div>
            )
          ) : loading ? (
            <p className="settings-preview settings-item-wide">{t('Loading…')}</p>
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
                <button className="rename-popup-btn confirm" onClick={() => save(tab)}>{t('Save')}</button>
                {saved === tab && <span style={{ color: '#3fb950', fontSize: 12 }}>{`${t('Saved')} ✓`}</span>}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{paths[tab]}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
};
