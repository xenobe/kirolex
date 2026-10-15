import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { uiGet, uiSet, uiRemove } from './uiStore';
import { carrySplitSizes, computeRowCells, SplitSizes } from './splitLayout';
import { Sidebar } from './components/Sidebar';
import { ChatArea, MarkdownView, expandPastes } from './components/ChatArea';
import type { PastedBlock } from './components/ChatArea';
import hljs from 'highlight.js';
import { SettingsDialog } from './components/SettingsDialog';
import { MemoryDialog } from './components/MemoryDialog';
import { WorkspacePanel } from './components/WorkspacePanel';
import { IconClose, IconLogs } from './components/Icons';
import { useAcp, isBackendOccupied } from './hooks/useAcp';
import { useFeatureFlags } from './hooks/useFeatureFlags';

declare global {
  interface Window {
    kiroApi: {
      connect: (options: { model?: string }) => Promise<any>;
      disconnect: () => Promise<void>;
      newSession: (
        kiroLexId: string,
        cwd: string,
        model: string,
        projectId?: string,
        kiroAgent?: string,
        permissionMode?: 'auto-approve' | 'ask',
      ) => Promise<{ sessionId: string }>;
      loadSession: (sessionId: string, cwd: string, model: string) => Promise<any>;
      primeHistory: (sessionId: string, force?: boolean) => Promise<any>;
      ensureContext?: (sessionId: string) => Promise<{ ok: boolean; skipped?: boolean; rebuilding?: boolean; error?: string }>;
      setPrimeMode?: (sessionId: string, primeMode: 'snapshot' | 'full') => Promise<{ ok: boolean; primeMode?: 'snapshot' | 'full'; error?: string }>;
      readTranscript: (sessionId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }[]>;
      truncateTranscriptBefore: (sessionId: string, messageId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }[]>;
      rewriteTranscript: (sessionId: string, messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }>) => Promise<{ ok: boolean }>;
      listDurableSessions: () => Promise<{ id: string; title: string; projectId?: string; model?: string; createdAt: number; updatedAt: number; archived: boolean; pinned?: boolean }[]>;
      listSessions: () => Promise<any>;
      listKiroAgents: () => Promise<{ agents: Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>; error?: string }>;
      openKiroAgentConfig: (sessionId: string, agentName: string, source?: 'built-in' | 'global' | 'local') => Promise<{ opened: boolean; path?: string; content?: string; error?: string }>;
      saveKiroAgentConfig: (sessionId: string, agentName: string, source: 'built-in' | 'global' | 'local' | undefined, content: string) => Promise<{ saved: boolean; path?: string; error?: string }>;
      switchKiroAgent: (sessionId: string, agentName: string) => Promise<{ ok: boolean; kiroAgent: string }>;
      switchModel: (sessionId: string, model: string) => Promise<{ ok: boolean; model: string }>;
      switchPermissionMode: (sessionId: string, permissionMode: 'auto-approve' | 'ask') => Promise<{ ok: boolean; permissionMode: 'auto-approve' | 'ask' }>;
      deleteSession: (sessionId: string) => Promise<{ ok: boolean; tombstoned?: boolean; error?: string }>;
      assignProject: (sessionId: string, projectId: string) => Promise<{ sessionId: string; projectId: string }>;
      setProject: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      moveSession: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      archiveSession: (sessionId: string, archived: boolean) => Promise<{ sessionId: string; archived: boolean }>;
      getExecutorCap: () => Promise<number>;
      getExecutorCapInfo: () => Promise<{ cap: number; auto: number; overridden: boolean }>;
      prepareImageAttachment?: (filePath: string) => Promise<{ path: string; downscaled?: boolean; from?: string; to?: string }>;
      getFeatures?: () => Promise<{ flags: Record<string, boolean>; defaults: Record<string, boolean> }>;
      setFeature?: (key: string, enabled: boolean) => Promise<{ ok: boolean; flags?: Record<string, boolean>; error?: string }>;
      setExecutorCap: (n: number) => Promise<{ ok: boolean; cap: number }>;
      getWedgeTimeout: () => Promise<{ seconds: number; default: number; min: number; max: number }>;
      setWedgeTimeout: (n: number) => Promise<{ ok: boolean; seconds: number }>;
      getToolStallTimeout: () => Promise<{ seconds: number; default: number; min: number; max: number }>;
      setToolStallTimeout: (n: number) => Promise<{ ok: boolean; seconds: number }>;
      getWorkspaceDir: () => Promise<string | null>;
      setWorkspaceDir: (dir: string) => Promise<{ ok: boolean; error?: string }>;
      getHelperModels: () => Promise<{ model: string; fallback: string; defaults: { model: string; fallback: string } }>;
      setHelperModels: (model: string, fallback: string) => Promise<{ model: string; fallback: string }>;
      reveal: () => Promise<{ revealed: boolean }>;
      splashStatus: (text: string) => Promise<{ ok: boolean }>;
      deleteProjectMemory: (projectId: string) => Promise<{ projectId: string }>;
      readMemory: (projectId?: string, sessionId?: string) => Promise<{ global: string; project: string; session: string; projectId: string | null; sessionId: string | null; globalPath: string; projectPath: string | null; sessionPath: string | null }>;
      readLastInjection: (sessionId?: string) => Promise<{ text: string; at: number | null; path: string | null }>;
      writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => Promise<{ ok: boolean }>;
      prompt: (sessionId: string, prompt: any[], model: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }) => Promise<any>;
      cancel: (sessionId: string, model: string, suppressInterruptionNotice?: boolean) => Promise<void>;
      steer: (sessionId: string, message: string) => Promise<{ steered: boolean; reason?: string }>;
      /** Persist a CONSUMED steer into the durable transcript (its only writer:
       *  steers never go through `prompt`). Merges into the turn's base user
       *  message, which is also how it is rendered. */
      persistSteer?: (sessionId: string, text: string, messageId?: string) => Promise<{ ok: boolean; merged?: boolean; error?: string }>;
      respondPermission: (requestId: number | string, optionId: string, sessionId: string) => Promise<void>;
      listModels: () => Promise<any>;
      getUsage: () => Promise<{ text: string }>;
      generateTitle: (firstUser: string, firstAssistant?: string) => Promise<{ title?: string; error?: string }>;
      generateSuggestions: (recentConvo: string) => Promise<{ suggestions: string[]; error?: string }>;
      setSessionPinned: (id: string, pinned: boolean) => Promise<{ sessionId: string; pinned: boolean }>;
      getHomeDir: () => Promise<string>;
      getLogs: (maxLines?: number) => Promise<{ text: string; path: string }>;
      openLogs: () => Promise<{ ok: boolean; error?: string }>;
      openExternal: (target: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      savePasteText: (text: string) => Promise<{ path: string; lines: number; chars: number; preview: string } | null>;
      readPaste: (filePath: string) => Promise<string | null>;
      getAutoResent: () => Promise<Record<string, string>>;
      setAutoResent: (sessionId: string, key: string) => Promise<{ ok: boolean }>;
      getDraftPastes: () => Promise<Record<string, any[]>>;
      setDraftPastes: (sessionId: string, blocks: any[]) => Promise<{ ok: boolean }>;
      pickFiles: () => Promise<Array<{ path: string; name: string; isImage: boolean }>>;
      saveClipboardImage: () => Promise<{ path: string; name: string; thumbnail: string } | null>;
      /** sessionId is optional everywhere below: it only picks the default
       *  directory / relative base. These are local disk reads and must never
       *  require a connected chat. */
      workspaceList: (sessionId?: string | null, directory?: string) => Promise<{
        path: string;
        parent: string;
        entries: Array<{ name: string; isDir: boolean }>;
      }>;
      workspaceRead: (sessionId: string | null | undefined, filePath: string) => Promise<{
        path: string;
        content: string;
        truncated?: boolean;
        binary?: boolean;
        /** Images come back as a base64 data URL for inline display. */
        image?: boolean;
        dataUrl?: string;
      }>;
      pathExists: (filePath: string, sessionId?: string) => Promise<boolean>;
      /** Session-independent image read for attachment thumbnails; null when the
       *  path is missing, unreadable, oversized, or not an image. */
      readImageDataUrl?: (filePath: string) => Promise<{ path: string; dataUrl: string } | null>;
      workspaceDownload: (sessionId: string | null | undefined, filePath: string) => Promise<{
        ok: boolean;
        path?: string;
        canceled?: boolean;
        error?: string;
      }>;
      onUpdate: (callback: (data: any) => void) => () => void;
      onError: (callback: (error: any) => void) => () => void;
      onAssistantFinal: (callback: (data: { sessionId: string; messageId: string; text: string }) => void) => () => void;
      onSessionBusy: (callback: (data: { sessionId: string; reason: string | null; detail?: string }) => void) => () => void;
      onSessionModel: (callback: (data: { sessionId: string; model: string }) => void) => () => void;
      onTurnRestart: (callback: (data: { sessionId: string }) => void) => () => void;
      onTurnQuiet: (callback: (data: { sessionId: string; quietSeconds: number; openTools?: number; toolIdleSeconds?: number; cpuBusy?: boolean; cpuVetoLeftSeconds?: number; interruptInSeconds?: number | null }) => void) => () => void;
      onTurnWedged: (callback: (data: { sessionId: string; produced: boolean }) => void) => () => void;
      getBusyMap: () => Promise<Record<string, string>>;
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
  /** Present on a user message injected mid-turn via _session/steer:
   *  'pending' = written, awaiting the agent's next tool boundary;
   *  'consumed' = the agent folded it into the running turn. */
  steer?: 'pending' | 'consumed';
  timestamp: number;
  /** Pasted blobs referenced by `[ 粘贴 #N · M 行 ]` placeholders in content. */
  pastes?: { seq: number; lines: number; chars: number; path: string }[];
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
  /** ACP tool kind (read/edit/execute/search/...) — drives the icon. */
  kind?: string;
  /** Absolute file paths this tool touched (ACP tool_call.locations[].path). */
  locations?: string[];
  /** File diffs carried by the tool call (ACP content blocks of type 'diff'). */
  diffs?: FileDiff[];
}

export interface FileDiff {
  path: string;
  oldText?: string;
  newText: string;
}

/** A single entry of the agent's execution plan (ACP `plan` update). */
export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status?: 'pending' | 'in_progress' | 'completed';
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  isImage?: boolean;
  preview?: string; // thumbnail data URL for image attachments
}

export interface QueuedMessage {
  id: string;
  /** DISPLAY text: keeps `[ 粘贴 #N · M 行 ]` placeholders so the queue card stays
   *  readable. `pastes` carries the real content for delivery. */
  content: string;
  attachments: AttachedFile[];
  pastes?: PastedBlock[];
  createdAt: number;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  /** Named kiro-cli agent for this session. Undefined = kiro_default. */
  kiroAgent?: string;
  /** Tool approvals for this session. Undefined legacy sessions default to Bypass. */
  permissionMode?: 'auto-approve' | 'ask';
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
  /** Font stack for all UI/chat text. Empty = system default. */
  fontFamily: string;
  /** Font stack for code blocks and file paths. Empty = built-in mono stack. */
  monoFontFamily: string;
  mergeQueuedMessages: boolean;
  /** After a restart, automatically RESEND an unanswered prompt when its chat is opened. */
  recoverInterruptedTurns: boolean;
  /** Auto-fold 💭 thinking segments once thinking finishes (default on). */
  autoFoldThinking: boolean;
  /** Auto-fold 🔧 tool segments once the tool call finishes (default on). */
  autoFoldTools: boolean;
  /** Split-view grid, "<rows>x<cols>". Caps how many chats can be shown at once. */
  splitGrid: SplitGrid;
}

