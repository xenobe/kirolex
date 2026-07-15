import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatArea } from './components/ChatArea';
import { PermissionDialog } from './components/PermissionDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { MemoryDialog } from './components/MemoryDialog';
import { useAcp } from './hooks/useAcp';

declare global {
  interface Window {
    kiroApi: {
      connect: (options: { model?: string }) => Promise<any>;
      disconnect: () => Promise<void>;
      newSession: (kiroLexId: string, cwd: string, model: string, projectId?: string) => Promise<{ sessionId: string }>;
      loadSession: (sessionId: string, cwd: string, model: string) => Promise<any>;
      readTranscript: (sessionId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number }[]>;
      listSessions: () => Promise<any>;
      deleteSession: (sessionId: string) => Promise<void>;
      assignProject: (sessionId: string, projectId: string) => Promise<{ sessionId: string; projectId: string }>;
      setProject: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      moveSession: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      archiveSession: (sessionId: string, archived: boolean) => Promise<{ sessionId: string; archived: boolean }>;
      getExecutorCap: () => Promise<number>;
      reveal: () => Promise<{ revealed: boolean }>;
      splashStatus: (text: string) => Promise<{ ok: boolean }>;
      deleteProjectMemory: (projectId: string) => Promise<{ projectId: string }>;
      readMemory: (projectId?: string, sessionId?: string) => Promise<{ global: string; project: string; session: string; projectId: string | null; sessionId: string | null; globalPath: string; projectPath: string | null; sessionPath: string | null }>;
      writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => Promise<{ ok: boolean }>;
      prompt: (sessionId: string, prompt: any[], model: string, projectId?: string) => Promise<any>;
      cancel: (sessionId: string, model: string) => Promise<void>;
      respondPermission: (requestId: number, granted: boolean, sessionId: string) => Promise<void>;
      listModels: () => Promise<any>;
      getUsage: () => Promise<{ text: string }>;
      getHomeDir: () => Promise<string>;
      saveClipboardImage: () => Promise<{ path: string; name: string; thumbnail: string } | null>;
      onUpdate: (callback: (data: any) => void) => () => void;
      onError: (callback: (error: any) => void) => () => void;
      onDisconnected: (callback: (data?: any) => void) => () => void;
      onSessionReady: (callback: (data: { sessionId: string; projectId?: string }) => void) => () => void;
    };
  }
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AttachedFile[];
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  isImage?: boolean;
  preview?: string; // thumbnail data URL for image attachments
}

