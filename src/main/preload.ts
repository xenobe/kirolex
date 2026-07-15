import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kiroApi', {
  // Connection
  connect: (options: { model?: string }) => ipcRenderer.invoke('acp:connect', options),
  disconnect: () => ipcRenderer.invoke('acp:disconnect'),
  
  // Sessions (one executor process per session, keyed by sessionId)
  newSession: (kiroLexId: string, cwd: string, model: string, projectId?: string) => ipcRenderer.invoke('acp:new-session', kiroLexId, cwd, model, projectId),
  loadSession: (sessionId: string, cwd: string, model: string) => ipcRenderer.invoke('acp:load-session', sessionId, cwd, model),
  listSessions: () => ipcRenderer.invoke('acp:list-sessions'),
  readTranscript: (sessionId: string) => ipcRenderer.invoke('acp:read-transcript', sessionId),
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
  writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => ipcRenderer.invoke('acp:write-memory', scope, projectId, sessionId, content),
  
  // Chat
  prompt: (sessionId: string, prompt: any[], model: string, projectId?: string) => ipcRenderer.invoke('acp:prompt', sessionId, prompt, model, projectId),
  cancel: (sessionId: string, model: string) => ipcRenderer.invoke('acp:cancel', sessionId, model),
  respondPermission: (requestId: number, granted: boolean, sessionId: string) => ipcRenderer.invoke('acp:request-permission-response', requestId, granted, sessionId),
  
  // Models
  listModels: () => ipcRenderer.invoke('acp:list-models'),
  getUsage: () => ipcRenderer.invoke('acp:get-usage'),
  getHomeDir: () => ipcRenderer.invoke('app:get-home-dir'),
  saveClipboardImage: () => ipcRenderer.invoke('app:save-clipboard-image'),
  
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