export type SplitGrid = '1x1' | '1x2' | '2x1' | '2x2';

export const SPLIT_GRIDS: Record<SplitGrid, { rows: number; cols: number; capacity: number }> = {
  '1x1': { rows: 1, cols: 1, capacity: 1 },
  '1x2': { rows: 1, cols: 2, capacity: 2 },
  // Two stacked full-width chats: better than 1x2 for long transcripts and wide
  // diffs, where horizontal room matters more than vertical.
  '2x1': { rows: 2, cols: 1, capacity: 2 },
  '2x2': { rows: 2, cols: 2, capacity: 4 },
  // 1x3 / 2x3 removed: three columns leave each pane too narrow to be usable at
  // this window size, so 2x2 is the real maximum. Saved values of the retired
  // grids fall back to 2x2 (see loadSettings).
};

const DEFAULT_SETTINGS: Settings = { fontSize: 14, fontFamily: '', monoFontFamily: '', mergeQueuedMessages: false, autoFoldThinking: true, autoFoldTools: true, recoverInterruptedTurns: true, splitGrid: '1x2' };

/** One open file in the viewer. Content and view state live PER TAB so switching
 *  back restores exactly what you were looking at. */
export interface FileTab {
  id: string;
  path: string;
  content: string;
  truncated?: boolean;
  binary?: boolean;
  image?: boolean;
  dataUrl?: string;
  /** Show raw source instead of rendered markdown / highlighted code. */
  raw?: boolean;
}
/** Cap: an image tab holds a base64 data URL (up to 25 MB each), so unbounded tabs
 *  would balloon renderer memory. Oldest non-active tab is evicted first. */
const MAX_FILE_TABS = 12;
const OPEN_TABS_KEY = 'kirolex-open-file-tabs';
const SPLIT_SESSION_KEY = 'kirolex-split-session';
/** Dragged split-pane proportions. Shape-keyed inside the value, see `splitShape`. */
const SPLIT_SIZES_KEY = 'kirolex-split-sizes';
/** Stable empty collections: a pane with none of these keeps referential
 *  identity across renders, so React can skip re-rendering it. */
const EMPTY_FILES: AttachedFile[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];
const EMPTY_PLAN: any[] = [];
const EMPTY_COMMANDS: any[] = [];
const EMPTY_LINKS: any[] = [];
/** Stable no-op for the monitor pane's inert handlers (a fresh arrow function
 *  per render would defeat any memoisation of the pane). */
const NOOP: any = () => {};

/** File types the in-app viewer can never render usefully — hand these straight
 *  to the OS default application instead of opening a dead "cannot preview" tab.
 *  Images are deliberately absent: the viewer shows them inline. */
const SYSTEM_APP_EXTS = new Set([
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'epub', 'mobi',
  // archives / disk images
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'dmg', 'pkg', 'iso',
  // audio / video
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  // design / binary assets
  'psd', 'ai', 'sketch', 'fig', 'xd', 'blend', 'heic', 'tiff', 'tif', 'raw',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // executables / stores
  'app', 'exe', 'msi', 'deb', 'rpm', 'so', 'dylib', 'dll', 'class', 'jar',
  'sqlite', 'sqlite3', 'db', 'parquet', 'xlsb', 'pyc', 'wasm',
]);

function needsSystemApp(p: string): boolean {
  const name = p.split('/').pop() || p;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return SYSTEM_APP_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** Files whose preview should be RENDERED markdown rather than raw source. */
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(String(p || '').trim());
}

// Syntax highlighting for the file/report viewer. Extension -> highlight.js
// language. Anything not listed falls back to plain text (never a wrong grammar,
// which mangles the output worse than no highlighting).
const VIEWER_LANGS: Record<string, string> = {
  json: 'json', jsonc: 'json', json5: 'json', map: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', tf: 'hcl', hcl: 'hcl',
  csv: 'plaintext', tsv: 'plaintext', log: 'plaintext', txt: 'plaintext',
};

function viewerLangFor(p: string): string | null {
  const name = String(p || '').trim().split('/').pop() || '';
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  if (/^(makefile)$/i.test(name)) return 'makefile';
  const ext = (name.includes('.') ? name.split('.').pop() || '' : '').toLowerCase();
  const lang = VIEWER_LANGS[ext];
  return lang && lang !== 'plaintext' ? lang : null;
}

/** Pretty-print JSON so a minified config/report is actually readable. Returns
 *  null when the text isn't valid JSON (partial preview, JSONL, trailing commas),
 *  in which case the original text is shown untouched. */