export interface Session {
  id: string;
  title: string;
  model: string;
  /** Write-once memory-scoping label (design §4/§6.4). Undefined = unassigned. */
  projectId?: string;
  /** Pinned sessions sort to the top of their group. */
  pinned?: boolean;
  /** User-archived: hidden from the main list into a collapsible Archived group. */
  archived?: boolean;
  folderId?: string | null; // legacy — retained for back-compat, no longer surfaced
  lastMessage?: string;
  timestamp: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface Settings {
  fontSize: number;
}

const DEFAULT_SETTINGS: Settings = { fontSize: 14 };

function loadSettings(): Settings {
  try {
    const saved = localStorage.getItem('kirolex-settings');
    if (saved) return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem('kirolex-settings', JSON.stringify(settings));
  } catch {}
}

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().includes('MAC');

const App: React.FC = () => {
  const {
    status,
    connectionError,
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    connectingSessionIds,
    activeToolCall,
    usage,
    permissionRequest,
    connect,
    disconnect,
    forceStop,
    newSession,
    switchSession,
    deleteSession,
    renameSession,
    changeSessionModel,
    assignProject,
    moveSession,
    archiveSession,
    projects,
    createProject,
    renameProject,
    deleteProject,
    togglePin,
    clearConversation,
    sendMessage,
    cancelStream,
    respondPermission,
    contextLinks,
    toggleContextSource,
  } = useAcp();

  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [selectedModel, setSelectedModel] = useState('claude-opus-4.6');
  const [models, setModels] = useState<any[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [homeDir, setHomeDir] = useState('~');
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{ name: string; memberCount: number } | null>(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);
  // "Don't ask again" for delete confirmation (persisted).
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState<boolean>(() => {
    try { return localStorage.getItem('kirolex-skip-delete-confirm') === 'true'; } catch { return false; }
  });
  const [dontAskDelete, setDontAskDelete] = useState(false);
  // New Chat dialog: choose project at creation.
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatProject, setNewChatProject] = useState<string>(''); // '' = none, '__new__' = create
  const [newChatNewProjectName, setNewChatNewProjectName] = useState('');

  // Mark sessions as unread when they finish streaming and the user isn't viewing them
  const prevStreamingIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevStreamingIdsRef.current;
    // Sessions that were streaming before but aren't now = just finished
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      if (fid !== currentSessionId) {
        setUnreadSessionIds((u) => (u.includes(fid) ? u : [...u, fid]));
      }
    }
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds, currentSessionId]);

  // Clear unread when user switches to a session
  const handleSwitchSession = useCallback((sessionId: string) => {
    setUnreadSessionIds((prev) => prev.filter((id) => id !== sessionId));
    switchSession(sessionId);
  }, [switchSession]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    // Read the persisted flag live (single source of truth, written by both the
    // Settings toggle and the dialog's "Don't ask again") to avoid any stale
    // closure of skipDeleteConfirm.
    let skip = skipDeleteConfirm;
    try { skip = localStorage.getItem('kirolex-skip-delete-confirm') === 'true'; } catch {}
    if (skip) { deleteSession(sessionId); return; }
    const session = sessions.find((s) => s.id === sessionId);
    setDeleteConfirm({ sessionId, title: session?.title || 'this session' });
  }, [sessions, skipDeleteConfirm, deleteSession]);

  // Create a new chat directly inside a project (created already assigned).
  const handleNewSessionInProject = useCallback((project: string) => {
    newSession(homeDir, selectedModel, project);
  }, [newSession, homeDir, selectedModel]);

  // Create a chat from the New Chat dialog, assigning the chosen project (if any)
  // at creation.
  const handleCreateChat = useCallback(() => {
    const proj = newChatProject === '__new__'
      ? (newChatNewProjectName.trim() || undefined)
      : (newChatProject || undefined);
    newSession(homeDir, selectedModel, proj);
    setShowNewChat(false);
    setNewChatProject('');
    setNewChatNewProjectName('');
  }, [newChatProject, newChatNewProjectName, newSession, homeDir, selectedModel]);

  const confirmDelete = useCallback(() => {
    if (deleteConfirm) {
      if (dontAskDelete) {
        setSkipDeleteConfirm(true);
        try { localStorage.setItem('kirolex-skip-delete-confirm', 'true'); } catch {}
      }
      deleteSession(deleteConfirm.sessionId);
      setDeleteConfirm(null);
      setDontAskDelete(false);
    }
  }, [deleteConfirm, deleteSession, dontAskDelete]);

  // Project deletion is destructive (removes every member chat + the project's
  // memory) and ALWAYS confirms — deliberately independent of the chat-delete
  // "Don't ask again" / Settings toggle.
  const handleDeleteProject = useCallback((name: string) => {
    const memberCount = sessions.filter((s) => s.projectId === name).length;
    setDeleteProjectConfirm({ name, memberCount });
  }, [sessions]);

  const confirmDeleteProject = useCallback(() => {
    if (deleteProjectConfirm) {
      deleteProject(deleteProjectConfirm.name);
      setDeleteProjectConfirm(null);
    }
  }, [deleteProjectConfirm, deleteProject]);

  useEffect(() => {
    if (window.kiroApi) {
      window.kiroApi.getHomeDir().then(setHomeDir).catch(() => {});
      
      window.kiroApi.listModels().then((data) => {
        setModels(data.models || []);
        try {
          localStorage.setItem('kirolex-models', JSON.stringify(data.models || []));
        } catch {}
      }).catch(() => {
        try {
          const cached = localStorage.getItem('kirolex-models');
          if (cached) setModels(JSON.parse(cached));
        } catch {}
      });

      // Auto-connect
      setTimeout(() => {
        connect(selectedModel);
      }, 300);
    }
  }, []);

  // Apply font size to document
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
  }, [settings.fontSize]);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
    saveSettings(newSettings);
  }, []);

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    // Per-session model: update the current session's model (routes to that
    // model's kiro-cli process). No global reconnect needed.
    if (currentSessionId) {
      changeSessionModel(currentSessionId, model);
    }
  }, [currentSessionId, changeSessionModel]);

  // Keep the model dropdown in sync with the current session's model.
  // Always reflect the current session's effective model so different sessions
  // show their own model (older 'auto' sessions fall back to the default).
  useEffect(() => {
    if (!currentSessionId) return;
    const s = sessions.find((x) => x.id === currentSessionId);
    const effective = (s?.model && s.model !== 'auto') ? s.model : 'claude-opus-4.6';
    setSelectedModel(effective);
  }, [currentSessionId]);

  const handleDropFiles = useCallback((files: AttachedFile[]) => {
    setAttachedFiles((prev) => [...prev, ...files]);
  }, []);

  const handleRemoveFile = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((f) => f.id !== id));
  }, []);

  const handleSendMessage = useCallback(async (text: string) => {
    // Clear unread status when user interacts
    if (currentSessionId) {
      setUnreadSessionIds((prev) => prev.filter((id) => id !== currentSessionId));
    }

    // Handle /stop locally - force interrupt and reconnect
    if (text.trim() === '/stop') {
      await forceStop(selectedModel);
      sendMessage([{ type: 'text', text: '/stop' }], '🔄 Force interrupted and reconnected.');
      return;
    }

    // Handle /clear: wipe the visible history + cache, then forward /clear so
    // the backend also resets its context.
    if (text.trim() === '/clear') {
      clearConversation(currentSessionId);
      await sendMessage([{ type: 'text', text: '/clear' }]);
      return;
    }

    // Handle /usage locally
    if (text.trim() === '/usage') {
      try {
        const result = await window.kiroApi.getUsage();
        // Add as a fake assistant message
        sendMessage([{ type: 'text', text: '/usage' }], result.text);
      } catch (err) {
        sendMessage([{ type: 'text', text: '/usage' }], 'Failed to fetch usage info');
      }
      return;
    }

    const prompt: any[] = [];
    const currentAttachments = [...attachedFiles];

    if (currentAttachments.length > 0) {
      const fileRefs = currentAttachments
        .map((f) => `file:${f.path}`)
        .join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }

    prompt.push({ type: 'text', text });
    setAttachedFiles([]);
    await sendMessage(prompt, undefined, currentAttachments.length > 0 ? currentAttachments : undefined, selectedModel);
  }, [attachedFiles, sendMessage, currentSessionId, forceStop, selectedModel]);

  // Command queue: commands entered with Ctrl+Enter during streaming
  const [commandQueue, setCommandQueue] = useState<string[]>([]);
  const queueSendingRef = useRef(false);

  const handleQueueCommand = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setCommandQueue((prev) => [...prev, t]);
  }, []);

  const handleRemoveQueuedCommand = useCallback((index: number) => {
    setCommandQueue((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Process the queue: when idle (not streaming) and queue non-empty, send next command
  useEffect(() => {
    if (isStreaming) return;
    if (queueSendingRef.current) return;
    if (commandQueue.length === 0) return;

    queueSendingRef.current = true;
    const next = commandQueue[0];
    setCommandQueue((prev) => prev.slice(1));
    Promise.resolve(handleSendMessage(next)).finally(() => {
      queueSendingRef.current = false;
    });
  }, [isStreaming, commandQueue, handleSendMessage]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('kirolex-sidebar-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 240;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isResizingRef = useRef(false);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(160, Math.min(500, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('kirolex-sidebar-width', String(sidebarWidth));
      } catch {}
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Save sidebar width when it changes
  useEffect(() => {
    try {
      localStorage.setItem('kirolex-sidebar-width', String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  return (
    <>
      <div className={`app-layout no-toolbar${isMac ? ' mac' : ''}`}>
        {isMac && <div className="mac-titlebar" />}
        {!sidebarCollapsed && (
          <div style={{ width: sidebarWidth, flexShrink: 0 }}>
            <Sidebar
              sessions={sessions}
              projects={projects}
              currentSessionId={currentSessionId}
              status={status}
              streamingSessionIds={streamingIds}
              attachedSessionIds={attachedSessionIds}
              connectingSessionIds={connectingSessionIds}
              unreadSessionIds={unreadSessionIds}
              onNewSession={() => { setNewChatProject(''); setNewChatNewProjectName(''); setShowNewChat(true); }}
              onCreateProject={createProject}
              onNewSessionInProject={handleNewSessionInProject}
              onRenameProject={renameProject}
              onDeleteProject={handleDeleteProject}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              onRenameSession={renameSession}
              onTogglePin={togglePin}
              onAssignProject={assignProject}
              onMoveSession={moveSession}
              onArchiveSession={archiveSession}
              onSettings={() => setShowSettings(true)}
              onOpenMemory={() => setShowMemory(true)}
            />
          </div>
        )}
        <div className="sidebar-resize-area">
          {!sidebarCollapsed && (
            <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
          )}
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
        </div>
        <ChatArea
          messages={messages}
          isStreaming={isStreaming}
          status={status}
          connectionError={connectionError}
          attachedFiles={attachedFiles}
          models={models}
          selectedModel={selectedModel}
          activeToolCall={activeToolCall}
          usage={usage}
          onModelChange={handleModelChange}
          onSend={handleSendMessage}
          onCancel={cancelStream}
          onDropFiles={handleDropFiles}
          onRemoveFile={handleRemoveFile}
          currentSessionId={currentSessionId}
          isArchived={!!sessions.find((s) => s.id === currentSessionId)?.archived}
          onUnarchive={() => { if (currentSessionId) archiveSession(currentSessionId, false); }}
          commandQueue={commandQueue}
          onQueueCommand={handleQueueCommand}
          onRemoveQueuedCommand={handleRemoveQueuedCommand}
          importableSessions={sessions
            .filter((s) => s.id !== currentSessionId && !s.id.startsWith('pending_') && !s.archived)
            .map((s) => ({ id: s.id, title: s.title }))}
          contextLinks={contextLinks}
          onToggleContextSource={toggleContextSource}
        />
      </div>
      {permissionRequest && (
        <PermissionDialog
          request={permissionRequest}
          onRespond={respondPermission}
        />
      )}
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
          confirmDeletes={!skipDeleteConfirm}
          onConfirmDeletesChange={(value) => {
            const skip = !value;
            setSkipDeleteConfirm(skip);
            try { localStorage.setItem('kirolex-skip-delete-confirm', String(skip)); } catch {}
          }}
        />
      )}
      {showNewChat && (
        <>
          <div className="overlay" onClick={() => setShowNewChat(false)} />
          <div className="permission-dialog">
            <h3>💬 New Chat</h3>
            <p style={{ marginBottom: 10 }}>Assign this chat to a project (optional). A project gives the chat its own memory.</p>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Project</label>
            <select
              className="rename-popup-input"
              value={newChatProject}
              onChange={(e) => setNewChatProject(e.target.value)}
              style={{ marginBottom: 12 }}
            >
              <option value="">No project (unassigned)</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value="__new__">+ New project…</option>
            </select>
            {newChatProject === '__new__' && (
              <input
                autoFocus
                className="rename-popup-input"
                placeholder="New project name…"
                value={newChatNewProjectName}
                onChange={(e) => setNewChatNewProjectName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateChat(); }}
                style={{ marginBottom: 12 }}
              />
            )}
            <div className="actions">
              <button className="btn deny" onClick={() => setShowNewChat(false)}>Cancel</button>
              <button className="btn allow" onClick={handleCreateChat}>Create</button>
            </div>
          </div>
        </>
      )}
      {showMemory && (
        <MemoryDialog
          projectId={sessions.find((s) => s.id === currentSessionId)?.projectId}
          sessionId={currentSessionId && !currentSessionId.startsWith('pending_') ? currentSessionId : undefined}
          onClose={() => setShowMemory(false)}
        />
      )}
      {deleteConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteConfirm(null)} />
          <div className="permission-dialog">
            <h3>🗑️ Delete Session</h3>
            <p>
              Are you sure you want to delete <strong>"{deleteConfirm.title}"</strong>?
              This will permanently remove the session and its history.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 14px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dontAskDelete}
                onChange={(e) => setDontAskDelete(e.target.checked)}
              />
              Don't ask again
            </label>
            <div className="actions">
              <button className="btn deny" onClick={() => { setDeleteConfirm(null); setDontAskDelete(false); }}>
                Cancel
              </button>
              <button className="btn allow" onClick={confirmDelete} style={{ background: '#ef5350' }}>
                Delete
              </button>
            </div>
          </div>
        </>
      )}
      {deleteProjectConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteProjectConfirm(null)} />
          <div className="permission-dialog">
            <h3>🗑️ Delete Project</h3>
            <p>
              Are you sure you want to delete the project <strong>"{deleteProjectConfirm.name}"</strong>?
              This permanently removes its memory{deleteProjectConfirm.memberCount > 0
                ? <> and <strong>{deleteProjectConfirm.memberCount} chat{deleteProjectConfirm.memberCount === 1 ? '' : 's'}</strong> inside it (with their history)</>
                : null}. This cannot be undone.
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setDeleteProjectConfirm(null)}>
                Cancel
              </button>
              <button className="btn allow" onClick={confirmDeleteProject} style={{ background: '#ef5350' }}>
                Delete project
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default App;
