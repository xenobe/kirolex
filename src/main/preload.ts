import { contextBridge, ipcRenderer } from 'electron';

/** Shared UI state (project groups, split layout, settings, widths…).
 *
 *  Exposed SYNCHRONOUSLY: the renderer reads these inside `useState(() => …)`
 *  initializers, so an async IPC would come back too late. `sendSync` hands over
 *  the whole snapshot once at preload time; writes go back asynchronously.
 *
 *  This replaces localStorage for those keys because localStorage is origin-scoped,
 *  and KiroLex's renderer origin differs between `file://` (normal start) and
 *  `http://localhost:5173` (dev/HMR) -- which silently gave each mode its own copy
 *  of the UI state. */
contextBridge.exposeInMainWorld('kiroUiState', {
  initial: (() => {
    try { return ipcRenderer.sendSync('app:ui-state-all') || {}; } catch { return {}; }
  })(),
  set: (key: string, value: string | null) => { ipcRenderer.send('app:ui-state-set', key, value); },
});

contextBridge.exposeInMainWorld('kiroApi', {
  // Connection
  connect: (options: { model?: string }) => ipcRenderer.invoke('acp:connect', options),
  disconnect: () => ipcRenderer.invoke('acp:disconnect'),
  
  // Sessions (one executor process per session, keyed by sessionId)
  newSession: (
    kiroLexId: string,
    cwd: string,
    model: string,
    projectId?: string,
    kiroAgent?: string,
    permissionMode: 'auto-approve' | 'ask' = 'auto-approve',
  ) => ipcRenderer.invoke(
    'acp:new-session',
    kiroLexId,
    cwd,
    model,
    projectId,
    kiroAgent,
    permissionMode,
  ),
  loadSession: (sessionId: string, cwd: string, model: string) => ipcRenderer.invoke('acp:load-session', sessionId, cwd, model),
  primeHistory: (sessionId: string, force?: boolean) =>
    ipcRenderer.invoke('acp:prime-history', sessionId, force),
  /** Called when a chat becomes the active one, so its context is verified (and
   *  rebuilt) at open time rather than on the user's first send. */
  ensureContext: (sessionId: string) => ipcRenderer.invoke('acp:ensure-context', sessionId),
  setPrimeMode: (sessionId: string, primeMode: 'snapshot' | 'full') =>
    ipcRenderer.invoke('acp:set-prime-mode', sessionId, primeMode),
  listSessions: () => ipcRenderer.invoke('acp:list-sessions'),
  listKiroAgents: () => ipcRenderer.invoke('kiro:list-agents'),
  openKiroAgentConfig: (sessionId: string, agentName: string, source?: 'built-in' | 'global' | 'local') => ipcRenderer.invoke('kiro:open-agent-config', sessionId, agentName, source),
  saveKiroAgentConfig: (sessionId: string, agentName: string, source: 'built-in' | 'global' | 'local' | undefined, content: string) => ipcRenderer.invoke('kiro:save-agent-config', sessionId, agentName, source, content),
  switchKiroAgent: (sessionId: string, agentName: string) => ipcRenderer.invoke('acp:switch-kiro-agent', sessionId, agentName),
  switchModel: (sessionId: string, model: string) => ipcRenderer.invoke('acp:switch-model', sessionId, model),
  switchPermissionMode: (sessionId: string, permissionMode: 'auto-approve' | 'ask') =>
    ipcRenderer.invoke('acp:switch-permission-mode', sessionId, permissionMode),
  readTranscript: (sessionId: string) => ipcRenderer.invoke('acp:read-transcript', sessionId),
  /** Store a pasted text blob on disk (composer keeps only a placeholder). */
  savePasteText: (text: string) => ipcRenderer.invoke('app:save-paste-text', text),
  /** Read a stored paste blob back (used when expanding a placeholder). */
  readPaste: (filePath: string) => ipcRenderer.invoke('app:read-paste', filePath),
  /** Paste blobs referenced by an unsent draft (per session, disk-backed). */
  /** Prompts already auto-resent after an interruption (per session). */
  getAutoResent: () => ipcRenderer.invoke('app:get-auto-resent'),
  setAutoResent: (sessionId: string, key: string) => ipcRenderer.invoke('app:set-auto-resent', sessionId, key),
  getDraftPastes: () => ipcRenderer.invoke('app:get-draft-pastes'),
  setDraftPastes: (sessionId: string, blocks: any[]) => ipcRenderer.invoke('app:set-draft-pastes', sessionId, blocks),
  truncateTranscriptBefore: (sessionId: string, messageId: string) =>
    ipcRenderer.invoke('acp:truncate-transcript-before', sessionId, messageId),
  rewriteTranscript: (sessionId: string, messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: any[] }>) =>
    ipcRenderer.invoke('acp:rewrite-transcript', sessionId, messages),
  // Durable on-disk session index (source of truth for the sidebar).
  listDurableSessions: () => ipcRenderer.invoke('acp:list-durable-sessions'),
  deleteSession: (sessionId: string) => ipcRenderer.invoke('acp:delete-session', sessionId),
  // Write-once project assignment (design §6.4)
  assignProject: (sessionId: string, projectId: string) => ipcRenderer.invoke('acp:assign-project', sessionId, projectId),
  // Project-level force set/clear (rename/delete project)
  setProject: (sessionId: string, projectId: string | null) => ipcRenderer.invoke('acp:set-project', sessionId, projectId),
  moveSession: (sessionId: string, projectId: string | null) => ipcRenderer.invoke('acp:move-session', sessionId, projectId),
  archiveSession: (sessionId: string, archived: boolean) => ipcRenderer.invoke('acp:archive-session', sessionId, archived),
  getExecutorCap: () => ipcRenderer.invoke('acp:get-executor-cap'),
  reveal: () => ipcRenderer.invoke('acp:reveal'),
  splashStatus: (text: string) => ipcRenderer.invoke('acp:splash-status', text),
  deleteProjectMemory: (projectId: string) => ipcRenderer.invoke('acp:delete-project-memory', projectId),
  readMemory: (projectId?: string, sessionId?: string) => ipcRenderer.invoke('acp:read-memory', projectId, sessionId),
  /** The context blocks the LAST send actually carried (archived at send time). */
  readLastInjection: (sessionId?: string) => ipcRenderer.invoke('acp:read-last-injection', sessionId),
  writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => ipcRenderer.invoke('acp:write-memory', scope, projectId, sessionId, content),
  
  // Chat
  prompt: (sessionId: string, prompt: any[], model: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }) => ipcRenderer.invoke('acp:prompt', sessionId, prompt, model, projectId, display),
  cancel: (sessionId: string, model: string, suppressInterruptionNotice = false) =>
    ipcRenderer.invoke('acp:cancel', sessionId, model, suppressInterruptionNotice),
  // Mid-turn steer: inject text into the running turn (kiro-cli _session/steer).
  // Resolves to { steered, reason } — the renderer falls back to the queue when
  // steered is false so the message is never dropped.
  steer: (sessionId: string, message: string) =>
    ipcRenderer.invoke('acp:steer', sessionId, message),
  /** Persist a steer the backend reported CONSUMED. Steers do not travel through
   *  `prompt`, so this is their only path to the durable transcript — and the
   *  transcript is what the context snapshot and history.md are rendered from. */
  persistSteer: (sessionId: string, text: string, messageId?: string) =>
    ipcRenderer.invoke('acp:persist-steer', sessionId, text, messageId),
  respondPermission: (requestId: number | string, optionId: string, sessionId: string) =>
    ipcRenderer.invoke('acp:request-permission-response', requestId, optionId, sessionId),
  
  // Models
  listModels: () => ipcRenderer.invoke('acp:list-models'),
  getUsage: () => ipcRenderer.invoke('acp:get-usage'),
  generateTitle: (firstUser: string, firstAssistant?: string) => ipcRenderer.invoke('app:generate-title', firstUser, firstAssistant),
  generateSuggestions: (recentConvo: string) => ipcRenderer.invoke('app:generate-suggestions', recentConvo),
  setSessionPinned: (id: string, pinned: boolean) => ipcRenderer.invoke('acp:set-session-pinned', id, pinned),
  getHomeDir: () => ipcRenderer.invoke('app:get-home-dir'),
  getLogs: (maxLines?: number) => ipcRenderer.invoke('app:get-logs', maxLines),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openExternal: (target: string, sessionId?: string) =>
    ipcRenderer.invoke('app:open-external', target, sessionId),
  getExecutorCapInfo: () => ipcRenderer.invoke('app:get-executor-cap-info'),
  /** User-selectable features. Both sides read live values, so a toggle takes
   *  effect on the next operation without restarting the app. */
  /** Cap an image attachment's dimensions (Bedrock rejects >2000px in multi-image
   *  requests, and the check covers the whole conversation history). */
  prepareImageAttachment: (filePath: string) => ipcRenderer.invoke('app:prepare-image-attachment', filePath),
  getFeatures: () => ipcRenderer.invoke('app:get-features'),
  setFeature: (key: string, enabled: boolean) => ipcRenderer.invoke('app:set-feature', key, enabled),
  setExecutorCap: (n: number) => ipcRenderer.invoke('app:set-executor-cap', n),
  /** Silence threshold, in seconds, before a protocol-silent + zero-CPU turn is
   *  treated as wedged and interrupted. 0 = never interrupt. */
  getWedgeTimeout: () => ipcRenderer.invoke('app:get-wedge-timeout'),
  setWedgeTimeout: (n: number) => ipcRenderer.invoke('app:set-wedge-timeout', n),
  /** How long an open tool call may go without an update before it stops counting as
   *  progress. Bounds the tool-call guard so a missing closing update cannot disable
   *  wedge detection for a whole turn. */
  getToolStallTimeout: () => ipcRenderer.invoke('app:get-tool-stall-timeout'),
  setToolStallTimeout: (n: number) => ipcRenderer.invoke('app:set-tool-stall-timeout', n),
  /** Models for KiroLex's own background chores (chat titles, prompt suggestions).
   *  Primary is tried first, fallback only if it cannot answer. */
  getWorkspaceDir: () => ipcRenderer.invoke('app:get-workspace-dir'),
  setWorkspaceDir: (dir: string) => ipcRenderer.invoke('app:set-workspace-dir', dir),
  getHelperModels: () => ipcRenderer.invoke('app:get-helper-models'),
  setHelperModels: (model: string, fallback: string) => ipcRenderer.invoke('app:set-helper-models', model, fallback),
  pickFiles: () => ipcRenderer.invoke('app:pick-files'),
  saveClipboardImage: () => ipcRenderer.invoke('app:save-clipboard-image'),
  /** sessionId is an OPTIONAL hint that only decides the default directory and what
   *  relative paths resolve against — the browser works with no chat connected. */
  workspaceList: (sessionId?: string | null, directory?: string) =>
    ipcRenderer.invoke('workspace:list', sessionId, directory),
  workspaceRead: (sessionId: string | null | undefined, filePath: string) =>
    ipcRenderer.invoke('workspace:read', sessionId, filePath),
  /** Session-independent image read, for attachment thumbnails. workspaceRead
   *  refuses when the chat has no live backend, which is not a sensible condition
   *  for showing a picture that is sitting on disk. */
  readImageDataUrl: (filePath: string) =>
    ipcRenderer.invoke('app:image-data-url', filePath),
  pathExists: (filePath: string, sessionId?: string) =>
    ipcRenderer.invoke('app:path-exists', filePath, sessionId),
  workspaceDownload: (sessionId: string | null | undefined, filePath: string) =>
    ipcRenderer.invoke('workspace:download', sessionId, filePath),
  
  // Events
  onUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:update', handler);
    return () => ipcRenderer.removeListener('acp:update', handler);
  },
  onError: (callback: (error: any) => void) => {
    const handler = (_event: any, error: any) => callback(error);
    ipcRenderer.on('acp:error', handler);
    return () => ipcRenderer.removeListener('acp:error', handler);
  },
  /** Per-session backend occupancy (turn / reconfiguring / attaching / priming). */
  onSessionBusy: (callback: (data: { sessionId: string; reason: string | null; detail?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:session-busy', handler);
    return () => ipcRenderer.removeListener('acp:session-busy', handler);
  },
  getBusyMap: (): Promise<Record<string, string>> => ipcRenderer.invoke('acp:get-busy-map'),
  /** Authoritative full assistant text at turn end (heals dropped chunks). */
  onAssistantFinal: (callback: (data: { sessionId: string; messageId: string; text: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:assistant-final', handler);
    return () => ipcRenderer.removeListener('acp:assistant-final', handler);
  },
  /** The model a session is REALLY running (after a connect-time or prompt-time
   *  fallback). The selector must follow this, not the last locally-chosen value. */
  onSessionModel: (callback: (data: { sessionId: string; model: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:session-model', handler);
    return () => ipcRenderer.removeListener('acp:session-model', handler);
  },
  /** The current turn is being resent (stall retry / model swap): drop the
   *  partial assistant output so the retry does not duplicate it on screen. */
  onTurnRestart: (callback: (data: { sessionId: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-restart', handler);
    return () => ipcRenderer.removeListener('acp:turn-restart', handler);
  },
  /** A turn has produced no output for a long while. INFORMATIONAL ONLY — the
   *  turn keeps running; KiroLex never interrupts a long task by itself. */
  onTurnQuiet: (callback: (data: { sessionId: string; quietSeconds: number; openTools?: number; toolIdleSeconds?: number; cpuBusy?: boolean; cpuVetoLeftSeconds?: number; interruptInSeconds?: number | null }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-quiet', handler);
    return () => ipcRenderer.removeListener('acp:turn-quiet', handler);
  },
  /** Unlike onTurnQuiet this is NOT advisory: silence was corroborated by a
   *  frozen-CPU executor, so the turn is dead rather than thinking, and main has
   *  already interrupted it. `produced` reports whether a partial reply survived —
   *  it is what decides auto-resend vs. asking the user. */
  onTurnWedged: (callback: (data: { sessionId: string; produced: boolean }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-wedged', handler);
    return () => ipcRenderer.removeListener('acp:turn-wedged', handler);
  },
  onDisconnected: (callback: (data?: { sessionId?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:disconnected', handler);
    return () => ipcRenderer.removeListener('acp:disconnected', handler);
  },
  // Seam hook A (design §11): a session's executor attached and is ready for its
  // first prompt. Carries { sessionId, projectId } for the memory layer + UI.
  onSessionReady: (callback: (data: { sessionId: string; projectId?: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('session:ready-for-first-prompt', handler);
    return () => ipcRenderer.removeListener('session:ready-for-first-prompt', handler);
  },
});