function prettyJson(text: string): string | null {
  const t = (text || '').trim();
  if (!t || !/^[[{]/.test(t)) return null;
  try {
    const formatted = JSON.stringify(JSON.parse(t), null, 2);
    return formatted && formatted !== t ? formatted : null;
  } catch {
    return null;
  }
}

/** Highlighted HTML for a file preview, or null to fall back to plain text. */
function highlightForViewer(path: string, text: string): { html: string; lang: string; prettified: boolean } | null {
  const lang = viewerLangFor(path);
  if (!lang) return null;
  // 512 KB previews would make highlight.js chew for seconds; keep the UI snappy.
  if (text.length > 200_000) return null;
  const pretty = lang === 'json' ? prettyJson(text) : null;
  const source = pretty ?? text;
  try {
    const { value } = hljs.highlight(source, { language: lang, ignoreIllegals: true });
    return { html: value, lang, prettified: !!pretty };
  } catch {
    return null;
  }
}

function loadSettings(): Settings {
  try {
    const saved = uiGet('kirolex-settings');
    if (saved) {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } as Settings;
      // A previously-saved grid that no longer exists (e.g. 3x3) must not leave
      // the app with an undefined capacity.
      // A saved 1x3 / 2x3 (both retired) lands here and becomes 2x2, the new maximum.
      if (!SPLIT_GRIDS[merged.splitGrid]) merged.splitGrid = '2x2';
      return merged;
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  try {
    uiSet('kirolex-settings', JSON.stringify(settings));
  } catch {}
}

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().includes('MAC');

const App: React.FC = () => {
  const {
    status,
    connectionError,
    clearConnectionError,
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    busyBySession,
    rebuildContext,
    cancelAutoResend,
    interruptedSessionIds,
    connectingSessionIds,
    historyLoadingIds,
    paneViews,
    setPaneSessions,
    activeToolCall,
    activityStatus,
    turnStall,
    usage,
    plan,
    commands,
    permissionRequest,
    permissionRequests,
    connect,
    disconnect,
    forceStop,
    newSession,
    duplicateSession,
    rerunFromMessage,
    switchSession,
    deleteSession,
    renameSession,
    changeSessionModel,
    changeSessionAgent,
    changeSessionPermissionMode,
    assignProject,
    moveSession,
    archiveSession,
    projects,
    createProject,
    reorderProjects,
    renameProject,
    deleteProject,
    togglePin,
    clearConversation,
    resetSessionCredits,
    sendMessage,
    sendQueuedMessage,
    steerMessage,
    takeUnconsumedSteers,
    discardUnconsumedSteers,
    cancelStream,
    respondPermission,
    contextLinks,
    toggleContextSource,
    loopingIds,
    startLoop,
    stopLoop,
    restoredInputDraft,
  } = useAcp();

  // Attachments are PER SESSION: with several composers on screen at once, one
  // shared list would let a file dropped on pane A be sent from pane B.
  const [attachedBySession, setAttachedBySession] = useState<Record<string, AttachedFile[]>>({});
  const attachedFor = useCallback(
    (sid: string | null) => (sid ? attachedBySession[sid] || EMPTY_FILES : EMPTY_FILES),
    [attachedBySession],
  );
  const addAttachments = useCallback((sid: string | null, files: AttachedFile[]) => {
    if (!sid) return;
    setAttachedBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] || []), ...files] }));
  }, []);
  const clearAttachments = useCallback((sid: string | null) => {
    if (!sid) return;
    setAttachedBySession((prev) => (prev[sid]?.length ? { ...prev, [sid]: [] } : prev));
  }, []);
  const attachedFiles = attachedFor(currentSessionId);
  // The user's last explicitly-chosen model, persisted so it survives restart
  // and is the fallback for new chats and 'auto'/legacy sessions -- instead of
  // always snapping back to the hardcoded default.
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return uiGet('kirolex-last-model') || 'claude-opus-4.6'; }
    catch { return 'claude-opus-4.6'; }
  });
  const [models, setModels] = useState<any[]>([]);
  const [kiroAgents, setKiroAgents] = useState<Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>>([]);
  // Per-session, NOT global: switching the model/Agent on one chat must never
  // grey out the selectors of another chat you switch to.
  const [switchingAgentIds, setSwitchingAgentIds] = useState<string[]>([]);
  const [switchingModelIds, setSwitchingModelIds] = useState<string[]>([]);
  const switchingAgent = !!currentSessionId && switchingAgentIds.includes(currentSessionId);
  const switchingModel = !!currentSessionId && switchingModelIds.includes(currentSessionId);
  const [showSettings, setShowSettings] = useState(false);
  const [executorCap, setExecutorCap] = useState<number>(0);
  useEffect(() => {
    window.kiroApi.getExecutorCap?.().then((n) => { if (n) setExecutorCap(n); }).catch(() => {});
  }, []);
  // Settings changes the cap live; reflect the new value in the sidebar N/cap
  // display without an app reload.
  useEffect(() => {
    const h = (e: Event) => {
      const c = (e as CustomEvent).detail?.cap;
      if (typeof c === 'number' && c > 0) setExecutorCap(c);
    };
    window.addEventListener('kirolex:executor-cap-changed', h as EventListener);
    return () => window.removeEventListener('kirolex:executor-cap-changed', h as EventListener);
  }, []);
  // Keep the Settings "confirm before delete" toggle in lockstep with the value
  // delete actually uses (persisted flag). handleDeleteSession reads the flag live
  // from localStorage, so re-hydrate the state whenever Settings opens to avoid the
  // toggle showing a stale value that disagrees with the real delete behavior.
  useEffect(() => {
    if (!showSettings) return;
    try { setSkipDeleteConfirm(uiGet('kirolex-skip-delete-confirm') === 'true'); } catch {}
  }, [showSettings]);
  const [showWorkspace, setShowWorkspace] = useState(false);

  const [showMemory, setShowMemory] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logsText, setLogsText] = useState('');
  // Log viewer opens at the newest tail; older lines load on scroll-up.
  const [logsLimit, setLogsLimit] = useState(500);
  const [logsLoadingOlder, setLogsLoadingOlder] = useState(false);
  const logsPreRef = useRef<HTMLPreElement>(null);
  const logsHasMoreRef = useRef(true);
  const LOGS_CHUNK = 500;
  // In-app file viewer (internal "browser"): file links/paths open here, not the OS.
  // File viewer TABS. Was a single object, so every click replaced the open file —
  // losing scroll position, the rendered/raw choice, and any way back without
  // re-finding the link in chat. Each tab now owns its own content and view state.
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const fileScrollRef = useRef<Record<string, number>>({});   // tabId -> scrollTop
  const fileBodyRef = useRef<HTMLDivElement | null>(null);
  const fileViewer = fileTabs.find((t) => t.id === activeFileTabId) || null;
  const [fileViewerLoading, setFileViewerLoading] = useState(false);
  // Markdown files render formatted by default; the toggle shows the raw source.
  const fileViewerRaw = !!fileViewer?.raw;
  const [settings, setSettings] = useState<Settings>(loadSettings);

  // --- Split view (1x1 … 3x3) -----------------------------------------------
  // The user CHECKS sessions in the sidebar; every checked session gets its own
  // fully interactive pane (own composer, queue, attachments, model). The
  // focused session is always shown, so unchecking everything returns to the
  // exact single-chat layout. Each pane stays live because useAcp mirrors those
  // sessions' streams into pane state.
  // focusSession is defined much further down; a dep on it here would be
  // evaluated during render and hit TDZ. Route through a ref instead.
  const focusSessionRef = useRef<(sid: string | null) => Promise<void>>(async () => {});
  /** Forward reference to handleQueueMessage, which is declared further down. Used
   *  so handleSendMessage can divert into the queue while a history rebuild owns
   *  the backend, without putting a later-declared const in a dependency array. */
  const queueMessageRef = useRef<((text: string, pastes?: PastedBlock[], paneSid?: string) => void) | null>(null);
  /** Same forward-reference pattern as queueMessageRef: handleSteerMessage is
   *  declared further down, and naming it in a dependency array up here would be
   *  evaluated during render and hit TDZ. */
  const handleSteerMessageRef = useRef<((text: string, pastes?: PastedBlock[], paneSid?: string) => Promise<void> | void) | null>(null);
  // The layout (which chat sits in which slot) IS remembered across restarts, so
  // reopening the app puts you back where you were. What must NOT happen is
  // re-filling slots when you merely switch the grid size on -- that is why the
  // grid-change effect below seeds only the current chat and leaves the rest
  // empty, while a restart restores the saved list verbatim.
  const [splitSessionIds, setSplitSessionIds] = useState<string[]>(() => {
    try {
      // Shared store, not origin-scoped localStorage: which chats sit in which pane
      // is layout state and was being lost on every dev/prod origin switch. The key
      // already existed in ui-state.json as a migration leftover that nothing read.
      const saved = JSON.parse(uiGet(SPLIT_SESSION_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
    } catch { return []; }
  });
  /** True until the restored layout has been reconciled against the real session
   *  list, so startup does not look like a user action. */
  const layoutRestoredRef = useRef(false);
  const { rows: splitRows, cols: splitCols, capacity: splitCapacity } = SPLIT_GRIDS[settings.splitGrid] || SPLIT_GRIDS['1x2'];
  // The highlighted set IS the grid, in selection order. Empty set = classic
  // single-chat layout. Deriving panes from the focused chat instead was wrong:
  // focusing a highlighted chat then collapsed the grid back to one pane.
  const panes = useMemo(() => {
    const known = new Set(sessions.map((s) => s.id));
    const list = splitSessionIds.filter((id) => known.has(id)).slice(0, Math.max(1, splitCapacity));
    if (list.length) return list;
    return currentSessionId ? [currentSessionId] : [];
  }, [splitSessionIds, sessions, splitCapacity, currentSessionId]);
  /** Split layout is driven by the setting, so a single chosen chat still renders
   *  as a grid (with the "add" strip) rather than silently collapsing to one chat. */
  const splitActive = splitCapacity > 1 && splitSessionIds.length > 0;
  // Assigned chats share the space; unused capacity is just the slim strip.
  const paneCols = Math.max(1, Math.min(splitCols, panes.length));
  const paneRows = Math.max(1, Math.ceil(panes.length / paneCols));
  // Where the free slots actually are decides the strip's orientation: a partly
  // filled row means "to the right", a full row with rows to spare means "below".
  const hasRoom = panes.length < splitCapacity;
  const rowComplete = panes.length % splitCols === 0;
  const stripBelow = hasRoom && rowComplete && paneRows < splitRows;
  const stripRight = hasRoom && !stripBelow;
  /** Panes grouped into rows. The layout is nested flex (rows of panes), not one
   *  CSS grid: a grid forces every row to share the same column tracks, so the
   *  "add" strip had to become a full-height column down the whole right edge
   *  even when the only free cell was the bottom-right one. Rows own their own
   *  splits, which also makes each divider independently draggable. */
  const paneRowsOfPanes = useMemo(() => {
    const out: (string | null)[][] = [];
    for (let i = 0; i < panes.length; i += paneCols) out.push(panes.slice(i, i + paneCols));
    return out.length ? out : [[null]];
  }, [panes, paneCols]);
  /** Dragged sizes are keyed by layout shape: restoring fractions that belonged to
   *  a different pane count would silently mis-size the new arrangement. */
  const splitShape = `${paneRowsOfPanes.length}x${paneCols}:${panes.length}:${stripBelow ? 'b' : stripRight ? 'r' : '-'}`;
  const [splitSizes, setSplitSizes] = useState<SplitSizes | null>(() => {
    try {
      // Shared store, NOT localStorage. localStorage is origin-scoped and this app
      // has two renderer origins (file:// for a normal start, http://localhost:5173
      // in dev), so dragged pane proportions silently reset every time you switched
      // between `npm start` and `npm run dev:hot` -- the same class of loss that
      // already cost project groups, pins and archive flags.
      const saved = uiGet(SPLIT_SIZES_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  // Live feature switches (main owns them; a Settings toggle re-renders here).
  const featureFlags = useFeatureFlags();
  const dragSplits = featureFlags.splitDragResize !== false;
  // Carried, not exact-matched: adding a pane must not move the dividers that
  // still describe the same structure. See carrySplitSizes.
  const activeSizes = useMemo(
    () => carrySplitSizes(splitSizes, splitShape, paneRowsOfPanes),
    [splitSizes, splitShape, paneRowsOfPanes],
  );
  const rowFlex = (r: number) => activeSizes?.rows?.[r] ?? 1;
  /** Per-row cell widths, INCLUDING the trailing empty cell when the row has one.
   *
   *  The empty slot used to be a fixed 56px sliver, which is what made every added
   *  pane shove the existing ones: the thinner the sliver, the more the real panes
   *  spread out, so the next pane had that much more to take back. With 3 chats in a
   *  2x2 the bottom pane spanned the whole row and then halved the moment a 4th
   *  arrived, and its edge never lined up with the row above it.
   *
   *  So an empty slot is a REAL CELL that takes the rest of its row, and its width
   *  comes from the ROW ABOVE -- a pane added later therefore lands exactly on the
   *  cell the placeholder occupied and nothing else moves. With no row above to copy,
   *  the row is split evenly. Own dragged values always win over inherited ones. */
  /** Cell widths per row, including the trailing empty slot. The rules and the
   *  reasoning live in splitLayout.ts, which is pure and covered by tests. */
  const rowCells = useMemo(
    () => computeRowCells(paneRowsOfPanes, { stripRight, splitCols, sizes: activeSizes }),
    [paneRowsOfPanes, stripRight, splitCols, activeSizes],
  );
  const colFlex = (r: number, c: number) => rowCells[r]?.paneFlex?.[c] ?? 1;
  /** Drag a divider: the two neighbours trade space, everything else holds still.
   *  Sizes are read from the DOM rather than from state so a fresh (all-equal)
   *  layout and an already-dragged one behave identically. */
  const handlePaneResizeStart = useCallback((
    e: React.MouseEvent,
    axis: 'col' | 'row',
    rowIndex: number,
    dividerIndex: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const prev = handle.previousElementSibling as HTMLElement | null;
    const next = handle.nextElementSibling as HTMLElement | null;
    if (!prev || !next) return;
    const horizontal = axis === 'col';
    const startPos = horizontal ? e.clientX : e.clientY;
    const prevBox = prev.getBoundingClientRect();
    const nextBox = next.getBoundingClientRect();
    const prevSize = horizontal ? prevBox.width : prevBox.height;
    const nextSize = horizontal ? nextBox.width : nextBox.height;
    const total = prevSize + nextSize;
    // A pane narrower than this cannot show its composer controls.
    const MIN = horizontal ? 320 : 180;
    if (total < MIN * 2) return;
    let dragging = true;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) return;
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      const newPrev = Math.max(MIN, Math.min(total - MIN, prevSize + delta));
      setSplitSizes((cur) => {
        // Build on the CARRIED sizes, not on an exact shape match: otherwise the
        // first drag after adding a pane would discard the proportions that were
        // just carried over and snap everything back to equal.
        const carried = carrySplitSizes(cur, splitShape, paneRowsOfPanes);
        const base = carried
          ? { shape: splitShape, rows: [...carried.rows], cols: carried.cols.map((row) => [...row]) }
          : {
            shape: splitShape,
            rows: paneRowsOfPanes.map(() => 1),
            cols: paneRowsOfPanes.map((row) => row.map(() => 1)),
          };
        while (base.rows.length < paneRowsOfPanes.length) base.rows.push(1);
        paneRowsOfPanes.forEach((row, r) => {
          if (!base.cols[r]) base.cols[r] = row.map(() => 1);
          while (base.cols[r].length < row.length) base.cols[r].push(1);
        });
        // Preserve the pair's combined share so untouched neighbours never move.
        const target = horizontal ? base.cols[rowIndex] : base.rows;
        const pairSum = (target[dividerIndex] ?? 1) + (target[dividerIndex + 1] ?? 1);
        const share = pairSum * (newPrev / total);
        target[dividerIndex] = share;
        target[dividerIndex + 1] = pairSum - share;
        return base;
      });
    };
    const onMouseUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [splitShape, paneRowsOfPanes]);
  useEffect(() => {
    try {
      // Reset (null) must also clear storage, otherwise a reload restores the
      // proportions the user just discarded.
      if (splitSizes) uiSet(SPLIT_SIZES_KEY, JSON.stringify(splitSizes));
      else uiRemove(SPLIT_SIZES_KEY);
    } catch {}
  }, [splitSizes]);

  const toggleSplitSession = useCallback((id: string) => {
    // Everything here runs in an event handler and reads state directly. Do NOT
    // move the setSettings call into a setSplitSessionIds updater: React can
    // replay updaters, and scheduling another update from inside one froze the
    // renderer and lost the selection.
    if (splitSessionIds.includes(id)) {
      const next = splitSessionIds.filter((x) => x !== id);
      if (next.length === 0) {
        // Closed the last pane = leave split mode entirely.
        setSettings((cur) => ({ ...cur, splitGrid: '1x1' }));
        setSplitSessionIds([]);
        return;
      }
      setSplitSessionIds(next);
      // Removing the chat you were in: move focus to the first survivor.
      if (id === currentSessionId) void focusSessionRef.current(next[0]);
      return;
    }
    // First selection seeds the grid with the chat you are already in, so one
    // ⌘-click gives a side-by-side instead of a single unrelated pane.
    const seeded = splitSessionIds.length === 0 && currentSessionId && currentSessionId !== id
      ? [currentSessionId, id]
      : [...splitSessionIds, id];
    let cap = Math.max(1, splitCapacity);
    // A 1x1 grid means "no split". Explicitly picking a second chat is a clear
    // intent to split, so raise the grid rather than ignore the click.
    if (cap < 2 && seeded.length > 1) {
      setSettings((cur) => (SPLIT_GRIDS[cur.splitGrid].capacity < 2 ? { ...cur, splitGrid: '1x2' } : cur));
      cap = 2;
    }
    setSplitSessionIds(seeded.length > cap ? seeded.slice(seeded.length - cap) : seeded);
  }, [splitSessionIds, currentSessionId, splitCapacity]);

  // The grid setting IS the on/off switch.
  //   * 1x1            -> leave split mode (assignments dropped)
  //   * turned ON empty -> seed with ONLY the chat you are in; other slots stay
  //                        empty (never pre-filled with recent chats)
  //   * made SMALLER   -> discard the assignments that no longer fit
  //   * made BIGGER    -> keep everything, new slots are empty
  const appliedGridRef = useRef<SplitGrid | null>(null);
  useEffect(() => {
    const cap = SPLIT_GRIDS[settings.splitGrid]?.capacity ?? 1;
    const gridChanged = appliedGridRef.current !== null && appliedGridRef.current !== settings.splitGrid;
    appliedGridRef.current = settings.splitGrid;
    if (cap <= 1) {
      if (splitSessionIds.length) setSplitSessionIds([]);
      return;
    }
    if (splitSessionIds.length > cap) {
      // Shrunk: keep the first `cap` slots, drop the rest.
      setSplitSessionIds(splitSessionIds.slice(0, cap));
      return;
    }
    if (splitSessionIds.length === 0 && currentSessionId && !currentSessionId.startsWith('pending_')) {
      setSplitSessionIds([currentSessionId]);
    }
    void gridChanged;
  }, [settings.splitGrid, currentSessionId, splitSessionIds]);

  // Plain-clicking a chat that is not in the grid would hide it entirely, so
  // adopt it into the grid (oldest pane makes room) instead of leaving the
  // focused chat invisible.
  useEffect(() => {
    if (!currentSessionId || splitSessionIds.length === 0) return;
    if (splitSessionIds.includes(currentSessionId)) return;
    setSplitSessionIds((prev) => {
      if (prev.includes(currentSessionId)) return prev;
      const cap = Math.max(1, splitCapacity);
      const next = [...prev, currentSessionId];
      return next.length > cap ? next.slice(next.length - cap) : next;
    });
  }, [currentSessionId, splitSessionIds, splitCapacity]);

  // Every pane except the focused one needs its stream mirrored into state.
  useEffect(() => {
    void setPaneSessions(panes.filter((id) => id !== currentSessionId));
  }, [panes, currentSessionId, setPaneSessions]);

  useEffect(() => {
    try {
      if (splitSessionIds.length) uiSet(SPLIT_SESSION_KEY, JSON.stringify(splitSessionIds));
      else uiRemove(SPLIT_SESSION_KEY);
    } catch {}
  }, [splitSessionIds]);

  // Startup reconciliation, once the session list exists: drop chats that no
  // longer exist, and focus a restored pane instead of letting the "adopt the
  // focused chat" rule below rewrite the layout we just restored.
  useEffect(() => {
    if (layoutRestoredRef.current || sessions.length === 0) return;
    layoutRestoredRef.current = true;
    if (splitSessionIds.length === 0) return;
    const known = new Set(sessions.map((x) => x.id));
    const alive = splitSessionIds.filter((id) => known.has(id));
    if (alive.length !== splitSessionIds.length) setSplitSessionIds(alive);
    if (alive.length && currentSessionId && !alive.includes(currentSessionId)) {
      void focusSessionRef.current(alive[0]);
    }
  }, [sessions, splitSessionIds, currentSessionId]);
  const [homeDir, setHomeDir] = useState('~');
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);
  const [rerunConfirm, setRerunConfirm] = useState<{
    messageId: string;
    editedText: string;
    deleteCount: number;
    /** The chat the rerun belongs to — a split pane is not necessarily focused. */
    sessionId?: string;
  } | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{ name: string; memberCount: number } | null>(null);
  const [usageActionConfirm, setUsageActionConfirm] = useState<
    'contextMenu' | 'compact' | 'clear' | 'resetCredits' | null
  >(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);
  // "Don't ask again" for delete confirmation (persisted).
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState<boolean>(() => {
    try { return uiGet('kirolex-skip-delete-confirm') === 'true'; } catch { return false; }
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
      if (fid !== currentSessionId && !loopingIds.includes(fid)) {
        setUnreadSessionIds((u) => (u.includes(fid) ? u : [...u, fid]));
      }
    }
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds, currentSessionId, loopingIds]);

  // Clear unread when user switches to a session
  const handleSwitchSession = useCallback((sessionId: string) => {
    setUnreadSessionIds((prev) => prev.filter((id) => id !== sessionId));
    switchSession(sessionId);
  }, [switchSession]);

  const handleOpenLogs = useCallback(async () => {
    const result = await window.kiroApi.getLogs(LOGS_CHUNK).catch(() => ({
      text: '(failed to read logs)',
      path: '',
    }));
    logsHasMoreRef.current = result.text.split('\n').length >= LOGS_CHUNK;
    setLogsLimit(LOGS_CHUNK);
    setLogsText(result.text);
    setShowLogs(true);
  }, []);

  // Older logs load when the user scrolls to the top; scroll position is
  // preserved so the view doesn't jump.
  const loadOlderLogs = useCallback(async () => {
    if (!logsHasMoreRef.current || logsLoadingOlder) return;
    const el = logsPreRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setLogsLoadingOlder(true);
    const nextLimit = logsLimit + LOGS_CHUNK;
    const result = await window.kiroApi.getLogs(nextLimit).catch(() => ({ text: logsText, path: '' }));
    const newCount = result.text.split('\n').length;
    if (newCount <= logsText.split('\n').length) {
      logsHasMoreRef.current = false; // reached the top of the file
    } else {
      setLogsText(result.text);
      setLogsLimit(nextLimit);
      requestAnimationFrame(() => {
        if (logsPreRef.current) logsPreRef.current.scrollTop += logsPreRef.current.scrollHeight - prevHeight;
      });
    }
    setLogsLoadingOlder(false);
  }, [logsLimit, logsLoadingOlder, logsText]);

  // On open, jump to the newest entries (bottom).
  useEffect(() => {
    if (showLogs && logsPreRef.current) {
      logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
    }
  }, [showLogs]);

  /** Close one tab; activate a sensible neighbour so the panel never goes blank
   *  while other files are still open.
   *  NOTE: declared BEFORE openFileInApp on purpose — it appears in that
   *  callback's dependency array, which is evaluated during render (a const
   *  declared later would hit TDZ and crash the whole tree). */
  const closeFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      setActiveFileTabId((current) => {
        if (current !== tabId) return current;
        const neighbour = next[idx] || next[idx - 1] || null;
        return neighbour ? neighbour.id : null;
      });
      return next;
    });
    delete fileScrollRef.current[tabId];
  }, []);

  // Open a file inside KiroLex's own viewer (internal "browser") rather than the
  // OS default app. Reads via the connected session's workspace:read.
  // Exception: file types the viewer cannot render (PDF/Office/media/archives…)
  // are handed to the OS default application instead of opening a dead tab.
  const openFileInApp = useCallback(async (rawPath: string) => {
    const p = rawPath.replace(/^file:\/\//, '');
    // Already open -> just focus that tab. Re-reading would throw away the scroll
    // position and the rendered/raw choice the user had set.
    const existing = fileTabs.find((t) => t.path === p);
    if (existing) { setActiveFileTabId(existing.id); return; }

    // Known non-previewable type: go straight to the system app, no tab flash.
    if (needsSystemApp(p)) {
      const res = await window.kiroApi.openExternal?.(p, currentSessionId || undefined);
      if (res?.ok !== false) return;
      // Fall through to the in-app tab so the failure is visible (and the tab
      // still offers Download).
    }

    const id = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setFileTabs((prev) => {
      const next = [...prev, { id, path: p, content: '' }];
      // Evict the oldest tab that is not the one we just opened.
      return next.length > MAX_FILE_TABS ? next.slice(next.length - MAX_FILE_TABS) : next;
    });
    setActiveFileTabId(id);
    setFileViewerLoading(true);
    try {
      // No connected chat required: the file viewer reads local disk, and gating it
      // on a session made the viewer (and the Workspace panel that feeds it) fail
      // with "打开一个已连接的会话后才能..." for any dormant chat. currentSessionId is
      // passed only so a RELATIVE path resolves against that chat's cwd.
      const result = await window.kiroApi.workspaceRead(currentSessionId, p);
      // Detected binary (NUL bytes / oversized image) with no useful preview:
      // hand it to the system app and drop the tab we just opened.
      if (result.binary && !result.image) {
        const res = await window.kiroApi.openExternal?.(p, currentSessionId || undefined);
        if (res?.ok !== false) { closeFileTab(id); return; }
      }
      setFileTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...result } : t)));
    } catch (err: any) {
      const message = `⚠️ ${err?.message || '无法读取文件。'}`;
      setFileTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content: message } : t)));
    } finally {
      setFileViewerLoading(false);
    }
  }, [currentSessionId, fileTabs, closeFileTab]);

  const setActiveTabRaw = useCallback((raw: boolean) => {
    setFileTabs((prev) => prev.map((t) => (t.id === activeFileTabId ? { ...t, raw } : t)));
  }, [activeFileTabId]);

  // Restore this tab's scroll position after it becomes active (and after its
  // content lands, which is why `fileViewer?.content` is a dependency).
  useEffect(() => {
    if (!activeFileTabId) return;
    const node = fileBodyRef.current;
    if (!node) return;
    const target = fileScrollRef.current[activeFileTabId] ?? 0;
    requestAnimationFrame(() => { try { node.scrollTop = target; } catch {} });
  }, [activeFileTabId, fileViewer?.content]);

  // Persist WHICH files are open (paths only, plus the raw/rendered choice) so the
  // set survives a restart; content is re-read lazily on first activation.
  useEffect(() => {
    try {
      // Shared store, not origin-scoped localStorage -- same reason as the drafts and
      // split sizes: the set of open files was reset on every dev/prod origin switch.
      if (fileTabs.length === 0) { uiRemove(OPEN_TABS_KEY); return; }
      uiSet(OPEN_TABS_KEY, JSON.stringify({
        tabs: fileTabs.map((t) => ({ path: t.path, raw: !!t.raw })),
        activePath: fileViewer?.path || null,
      }));
    } catch {}
  }, [fileTabs, fileViewer?.path]);

  // Re-open last session's tabs on mount. This used to wait for `currentSessionId`
  // because workspaceRead demanded a connected chat; it no longer does, so the tabs
  // come back immediately instead of only after a backend happens to attach.
  const tabsRestoredRef = useRef(false);
  useEffect(() => {
    if (tabsRestoredRef.current) return;
    tabsRestoredRef.current = true;
    let saved: { tabs?: { path: string; raw?: boolean }[]; activePath?: string | null } | null = null;
    try { saved = JSON.parse(uiGet(OPEN_TABS_KEY) || 'null'); } catch {}
    const paths = (saved?.tabs || []).map((t) => t.path).filter(Boolean);
    if (!paths.length) return;
    (async () => {
      for (const path of paths.slice(0, MAX_FILE_TABS)) await openFileInApp(path);
      const active = saved?.activePath;
      if (active) {
        setFileTabs((prev) => {
          const hit = prev.find((t) => t.path === active);
          if (hit) setActiveFileTabId(hit.id);
          return prev.map((t) => {
            const savedTab = (saved?.tabs || []).find((x) => x.path === t.path);
            return savedTab?.raw ? { ...t, raw: true } : t;
          });
        });
      }
    })();
  }, [currentSessionId, openFileInApp]);

  // ⌘/Ctrl+W closes the active file tab, ⌘/Ctrl+1..9 jumps to the Nth. Only while
  // the panel is open, so these never steal the shortcut from the rest of the app.
  useEffect(() => {
    if (fileTabs.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (activeFileTabId) closeFileTab(activeFileTabId);
        return;
      }
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && fileTabs[n - 1]) {
        event.preventDefault();
        setActiveFileTabId(fileTabs[n - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileTabs, activeFileTabId, closeFileTab]);

  // File links/paths rendered in chat dispatch this event; open them in-app.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (typeof path === 'string' && path) void openFileInApp(path);
    };
    window.addEventListener('kirolex:open-file', handler as EventListener);
    return () => window.removeEventListener('kirolex:open-file', handler as EventListener);
  }, [openFileInApp]);

  const handleForkMessage = useCallback((messageId: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    if (loopingIds.includes(sid)) return;   // loop owns the session
    const forkedSessionId = duplicateSession(sid, messageId);
    if (forkedSessionId) handleSwitchSession(forkedSessionId);
  }, [currentSessionId, duplicateSession, handleSwitchSession, loopingIds]);

  // Rerun must resolve the turn inside the SESSION THE MESSAGE BELONGS TO. It
  // used to scan the focused chat's `messages`, so a rerun issued from a split
  // pane looked up the id in the wrong conversation (and could truncate it).
  const handleRerunMessage = useCallback((messageId: string, editedText: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (sid && loopingIds.includes(sid)) return;   // loop owns the session
    const list = (sid && sid !== currentSessionId ? paneViews[sid]?.messages : messages) || [];
    const baseIndex = list.findIndex((message) => message.id === messageId);
    if (baseIndex < 0) return;
    let turnEnd = baseIndex;
    while (
      turnEnd + 1 < list.length
      && list[turnEnd + 1].role === 'user'
      && !!list[turnEnd + 1].steer
    ) {
      turnEnd++;
    }
    const laterRecords = list.slice(turnEnd + 1);
    const hasLaterUserTurn = laterRecords.some((message) => message.role === 'user');
    if (hasLaterUserTurn) {
      setRerunConfirm({ messageId, editedText, deleteCount: laterRecords.length, sessionId: sid || undefined });
      return;
    }
    void rerunFromMessage(messageId, editedText, undefined, sid || undefined);
  }, [messages, paneViews, currentSessionId, rerunFromMessage, loopingIds]);

  const confirmRerun = useCallback(() => {
    if (!rerunConfirm) return;
    const pending = rerunConfirm;
    setRerunConfirm(null);
    void rerunFromMessage(pending.messageId, pending.editedText, undefined, pending.sessionId);
  }, [rerunConfirm, rerunFromMessage]);

  const handleDeleteSession = useCallback((sessionId: string) => {
    // Drop it from the split layout too, otherwise the saved list keeps growing
    // with ids of chats that no longer exist (rendering already filters them,
    // but the persisted layout should stay clean).
    setSplitSessionIds((prev) => (prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : prev));
    // Read the persisted flag live (single source of truth, written by both the
    // Settings toggle and the dialog's "Don't ask again") to avoid any stale
    // closure of skipDeleteConfirm.
    let skip = skipDeleteConfirm;
    try { skip = uiGet('kirolex-skip-delete-confirm') === 'true'; } catch {}
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
        try { uiSet('kirolex-skip-delete-confirm', 'true'); } catch {}
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
          uiSet('kirolex-models', JSON.stringify(data.models || []));
        } catch {}
      }).catch(() => {
        try {
          const cached = uiGet('kirolex-models');
          if (cached) setModels(JSON.parse(cached));
        } catch {}
      });

      window.kiroApi.listKiroAgents().then((data) => {
        setKiroAgents(data.agents || []);
      }).catch(() => setKiroAgents([]));

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

  // Font families are applied as CSS variables so every surface (chat, sidebar,
  // dialogs, code blocks) follows the setting without per-component overrides.
  useEffect(() => {
    const root = document.documentElement.style;
    if (settings.fontFamily.trim()) root.setProperty('--app-font', settings.fontFamily);
    else root.removeProperty('--app-font');
    if (settings.monoFontFamily.trim()) root.setProperty('--mono-font', settings.monoFontFamily);
    else root.removeProperty('--mono-font');
  }, [settings.fontFamily, settings.monoFontFamily]);

  // Persist from EVERY path, not just the dialog. Split view raises/clears
  // splitGrid internally (entering and leaving split mode), and those changes
  // were silently lost because only the dialog handler called saveSettings.
  useEffect(() => { saveSettings(settings); }, [settings]);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
  }, []);

  const handleModelChange = useCallback(async (model: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (
      !sid ||
      streamingIds.includes(sid) ||
      loopingIds.includes(sid) ||
      switchingModelIds.includes(sid)
    ) return;

    setSwitchingModelIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    try {
      const effective = (await changeSessionModel(sid, model)) || model;
      // Reflect what the BACKEND confirmed. Setting the requested model here
      // unconditionally is what let the selector drift away from the executor.
      setSelectedModel(effective);
      try { uiSet('kirolex-last-model', effective); } catch {}
    } finally {
      setSwitchingModelIds((prev) => prev.filter((id) => id !== sid));
    }
  }, [currentSessionId, streamingIds, loopingIds, switchingModelIds, changeSessionModel]);

  // Keep the model dropdown in sync with the current session's model.
  // A session with its own explicit model shows it; 'auto'/legacy sessions fall
  // back to the user's last-chosen model (persisted) rather than a hardcoded one.
  useEffect(() => {
    if (!currentSessionId) return;
    const s = sessions.find((x) => x.id === currentSessionId);
    let lastModel = 'claude-opus-4.6';
    try { lastModel = uiGet('kirolex-last-model') || lastModel; } catch {}
    const effective = (s?.model && s.model !== 'auto') ? s.model : lastModel;
    setSelectedModel(effective);
  }, [currentSessionId, sessions]);

  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  const selectedKiroAgent = currentSession?.kiroAgent
    || kiroAgents.find((agent) => agent.isDefault)?.name
    || 'kiro_default';

  const handleKiroAgentChange = useCallback(async (agentName: string, paneSid?: string) => {
    // `paneSid` was accepted and then ignored, so changing the Agent in a split
    // pane reconfigured the FOCUSED pane's session instead — a wrong-target write,
    // not just a display glitch. Every guard below is likewise per-session; the
    // focused-pane values (isStreaming / switchingAgent / selectedKiroAgent) let a
    // switch through while the target pane was busy and compared against the wrong
    // Agent. Mirrors handleModelChange.
    const sid = paneSid || currentSessionId;
    const currentAgent = sessions.find((session) => session.id === sid)?.kiroAgent
      || kiroAgents.find((agent) => agent.isDefault)?.name
      || 'kiro_default';
    if (
      !sid ||
      streamingIds.includes(sid) ||
      loopingIds.includes(sid) ||
      switchingAgentIds.includes(sid) ||
      agentName === currentAgent
    ) return;

    setSwitchingAgentIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    try {
      await changeSessionAgent(sid, agentName);
    } finally {
      setSwitchingAgentIds((prev) => prev.filter((id) => id !== sid));
    }
  }, [currentSessionId, sessions, kiroAgents, streamingIds, loopingIds, switchingAgentIds, changeSessionAgent]);


  const permissionMode = currentSession?.permissionMode || 'auto-approve';
  const handlePermissionModeChange = useCallback(async (
    mode: 'auto-approve' | 'ask',
    paneSid?: string,
  ) => {
    const sid = paneSid || currentSessionId;
    const sessionForMode = sid ? sessions.find((s) => s.id === sid) : null;
    if (
      !sid
      || streamingIds.includes(sid)
      || loopingIds.includes(sid)
      || mode === (sessionForMode?.permissionMode || 'auto-approve')
    ) return;
    await changeSessionPermissionMode(sid, mode);
  }, [
    currentSessionId,
    sessions,
    streamingIds,
    loopingIds,
    changeSessionPermissionMode,
  ]);

  const handleDropFiles = useCallback((files: AttachedFile[], sid?: string) => {
    addAttachments(sid || currentSessionId, files);
  }, [addAttachments, currentSessionId]);

  const handleRemoveFile = useCallback((id: string, sid?: string) => {
    const target = sid || currentSessionId;
    if (!target) return;
    setAttachedBySession((prev) => ({ ...prev, [target]: (prev[target] || []).filter((f) => f.id !== id) }));
  }, [currentSessionId]);

  /** Make `sid` the focused session before acting on it. switchSession sets the
   *  hook's currentSessionRef SYNCHRONOUSLY, so a send issued right after this
   *  lands in `sid` even before React re-renders. This is what lets every split
   *  pane have a working composer without duplicating the send pipeline. */
  const focusSession = useCallback(async (sid: string | null) => {
    if (!sid || sid === currentSessionId) return;
    await handleSwitchSession(sid);
  }, [currentSessionId, handleSwitchSession]);

  focusSessionRef.current = focusSession;

  const handleSendMessage = useCallback(async (text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    // A loop OWNS its session: it is already resending on a timer, so anything else
    // sent into it interleaves with those turns. Stop is the only way out, and it
    // clears the loop (see cancelStream). Disabling the buttons was not enough —
    // Enter and Ctrl+Enter reach these handlers directly.
    if (sid && loopingIds.includes(sid)) return;
    await focusSession(sid);
    // Clear unread status when user interacts
    if (sid) {
      setUnreadSessionIds((prev) => prev.filter((id) => id !== sid));
    }

    // History rebuild in progress / owed: the backend cannot answer this yet, so
    // QUEUE it rather than firing it into a context-less session. The queue drains
    // automatically once the rebuild finishes, preserving order. Slash commands are
    // handled locally below and are exempt.
    if (sid && !text.trim().startsWith('/') && isBackendOccupied(busyBySession[sid])
        && (busyBySession[sid] === 'prime-pending' || busyBySession[sid] === 'priming')) {
      // Via ref: handleQueueMessage is declared BELOW this callback, and a
      // later-declared const in a dependency array is evaluated during render and
      // would hit TDZ, crashing the whole tree.
      queueMessageRef.current?.(text, pastes, sid);
      return;
    }

    // A TURN is still running on this chat. Reaching here means the composer thought
    // otherwise -- e.g. this window reloaded mid-turn and lost `streamingIds`, so
    // Enter sent instead of steering. Main would reject it ("wait for the active
    // turn") AFTER the bubble is already on screen, i.e. the message silently never
    // arrives. Steer it into the running turn instead, which is what Enter during a
    // turn means anyway.
    if (sid && !text.trim().startsWith('/') && busyBySession[sid] === 'turn') {
      void handleSteerMessageRef.current?.(text, pastes, sid);
      return;
    }

    // Handle /stop locally - force interrupt and reconnect
    if (text.trim() === '/stop') {
      // Hard stop is an explicit user cancel: clear every session's un-consumed
      // pending steers so the turn-end reconcile can't re-queue a phantom
      // follow-up after the reconnect. Ordinary queues are preserved (KiroLex
      // "Stop keeps the queue" rule) — we only drop un-consumed steers.
      discardUnconsumedSteers();
      await forceStop(selectedModel);
      sendMessage([{ type: 'text', text: '/stop' }], '🔄 Force interrupted and reconnected.');
      return;
    }

    // Handle /clear: wipe the visible history + cache, then forward /clear so
    // the backend also resets its context. KiroLex's own stored transcript is
    // deliberately left alone -- see the note on clearConversation.
    if (text.trim() === '/clear') {
      clearConversation(sid);
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
    const currentAttachments = [...attachedFor(sid)];

    if (currentAttachments.length > 0) {
      const fileRefs = currentAttachments
        .map((f) => `file:${f.path}`)
        .join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }

    // With attachments and no typed text, the hidden file-ref block already
    // carries the instruction -- don't append an empty text part.
    // The MODEL must see the real pasted content; the bubble and the transcript
    // keep the short `[ 粘贴 #N · M 行 ]` placeholders. KiroLex already separates
    // prompt from displayText, so this needs no extra storage.
    const expanded = pastes?.length ? expandPastes(text, pastes) : text;
    if (text.trim() || currentAttachments.length === 0) prompt.push({ type: 'text', text: expanded });
    clearAttachments(sid);
    await sendMessage(
      prompt,
      undefined,
      currentAttachments.length > 0 ? currentAttachments : undefined,
      selectedModel,
      pastes?.length
        ? { text, pastes: pastes.map(({ seq, lines, chars, path }) => ({ seq, lines, chars, path })) }
        : undefined,
    );
  }, [attachedFor, clearAttachments, focusSession, sendMessage, currentSessionId, forceStop, selectedModel, discardUnconsumedSteers, clearConversation, busyBySession, loopingIds]);

  // Explicit user Stop (composer stop button). Discard this session's un-consumed
  // steers FIRST so the turn-end reconcile finds nothing to re-queue (no phantom
  // follow-up turn), THEN cancel the running prompt. Already-consumed steers are
  // not pending, so they remain in the message group; only the current turn ends.
  const handleStopStream = useCallback(async (paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    // Stop must ALWAYS do something. Previously it returned early during a history
    // rebuild, which left no way to call off even a pending auto-resend.
    if (sid) {
      cancelAutoResend(sid);          // stop a queued/pending auto-resend first
      discardUnconsumedSteers(sid);
    }
    await cancelStream(sid);          // main turns this into "abandon rebuild" when priming
  }, [currentSessionId, discardUnconsumedSteers, cancelStream, cancelAutoResend]);

  const handleConfirmUsageAction = useCallback(async () => {
    const action = usageActionConfirm;
    setUsageActionConfirm(null);
    if (
      !action
      || action === 'contextMenu'
      || !currentSessionId
      || isStreaming
    ) return;
    if (action === 'compact') {
      await handleSendMessage('/compact');
    } else if (action === 'clear') {
      await handleSendMessage('/clear');
    } else {
      resetSessionCredits(currentSessionId);
    }
  }, [usageActionConfirm, currentSessionId, isStreaming, handleSendMessage, resetSessionCredits]);

  // MeshClaw-style per-session follow-up queues. A message submitted while its
  // session is busy is queued; idle submissions bypass the queue and run now.
  // Each queue is FIFO, independently drains in the background, and supports
  // edit/cancel/reorder before execution. Queue state is intentionally runtime-
  // only, matching MeshClaw's live slot queue rather than chat history.
  const [queuesBySession, setQueuesBySession] = useState<Record<string, QueuedMessage[]>>({});
  // Mirror so a pane's queue action can read ITS queue without depending on the
  // focused session's snapshot.
  const queuesBySessionRef = useRef<Record<string, QueuedMessage[]>>({});
  queuesBySessionRef.current = queuesBySession;
  const queueSendingRef = useRef<Set<string>>(new Set());
  const [restoredQueueDraft, setRestoredQueueDraft] = useState<{ id: number; text: string; sessionId?: string } | null>(null);

  const currentQueue = currentSessionId ? (queuesBySession[currentSessionId] || []) : [];

  // Reconcile un-consumed mid-turn steers into the queue head (order preserved)
  // once a turn finishes, so a steer written too late to be consumed is never
  // lost — it becomes a normal queued item that drains next on the idle session.
  // Kept separate from the unread effect so it can reference the queue state
  // declared just above (no forward reference), and uses its own transition ref.
  const prevSteerStreamingRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevSteerStreamingRef.current;
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      const leftover = takeUnconsumedSteers(fid);
      if (leftover.length === 0) continue;
      setQueuesBySession((current) => ({
        ...current,
        [fid]: [
          ...leftover.map((s) => ({
            id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content: s.content,
            attachments: s.attachments,
            createdAt: Date.now(),
          })),
          ...(current[fid] || []),
        ],
      }));
    }
    prevSteerStreamingRef.current = streamingIds;
  }, [streamingIds, takeUnconsumedSteers]);

  // Ordinary Enter while a turn is running. Precedence:
  //   (4) queue non-empty  -> extend the queue tail (never steer/interrupt);
  //   (7) has attachments  -> queue it (steer is text-only; never drop files);
  //   (3) else             -> steer the running turn via _session/steer.
  // Ctrl/⌘+Enter (handleQueueMessage) always adds a separate FIFO item instead.
  const handleSteerMessage = useCallback(async (text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const steerSid = paneSid || currentSessionId;
    if (steerSid && loopingIds.includes(steerSid)) return;   // loop owns the session
    await focusSession(steerSid);
    // Steering carries text only, so a paste must be expanded before it goes out —
    // the placeholder would otherwise reach the model as literal noise.
    if (pastes?.length) text = expandPastes(text, pastes);
    const content = text.trim();
    const sessionId = paneSid || currentSessionId;
    const attachments = [...attachedFor(sessionId)];
    if ((!content && attachments.length === 0) || !sessionId) return;

    // A history rebuild is a LOCKED task: it is a hidden turn whose whole purpose
    // is to restore the context, so steering into it would be answered without
    // that context and would never be visible. Park the message in the queue; it
    // drains in order the moment the rebuild finishes.
    const reason = busyBySession[sessionId];
    if (reason === 'priming' || reason === 'prime-pending') {
      queueMessageRef.current?.(content, pastes, sessionId);
      return;
    }

    // (4) Queue already has items: ordinary Enter merges into the last queued
    // follow-up (text joined by a blank line, attachments merged). Never steers.
    if (currentQueue.length > 0) {
      const tailId = currentQueue[currentQueue.length - 1].id;
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] || []).map((item) => (
          item.id === tailId
            ? {
                ...item,
                // Skip empty sides: a pure-attachment item (or an empty tail)
                // would otherwise leave blank paragraphs in the queued text.
                content: [item.content, content].map((s) => (s || '').trim()).filter(Boolean).join('\n\n'),
                attachments: [...item.attachments, ...attachments],
              }
            : item
        )),
      }));
      clearAttachments(sessionId);
      return;
    }

    // (7) _session/steer carries text only. A busy message with attachments
    // cannot be steered without silently dropping them — safe-degrade to a
    // normal queued item (drains after the turn); the UI shows it as queued.
    if (attachments.length > 0) {
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] || []),
          {
            id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            attachments,
            createdAt: Date.now(),
          },
        ],
      }));
      clearAttachments(sessionId);
      return;
    }

    // (3) Busy + empty queue + no attachments: steer the running turn. The
    // helper shows it optimistically and returns { steered }.
    clearAttachments(sessionId);
    const res = await steerMessage(content, sessionId);
    if (!res.steered) {
      // Reliable fallback (steer unsupported / turn already idle / write failed):
      // never drop the message — put it at the queue head so it delivers next.
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          { id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, content, attachments: [], createdAt: Date.now() },
          ...(prev[sessionId] || []),
        ],
      }));
    }
  }, [currentSessionId, currentQueue, attachedFor, clearAttachments, focusSession, steerMessage, loopingIds]);

  const handleQueueMessage = useCallback((text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const content = text.trim();
    const sessionId = paneSid || currentSessionId;
    if (!content || !sessionId) return;
    if (loopingIds.includes(sessionId)) return;   // loop owns the session
    const item: QueuedMessage = {
      id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      attachments: [...attachedFor(sessionId)],
      ...(pastes?.length ? { pastes } : {}),
      createdAt: Date.now(),
    };
    clearAttachments(sessionId);
    setQueuesBySession((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), item],
    }));
  }, [currentSessionId, attachedFor, clearAttachments, loopingIds]);
  // Publish it for handleSendMessage's rebuild diversion (declared above).
  queueMessageRef.current = handleQueueMessage;
  handleSteerMessageRef.current = handleSteerMessage;

  // Queue actions carry their own session: in split view the pane you clicked in
  // is NOT necessarily the focused chat, and using currentSessionId moved queue
  // items (and their text) into a different conversation.
  const handleCancelQueuedMessage = useCallback((queueId: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    const item = (queuesBySessionRef.current[sid] || []).find((candidate) => candidate.id === queueId);
    if (item) {
      addAttachments(sid, item.attachments);
      setRestoredQueueDraft({ id: Date.now(), text: item.content, sessionId: sid });
    }
    setQueuesBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).filter((candidate) => candidate.id !== queueId),
    }));
  }, [currentSessionId, addAttachments]);

  const handleEditQueuedMessage = useCallback((queueId: string, content: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid || !content.trim()) return;
    setQueuesBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).map((item) => (
        item.id === queueId ? { ...item, content: content.trim() } : item
      )),
    }));
  }, [currentSessionId]);

  const handleMoveQueuedMessage = useCallback((queueId: string, direction: -1 | 1, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    setQueuesBySession((prev) => {
      const queue = [...(prev[sid] || [])];
      const from = queue.findIndex((item) => item.id === queueId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= queue.length) return prev;
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      return { ...prev, [sid]: queue };
    });
  }, [currentSessionId]);

  // Drain every session independently when it becomes idle. This continues in
  // the background after the user switches chats, matching MeshClaw slots.
  useEffect(() => {
    for (const [sessionId, queue] of Object.entries(queuesBySession)) {
      if (
        queue.length === 0 ||
        streamingIds.includes(sessionId) ||
        // Backend occupied (turn / attaching / model swap / HISTORY REBUILD).
        // Draining into a rebuild would be rejected by main as "active turn";
        // the queue simply waits until the backend is free.
        isBackendOccupied(busyBySession[sessionId]) ||
        // A loop owns its session, and it is idle BETWEEN iterations — exactly when
        // this drain would fire and slip a queued message between two loop turns.
        loopingIds.includes(sessionId) ||
        queueSendingRef.current.has(sessionId) ||
        (sessionId === currentSessionId && (
          switchingModel || switchingAgent
        ))
      ) continue;

      // Merge mode sends the whole queue as ONE turn. Bounded on purpose: without
      // a cap, a long queue becomes a single enormous prompt; the remainder simply
      // drains on the next turn.
      const MERGE_MAX_ITEMS = 10;
      const consumed = settings.mergeQueuedMessages ? queue.slice(0, MERGE_MAX_ITEMS) : [queue[0]];
      const consumedIds = new Set(consumed.map((item) => item.id));
      // Empty-content items are real (a busy Enter with attachments and no typed
      // text degrades to a queued item), and joining them blindly produced stray
      // blank paragraphs inside the merged prompt.
      const parts = consumed.map((item) => (item.content || '').trim()).filter(Boolean);
      const content = parts.length > 1
        ? `【已合并 ${parts.length} 条排队消息】\n\n${parts.join('\n\n')}`
        : (parts[0] ?? '');
      // Placeholders stay in `content` (display/transcript); the delivered prompt
      // gets the expanded text.
      const queuedPastes = consumed.flatMap((item) => item.pastes || []);
      const deliveredContent = queuedPastes.length ? expandPastes(content, queuedPastes) : content;
      // Same file queued twice must not be referenced twice in the file-ref block.
      const attachments = consumed
        .flatMap((item) => item.attachments)
        .filter((file, i, arr) => arr.findIndex((other) => other?.path === file?.path) === i);

      queueSendingRef.current.add(sessionId);
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] || []).filter((item) => !consumedIds.has(item.id)),
      }));
      Promise.resolve(sendQueuedMessage(sessionId, deliveredContent, attachments, queuedPastes.length ? { displayText: content, pastes: queuedPastes } : undefined))
        .catch((error) => {
          // The backend remains authoritative. If the original turn (including
          // compaction) was still busy or delivery otherwise failed, restore the
          // exact items at the head and preserve FIFO order.
          console.error('Queued message delivery deferred:', error);
          setQueuesBySession((prev) => {
            const existing = prev[sessionId] || [];
            const existingIds = new Set(existing.map((item) => item.id));
            const restored = consumed.filter((item) => !existingIds.has(item.id));
            return { ...prev, [sessionId]: [...restored, ...existing] };
          });
        })
        .finally(() => {
          queueSendingRef.current.delete(sessionId);
        });
    }
  }, [
    queuesBySession,
    streamingIds,
    busyBySession,
    settings.mergeQueuedMessages,
    sendQueuedMessage,
    currentSessionId,
    switchingModel,
    switchingAgent,
  ]);

  // Drop queues whose sessions were deleted or archived.
  useEffect(() => {
    const liveIds = new Set(sessions.filter((session) => !session.archived).map((session) => session.id));
    setQueuesBySession((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([sessionId]) => liveIds.has(sessionId)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [sessions]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = uiGet('kirolex-sidebar-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 240;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isResizingRef = useRef(false);
  // Resizable width for the right-side file panel (drag its left edge).
  const [fileViewerWidth, setFileViewerWidth] = useState(() => {
    try {
      const saved = uiGet('kirolex-fileviewer-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 520;
  });
  const handleFileResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = fileViewerWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Panel sits on the RIGHT: dragging the left edge leftwards widens it.
      const newWidth = Math.max(320, Math.min(1100, startWidth + startX - ev.clientX));
      setFileViewerWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [fileViewerWidth]);
  useEffect(() => {
    try { uiSet('kirolex-fileviewer-width', String(fileViewerWidth)); } catch {}
  }, [fileViewerWidth]);

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
        uiSet('kirolex-sidebar-width', String(sidebarWidth));
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
      uiSet('kirolex-sidebar-width', String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  /** One split pane = one fully interactive chat. Every prop is scoped to `sid`
   *  (messages, model, queue, attachments, permission request), and the write
   *  handlers focus that session first so the send pipeline stays single-path. */
  const renderPane = (sid: string | null, focused: boolean, withHeader: boolean, paneStyle?: React.CSSProperties) => {
    const session = sid ? sessions.find((s) => s.id === sid) || null : null;
    const view = sid && !focused ? paneViews[sid] : undefined;
    const paneMessages = focused ? messages : (view?.messages || []);
    const paneModel = focused
      ? selectedModel
      : ((session?.model && session.model !== 'auto') ? session.model : selectedModel);
    const inner = (
      <ChatArea
        paneFocused={focused}
        messages={paneMessages}
        // A history rebuild is a real, cancellable operation even though its turn is
        // hidden: without counting it here the composer showed no Stop button at
        // all, so the rebuild (and any pending auto-resend) could not be called off.
        //
        // `busyBySession[sid] === 'turn'` is the AUTHORITATIVE half. `streamingIds`
        // is renderer state, so it is wiped by any reload of this window -- an HMR
        // update during a live turn was enough. The composer then believed the turn
        // had ended: Enter stopped steering and sent a NEW message instead, which
        // main rejected ("wait for the active turn") after the bubble was already on
        // screen. Main always knows whether a turn is running; ask it too.
        isStreaming={!!sid && (streamingIds.includes(sid)
          || busyBySession[sid] === 'turn'
          || busyBySession[sid] === 'priming' || busyBySession[sid] === 'prime-pending')}
        status={status}
        sessionConnected={!!sid && attachedSessionIds.includes(sid) && !connectingSessionIds.includes(sid)}
        connectionError={focused ? connectionError : null}
        onDismissError={clearConnectionError}
        turnInterrupted={!!sid && interruptedSessionIds.includes(sid)}
        attachedFiles={attachedFor(sid)}
        models={models}
        selectedModel={paneModel}
        activeToolCall={focused ? activeToolCall : (view?.activeTool || null)}
        activityStatus={focused ? activityStatus : (view?.activity || null)}
        stall={focused ? turnStall : (view?.stall || null)}
        permissionRequest={sid ? permissionRequests[sid] || null : null}
        onRespondPermission={respondPermission}
        usage={focused ? usage : (view?.usage || null)}
        plan={focused ? plan : EMPTY_PLAN}
        autoFoldThinking={settings.autoFoldThinking}
        autoFoldTools={settings.autoFoldTools}
        onManageContext={() => setUsageActionConfirm('contextMenu')}
        onResetCredits={() => setUsageActionConfirm('resetCredits')}
        commands={focused ? commands : EMPTY_COMMANDS}
        onModelChange={(model) => { void handleModelChange(model, sid || undefined); }}
        kiroAgent={session?.kiroAgent || selectedKiroAgent}
        kiroAgents={kiroAgents}
        switchingAgent={focused && switchingAgent}
        switchingModel={focused && switchingModel}
        permissionMode={session?.permissionMode || 'auto-approve'}
        onPermissionModeChange={(mode) => { void handlePermissionModeChange(mode, sid || undefined); }}
        onKiroAgentChange={(agentName) => { void handleKiroAgentChange(agentName, sid || undefined); }}
        onForkMessage={(messageId) => handleForkMessage(messageId, sid || undefined)}
        onRerunMessage={(messageId, editedText) => handleRerunMessage(messageId, editedText, sid || undefined)}
        onSend={(text, pastes) => { void handleSendMessage(text, pastes, sid || undefined); }}
        onSteerMessage={(text) => { void handleSteerMessage(text, undefined, sid || undefined); }}
        onCancel={() => { void handleStopStream(sid || undefined); }}
        onDropFiles={(files) => handleDropFiles(files, sid || undefined)}
        onRemoveFile={(id) => handleRemoveFile(id, sid || undefined)}
        currentSessionId={sid}
        isArchived={!!session?.archived}
        onUnarchive={() => { if (sid) archiveSession(sid, false); }}
        queuedMessages={sid ? queuesBySession[sid] || EMPTY_QUEUE : EMPTY_QUEUE}
        mergeQueuedMessages={settings.mergeQueuedMessages}
        historyLoading={!!sid && historyLoadingIds.includes(sid)}
        restoredQueueDraft={restoredQueueDraft}
        restoredInputDraft={restoredInputDraft}
        onQueueMessage={(text, pastes) => handleQueueMessage(text, pastes, sid || undefined)}
        onCancelQueuedMessage={(queueId) => handleCancelQueuedMessage(queueId, sid || undefined)}
        onEditQueuedMessage={(queueId, content) => handleEditQueuedMessage(queueId, content, sid || undefined)}
        onMoveQueuedMessage={(queueId, direction) => handleMoveQueuedMessage(queueId, direction, sid || undefined)}
        importableSessions={sessions
          .filter((s) => s.id !== sid && !s.id.startsWith('pending_') && !s.archived)
          .map((s) => ({ id: s.id, title: s.title }))}
        contextLinks={focused ? contextLinks : (view?.contextLinks || EMPTY_LINKS)}
        onToggleContextSource={(sourceId) => toggleContextSource(sourceId, sid || undefined)}
        isLooping={!!sid && loopingIds.includes(sid)}
        onStartLoop={(text, intervalSec) => { if (sid) startLoop(sid, text, intervalSec); }}
        onStopLoop={() => { if (sid) void stopLoop(sid); }}
      />
    );
    if (!withHeader) return inner;
    return (
      <div
        key={sid || 'empty'}
        className={`chat-pane${focused ? ' focused' : ''}`}
        style={paneStyle}
        // Clicking anywhere in a pane (including its composer) focuses that
        // session, so Enter always sends to the pane you are looking at.
        onMouseDownCapture={(e) => {
          // Header buttons (✕) must not trigger a session switch: switching
          // re-renders this subtree and the follow-up click was getting lost,
          // which is why a pane sometimes could not be closed.
          if ((e.target as HTMLElement).closest('.chat-pane-header')) return;
          void focusSession(sid);
        }}
      >
        <div className="chat-pane-header">
          <span className="chat-pane-title" title={session?.title}>{session?.title || 'Untitled'}</span>
          <button
            className="chat-pane-btn"
            title="从分屏中移除"
            // pointerdown, not click: acting before any re-render means the
            // close can never be swallowed by a concurrent focus switch.
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); if (sid) toggleSplitSession(sid); }}
            onClick={(e) => { e.stopPropagation(); }}
          >✕</button>
        </div>
        {inner}
      </div>
    );
  };

  /** The empty-cell strip that advertises free split capacity.
   *
   *  It used to read just "＋ 加入分屏", which says what the cell IS but not what to
   *  DO -- the action (click a chat in the sidebar) happens somewhere else entirely,
   *  so the strip has to name it. Also states how many slots are left, since that
   *  is the one fact the strip is uniquely placed to report. */
  const renderAddStrip = (horizontal: boolean, style?: React.CSSProperties) => {
    const remaining = Math.max(0, splitCapacity - panes.length);
    const tip = [
      '这一格是空的分屏位。',
      '把会话放进来：在左侧会话列表点任意一个会话，或右键该会话选「⇆ 加入分屏」。',
      // Deliberately does NOT restate the layout: it reported the CONFIGURED grid
      // (e.g. 2x2) while the panes on screen were arranged 1x2, so it contradicted
      // what the user could see. The remaining-slots count below is the honest part.
      `还能再放 ${remaining} 个会话。`,
      '移除某一格：点该格右上角的 ✕，或右键该会话选「⇆ 从分屏移除」。',
      '调整大小：拖动格子之间的分隔线，双击分隔线恢复均分。',
      '换布局：设置 → 分屏网格。',
      '每一格都是完整的会话，各自有输入框、队列和附件。',
    ].join('\n');
    return (
      <div
        className={`chat-pane-add${horizontal ? ' horizontal' : ''}${style ? ' cell' : ''}`}
        title={tip}
        style={style}
      >
        <span className="chat-pane-add-plus">＋</span>
        <span className="chat-pane-add-label">
          {horizontal ? '点击左侧列表里的任意会话，把它加入这一格' : '点左侧会话加入这一格'}
        </span>
        <span className="chat-pane-add-hint">还能放 {remaining} 个</span>
      </div>
    );
  };

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
              busyBySession={busyBySession}
              connectingSessionIds={connectingSessionIds}
              unreadSessionIds={unreadSessionIds}
              executorCap={executorCap}
              onNewSession={() => { setNewChatProject(''); setNewChatNewProjectName(''); setShowNewChat(true); }}
              onCreateProject={createProject}
              onReorderProjects={reorderProjects}
              onNewSessionInProject={handleNewSessionInProject}
              onRenameProject={renameProject}
              onDeleteProject={handleDeleteProject}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              onRebuildContext={(id, mode) => { void rebuildContext(id, mode); }}
              onRenameSession={renameSession}
              onTogglePin={togglePin}
              // Only the EXPLICIT selection highlights rows. In single-chat mode
              // `panes` falls back to the focused chat, which must not look selected.
              splitOrder={(id) => {
                if (splitSessionIds.length === 0) return 0;
                const i = panes.indexOf(id);
                return i < 0 ? 0 : i + 1;
              }}
              onToggleSplit={(id) => toggleSplitSession(id)}
              onAssignProject={assignProject}
              onMoveSession={moveSession}
              onArchiveSession={archiveSession}
              onSettings={() => setShowSettings(true)}
              workspaceOpen={showWorkspace}
              onOpenWorkspace={() => setShowWorkspace((visible) => !visible)}
              onOpenLogs={() => void handleOpenLogs()}
              onOpenMemory={() => setShowMemory(true)}
              // Agent config is global: one trigger in the sidebar, handled by the
              // focused pane so a split view never opens several editors.
              onOpenAgentConfig={() => window.dispatchEvent(new CustomEvent('kirolex:open-agent-config'))}
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
        {!splitActive ? (
          renderPane(panes[0] || currentSessionId, true, false)
        ) : (
          // Nested flex: a column of rows, each row its own set of panes. Dividers
          // are real elements between them, so every split is draggable and the
          // "add" strip can sit in just the free corner instead of claiming the
          // whole right edge (a CSS grid forced every row to share columns).
          <div className="chat-grid">
            {paneRowsOfPanes.map((rowPanes, r) => (
              <React.Fragment key={`split-row-${r}`}>
                {r > 0 && (
                  // Always rendered: it also draws the hairline between rows. The
                  // switch only decides whether it is DRAGGABLE.
                  <div
                    className={`pane-resize-handle horizontal${dragSplits ? '' : ' locked'}`}
                    title={dragSplits ? '拖动调整高度（双击恢复均分）' : '分屏拖拽已在设置中关闭'}
                    onMouseDown={dragSplits ? (e) => handlePaneResizeStart(e, 'row', 0, r - 1) : undefined}
                    onDoubleClick={dragSplits ? () => setSplitSizes(null) : undefined}
                  />
                )}
                <div className="chat-row" style={{ flexGrow: rowFlex(r), flexBasis: 0 }}>
                  {rowPanes.map((sid, c) => (
                    <React.Fragment key={sid || `split-pane-${r}-${c}`}>
                      {c > 0 && (
                        <div
                          className={`pane-resize-handle vertical${dragSplits ? '' : ' locked'}`}
                          title={dragSplits ? '拖动调整宽度（双击恢复均分）' : '分屏拖拽已在设置中关闭'}
                          onMouseDown={dragSplits ? (e) => handlePaneResizeStart(e, 'col', r, c - 1) : undefined}
                          onDoubleClick={dragSplits ? () => setSplitSizes(null) : undefined}
                        />
                      )}
                      {renderPane(sid, sid === currentSessionId, true, {
                        flexGrow: colFlex(r, c),
                        flexBasis: 0,
                      })}
                    </React.Fragment>
                  ))}
                  {/* Free capacity lives in the actual empty cell, and takes that
                      cell's real width (inherited from the row above) rather than a
                      56px sliver -- so filling it later moves nothing. */}
                  {stripRight && r === paneRowsOfPanes.length - 1 && (
                    <>
                      <div
                        className="pane-resize-handle vertical locked"
                        title="空分屏位的边界。宽度跟随上一行，所以之后放进来的会话会正好落在这一格。"
                      />
                      {/* With a SINGLE chat the placeholder stays visible (it is the
                          only affordance for adding a second one) but must not claim
                          half the window for an empty box. Passing no style keeps it
                          off the `cell` class, i.e. the slim 56px strip — there is no
                          row above to align with yet, so reserving a full cell buys
                          nothing. From two panes on it takes the real cell width
                          again, so a later pane lands exactly where it sat. */}
                      {panes.length < 2
                        ? renderAddStrip(false)
                        : renderAddStrip(false, { flexGrow: rowCells[r]?.emptyFlex ?? 1, flexBasis: 0 })}
                    </>
                  )}
                </div>
              </React.Fragment>
            ))}
            {stripBelow && renderAddStrip(true)}
          </div>
        )}
        {showWorkspace && (
          <WorkspacePanel
            sessionId={currentSessionId}
            onClose={() => setShowWorkspace(false)}
            onOpenFile={(p) => void openFileInApp(p)}
          />
        )}
        {(fileViewerLoading || fileViewer) && (
          <div className="workspace-file-panel" role="complementary" aria-label="File preview" style={{ width: fileViewerWidth }}>
            <div className="file-resize-handle" onMouseDown={handleFileResizeStart} title="拖动调整宽度" />
            <div className="settings-header">
              <h3 title={fileViewer?.path} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fileViewer ? (fileViewer.path.split('/').pop() || fileViewer.path) : 'Loading…'}
                </span>
              </h3>
              <div className="workspace-file-actions">
                {fileViewer && !fileViewer.image && !fileViewer.binary && (isMarkdownPath(fileViewer.path) || !!viewerLangFor(fileViewer.path)) && (
                  <button
                    className="text-btn"
                    title={fileViewerRaw ? '显示优化视图（Markdown 渲染 / 语法高亮 / JSON 格式化）' : '显示文件原文'}
                    onClick={() => setActiveTabRaw(!fileViewerRaw)}
                  >
                    {fileViewerRaw ? '◉ 渲染' : '◎ 原文'}
                  </button>
                )}
                {/* Download no longer requires a connected chat -- it is a local
                    file copy through a save dialog. */}
                {fileViewer && (
                  <button
                    className="text-btn"
                    onClick={() => void window.kiroApi.workspaceDownload?.(currentSessionId, fileViewer.path)}
                  >
                    ⬇ Download
                  </button>
                )}
                <button className="settings-close" onClick={() => { setFileTabs([]); setActiveFileTabId(null); setFileViewerLoading(false); }} title="关闭面板">
                  <IconClose size={16} />
                </button>
              </div>
            </div>
            {fileTabs.length > 1 && (
              <div className="file-tabs" role="tablist" aria-label="Open files">
                {fileTabs.map((tab) => (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={tab.id === activeFileTabId}
                    className={`file-tab ${tab.id === activeFileTabId ? 'active' : ''}`}
                    title={tab.path}
                    onClick={() => setActiveFileTabId(tab.id)}
                    onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeFileTab(tab.id); } }}
                  >
                    <span className="file-tab-name">{tab.path.split('/').pop() || tab.path}</span>
                    <button
                      type="button"
                      className="file-tab-close"
                      title="关闭标签"
                      onClick={(e) => { e.stopPropagation(); closeFileTab(tab.id); }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div
              className="workspace-file-modal-body"
              ref={fileBodyRef}
              onScroll={(e) => {
                // Remember where this tab was scrolled to; restored on switch back.
                if (activeFileTabId) fileScrollRef.current[activeFileTabId] = (e.target as HTMLDivElement).scrollTop;
              }}
            >
              {fileViewerLoading && <div className="workspace-hint">Loading file…</div>}
              {!fileViewerLoading && fileViewer && (
                <>
                  <div className="workspace-viewer-path" title={fileViewer.path}>{fileViewer.path}</div>
                  {fileViewer.image && fileViewer.dataUrl ? (
                    <div className="workspace-image-wrap">
                      <img className="workspace-image" src={fileViewer.dataUrl} alt={fileViewer.path.split('/').pop() || 'image'} />
                    </div>
                  ) : fileViewer.binary ? (
                    <div className="workspace-binary-hint">
                      <span>{fileViewer.content || 'This file type cannot be previewed. Download it to open it locally.'}</span>
                    </div>
                  ) : (
                    <>
                      {fileViewer.truncated && (
                        <div className="workspace-hint">⚠️ Preview truncated at 512 KB. Download for the complete file.</div>
                      )}
                      {isMarkdownPath(fileViewer.path) && !fileViewerRaw ? (
                        <div className="workspace-viewer-md">
                          <MarkdownView content={fileViewer.content} />
                        </div>
                      ) : (() => {
                        const hl = fileViewerRaw ? null : highlightForViewer(fileViewer.path, fileViewer.content);
                        if (!hl) return <pre className="workspace-viewer-content">{fileViewer.content}</pre>;
                        return (
                          <>
                            {hl.prettified && (
                              <div className="workspace-hint">已格式化显示（原文为压缩 JSON）。点「原文」查看未格式化内容。</div>
                            )}
                            <pre className="workspace-viewer-content hljs">
                              <code
                                className={`language-${hl.lang}`}
                                dangerouslySetInnerHTML={{ __html: hl.html }}
                              />
                            </pre>
                          </>
                        );
                      })()}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
          confirmDeletes={!skipDeleteConfirm}
          onConfirmDeletesChange={(value) => {
            const skip = !value;
            setSkipDeleteConfirm(skip);
            try { uiSet('kirolex-skip-delete-confirm', String(skip)); } catch {}
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
      {showLogs && (
        <>
          <div className="overlay" onClick={() => setShowLogs(false)} />
          <div className="settings-dialog" style={{ width: 720, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="settings-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconLogs size={17} /> 日志
              </h3>
              <button className="settings-close" onClick={() => setShowLogs(false)} title="关闭日志">
                <IconClose size={16} />
              </button>
            </div>
            <div className="settings-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn deny"
                  style={{ padding: '6px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  onClick={async () => {
                    const result = await window.kiroApi.getLogs(logsLimit).catch(() => ({
                      text: '(failed to read logs)',
                      path: '',
                    }));
                    logsHasMoreRef.current = result.text.split('\n').length >= logsLimit;
                    setLogsText(result.text);
                    requestAnimationFrame(() => {
                      if (logsPreRef.current) logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
                    });
                  }}
                >
                  刷新
                </button>
                <button
                  className="btn deny"
                  style={{ padding: '6px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  onClick={() => void window.kiroApi.openLogs()}
                >
                  打开日志文件
                </button>
              </div>
              <pre style={{
                flex: 1,
                overflow: 'auto',
                margin: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 11,
                lineHeight: 1.5,
                background: 'var(--bg-tertiary)',
                padding: 12,
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '60vh',
              }}
                ref={logsPreRef}
                onScroll={(e) => {
                  if (e.currentTarget.scrollTop <= 40) void loadOlderLogs();
                }}
              >
                {logsHasMoreRef.current && (logsLoadingOlder ? '⋯ 加载更早的日志…\n' : '↑ 上拉加载更早的日志\n')}
                {logsText || '(no logs yet)'}
              </pre>
            </div>
          </div>
        </>
      )}
      {usageActionConfirm && (
        <>
          <div className="overlay" onClick={() => setUsageActionConfirm(null)} />
          <div className="permission-dialog">
            {usageActionConfirm === 'contextMenu' ? (
              <>
                <h3>Manage context</h3>
                <p>
                  Choose whether to summarize older context or clear the active
                  conversation context completely.
                </p>
                <div className="actions">
                  <button className="btn deny" onClick={() => setUsageActionConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn deny"
                    onClick={() => setUsageActionConfirm('clear')}
                    style={{ color: 'var(--error)' }}
                  >
                    Clear
                  </button>
                  <button
                    className="btn allow"
                    onClick={() => setUsageActionConfirm('compact')}
                  >
                    Compact
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>
                  {usageActionConfirm === 'compact'
                    ? 'Compact context?'
                    : usageActionConfirm === 'clear'
                    ? 'Clear context?'
                    : 'Reset Credits counter?'}
                </h3>
                <p>
                  {usageActionConfirm === 'compact'
                    ? 'Kiro CLI will summarize older conversation context to free context-window capacity. The original full context cannot be restored inside this active Kiro session.'
                    : usageActionConfirm === 'clear'
                    ? 'Kiro CLI will discard the active conversation context, and KiroLex will clear the currently displayed history. This cannot be undone inside this active chat.'
                    : 'This resets the Credits counter for the current KiroLex session to 0. It does not change actual account usage, billing, or Kiro credit records.'}
                </p>
                <div className="actions">
                  <button className="btn deny" onClick={() => setUsageActionConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn allow"
                    onClick={() => void handleConfirmUsageAction()}
                    style={usageActionConfirm === 'clear' ? { background: 'var(--error)' } : undefined}
                  >
                    {usageActionConfirm === 'compact'
                      ? 'Compact'
                      : usageActionConfirm === 'clear'
                      ? 'Clear'
                      : 'Reset'}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
      {rerunConfirm && (
        <>
          <div className="overlay" onClick={() => setRerunConfirm(null)} />
          <div className="permission-dialog">
            <h3>编辑并重跑</h3>
            <p>
              将删除这条之后的 <strong>{rerunConfirm.deleteCount}</strong> 条记录并基于编辑后的消息重跑。
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setRerunConfirm(null)}>取消</button>
              <button className="btn allow" onClick={confirmRerun}>确认并重跑</button>
            </div>
          </div>
        </>
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
