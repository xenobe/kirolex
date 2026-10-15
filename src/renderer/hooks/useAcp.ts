import { useState, useCallback, useEffect, useRef } from 'react';
import { uiGet, uiSet, uiRemove } from '../uiStore';
import type { Message, ToolCall, Session, SessionFolder, AttachedFile, FileDiff, PlanEntry } from '../App';

/** Tool kinds that RUN something rather than touch a file. Mirrors RUN_KINDS in the
 *  main process: a command carries neither locations nor diffs, so without this it is
 *  dropped and the turn shows a script being created but never run. */
const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

type LoopState = {
  text: string;
  intervalSec: number;
  stopped: boolean;
  timer: ReturnType<typeof setTimeout> | null;
};

export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
  subcommands?: string[];
}

export interface PermissionOption {
  optionId: string;
  name?: string;
  kind?: string;
}

export interface PermissionRequest {
  requestId: number | string;
  sessionId: string;
  toolTitle: string;
  description?: string;
  options: PermissionOption[];
}

/** A running turn that has gone quiet, re-sent by main on every watchdog tick.
 *  `interruptInSeconds` is null when the timeout interrupt is switched off, so the
 *  UI can say "nothing will happen" instead of implying a countdown. */
export interface TurnStall {
  quietSeconds: number;
  openTools: number;
  toolIdleSeconds: number;
  /** The OS found the executor's tree burning CPU, so it is computing rather than
   *  blocked, and the interrupt has been postponed. NOT proof of progress — a
   *  spin-wait looks identical — hence `cpuVetoLeftSeconds`, after which the
   *  interrupt fires anyway. */
  cpuBusy: boolean;
  cpuVetoLeftSeconds: number;
  interruptInSeconds: number | null;
}

/** Live view of a session rendered in a split pane (i.e. visible but NOT the
 *  focused session). Mirrors what the focused session keeps in plain state. */
export interface PaneView {
  messages: Message[];
  activity: string | null;
  activeTool: string | null;
  /** Per-session context/credits meter — the focused chat keeps this in plain
   *  state, a pane needs its own copy or the widget disappears in split view. */
  usage: { contextPercent: number; credits: number; turnMs?: number } | null;
  /** Per-session context-sync links (Context Engineering). */
  contextLinks: { sourceId: string; sourceTitle: string }[];
  /** Live "this turn has stopped producing" state; drives the stall warning. */
  stall: TurnStall | null;
}

// Extract absolute file paths an ACP tool_call touched (update.locations[].path).
/** Busy reasons that mean the backend must NOT be given a new message yet.
 *  'prime-pending' is included deliberately: a chat whose backend lost its history
 *  would otherwise answer from nothing, so new messages QUEUE behind the rebuild.
 *  The rebuild has no attempt limit, so the ONLY releases are the user pressing
 *  Stop (abandon) or clearing the history. */
export const OCCUPYING_BUSY_REASONS = new Set(['turn', 'reconfiguring', 'attaching', 'priming', 'prime-pending']);
export function isBackendOccupied(reason: string | null | undefined): boolean {
  return !!reason && OCCUPYING_BUSY_REASONS.has(reason);
}

function extractLocations(update: any): string[] {  const raw = Array.isArray(update?.locations) ? update.locations : [];
  const paths = raw
    .map((loc: any) => (typeof loc === 'string' ? loc : loc?.path))
    .filter((p: any): p is string => typeof p === 'string' && p.length > 0);
  return Array.from(new Set(paths));
}

// Extract file diffs carried in an ACP tool_call's content blocks
// (`{ type: 'diff', path, oldText, newText }`).
function extractDiffs(update: any): FileDiff[] {
  const blocks = Array.isArray(update?.content) ? update.content : [];
  const diffs: FileDiff[] = [];
  for (const block of blocks) {
    if (block?.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string') {
      diffs.push({ path: block.path, oldText: block.oldText ?? undefined, newText: block.newText });
    }
  }
  return diffs;
}

/** Text a tool reported, across ALL of its content blocks. This used to read only
 *  block [0]; main persists every block, so reading one here would make a reopened
 *  chat show MORE than the live one did for the same tool call. */
function extractToolOutput(update: any): string {
  return (Array.isArray(update?.content) ? update.content : [])
    .map((block: any) => (typeof block?.content?.text === 'string' ? block.content.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Why did the turn stop? A non-end_turn reason is the "reply cut off
 *  mid-sentence with no error" case and MUST be surfaced -- kiro-cli returns it
 *  on session/prompt and KiroLex used to throw it away. Returns null for a
 *  normal completion (and for cancels, which already have their own banner). */
/** Map live messages to durable transcript records for a truncating rewrite
 *  (edit-rerun / cancel-overwrite). Thinking (💭) segments are live-only, but
 *  attachments and paste refs MUST survive: dropping them used to strip every
 *  earlier message's image/paste metadata on each rerun, which killed the
 *  attachment chips, broke history re-injection (`file:` refs), and made the
 *  boot GC treat those blobs as orphans and delete them. */
/** Supplied by the cancel-overwrite path: it has ALREADY built the prompt from the
 *  composer (new attachments, expanded pastes), so the rerun must use those rather
 *  than resurrecting the interrupted message's own attachments. */
type RerunOverride = { prompt?: any[]; attachments?: any[]; pastes?: any[]; displayText?: string };

/** How many times an interrupted prompt may be auto-resent before KiroLex stops
 *  trying. More than one, because the resend's OWN turn can be interrupted too;
 *  bounded, because every attempt costs credits. */
const AUTO_RESEND_MAX_ATTEMPTS = 2;

/** Per-session usage, persisted so the context gauge is not blank until the next
 *  turn. Stored as entries (not an object) to keep session ids opaque. */
const USAGE_MAP_KEY = 'kirolex-usage-by-session';
type UsageEntry = { contextPercent: number; credits: number; turnMs?: number };
function readUsageMap(): [string, UsageEntry][] {
  try {
    const raw = uiGet(USAGE_MAP_KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows)
      ? rows.filter((r: any) => Array.isArray(r) && typeof r[0] === 'string' && r[1] && typeof r[1].contextPercent === 'number')
      : [];
  } catch { return []; }
}
function writeUsageMap(map: Map<string, UsageEntry>): void {
  try { uiSet(USAGE_MAP_KEY, JSON.stringify([...map.entries()])); } catch {}
}

/** The durable-session listing, fetched at most ONCE per window.
 *
 *  React.StrictMode double-invokes mount effects in dev: effect -> cleanup ->
 *  effect. The hydrate effect's cleanup sets `cancelled`, so the FIRST run's result
 *  is discarded and the SECOND run is the one that counts -- meaning the whole
 *  listing (17 chats: record.json + transcript sizing) was paid for twice and used
 *  once. Measured on a real boot: two `list-durable-sessions` requests 5.2s apart,
 *  i.e. ~5s of the 13.6s to a visible window spent recomputing a discarded answer.
 *  Sharing the promise keeps the cancel semantics exactly as they were and only
 *  removes the duplicated disk work. */
let durableSessionsOnce: Promise<any[]> | null = null;
function listDurableSessionsOnce(): Promise<any[]> {
  if (!durableSessionsOnce) {
    durableSessionsOnce = Promise.resolve(window.kiroApi?.listDurableSessions?.() ?? [])
      .then((rows) => (Array.isArray(rows) ? rows : []))
      .catch(() => []);
  }
  return durableSessionsOnce;
}

/** Stable short key for an interrupted prompt, so the SAME text is not
 *  auto-resent without limit across restarts (each resend costs credits). */
function autoResendKey(text: string): string {
  let h = 0;
  for (let i = 0; i < text.length; i++) { h = (h * 31 + text.charCodeAt(i)) | 0; }
  return `${text.length}:${h}`;
}

function toStoredTranscript(messages: Message[]) {
  return messages
    .filter((m) => !(m.role === 'assistant' && m.content.startsWith('💭 ')))
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      ts: m.timestamp,
      toolCalls: m.toolCalls,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
      ...((m as any).pastes?.length ? { pastes: (m as any).pastes } : {}),
    }));
}

function noticeForStopReason(reason: unknown, result?: any): string | null {
  const r = String(reason ?? '').trim();
  if (!r) return null;
  const norm = r.toLowerCase().replace(/[\s-]+/g, '_');
  if (norm === 'end_turn' || norm === 'endturn') return null;
  if (norm === 'cancelled' || norm === 'canceled') return null; // cancel path shows its own notice
  if (norm === 'max_tokens' || norm === 'maxtokens' || norm === 'max_token') {
    return '⚠️ 回复被截断：达到本回合输出上限（stopReason: max_tokens）。发送「继续」可让它接着写。';
  }
  if (norm === 'max_turn_requests' || norm === 'max_turn_request') {
    return '⚠️ 回合被终止：达到本回合的工具调用次数上限（stopReason: max_turn_requests）。发送「继续」可让它接着做。';
  }
  if (norm === 'refusal') {
    return '⚠️ 模型拒绝了这次请求（stopReason: refusal）。换个说法或拆小问题再试。';
  }
  return `⚠️ 回合非正常结束（stopReason: ${r}）。`;
}

/** A turn that resolved with NO output and NO stated reason is abnormal too --
 *  never let it pass as a silent normal completion. */
function noticeForEmptyTurn(result: any): string | null {
  const produced = result?.__kirolex?.produced;
  if (produced !== false) return null;
  const r = String(result?.stopReason ?? '').trim().toLowerCase();
  if (r === 'cancelled' || r === 'canceled') return null; // cancel has its own banner
  return `⚠️ 这一轮没有产生任何输出${r ? `（stopReason: ${r}）` : '，后端也没有说明结束原因'}。可以重发或点重跑。`;
}

export function useAcp() {  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => {
    // Load persisted sessions
    try {
      const saved = uiGet('kirolex-sessions');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [folders, setFolders] = useState<SessionFolder[]>(() => {
    try {
      const saved = uiGet('kirolex-folders');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  // Projects: explicit, user-created grouping (write-once memory scope §6.4).
  // A project is just a name; membership is a session's projectId.
  const [projects, setProjects] = useState<string[]>(() => {
    try {
      const saved = uiGet('kirolex-projects');
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    try {
      return uiGet('kirolex-last-session') || null;
    } catch {}
    return null;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  // Session IDs currently streaming (supports parallel streaming across models)
  const [streamingIds, setStreamingIds] = useState<string[]>([]);
  // Session IDs whose per-session executor is ATTACHED this run (design §3).
  // Drives the live/dormant sidebar dot; a persisted session is dormant until
  // it is opened and its executor attaches.
  const [attachedSessionIds, setAttachedSessionIds] = useState<string[]>([]);
  // Session IDs whose executor is currently ATTACHING (spawn/connect in flight).
  // Drives the "connecting" flash dot.
  const [connectingSessionIds, setConnectingSessionIds] = useState<string[]>([]);
  // Sessions whose history is being read from disk. Rendered as a loading state so
  // a cold chat never flashes an empty/"no messages" view before the transcript
  // lands (message bodies are not mirrored into localStorage any more).
  const [historyLoadingIds, setHistoryLoadingIds] = useState<string[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<Record<string, PermissionRequest>>({});

  // --- Split view: panes shown side-by-side with the focused session --------
  // Background sessions stream into `messagesCacheRef` ONLY. That is a ref, so
  // it never re-renders — deliberate, because ~12 warm sessions streaming at
  // once would otherwise re-render the whole app on every chunk. A pane must be
  // LIVE though, so for the handful of sessions currently on screen we mirror
  // the same data into state. Non-visible sessions keep the cheap ref-only path.
  const paneSessionIdsRef = useRef<Set<string>>(new Set());
  const [paneViews, setPaneViews] = useState<Record<string, PaneView>>({});
  /** Update one pane's live view. No-op for sessions that are not on screen. */
  const patchPane = useCallback((sid: string | null, patch: Partial<PaneView>) => {
    if (!sid || !paneSessionIdsRef.current.has(sid)) return;
    setPaneViews((prev) => {
      const cur = prev[sid];
      if (!cur) return prev;
      const keys = Object.keys(patch) as (keyof PaneView)[];
      if (!keys.some((k) => cur[k] !== patch[k])) return prev;   // no-op keeps memo stable
      return { ...prev, [sid]: { ...cur, ...patch } };
    });
  }, []);
  /** Single seam for "this session is not the focused one": always the ref,
   *  plus pane state when it happens to be visible in a split pane. */
  const commitBackgroundMessages = useCallback((sid: string, next: Message[]) => {
    messagesCacheRef.current.set(sid, next);
    patchPane(sid, { messages: next });
  }, [patchPane]);
  const permissionRequest = currentSessionId
    ? permissionRequests[currentSessionId] || null
    : null;
  const [activeToolCall, setActiveToolCall] = useState<string | null>(null);
  // Human-readable in-flight phase for the VIEWED session (send, backend
  // rebuild, executor attach, awaiting reply). Rendered in the chat so a slow
  // phase is never a silent UI freeze.
  const [activityStatus, setActivityStatus] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ contextPercent: number; credits: number; turnMs?: number } | null>(null);
  // Agent execution plan (ACP `plan` update) for the viewed session. Replaced
  // wholesale on each plan update (ACP resends the full plan each time).
  const [plan, setPlan] = useState<PlanEntry[]>([]);
  // Files the agent touched this turn (ACP tool_call locations + diff content),
  // for the viewed session. Ordered, deduped by path (latest diff wins).
  const [fileChanges, setFileChanges] = useState<ToolCall[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  // Cross-session context sync: the current session's linked sources (0..n).
  // Persistent per-session; each send injects only each source's NEW messages.
  const [contextLinks, setContextLinks] = useState<{ sourceId: string; sourceTitle: string }[]>([]);
  // Session IDs with an active single-prompt resend loop.
  const [loopingIds, setLoopingIds] = useState<string[]>([]);

  const currentMessageRef = useRef<string>('');
  const toolCallsRef = useRef<Map<string, ToolCall>>(new Map());
  const currentSessionRef = useRef<string | null>(null);
  const messagesCacheRef = useRef<Map<string, Message[]>>(new Map());
  const streamingIdsRef = useRef<Set<string>>(new Set());
  // Identifies the newest prompt for each session. A cancelled older prompt may
  // settle after its replacement starts; its cleanup must not clear the new
  // prompt's streaming state.
  const activePromptTokenRef = useRef<Map<string, symbol>>(new Map());
  // Attached-executor set (mirrors attachedSessionIds state).
  const attachedIdsRef = useRef<Set<string>>(new Set());
  /** last auto-recovery attempt per session (throttles reconnect-on-death). */
  const autoRecoverAtRef = useRef<Map<string, number>>(new Map());
  /** sessions currently switching model/Agent -- auto-recovery must skip them. */
  const reconfiguringRef = useRef<Set<string>>(new Set());
  /** Per-session backend occupancy pushed by main: 'turn' | 'reconfiguring' |
   *  'attaching' | 'priming'. Rendered on the sidebar dot + composer so an
   *  occupied session is visible BEFORE the user tries to act on it. */
  const [busyBySession, setBusyBySession] = useState<Record<string, string>>({});
  // Connecting (attaching) set (mirrors connectingSessionIds state).
  const connectingRef = useRef<Set<string>>(new Set());
  // When sessionId is missing from an update, use the last session we prompted
  // (not the currently viewed session). This prevents stale chunks from a
  // previous session bleeding into a newly created session.
  const lastPromptedSessionRef = useRef<string | null>(null);
  // Per-session usage (credits/context), keyed by sessionId.
  //
  // DURABLE. It used to live only in memory, so the composer's context gauge was
  // blank for every chat until that chat ran a fresh turn -- after a restart (or an
  // HMR reload of this hook) the model line showed just "claude-opus-5 · 1M" with no
  // percentage, even for a chat with a large history. The percentage is a property
  // of the conversation, not of the current window, so it is read back from disk.
  // Note the old on-disk copy was keyed by kiro-cli's UUID, which no longer maps to
  // anything the UI knows; this one is keyed by the stable KiroLex session id.
  const usageMapRef = useRef<Map<string, { contextPercent: number; credits: number; turnMs?: number }>>(new Map(readUsageMap()));
  // Per-session agent plan (ACP `plan`), keyed by sessionId.
  const planMapRef = useRef<Map<string, PlanEntry[]>>(new Map());
  // Per-session file-change tool calls this turn, keyed by sessionId.
  const fileChangesMapRef = useRef<Map<string, ToolCall[]>>(new Map());
  // Helper commands are advertised by each Kiro CLI agent process, not by the model.
  const commandsMapRef = useRef<Map<string, SlashCommand[]>>(new Map());
  // Maps sessionId -> model, so every call can route to the right kiro-cli process
  const sessionModelRef = useRef<Map<string, string>>(new Map());
  // Per-target-session context links: targetId -> array of { sourceId, sourceTitle, syncedCount }.
  // Each source keeps its own high-water mark so every send only forwards that
  // source's delta (new messages). A target can sync from multiple sources.
  const contextLinksRef = useRef<Map<string, { sourceId: string; sourceTitle: string; syncedCount: number }[]>>(new Map());
  // Duplicated sessions awaiting backend context injection on their first send.
  // Keyed by the duplicate's pending id -> the source session's message history.
  // On the first real send, this history is injected as a <hidden> priming block
  // so the freshly-created kiro-cli session inherits the full conversation context.
  const duplicateHistoryRef = useRef<Map<string, Message[]>>(new Map());
  // Pending duplicate id -> source project. Keep this separate from React state so
  // an immediate first send cannot race the pending session render and lose the
  // source chat's project while materializing the backend session.
  const duplicateProjectRef = useRef<Map<string, string | undefined>>(new Map());
  // In-flight session creations, keyed by the pending tempId -> Promise<realId>.
  // Lets a send that happens before connection completes await the SAME creation
  // instead of racing a duplicate (which lost the message).
  const creatingRef = useRef<Map<string, Promise<string>>>(new Map());
  // Mid-turn steers written into a running turn but NOT yet consumed by the
  // agent, keyed by sessionId. Each entry keeps its optimistic user-message id
  // so `steer_consumed` can flip the badge to 'consumed', and turn-end can
  // reconcile any still-un-consumed steers back into the queue (never dropped).
  const pendingSteersRef = useRef<Map<string, { msgId: string; content: string; attachments: AttachedFile[] }[]>>(new Map());
  const loopsRef = useRef<Map<string, LoopState>>(new Map());
  const DEFAULT_MODEL = 'claude-opus-4.6';

  // Always-fresh mirror of sessions for reads inside async callbacks (closures
  // otherwise capture a stale sessions array). Used to resolve a session's
  // authoritative projectId at prompt time.
  const sessionsRef = useRef<Session[]>([]);
  sessionsRef.current = sessions;
  const projectForSession = (sid: string | null): string | undefined =>
    sid ? sessionsRef.current.find((s) => s.id === sid)?.projectId : undefined;
  const permissionModeForSession = (sid: string | null): 'auto-approve' | 'ask' =>
    sid ? (sessionsRef.current.find((s) => s.id === sid)?.permissionMode || 'auto-approve') : 'auto-approve';

  // Record/merge a file-touching tool call into a session's file-change list.
  // Deduped by toolCallId (a tool_call then its tool_call_update refer to the
  // same entry). Surfaces to the visible `fileChanges` state for the viewed session.
  const upsertFileChange = useCallback((sid: string, tc: ToolCall, isActive: boolean) => {
    const list = fileChangesMapRef.current.get(sid) || [];
    const idx = list.findIndex((t) => t.toolCallId === tc.toolCallId);
    const next = idx >= 0 ? [...list.slice(0, idx), tc, ...list.slice(idx + 1)] : [...list, tc];
    fileChangesMapRef.current.set(sid, next);
    if (isActive) setFileChanges(next);
  }, []);

  /** Rebuild a session's file-change list from its stored history.
   *
   *  Live turns fill this through upsertFileChange and NOTHING ever refilled it from
   *  disk, so after a restart the changed-files panel was empty for every existing
   *  chat — while the data was there the whole time (measured on one chat: 73 stored
   *  tool calls carrying 20 diffs and 36 location lists, none of it reachable).
   *  Same dedupe key as the live path so a chat reopened from disk and one watched
   *  live cannot disagree; anything already in the map is newer and wins. */
  const rebuildFileChanges = useCallback((sid: string, history: Message[], isActive: boolean) => {
    const byId = new Map<string, ToolCall>();
    for (const message of history) {
      for (const tc of message.toolCalls || []) {
        // File-touching calls only: `execute` with neither diffs nor locations is a
        // command, and the panel lists files, not commands.
        if (!tc?.toolCallId || !(tc.diffs?.length || tc.locations?.length)) continue;
        byId.set(tc.toolCallId, tc);
      }
    }
    if (byId.size === 0) return;   // never clobber a live list with an empty one
    for (const live of fileChangesMapRef.current.get(sid) || []) byId.set(live.toolCallId, live);
    const list = Array.from(byId.values());
    fileChangesMapRef.current.set(sid, list);
    if (isActive) setFileChanges(list);
  }, []);

  const persistContextLinks = () => {
    try {
      uiSet(
        'kirolex-context-links',
        JSON.stringify(Array.from(contextLinksRef.current.entries()))
      );
    } catch {}
  };

  const refreshContextLinks = (sid: string | null) => {
    const arr = contextLinksRef.current.get(sid || '') || [];
    const view = arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle }));
    if (!sid || currentSessionRef.current === sid) setContextLinks(view);
    patchPane(sid, { contextLinks: view });
  };

  const addStreaming = (sid: string) => {
    if (!sid) return;
    if (!streamingIdsRef.current.has(sid)) {
      streamingIdsRef.current.add(sid);
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };
  const removeStreaming = (sid: string | null) => {
    if (!sid) return;
    // A turn cannot have a tool in flight once it is over. Clearing here is the
    // authoritative fix for a stale "Running: ..." label that outlived its turn
    // (kiro-cli does not always send a terminal tool_call_update).
    setSessionActiveTool(sid, null);
    // Same reasoning for the stall warning: it describes a RUNNING turn, so it must
    // not survive the turn it describes.
    setSessionStall(sid, null);
    if (streamingIdsRef.current.delete(sid)) {
      setStreamingIds(Array.from(streamingIdsRef.current));
    }
  };
  const beginStreamingTurn = (sid: string) => {
    const token = Symbol(sid);
    activePromptTokenRef.current.set(sid, token);
    // Single seam for "a turn is starting", so a stall notice from the previous
    // attempt is retired here rather than lingering over a healthy turn.
    setSessionStall(sid, null);
    addStreaming(sid);
    return token;
  };
  const finishStreamingTurn = (sid: string | null, token: symbol) => {
    if (!sid || activePromptTokenRef.current.get(sid) !== token) return;
    activePromptTokenRef.current.delete(sid);
    removeStreaming(sid);
  };

  const addAttached = (sid: string) => {
    if (!sid) return;
    if (!attachedIdsRef.current.has(sid)) {
      attachedIdsRef.current.add(sid);
      setAttachedSessionIds(Array.from(attachedIdsRef.current));
    }
  };
  const removeAttached = (sid: string | null) => {
    if (!sid) return;
    if (attachedIdsRef.current.delete(sid)) {
      setAttachedSessionIds(Array.from(attachedIdsRef.current));
    }
  };

  const markHistoryLoading = (sid: string) =>
    setHistoryLoadingIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  const clearHistoryLoading = (sid: string) =>
    setHistoryLoadingIds((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : prev));

  const markConnecting = (sid: string | null) => {
    if (!sid) return;
    if (!connectingRef.current.has(sid)) {
      connectingRef.current.add(sid);
      setConnectingSessionIds(Array.from(connectingRef.current));
    }
  };
  const clearConnecting = (sid: string | null) => {
    if (!sid) return;
    if (connectingRef.current.delete(sid)) {
      setConnectingSessionIds(Array.from(connectingRef.current));
    }
  };

  const modelForSession = (sid: string | null): string => {
    if (!sid) return DEFAULT_MODEL;
    return sessionModelRef.current.get(sid) || DEFAULT_MODEL;
  };

  // Record which phase a session is in. Only surfaced for the viewed session;
  // background sessions keep their phase in the map for when you switch to them.
  const activityMapRef = useRef<Map<string, string>>(new Map());
  const setSessionActivity = (sid: string | null, text: string | null) => {
    if (!sid) return;
    if (text) activityMapRef.current.set(sid, text);
    else activityMapRef.current.delete(sid);
    if (currentSessionRef.current === sid) setActivityStatus(text);
    patchPane(sid, { activity: text });
  };

  // Live stall state PER SESSION, same shape as the activity line above: a map so a
  // background session keeps it for when you switch to it, plus plain state for the
  // focused one. REPLACED on every watchdog tick, so the elapsed time and the
  // countdown on screen stay truthful for as long as the turn stays quiet.
  const stallMapRef = useRef<Map<string, TurnStall>>(new Map());
  const [turnStall, setTurnStall] = useState<TurnStall | null>(null);
  const setSessionStall = (sid: string | null, info: TurnStall | null) => {
    if (!sid) return;
    if (info) stallMapRef.current.set(sid, info);
    else if (!stallMapRef.current.delete(sid)) return;   // nothing to clear
    if (currentSessionRef.current === sid) setTurnStall(info);
    patchPane(sid, { stall: info });
  };

  // In-flight tool title PER SESSION. Kept in a map (not just the viewed
  // session's state) so a tool that finishes while you are looking at another
  // session still gets cleared -- otherwise its title stuck on the composer
  // forever and hid the usage/credits widgets.
  const activeToolMapRef = useRef<Map<string, string>>(new Map());
  const setSessionActiveTool = (sid: string | null, title: string | null) => {
    if (!sid) return;
    if (title) activeToolMapRef.current.set(sid, title);
    else activeToolMapRef.current.delete(sid);
    if (currentSessionRef.current === sid) setActiveToolCall(title);
    patchPane(sid, { activeTool: title });
  };

  // Cancel-restore: when a turn is cancelled, the interrupted user prompt (incl.
  // same-turn steers, which are merged into the one user bubble) is pushed back
  // into the composer via this draft, and overwriteTargetRef remembers the
  // interrupted user message so the NEXT submit overwrites (reruns) that turn.
  const [restoredInputDraft, setRestoredInputDraft] = useState<{ id: number; text: string; sessionId?: string } | null>(null);
  const overwriteTargetRef = useRef<Map<string, string>>(new Map());
  /** Sessions whose last turn was INTERRUPTED and is awaiting an overwrite by the
   *  next composer submit. Rendered so per-message Rerun can be blocked: the
   *  documented recovery for an interrupted turn is "resubmit in the composer",
   *  not a per-message rerun. */
  const [interruptedSessionIds, setInterruptedSessionIds] = useState<string[]>([]);
  const markInterrupted = (sid: string, msgId: string) => {
    overwriteTargetRef.current.set(sid, msgId);
    setInterruptedSessionIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
  };
  const clearInterrupted = (sid: string) => {
    overwriteTargetRef.current.delete(sid);
    setInterruptedSessionIds((prev) => (prev.includes(sid) ? prev.filter((id) => id !== sid) : prev));
  };

  // Sessions already examined for an interrupted turn this run, so recovery runs at
  // most once per chat.
  const recoveryCheckedRef = useRef<Set<string>>(new Set());
  /** A turn that never got a reply — the app quit (or crashed) while it was running.
   *  Recovery RESENDS it automatically: the transcript is truncated back to before
   *  that user message and the same prompt (with its attachments and paste refs) is
   *  sent again on the live executor, so the chat continues by itself instead of
   *  leaving a dangling question. Only ever for the chat that is currently open, and
   *  only once per run. */
  /** Sessions whose pending auto-resend should stop waiting (e.g. user took over). */
  const recoveryCancelledRef = useRef<Set<string>>(new Set());
  /** Sessions we already asked main to rebuild, so the backstop fires once. */
  const primeKickedRef = useRef<Set<string>>(new Set());
  /** Live mirror of which sessions are in a history-rebuild state. Background
   *  flows (auto-resend) consult this so they never overwrite the rebuild's
   *  status line -- that clobbering is why the rebuild looked invisible. */
  const primeStateRef = useRef<Map<string, string>>(new Map());
  const isRebuilding = useCallback((sid: string) => {
    const s = primeStateRef.current.get(sid);
    return s === 'priming' || s === 'prime-pending';
  }, []);
  /** Is this chat ON SCREEN right now -- focused, or one of the split panes?
   *
   *  The old test was `sid === currentSessionRef.current`, which failed twice over.
   *  A split pane is fully visible and fully usable, yet never qualified: an
   *  unanswered question sat there forever because the FOCUSED chat happened to be a
   *  different one. And `currentSessionRef` is synced in an effect, so during
   *  switchSession it still holds the PREVIOUS id -- the check ran against the chat
   *  the user just left. Callers that know which chat is being opened pass
   *  `assumeCurrent`. */
  const isVisibleSession = (sid: string): boolean => {
    if (sid === currentSessionRef.current) return true;
    try {
      const raw = uiGet('kirolex-split-session');
      if (raw) {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids) && ids.includes(sid)) return true;
      }
    } catch {}
    return false;
  };
  const recoverInterruptedTurn = (sid: string, msgs: Message[], opts?: { assumeCurrent?: boolean }) => {
    if (!sid || sid.startsWith('pending_')) return;
    // Only ever for chats the user can SEE. Doing it for every hydrated session at
    // startup would fire a dozen billable turns at once. Not marking it checked here
    // means the check runs again when the user actually opens that chat.
    if (!opts?.assumeCurrent && !isVisibleSession(sid)) return;
    if (recoveryCheckedRef.current.has(sid)) return;
    recoveryCheckedRef.current.add(sid);
    // Opt-out lives in Settings ("重启后自动重发未完成的提问"). Read from the persisted
    // settings object: this hook runs outside App's settings state.
    try {
      const raw = uiGet('kirolex-settings');
      if (raw && JSON.parse(raw)?.recoverInterruptedTurns === false) return;
    } catch { /* default: enabled */ }
    if (streamingIdsRef.current.has(sid)) return;      // still running — not interrupted
    if (overwriteTargetRef.current.has(sid)) return;   // already flagged
    if (loopsRef.current.has(sid)) return;             // a loop is already resending this
    if (sessionsRef.current.find((s) => s.id === sid)?.archived) return; // archived chats are inert
    // Walk back over live-only thinking segments; a real assistant reply means the
    // turn completed.
    let i = msgs.length - 1;
    while (i >= 0 && msgs[i].role === 'assistant' && msgs[i].content.startsWith('💭 ')) i--;
    if (i < 0) return;
    if (msgs[i].role !== 'user') {
      // Answered. Clear this chat's resend ledger entry: it exists only to stop a
      // resend from firing twice, and once a reply is in there is nothing to guard.
      // Leaving it behind is what made the guard permanent -- see below.
      void window.kiroApi.setAutoResent?.(sid, '');
      return;
    }
    // Anchor to the turn's BASE user message: steers are not persisted.
    let base = i;
    while (base > 0 && msgs[base].steer) base--;
    const target = msgs[base];
    if (target.role !== 'user' || !target.content.trim()) return;
    // Fire-and-forget. Progress shows as the session's activity line, NOT an error
    // banner — nothing failed here.
    void (async () => {
      const key = autoResendKey(target.content);
      let attempts = 0;
      try {
        // Durable de-dup, but COUNTED. It used to store the bare key and refuse
        // forever after: one resend whose own turn got interrupted (a crash, or the
        // dev supervisor restarting the app) permanently disabled recovery for that
        // prompt -- the chat went idle and green and still never retried, with no
        // way to tell why. So: allow a bounded number of automatic attempts, and
        // clear the entry once the prompt is finally answered (above).
        const seen = await window.kiroApi.getAutoResent?.();
        const record = seen?.[sid];
        if (record) {
          const [seenKey, seenCount] = String(record).split('#');
          if (seenKey === key) {
            attempts = Number(seenCount) || 1;
            if (attempts >= AUTO_RESEND_MAX_ATTEMPTS) return;
          }
        }
      } catch { /* if the guard is unavailable, still only once per run */ }

      // The BACKEND may still be finishing the previous turn (or compacting) right
      // after a restart. Prompting then is rejected with "Wait for the active turn
      // ... to finish", which surfaced as a raw IPC error inside the chat. Wait for
      // it to go idle instead, and give up quietly rather than firing a doomed send.
      const waitForIdle = async (): Promise<boolean> => {
        for (let attempt = 0; attempt < 20; attempt++) {           // ~60s
          if (recoveryCancelledRef.current.has(sid)) return false;
          let busy = false;
          try {
            const map = await window.kiroApi.getBusyMap?.();
            const reason = map?.[sid];
            // A history rebuild is NOT a reason to wait here: main serialises it
            // (acp:prompt awaits the rebuild, then sends). Counting it as busy made
            // this poll burn its 60s and then give up QUIETLY, so the interrupted
            // question was never resent and nothing said why.
            busy = isBackendOccupied(reason) && reason !== 'priming' && reason !== 'prime-pending';
          } catch { /* treat as idle if unknown */ }
          if (!busy && !streamingIdsRef.current.has(sid)) return true;
          // Never overwrite the rebuild's own progress line.
          if (!isRebuilding(sid)) setSessionActivity(sid, '⏳ 上一轮仍在收尾，稍后自动重发…');
          await new Promise((r) => setTimeout(r, 3000));
        }
        return false;
      };
      if (!(await waitForIdle())) {
        if (!isRebuilding(sid)) setSessionActivity(sid, null);
        recoveryCheckedRef.current.delete(sid);   // allow another attempt later
        return;
      }
      try { await window.kiroApi.setAutoResent?.(sid, `${key}#${attempts + 1}`); } catch {}
      if (!isRebuilding(sid)) setSessionActivity(sid, '⟳ 上次未完成的这一轮，正在自动重发…');
      try {
        await rerunFromMessageRef.current?.(target.id, target.content, undefined, sid);
      } catch (error: any) {
        // A real failure IS worth a banner: the question would otherwise sit
        // unanswered with no explanation.
        setSessionActivity(sid, null);
        setConnectionError(`自动重发失败：${error?.message || error}。可对该消息手动点重跑。`);
      }
    })();
  };
  // Ref to rerunFromMessage (defined later) so the send path can invoke the
  // overwrite without a circular useCallback dependency.
  /** NOTE the 4th parameter. It exists on `rerunFromMessage` but was MISSING from
   *  this ref's type, so every caller silently fell back to
   *  `currentSessionRef.current` -- and the auto-resend, which runs during startup
   *  hydrate for a chat that is NOT necessarily focused, therefore fired one chat's
   *  prompt INTO ANOTHER CHAT. Observed live: a resend for the PPT chat landed in a
   *  different session's transcript. Always pass the session explicitly. */
  const rerunFromMessageRef = useRef<((messageId: string, editedText: string, override?: RerunOverride, targetSid?: string) => Promise<void>) | null>(null);

  const clearLoopState = useCallback((sessionId?: string): boolean => {
    const targets = sessionId ? [sessionId] : Array.from(loopsRef.current.keys());
    let cleared = false;
    for (const sid of targets) {
      const loop = loopsRef.current.get(sid);
      if (!loop) continue;
      loop.stopped = true;
      if (loop.timer) clearTimeout(loop.timer);
      loopsRef.current.delete(sid);
      cleared = true;
    }
    if (cleared) setLoopingIds(Array.from(loopsRef.current.keys()));
    return cleared;
  }, []);

  // Mutate a session's messages whether it is the active view (setMessages) or a
  // background session (its localStorage-backed cache). Mirrors the updateSession
  // helper inside sendQueuedMessage so steer display stays consistent with it.
  const mutateSessionMessages = useCallback((sid: string, updater: (msgs: Message[]) => Message[]) => {
    if (currentSessionRef.current === sid) {
      setMessages((current) => {
        const next = updater(current);
        // Update the session cache in the same tick. An async transcript read
        // must never replace a newly-sent optimistic message with an older snapshot.
        messagesCacheRef.current.set(sid, next);
        return next;
      });
    } else {
      const cached = messagesCacheRef.current.get(sid) || [];
      commitBackgroundMessages(sid, updater(cached));
    }
  }, [commitBackgroundMessages]);

  const attachFileChangeToLatestTurn = useCallback((sid: string, tc: ToolCall, isActive: boolean) => {
    upsertFileChange(sid, tc, isActive);
    mutateSessionMessages(sid, (current) => {
      // Manual scan instead of findLastIndex: that method needs lib ES2023, which
      // this project does not target, so it was a standing TS2550 + implicit-any.
      let lastUserIndex = -1;
      for (let index = current.length - 1; index >= 0; index--) {
        if (current[index].role === 'user') { lastUserIndex = index; break; }
      }
      let assistantIndex = -1;
      for (let index = current.length - 1; index > lastUserIndex; index--) {
        if (current[index].role === 'assistant') {
          assistantIndex = index;
          break;
        }
      }
      const mergeToolCall = (toolCalls: ToolCall[] = []) => {
        const index = toolCalls.findIndex((item) => item.toolCallId === tc.toolCallId);
        return index >= 0
          ? [...toolCalls.slice(0, index), tc, ...toolCalls.slice(index + 1)]
          : [...toolCalls, tc];
      };
      if (assistantIndex >= 0) {
        return current.map((message, index) => index === assistantIndex
          ? { ...message, toolCalls: mergeToolCall(message.toolCalls) }
          : message);
      }
      return [...current, {
        id: `tool_turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        role: 'assistant' as const,
        content: '',
        toolCalls: [tc],
        timestamp: Date.now(),
      }];
    });
  }, [mutateSessionMessages, upsertFileChange]);

  // Inject a mid-turn steer into the running turn via _session/steer. Shows the
  // message optimistically with a 'pending' badge, fires the (text-only) steer,
  // and returns { steered }. On a false result the caller (App) routes the SAME
  // text to the queue so it is never dropped. Attachments are NOT sent via steer
  // (the ext-method is text-only) — App must route attachment-bearing messages
  // to the queue and never call this with attachments.
  const steerMessage = useCallback(async (
    content: string,
    targetSid?: string,
  ): Promise<{ steered: boolean; reason?: string }> => {
    // Explicit target: a split pane can steer its own running turn without
    // depending on which chat happens to be focused.
    const sid = targetSid || currentSessionRef.current;
    const text = content.trim();
    if (!sid || !text) return { steered: false, reason: 'no-session' };

    const msgId = `steer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mutateSessionMessages(sid, (prev) => {
      const steerMsg: Message = {
        id: msgId, role: 'user', content: text, steer: 'pending', timestamp: Date.now(),
      };
      // Place the steer directly AFTER this turn's base user message (and after
      // any earlier steers of the same turn), i.e. BEFORE every assistant/tool
      // segment of the turn. Anchoring to the base -- instead of only stepping
      // over the single last assistant message -- keeps the steer adjacent to it
      // no matter how much the turn already streamed (thinking block, tool
      // messages, partial reply). ChatArea groups adjacent steers into the same
      // bubble; a steer stranded after an assistant message renders as a lone
      // orphan bubble with no Steer label.
      let baseIdx = -1;
      for (let i = prev.length - 1; i >= 0; i--) {
        if (prev[i].role === 'user' && !prev[i].steer) { baseIdx = i; break; }
      }
      if (baseIdx < 0) return [...prev, steerMsg];
      let insertAt = baseIdx + 1;
      while (insertAt < prev.length && prev[insertAt].role === 'user' && prev[insertAt].steer) insertAt++;
      return [...prev.slice(0, insertAt), steerMsg, ...prev.slice(insertAt)];
    });

    // Register BEFORE writing to ACP. Kiro can emit steering_consumed as soon
    // as stdin is drained; registering afterwards creates a race where that
    // notification is missed and an already-consumed steer is queued again at
    // turn-end. This ordering matches MeshClaw's pending-steer invariant.
    const pending = pendingSteersRef.current.get(sid) || [];
    pendingSteersRef.current.set(sid, [
      ...pending,
      { msgId, content: text, attachments: [] },
    ]);

    let res: { steered: boolean; reason?: string };
    try {
      res = await window.kiroApi.steer(sid, text);
    } catch {
      res = { steered: false, reason: 'ipc-error' };
    }

    if (!res?.steered) {
      const current = pendingSteersRef.current.get(sid) || [];
      const stillPending = current.some((item) => item.msgId === msgId);

      // If it disappeared while IPC was in flight, either Kiro consumed it or
      // turn-end reconciliation already moved it to Queue. Both paths have
      // safely handled the message, so do not enqueue a duplicate.
      if (!stillPending) return { steered: true };

      const remaining = current.filter((item) => item.msgId !== msgId);
      if (remaining.length > 0) pendingSteersRef.current.set(sid, remaining);
      else pendingSteersRef.current.delete(sid);

      // The write failed before delivery; roll back the optimistic message and
      // let the caller place the exact text at the Queue head.
      mutateSessionMessages(sid, (prev) => prev.filter((m) => m.id !== msgId));
      return { steered: false, reason: res?.reason };
    }

    return { steered: true };
  }, [mutateSessionMessages]);

  // Remove and return a session's un-consumed steers (the turn ended before the
  // agent consumed them). Strips their optimistic messages so the caller (App)
  // can re-queue the exact text at the queue head — reappearing as a normal
  // queued item, order preserved, never dropped. Called by App when a session
  // leaves the streaming set.
  const takeUnconsumedSteers = useCallback((sid: string): { content: string; attachments: AttachedFile[] }[] => {
    const list = pendingSteersRef.current.get(sid);
    if (!list || list.length === 0) return [];
    pendingSteersRef.current.delete(sid);
    const ids = new Set(list.map((s) => s.msgId));
    mutateSessionMessages(sid, (prev) => prev.filter((m) => !ids.has(m.id)));
    return list.map((s) => ({ content: s.content, attachments: s.attachments }));
  }, [mutateSessionMessages]);

  // Explicitly drop a session's (or every session's, when sid is omitted)
  // UN-consumed pending steers on an explicit user cancel / hard stop. Unlike
  // takeUnconsumedSteers this does NOT return them for re-queue: the user
  // cancelled, so the un-consumed steers must simply disappear (their optimistic
  // messages removed too) and never auto-start a follow-up turn. Consumed steers
  // are not in the pending set, so they stay in the rendered message group.
  const discardUnconsumedSteers = useCallback((sid?: string | null) => {
    const targets = sid ? [sid] : Array.from(pendingSteersRef.current.keys());
    for (const target of targets) {
      const list = pendingSteersRef.current.get(target);
      if (!list || list.length === 0) continue;
      pendingSteersRef.current.delete(target);
      const ids = new Set(list.map((s) => s.msgId));
      mutateSessionMessages(target, (prev) => prev.filter((m) => !ids.has(m.id)));
    }
  }, [mutateSessionMessages]);

  // Populate sessionModelRef from persisted sessions on init
  useEffect(() => {
    for (const s of sessions) {
      if (s.model && s.model !== 'auto') sessionModelRef.current.set(s.id, s.model);
    }
  }, []);

  // Load messages cache from localStorage on init and restore last session messages
  useEffect(() => {
    // Message bodies are NO LONGER mirrored into localStorage. That cache had
    // grown to ~12.7 MB for 20 sessions — a duplicate of data the durable
    // transcript on disk already owns, written through a silent try/catch so a
    // quota failure would have been invisible. The in-memory Map still gives
    // instant switching within a run; a cache miss reads the transcript from
    // disk (see switchSession), which is the source of truth anyway.
    try { uiRemove('kirolex-messages-cache'); } catch {}
    // Restore the last session's messages from DISK so reopening the app still
    // lands on a populated chat instead of a blank one.
    (async () => {
      // Declared out here so the split-pane sweep below can skip it -- and so an
      // empty/unreadable last session no longer returns early and skips the sweep
      // entirely, which is what left panes unchecked.
      const lastSid = uiGet('kirolex-last-session');
      try {
        if (!lastSid) throw new Error('no last session');
        const transcript = await window.kiroApi.readTranscript?.(lastSid);
        if (!Array.isArray(transcript) || transcript.length === 0) throw new Error('empty transcript');
        const restored: Message[] = transcript.map((m: any) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          toolCalls: m.toolCalls,
          attachments: m.attachments,
          pastes: (m as any).pastes,
          timestamp: m.ts,
        }));
        messagesCacheRef.current.set(lastSid, restored);
        rebuildFileChanges(lastSid, restored, currentSessionRef.current === lastSid || !currentSessionRef.current);
        // Only paint it if the user is still on that session (hydrate is async).
        if (currentSessionRef.current === lastSid || !currentSessionRef.current) setMessages(restored);
        recoverInterruptedTurn(lastSid, restored, { assumeCurrent: true });
      } catch {}
      // Split panes are on screen too, and nothing ever ran the check for them: an
      // unanswered question in a pane just sat there because the FOCUSED chat was a
      // different one. Sweep them once at startup, after the focused chat, so the
      // restored session still goes first.
      try {
        const raw = uiGet('kirolex-split-session');
        const ids: string[] = raw ? JSON.parse(raw) : [];
        for (const sid of Array.isArray(ids) ? ids : []) {
          if (!sid || sid === lastSid || sid.startsWith('pending_')) continue;
          const transcript = await window.kiroApi.readTranscript?.(sid);
          if (!transcript?.length) continue;
          const msgs: Message[] = transcript.map((m: any) => ({
            id: m.id, role: m.role, content: m.content,
            toolCalls: m.toolCalls, attachments: m.attachments,
            pastes: (m as any).pastes, timestamp: m.ts,
          }));
          messagesCacheRef.current.set(sid, msgs);
          rebuildFileChanges(sid, msgs, currentSessionRef.current === sid);
          recoverInterruptedTurn(sid, msgs);
        }
      } catch {}
    })();
    // Load persisted context links and reflect the current session's links
    try {
      const savedLinks = uiGet('kirolex-context-links');
      if (savedLinks) {
        const entries: [string, any][] = JSON.parse(savedLinks);
        // Normalize: earlier versions stored a single object per target
        const normalized: [string, { sourceId: string; sourceTitle: string; syncedCount: number }[]][] =
          entries.map(([k, v]) => [k, Array.isArray(v) ? v : [v]]);
        contextLinksRef.current = new Map(normalized);
        const lastSid = uiGet('kirolex-last-session');
        const arr = lastSid ? contextLinksRef.current.get(lastSid) : undefined;
        if (arr) setContextLinks(arr.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })));
      }
    } catch {}
  }, []);

  // Eager-attach existing sessions at startup so switching is instant — no
  // click-then-wait-to-connect. Spawning an executor per chat is bounded by the
  // backend cap (MAX_CONCURRENT_SESSIONS = 8) with no LRU eviction, so we attach
  // the MOST RECENT sessions first and reserve one slot for a brand-new chat.
  // Runs once, concurrent + best-effort (skips failures), and never changes the
  // current view. Attached-but-unselected chats stay dormant (dot rule), so this
  // does not light everything green.
  // Declared here (above the eager-attach effect) because that effect reads
  // `hydrated` both in its body and its dependency array, which are evaluated
  // during render -- declaring it later caused a TDZ crash
  // ("Cannot access 'hydrated' before initialization").
  const hydratedRef = useRef(false);
  const [hydrated, setHydrated] = useState(false);
  const eagerAttachedRef = useRef(false);
  useEffect(() => {
    if (eagerAttachedRef.current) return;
    // Wait until disk hydration has finished. `hydrated` and `sessions` are
    // separate state updates, so `hydrated` can flip true on a render where
    // `sessions` is still empty. We must NOT burn the one-shot guard then, or the
    // attach loop runs with zero sessions and never fires again -- leaving every
    // background chat unconnected. So: wait for hydration, and if sessions haven't
    // populated yet, just reveal the window and RETURN WITHOUT setting the guard,
    // so this effect re-runs once sessions arrive and actually warms them.
    if (!hydrated) return;
    eagerAttachedRef.current = true; // claim the one-shot immediately
    const EXECUTOR_CAP_FALLBACK = 8; // used only if the cap fetch fails
    let cancelled = false;
    // Declared outside the try: chosen inside it (before reveal) and consumed
    // after it, once the window is already visible.
    let cap = EXECUTOR_CAP_FALLBACK;
    let toAttach: Array<{ id: string }> = [];
    (async () => {
      // REVEAL FIRST, CONNECT AFTER. The splash only covers reading session
      // history from disk; no executor start is allowed to hold the window back.
      // Backends then attach with the main UI already usable, and each session's
      // progress is visible on its own sidebar dot (yellow connecting -> green).
      try {
        // `hydrated` can flip true a render BEFORE setSessions commits (they are
        // separate state updates), so an empty snapshot right now does NOT mean
        // "no sessions". Wait briefly for sessions to populate, otherwise we would
        // reveal an EMPTY window. Genuinely-empty installs fall through after the
        // short wait.
        for (let i = 0; i < 40 && sessionsRef.current.length === 0 && !cancelled; i++) {
          await new Promise((r) => setTimeout(r, 50)); // up to ~2s
        }
        if (cancelled) return;
        await window.kiroApi.splashStatus?.('Loading session history…');
        // Decide the warm set and mark it connecting BEFORE the window shows,
        // otherwise the first painted frame has every dot grey ("not connected")
        // and the UI looks broken for a moment. getExecutorCap is a cheap
        // computed value, not a process spawn, so this does not delay reveal.
        try { cap = (await window.kiroApi.getExecutorCap()) || EXECUTOR_CAP_FALLBACK; } catch {}
        const limit = Math.max(1, cap - 1); // reserve one slot so "New chat" can attach
        const lastSid = uiGet('kirolex-last-session');
        const ordered = sessionsRef.current.filter((s) => s && !String(s.id).startsWith('pending_') && !s.archived);
        // Ordering now only decides WHICH sessions make the cap cut, not who starts
        // first -- keep the current chat inside the cut.
        ordered.sort((a, b) => (a.id === lastSid ? -1 : b.id === lastSid ? 1 : 0));
        toAttach = ordered.slice(0, limit);
        toAttach.forEach((s) => { if (!attachedIdsRef.current.has(s.id)) markConnecting(s.id); });
        // Let React paint the hydrated sidebar/transcript before the window shows.
        await new Promise((r) => setTimeout(r, 120));
      } finally {
        if (!cancelled) {
          try { await window.kiroApi.reveal?.(); } catch {}
        }
      }
      if (cancelled) return;

      // Now spawn the executors, ALL AT ONCE. Every candidate was already marked
      // connecting above so the whole sidebar flashes together rather than lighting
      // up in waves. Bounded only by the backend executor cap. The landed-on chat
      // starts in the same wave (not ahead of the others) -- it is already
      // interactive, and sending a message attaches on demand anyway.
      if (toAttach.length === 0) return;
      await Promise.all(
        toAttach.map(async (s) => {
          if (cancelled || attachedIdsRef.current.has(s.id)) { clearConnecting(s.id); return; }
          try {
            await window.kiroApi.loadSession(s.id, '~', modelForSession(s.id));
            addAttached(s.id);
          } catch {
            // best-effort: cap reached, connect failure, or unloadable session.
            // The chat stays dormant (grey) and attaches on click/send.
          } finally {
            clearConnecting(s.id);
          }
        })
      );
    })();
    return () => { cancelled = true; };
  }, [hydrated]);

  // Keep ref in sync with state, persist last session.
  useEffect(() => {
    currentSessionRef.current = currentSessionId;
    setCommands(currentSessionId ? (commandsMapRef.current.get(currentSessionId) || []) : []);
    if (currentSessionId) {
      try {
        uiSet('kirolex-last-session', currentSessionId);
      } catch {}
    }
  }, [currentSessionId]);

  // Keep the IN-MEMORY cache for the current session so switching back is
  // instant. Nothing is written to localStorage any more: the durable transcript
  // on disk is the source of truth and switchSession reads it on a cache miss.
  useEffect(() => {
    if (currentSessionId && messages.length > 0) {
      messagesCacheRef.current.set(currentSessionId, messages);
    }
  }, [messages, currentSessionId]);


  // Persist sessions whenever they change
  // Hydrate the sidebar from the on-disk durable store (source of truth).
  // localStorage['kirolex-sessions'] is origin-scoped and can be emptied by a
  // dev-port/origin change or a bad blank load; the transcripts on disk are not.
  // On mount we merge any disk record that the local index is missing, so
  // sessions can never silently "disappear". localStorage keeps ownership of the
  // richer, renderer-only fields (projectId/folderId/pinned/model/permissionMode).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const disk = await listDurableSessionsOnce();
        if (cancelled || !Array.isArray(disk)) return;
        const diskIds = new Set(disk.map((r: any) => r?.id).filter(Boolean));
        // sessionModelRef is what gets SENT as the attach model. It is seeded once
        // on mount from the (possibly stale) localStorage list, so refresh it from
        // disk here -- otherwise startup keeps requesting the old model forever.
        for (const rec of disk) {
          if (rec?.id && rec.model && rec.model !== 'auto') {
            sessionModelRef.current.set(rec.id, rec.model);
          }
        }
        setSessions((prev) => {
          const byId = new Map(prev.map((s) => [s.id, s]));
          for (const rec of disk) {
            const existing = byId.get(rec.id);
            if (existing) {
              // Keep local fields; backfill missing title/timestamp/projectId.
              byId.set(rec.id, {
                ...existing,
                title: existing.title || rec.title || 'New Chat',
                timestamp: existing.timestamp || rec.updatedAt,
                projectId: existing.projectId ?? rec.projectId,
                // The durable record OWNS the model, like archive/pin state below.
                // Preferring the localStorage copy meant a stale, origin-scoped
                // value kept being sent as the attach model long after the record
                // had changed -- e.g. still requesting a retired 'claude-opus-4.8'
                // when every record on disk said 'claude-opus-5'.
                model: rec.model || existing.model || DEFAULT_MODEL,
                // The durable record owns archive state: localStorage is
                // origin-scoped and can silently lose it, which made archived
                // chats reappear in the normal list instead of the Archived group.
                archived: rec.archived ?? existing.archived,
                pinned: existing.pinned ?? rec.pinned, // durable pin survives origin/localStorage change
              });
            } else {
              byId.set(rec.id, {
                id: rec.id,
                title: rec.title || 'New Chat',
                model: rec.model || DEFAULT_MODEL,
                projectId: rec.projectId,
                archived: rec.archived,
                pinned: rec.pinned,
                timestamp: rec.updatedAt,
              });
            }
          }
          return Array.from(byId.values())
            // DISK IS AUTHORITATIVE. This merge used to be a pure union, so a chat
            // that localStorage still listed but the disk no longer had (deleted,
            // then the removal or the index write did not land) was resurrected on
            // every start. Keep only what disk knows about, plus not-yet-persisted
            // pending/new chats.
            .filter((s) => diskIds.has(s.id) || String(s.id).startsWith('pending_'))
            .sort((a, b) => b.timestamp - a.timestamp);
        });
        // Rebuild the projects list from disk projectIds so restored projects
        // (e.g. test/test2) reappear as groups instead of collapsing to Unassigned.
        const diskProjects = Array.from(
          new Set(disk.map((r) => r.projectId).filter(Boolean) as string[])
        );
        if (diskProjects.length) {
          setProjects((prev) => Array.from(new Set([...prev, ...diskProjects])));
        }
      } catch {
        /* disk hydrate is best-effort; local index still works */
      } finally {
        hydratedRef.current = true;
        setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    try {
      // Guardrail: never overwrite the persisted index with an empty array
      // before disk hydration has completed. This is exactly the case that
      // wiped the sidebar — a blank/error load persisting [] over a good index.
      if (!hydratedRef.current && sessions.length === 0) return;
      uiSet('kirolex-sessions', JSON.stringify(sessions));
    } catch {}
  }, [sessions]);

  // Auto-load a session on startup. currentSessionId is restored from
  // localStorage['kirolex-last-session'] but nothing calls switchSession for it,
  // so the chat stays blank until the user manually clicks a session. Once disk
  // hydration has populated the sidebar, switch into the restored session (or the
  // most-recent non-archived one) exactly once so its transcript loads on open.
  const initialSwitchDoneRef = useRef(false);
  useEffect(() => {
    if (initialSwitchDoneRef.current) return;
    if (sessions.length === 0) return;
    const isSelectable = (s: Session) => !String(s.id).startsWith('pending_') && !s.archived;
    const restored = currentSessionRef.current
      ? sessions.find((s) => s.id === currentSessionRef.current)
      : undefined;
    const target = restored && isSelectable(restored)
      ? restored
      : sessions.filter(isSelectable).sort((a, b) => b.timestamp - a.timestamp)[0];
    if (!target) return;
    initialSwitchDoneRef.current = true;
    void switchSession(target.id);
  }, [sessions]);

  // Persist folders whenever they change
  useEffect(() => {
    try {
      uiSet('kirolex-folders', JSON.stringify(folders));
    } catch {}
  }, [folders]);

  // Persist projects whenever they change
  useEffect(() => {
    try {
      uiSet('kirolex-projects', JSON.stringify(projects));
    } catch {}
  }, [projects]);

  // Seed the projects list from any projectIds already present on sessions.
  useEffect(() => {
    const fromSessions = Array.from(
      new Set(sessions.map((s) => s.projectId).filter(Boolean) as string[])
    );
    if (fromSessions.length) {
      setProjects((prev) => Array.from(new Set([...prev, ...fromSessions])));
    }
  }, []);

  useEffect(() => {
    if (!window.kiroApi) return;

    const removeUpdate = window.kiroApi.onUpdate((data: any) => {
      if (!data?.update) return;
      const { update, sessionId } = data;

      // Route updates strictly by sessionId. If the backend fails to supply one,
      // fall back to the last session we prompted (NOT the currently viewed one).
      // With split view several chats can be busy at once, and "last prompted"
      // is a single value -- guessing would drop A's reply into B. So only use
      // the fallback when EXACTLY ONE session is streaming (then it is
      // unambiguous); otherwise discard the orphan chunk rather than misroute it.
      let targetSid = sessionId;
      if (!targetSid) {
        const busy = Array.from(streamingIdsRef.current);
        if (busy.length === 1) targetSid = busy[0];
        else if (busy.length === 0) targetSid = lastPromptedSessionRef.current;
        else {
          console.warn('[kirolex] update without sessionId while', busy.length, 'chats are streaming — discarded');
          return;
        }
      }
      if (!targetSid) return; // No session context at all, discard
      const isActiveSession = targetSid === currentSessionRef.current;

      // The first update of any kind means the agent has started responding, so
      // the phase text ("已发送，等待 Kiro 响应…") is stale: from here the live
      // stream and the tool-activity bar describe what is happening.
      if (activityMapRef.current.has(targetSid)) setSessionActivity(targetSid, null);
      // Output resumed, so the turn is demonstrably alive again and the stall
      // warning (with its countdown) must go with it.
      setSessionStall(targetSid, null);

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = update.content?.text || '';

          // kiro-cli signals context compaction as a plain message chunk (there
          // is no structured ACP event for it — verified via probe). Surface it
          // as a transient status so the user knows what the quiet turn is doing.
          if (/compacting|compact(ing)? (the )?conversation|compact(ing)? context|正在压缩|压缩上下文|压缩对话/i.test(text)) {
            setSessionActivity(targetSid, '🗜️ 正在压缩上下文…');
          }

          // Safety: only write to active session if it's actually streaming.
          // This prevents stale chunks from leaking into a freshly created session.
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              // Append to the last assistant message during streaming, UNLESS it is
              // a 💭 thinking segment — reply text must start a fresh message.
              if (last?.role === 'assistant' && !last.content.startsWith('💭 ')) {
                return [
                  ...prev.slice(0, -1),
                  { ...last, content: last.content + text },
                ];
              } else {
                // Create new assistant message
                return [
                  ...prev,
                  {
                    id: update.messageId || `msg_${Date.now()}`,
                    role: 'assistant',
                    content: text,
                    toolCalls: [],
                    timestamp: Date.now(),
                  },
                ];
              }
            });
          } else if (targetSid) {
            // Buffer message for background session (or active session that isn't streaming).
            // commitBackgroundMessages also keeps a split pane live if this
            // session happens to be on screen.
            const cached = messagesCacheRef.current.get(targetSid) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'assistant' && !last.content.startsWith('💭 ')) {
              const updated = [...cached.slice(0, -1), { ...last, content: last.content + text }];
              commitBackgroundMessages(targetSid, updated);
            } else {
              commitBackgroundMessages(targetSid, [
                ...cached,
                { id: update.messageId || `msg_${Date.now()}`, role: 'assistant' as const, content: text, timestamp: Date.now() },
              ]);
            }
          }
          break;
        }

        case 'agent_thought_chunk':
        case 'agent_reasoning_chunk': {
          // Reasoning/thinking stream. Rendered as a 💭 thinking segment (kept
          // separate from the reply; live-only, not persisted to the transcript).
          const text = update.content?.text || '';
          if (!text) break;
          const applyThink = (arr: Message[]): Message[] => {
            const lastM = arr[arr.length - 1];
            if (lastM?.role === 'assistant' && lastM.content.startsWith('💭 ')) {
              return [...arr.slice(0, -1), { ...lastM, content: lastM.content + text }];
            }
            return [...arr, {
              id: update.messageId || `think_${Date.now()}`,
              role: 'assistant' as const,
              content: '💭 ' + text,
              timestamp: Date.now(),
            }];
          };
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages(applyThink);
          } else if (targetSid) {
            commitBackgroundMessages(targetSid, applyThink(messagesCacheRef.current.get(targetSid) || []));
          }
          break;
        }

        case 'tool_call': {
          const locations = extractLocations(update);
          const diffs = extractDiffs(update);
          const tc: ToolCall = {
            toolCallId: update.toolCallId,
            title: update.title || 'Tool call',
            status: update.status || 'pending',
            kind: update.kind,
            locations,
            diffs,
            content: extractToolOutput(update) || undefined,
          };
          toolCallsRef.current.set(update.toolCallId, tc);
          // Track per session so it is cleared even if you switch away mid-tool
          setSessionActiveTool(targetSid, tc.title);
          if (locations.length || diffs.length || RUN_KINDS.has((tc.kind || '').toLowerCase())) attachFileChangeToLatestTurn(targetSid, tc, isActiveSession);
          break;
        }

        case 'tool_call_update': {
          const existing = toolCallsRef.current.get(update.toolCallId);
          if (existing) {
            existing.status = update.status;
            if (update.kind) existing.kind = update.kind;
            const newLocations = extractLocations(update);
            const newDiffs = extractDiffs(update);
            if (newLocations.length) existing.locations = newLocations;
            if (newDiffs.length) existing.diffs = newDiffs;
            const output = extractToolOutput(update);
            if (output) existing.content = output;
            toolCallsRef.current.set(update.toolCallId, existing);
            if (existing.locations?.length || existing.diffs?.length
                || RUN_KINDS.has((existing.kind || '').toLowerCase())) {
              attachFileChangeToLatestTurn(targetSid, existing, isActiveSession);
            }

            if (update.status === 'completed' || update.status === 'failed') {
              // Clear after a brief moment (only if no newer tool took over)
              const finished = existing.title;
              setTimeout(() => {
                if (activeToolMapRef.current.get(targetSid) === finished) {
                  setSessionActiveTool(targetSid, null);
                }
              }, 800);
            } else {
              setSessionActiveTool(targetSid, existing.title);
            }
          }
          break;
        }

        case 'plan': {
          // ACP execution plan. kiro-cli resends the full plan on each update,
          // so we replace wholesale. Rendered as a collapsible Plan/Todo panel.
          const entries: PlanEntry[] = Array.isArray(update.entries)
            ? update.entries
                .map((e: any) => ({
                  content: typeof e?.content === 'string' ? e.content : (e?.content?.text || ''),
                  priority: e?.priority,
                  status: e?.status,
                }))
                .filter((e: PlanEntry) => !!e.content)
            : [];
          planMapRef.current.set(targetSid, entries);
          if (isActiveSession) setPlan(entries);
          break;
        }

        case 'permission_request': {
          const requestSessionId = targetSid;
          const toolTitle = update.toolCall?.title
            || update.tool?.name
            || update.toolName
            || 'Tool permission required';
          const trustDisplay = update._meta?.trustOptions?.[0]?.display;
          const description = update.description
            || update.tool?.description
            || trustDisplay;
          const options: PermissionOption[] = Array.isArray(update.options)
            ? update.options.map((option: any) => ({
                optionId: option.optionId,
                name: option.name,
                kind: option.kind,
              })).filter((option: PermissionOption) => !!option.optionId)
            : [];
          setPermissionRequests((current) => ({
            ...current,
            [requestSessionId]: {
              requestId: update.requestId,
              sessionId: requestSessionId,
              toolTitle,
              description,
              options,
            },
          }));
          break;
        }

        case 'user_message_chunk': {
          // During session replay — only write to live messages if this is the
          // active session AND we initiated a load for it. The gate used to
          // compare against lastPromptedSessionRef (a single value), which is
          // wrong once two panes can prompt: it either dropped A's replay or
          // attributed it to B. Compare against the session's own streaming
          // state instead.
          const text = update.content?.text || '';
          if (isActiveSession && streamingIdsRef.current.has(targetSid)) {
            setMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last?.role === 'user' && last.id === update.messageId) {
                return [...prev.slice(0, -1), { ...last, content: last.content + text }];
              }
              return [...prev, {
                id: update.messageId || `user_${Date.now()}`,
                role: 'user',
                content: text,
                timestamp: Date.now(),
              }];
            });
          } else if (targetSid) {
            // Buffer into the correct session's cache (and its pane, if visible)
            const cached = messagesCacheRef.current.get(targetSid) || [];
            const last = cached[cached.length - 1];
            if (last?.role === 'user' && last.id === update.messageId) {
              commitBackgroundMessages(targetSid, [...cached.slice(0, -1), { ...last, content: last.content + text }]);
            } else {
              commitBackgroundMessages(targetSid, [...cached, {
                id: update.messageId || `user_${Date.now()}`,
                role: 'user' as const,
                content: text,
                timestamp: Date.now(),
              }]);
            }
          }
          break;
        }

        case 'usage_update': {
          // Standard ACP usage update (may not be sent by kiro-cli)
          break;
        }

        case '_kiro_internal': {
          // Handle kiro-specific metadata (per-session usage)
          if (update.method === '_kiro.dev/metadata' && sessionId) {
            const turnCredits = update.meteringUsage?.[0]?.value || 0;
            const prev = usageMapRef.current.get(sessionId);
            const next = {
              contextPercent: update.contextUsagePercentage || 0,
              credits: (prev?.credits || 0) + turnCredits,
              turnMs: update.turnDurationMs,
            };
            usageMapRef.current.set(sessionId, next);
            writeUsageMap(usageMapRef.current); // durable: see USAGE_MAP_KEY
            // Only update the visible usage if this is the session being viewed
            if (isActiveSession) setUsage(next);
            patchPane(sessionId, { usage: next });
          } else if (update.method === '_kiro.dev/commands/available' && Array.isArray(update.commands)) {
            const nextCommands: SlashCommand[] = update.commands
              .filter((command: any) => typeof command?.name === 'string')
              .map((command: any) => ({
                name: command.name,
                description: command.description,
                hint: command.meta?.hint || undefined,
                subcommands: command.meta?.subcommands || undefined,
              }));
            commandsMapRef.current.set(targetSid, nextCommands);
            if (isActiveSession) setCommands(nextCommands);
          } else if (typeof update.method === 'string' && update.method.startsWith('_kiro.dev/')) {
            // Unhandled kiro-specific event (e.g. context compaction). Log it so
            // we can wire a precise status (like "正在压缩上下文") once we know
            // the exact method/shape kiro-cli emits during compaction.
            console.warn('[kirolex] unhandled kiro event', update.method, update);
          }
          break;
        }

        case 'steer_queued': {
          // kiro-cli acknowledged the steer will be applied at its next tool
          // boundary. The optimistic 'pending' badge already reflects this;
          // explicit case (not a fall-through) so intent is clear.
          break;
        }

        case 'steer_consumed': {
          // The agent folded a steer into the running turn. Correlate to the
          // optimistic message(s): prefer substring-matching the concatenated
          // snapshot (robust when several steers consume at one boundary), and
          // fall back to the oldest pending when the snapshot is empty. Flip the
          // matched message(s) to the 'consumed' badge and drop them from the
          // pending set so turn-end never re-queues an already-delivered steer.
          const snapshot: string = update.text || '';
          const list = pendingSteersRef.current.get(targetSid) || [];
          if (list.length === 0) break;

          const consumedIds = new Set<string>();
          if (snapshot) {
            // Kiro normally returns one or more wrapped user-message blocks.
            // Match each block to exactly one pending entry so duplicate text is
            // consumed by count rather than all identical entries at once.
            const blocks = Array.from(
              snapshot.matchAll(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/g),
              (match) => match[1].trim(),
            );

            if (blocks.length > 0) {
              for (const block of blocks) {
                const match = list.find(
                  (item) => !consumedIds.has(item.msgId) && item.content === block,
                );
                if (match) consumedIds.add(match.msgId);
              }
            } else {
              // Compatibility path for versions that emit unwrapped snapshots.
              // Remove one matched occurrence at a time to preserve duplicate
              // counts and pending order.
              let remainingSnapshot = snapshot;
              for (const item of list) {
                const index = remainingSnapshot.indexOf(item.content);
                if (index < 0) continue;
                consumedIds.add(item.msgId);
                remainingSnapshot = `${remainingSnapshot.slice(0, index)}${remainingSnapshot.slice(index + item.content.length)}`;
              }
            }
          }

          // Some versions omit the consumed content entirely. Their lifecycle
          // remains FIFO, so consume exactly the oldest pending steer.
          if (consumedIds.size === 0) consumedIds.add(list[0].msgId);

          const remaining = list.filter((item) => !consumedIds.has(item.msgId));
          if (remaining.length > 0) pendingSteersRef.current.set(targetSid, remaining);
          else pendingSteersRef.current.delete(targetSid);
          // Persist what was actually delivered. Steers never go through
          // acp:prompt, so NOTHING else writes them to the durable transcript: on
          // disk the turn kept the reply that answered the steer but not the steer
          // itself, and since the ride-along context snapshot is rebuilt from that
          // transcript, a restored chat showed the model answering a question
          // nobody had asked. Written only on CONSUMED, because an un-consumed
          // steer is reconciled back into the queue and re-sent through acp:prompt
          // — which persists it there, so writing it here as well would double it.
          for (const item of list) {
            if (!consumedIds.has(item.msgId)) continue;
            void window.kiroApi.persistSteer?.(targetSid, item.content, item.msgId).catch(() => {});
          }
          mutateSessionMessages(targetSid, (prev) =>
            prev.map((m) => (consumedIds.has(m.id) ? { ...m, steer: 'consumed' as const } : m))
          );
          break;
        }

        case 'steer_cleared': {
          // kiro-cli dropped all queued steers for this turn without consuming
          // them. Leave them pending — the turn-end reconcile (App) converts any
          // un-consumed steers into the queue head so they are never lost.
          break;
        }

        default:
          break;
      }
    });

    const removeError = window.kiroApi.onError((error: any) => {
      console.error('ACP error:', error);
    });

    // Turn end: adopt main's authoritative full assistant text. The streaming
    // append can miss trailing chunks (it is gated on the session still being
    // marked streaming), which showed up as a reply cut off mid-sentence while
    // the persisted transcript was complete. Healing here makes the on-screen
    // message match what was actually produced.
    const removeSessionBusy = window.kiroApi.onSessionBusy?.(({ sessionId: sid, reason, detail }) => {
      if (!sid) return;
      // Mirror the rebuild state so background flows (auto-resend) can avoid
      // overwriting its status line -- that clobbering is why the rebuild looked
      // invisible even when it was the session's actual state.
      if (reason === 'priming' || reason === 'prime-pending') primeStateRef.current.set(sid, reason);
      else primeStateRef.current.delete(sid);
      // Rebuild progress ("重建历史上下文 2/5") must be visible: a large chat can
      // spend a minute here, and a silent wait is indistinguishable from a hang.
      if (reason === 'priming') setSessionActivity(sid, `⏳ ${detail || '重建历史上下文'}…`);
      else if (reason === 'prime-pending') {
        setSessionActivity(sid, '⏳ 历史上下文缺失，正在重建（会重试到完成）；新消息排队，完成后依次发出。按 Stop 放弃重建（之后的消息会照常发出，只是后端没有这个会话的历史）');
        // Marking the chat busy is only safe if the rebuild actually STARTS. Main
        // kicks every one of them at attach, so this is only a backstop for a
        // missed trigger -- and it is limited to the chat the user is LOOKING at.
        // Firing it for every background chat would defeat main's startup stagger
        // (~17 chats attach at once) and put them all on the model simultaneously.
        if (sid === currentSessionRef.current && !primeKickedRef.current.has(sid)) {
          primeKickedRef.current.add(sid);
          window.kiroApi.primeHistory?.(sid)
            .then((res: any) => {
              // Main retries internally without limit, so a non-ok result here
              // means the run ENDED early (executor replaced, model swapped, user
              // abandoned). Re-arm the backstop so the next busy event starts a
              // fresh run; otherwise the chat could sit 'prime-pending' (occupied,
              // queue blocked) with nothing running.
              if (res && !res.ok && !res.queued) {
                setTimeout(() => primeKickedRef.current.delete(sid), 5000);
              }
            })
            .catch(() => { setTimeout(() => primeKickedRef.current.delete(sid), 5000); });
        }
      } else {        primeKickedRef.current.delete(sid);
        if (activityMapRef.current.get(sid)?.includes('重建')
            || activityMapRef.current.get(sid)?.includes('历史上下文')) {
          setSessionActivity(sid, null);
        }
      }
      setBusyBySession((prev) => {
        const current = prev[sid] || null;
        if (current === (reason || null)) return prev;
        const next = { ...prev };
        if (reason) next[sid] = reason; else delete next[sid];
        return next;
      });
    });
    // Paint the initial snapshot (sessions already busy before this mount).
    window.kiroApi.getBusyMap?.().then((map) => { if (map) setBusyBySession(map); }).catch(() => {});

    const removeAssistantFinal = window.kiroApi.onAssistantFinal?.(({ sessionId: sid, messageId, text }) => {
      if (!sid || !text) return;
      const patch = (list: Message[]): Message[] => {
        // Prefer the id main used; fall back to the last assistant message.
        let idx = list.findIndex((m) => m.id === messageId);
        if (idx < 0) {
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].role === 'assistant' && !list[i].content.startsWith('💭 ')) { idx = i; break; }
          }
        }
        if (idx < 0) return list;
        if (list[idx].content === text) return list;
        if (text.length < list[idx].content.length) return list; // never shrink
        console.warn('[kirolex] healed truncated assistant message', {
          sid, rendered: list[idx].content.length, authoritative: text.length,
        });
        const next = [...list];
        next[idx] = { ...next[idx], content: text };
        return next;
      };
      const cached = messagesCacheRef.current.get(sid);
      if (cached) messagesCacheRef.current.set(sid, patch(cached));
      if (sid === currentSessionRef.current) setMessages((prev) => patch(prev));
    });

    // The session's REAL model, pushed by main after a connect-time or
    // prompt-time fallback. Keeps the composer selector honest: before this, the
    // selector could show a model the executor was not running at all.
    const removeSessionModel = window.kiroApi.onSessionModel?.(({ sessionId: sid, model }) => {
      if (!sid || !model) return;
      sessionModelRef.current.set(sid, model);
      setSessions((prev) => prev.map((s) => (s.id === sid ? { ...s, model } : s)));
    });

    // The turn is being resent (stall retry / mid-flight model swap). Drop the
    // aborted attempt's partial assistant output, otherwise the retry's answer is
    // appended after it and the same paragraphs appear twice.
    const removeTurnRestart = window.kiroApi.onTurnRestart?.(({ sessionId: sid }) => {
      if (!sid) return;
      const dropPartial = (list: Message[]): Message[] => {
        let idx = -1;
        for (let i = list.length - 1; i >= 0; i--) {
          if (list[i].role === 'user') break;               // reached this turn's prompt
          if (list[i].role === 'assistant') { idx = i; break; }
        }
        if (idx < 0) return list;
        return list.filter((_, i) => i < idx);
      };
      const cached = messagesCacheRef.current.get(sid);
      if (cached) messagesCacheRef.current.set(sid, dropPartial(cached));
      if (sid === currentSessionRef.current) setMessages((prev) => dropPartial(prev));
      setSessionActivity(sid, '上一次尝试无响应，正在重试…');
    });

    // Long silence on a running turn. Purely informational: shown as the session's
    // activity line (NOT an error banner), and nothing is cancelled — a long tool
    // call or a big context compaction is normal, and Stop remains the user's call.
    const removeTurnQuiet = window.kiroApi.onTurnQuiet?.((data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      setSessionStall(sid, {
        quietSeconds: data.quietSeconds || 0,
        openTools: data.openTools || 0,
        toolIdleSeconds: data.toolIdleSeconds || 0,
        cpuBusy: !!data.cpuBusy,
        cpuVetoLeftSeconds: data.cpuVetoLeftSeconds || 0,
        interruptInSeconds: data.interruptInSeconds ?? null,
      });
    });

    // Main has decided this turn is not coming back and is interrupting it. Unlike
    // onTurnQuiet this one ACTS. Nothing is rendered from here: main writes the reason
    // into the turn's own message, which is permanent and in the right place, whereas
    // anything set here would be a floating notice outliving the turn it describes.
    const removeTurnWedged = window.kiroApi.onTurnWedged?.(({ sessionId: sid, produced }) => {
      if (!sid) return;
      if (produced) return;   // partial reply exists -> resending would duplicate it
      // The auto-resend, by contrast, IS live, so it gets a status line.
      setSessionActivity(sid, '⚠️ 该轮无响应，已中断，正在自动重发…');

      void (async () => {
        // The event is emitted the moment main DECIDES, before the interrupt lands,
        // so the turn is still streaming here. recoverInterruptedTurn bails on a
        // streaming session, hence waiting for it to actually settle first.
        const deadline = Date.now() + 60000;
        while (streamingIdsRef.current.has(sid) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
        }
        if (streamingIdsRef.current.has(sid)) return;   // never settled; leave it to the user
        // recoveryCheckedRef dedupes the once-per-run STARTUP sweep; a wedge is a
        // fresh event, so clear the mark. The durable counted ledger in
        // auto-resent.json is what actually bounds retries.
        recoveryCheckedRef.current.delete(sid);
        recoverInterruptedTurn(sid, messagesCacheRef.current.get(sid) || [], { assumeCurrent: true });
      })();
    });

    const removeDisconnected = window.kiroApi.onDisconnected((data?: any) => {
      // A per-session executor process disconnected. Clear that session's
      // streaming/loop state (design §3: one process per session).
      const sid = data?.sessionId;
      if (sid) {
        const wasStreaming = streamingIdsRef.current.has(sid);
        streamingIdsRef.current.delete(sid);
        removeAttached(sid); // executor gone -> dormant
        clearConnecting(sid);
        clearLoopState(sid);
        // Mid-turn death is an interruption: mark the last user turn so the next
        // submit OVERWRITES it, and (if this is the viewed session) surface an
        // error + restore its prompt to the composer.
        if (wasStreaming) {
          const msgs = messagesCacheRef.current.get(sid) || [];
          let idx = -1;
          for (let i = msgs.length - 1; i >= 0; i--) {
            // Anchor to the turn's BASE user message, not the last steer: steer
            // messages are optimistic-only (main never persists them) and get
            // stripped when un-consumed steers are re-queued -- an overwrite /
            // rerun target pointing at one then fails to resolve.
            if (msgs[i].role === 'user' && !msgs[i].steer) { idx = i; break; }
          }
          if (idx >= 0) {
            markInterrupted(sid, msgs[idx].id);
            if (sid === currentSessionRef.current) {
              if (msgs[idx].content.trim()) setRestoredInputDraft({ id: Date.now(), text: msgs[idx].content, sessionId: sid });
              setConnectionError('⚠️ 会话在回合中被中断；下一条消息将覆盖这一轮。');
            }
          }
        }
        // AUTO-RECOVERY: the executor process is genuinely gone, so bring the
        // session back by itself instead of leaving a dead grey chat that only
        // heals on the user's next send. Throttled per session (>=8s apart) so a
        // crash-looping backend can't spin here.
        const lastTry = autoRecoverAtRef.current.get(sid) || 0;
        if (!reconfiguringRef.current.has(sid) && Date.now() - lastTry > 8000) {          autoRecoverAtRef.current.set(sid, Date.now());
          setTimeout(() => {
            (async () => {
              if (attachedIdsRef.current.has(sid)) return; // already back
              try {
                markConnecting(sid);
                await window.kiroApi.loadSession(sid, '~', modelForSession(sid));
                addAttached(sid);
                if (sid === currentSessionRef.current) setSessionActivity(sid, null);
              } catch {
                // Still down -- stay dormant; the next send retries as before.
              } finally {
                clearConnecting(sid);
              }
            })();
          }, 600);
        }
      } else {
        streamingIdsRef.current.clear();
        clearLoopState();
        attachedIdsRef.current.clear();
        setAttachedSessionIds([]);
        connectingRef.current.clear();
        setConnectingSessionIds([]);
      }
      setStreamingIds(Array.from(streamingIdsRef.current));
    });

    // Seam hook A (design §11): a session's executor attached and is ready for
    // its first prompt. Mark it live and reflect its (write-once) projectId.
    const removeSessionReady = window.kiroApi.onSessionReady((data) => {
      const sid = data?.sessionId;
      if (!sid) return;
      clearConnecting(sid);
      if (data.projectId) {
        setSessions((prev) =>
          prev.map((s) => (s.id === sid && !s.projectId ? { ...s, projectId: data.projectId } : s))
        );
      }
    });

    return () => {
      removeUpdate();
      removeError();
      removeAssistantFinal?.();
      removeSessionModel?.();
      removeTurnRestart?.();
      removeTurnQuiet?.();
      removeTurnWedged?.();
      removeSessionBusy?.();
      removeDisconnected();
      removeSessionReady();
    };
  }, []);

  const connect = useCallback(async (model: string) => {
    setStatus('connecting');
    setConnectionError(null);
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      setConnectionError(err?.message || 'Failed to connect');
    }
  }, []);

  const disconnect = useCallback(async () => {
    clearLoopState();
    await window.kiroApi.disconnect();
    setStatus('disconnected');
    setCurrentSessionId(null);
  }, [clearLoopState]);

  const newSession = useCallback(async (cwd: string, model: string = DEFAULT_MODEL, projectId?: string) => {
    await connect(model);

    // KiroLex-owned session id, stable from creation (never a pending swap).
    // Main maps kiro-cli's backend session id to this id internally.
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    currentSessionRef.current = id;
    sessionModelRef.current.set(id, model);
    setCurrentSessionId(id);
    setMessages([]);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    setUsage(null);
    setPlan([]);
    setFileChanges([]);
    setActiveToolCall(null);
    setContextLinks([]);

    if (projectId) setProjects((prev) => (prev.includes(projectId) ? prev : [...prev, projectId]));

    setSessions((prev) => [
      { id, title: 'New Chat', model, permissionMode: 'auto-approve', projectId, timestamp: Date.now() },
      ...prev,
    ]);
    markConnecting(id); // flash while the executor spawns

    // Register the in-flight creation so a send before connect finishes awaits
    // this same attach (id is already stable, so no swap — just gate readiness).
    const createPromise = (async (): Promise<string> => {
      try {
        await window.kiroApi.newSession(id, cwd, model, projectId, undefined, 'auto-approve');
        clearConnecting(id);
        // Per design: a newly created chat auto-connects. The executor is
        // spawned, so mark it attached immediately -> the sidebar dot goes green
        // right away (no lazy "dormant until first message" state).
        addAttached(id);
      } catch {
        clearConnecting(id);
      } finally {
        creatingRef.current.delete(id);
      }
      return id;
    })();
    creatingRef.current.set(id, createPromise);
    return id;
  }, [connect]);

  // Duplicate a session: create a full copy at the same folder level, preserving
  // all messages and context. The backend kiro-cli session is NOT created yet;
  // the copied history is injected as a <hidden> priming block on the first send
  // (reusing the same context-rebuild pattern used for stale sessions), so the
  // model treats the duplicate as a seamless continuation with full context.
  const duplicateSession = useCallback((
    sessionId: string,
    throughMessageId?: string,
  ): string | undefined => {
    const src = sessions.find((s) => s.id === sessionId);
    if (!src) return undefined;

    const srcMsgs = messagesCacheRef.current.get(sessionId) || [];
    const throughIndex = throughMessageId
      ? srcMsgs.findIndex((message) => message.id === throughMessageId)
      : -1;
    const selectedMessages = throughIndex >= 0
      ? srcMsgs.slice(0, throughIndex + 1)
      : srcMsgs;
    const newId = `pending_dup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const copied = selectedMessages.map((m) => ({
      ...m,
      attachments: m.attachments?.map((attachment) => ({ ...attachment })),
    }));

    // Copy messages into the duplicate's display cache and persist
    messagesCacheRef.current.set(newId, copied);

    // Cold cache (a session hydrated from disk but never opened this run) used to
    // fork an EMPTY chat: message bodies are no longer mirrored into localStorage,
    // so the in-memory cache only fills when a session is opened. Backfill from the
    // durable transcript — the source of truth — as soon as it can be read.
    if (copied.length === 0 && !throughMessageId) {
      void (async () => {
        try {
          const t = await window.kiroApi.readTranscript?.(sessionId);
          if (!Array.isArray(t) || t.length === 0) return;
          const restored: Message[] = t.map((m: any) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            attachments: m.attachments,
            pastes: m.pastes,
            timestamp: m.ts,
          }));
          // Only fill if nothing has been written to the fork meanwhile.
          if ((messagesCacheRef.current.get(newId) || []).length === 0) {
            messagesCacheRef.current.set(newId, restored);
            duplicateHistoryRef.current.set(newId, restored);
            rebuildFileChanges(newId, restored, currentSessionRef.current === newId);
            if (currentSessionRef.current === newId) setMessages(restored);
          }
        } catch { /* fork just starts empty */ }
      })();
    }

    // Stash the history and project for backend context injection/materialization
    // on the first send. The explicit project ref avoids a React state timing race.
    if (copied.length > 0) {
      duplicateHistoryRef.current.set(newId, copied);
    }
    duplicateProjectRef.current.set(newId, src.projectId);

    // Copy the per-session model routing
    const model = sessionModelRef.current.get(sessionId) || DEFAULT_MODEL;
    sessionModelRef.current.set(newId, model);

    // Copy this session's own usage snapshot for display continuity
    const srcUsage = usageMapRef.current.get(sessionId);
    if (srcUsage) { usageMapRef.current.set(newId, { ...srcUsage }); writeUsageMap(usageMapRef.current); }

    // Copy context-sync links (each restarts its high-water mark at 0 so the
    // duplicate re-forwards the linked sources' history on its first send)
    const links = contextLinksRef.current.get(sessionId);
    if (links && links.length > 0) {
      contextLinksRef.current.set(newId, links.map((l) => ({ ...l, syncedCount: 0 })));
      persistContextLinks();
    }

    // Insert the duplicate right after the source, in the same folder
    setSessions((prev) => {
      const dup: Session = {
        id: newId,
        title: throughMessageId ? `fork:${src.title}` : `dup:${src.title}`,
        model,
        permissionMode: src.permissionMode || 'auto-approve',
        projectId: src.projectId,
        folderId: src.folderId ?? null,
        timestamp: Date.now(),
      };
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx === -1) return [dup, ...prev];
      const next = [...prev];
      next.splice(idx + 1, 0, dup);
      return next;
    });

    return newId;
  }, [sessions]);

  /** Declare which sessions are visible in split panes (never the focused one).
   *  Seeds each pane's live view from the message cache, and reads the
   *  transcript from disk for a pane that was never opened this run — the same
   *  cold path switchSession uses, so a pane is never blank-but-loaded. */
  const setPaneSessions = useCallback(async (ids: string[]) => {
    const wanted = ids.filter((id) => !!id && !id.startsWith('pending_'));
    paneSessionIdsRef.current = new Set(wanted);
    setPaneViews((prev) => {
      const next: Record<string, PaneView> = {};
      for (const id of wanted) {
        next[id] = prev[id] || {
          messages: messagesCacheRef.current.get(id) || [],
          activity: activityMapRef.current.get(id) || null,
          activeTool: activeToolMapRef.current.get(id) || null,
          usage: usageMapRef.current.get(id) || null,
          contextLinks: (contextLinksRef.current.get(id) || [])
            .map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle })),
          stall: stallMapRef.current.get(id) || null,
        };
      }
      return next;   // panes that went away are dropped, freeing their copy
    });
    for (const id of wanted) {
      if ((messagesCacheRef.current.get(id) || []).length > 0) continue;
      markHistoryLoading(id);
      try {
        const transcript = await window.kiroApi.readTranscript(id);
        if (Array.isArray(transcript) && transcript.length > 0) {
          const restored: Message[] = transcript.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            attachments: (m as any).attachments,
            pastes: (m as any).pastes,
            timestamp: m.ts,
          }));
          const live = messagesCacheRef.current.get(id) || [];
          const liveById = new Map(live.map((message) => [message.id, message]));
          const restoredIds = new Set(restored.map((message) => message.id));
          const merged = [
            ...restored.map((message) => liveById.get(message.id) || message),
            ...live.filter((message) => !restoredIds.has(message.id)),
          ];
          commitBackgroundMessages(id, merged);
          rebuildFileChanges(id, merged, currentSessionRef.current === id);
        }
      } catch { /* a pane that cannot be read just stays empty */ }
      finally { clearHistoryLoading(id); }
    }
  }, [commitBackgroundMessages]);

  const switchSession = useCallback(async (sessionId: string) => {
    currentSessionRef.current = sessionId; // sync immediately to avoid leaked updates
    setCurrentSessionId(sessionId);
    currentMessageRef.current = '';
    toolCallsRef.current.clear();
    // Reflect this session's persistent context-sync links (if any)
    refreshContextLinks(sessionId);
    // Restore this session's own usage; clear the tool indicator
    setUsage(usageMapRef.current.get(sessionId) || null);
    setPlan(planMapRef.current.get(sessionId) || []);
    setFileChanges(fileChangesMapRef.current.get(sessionId) || []);
    setActiveToolCall(activeToolMapRef.current.get(sessionId) || null);
    setActivityStatus(activityMapRef.current.get(sessionId) || null);
    setTurnStall(stallMapRef.current.get(sessionId) || null);

    // Restore from local cache instantly
    const cached = messagesCacheRef.current.get(sessionId);
    setMessages(cached || []);
    if (cached && cached.length > 0) recoverInterruptedTurn(sessionId, cached, { assumeCurrent: true });

    // Pending new/forked chats intentionally have no backend executor until
    // their first message materializes the real session and injects history.
    if (sessionId.startsWith('pending_')) return;

    // Cache miss (a session hydrated from disk but not yet opened this run):
    // load its transcript from disk. Message bodies are no longer mirrored into
    // localStorage, so this is the normal path after a restart. Mark the session
    // as LOADING while the read runs: painting `[]` first made a cold chat flash
    // an empty/"no messages" state that filled in a moment later, which reads as
    // "the history is gone". loadSession below resumes the backend without
    // re-streaming, so this is the only path that repopulates old chats.
    if (!cached || cached.length === 0) {
      const known = sessionsRef.current.find((s) => s.id === sessionId);
      const hasTranscript = !!known && !sessionId.startsWith('pending_');
      if (hasTranscript) markHistoryLoading(sessionId);
      try {
        const transcript = await window.kiroApi.readTranscript(sessionId);
        if (Array.isArray(transcript) && transcript.length > 0) {
          const restored: Message[] = transcript.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            toolCalls: m.toolCalls,
            // Attachment chips must survive a restart (persisted per message).
            attachments: (m as any).attachments,
            pastes: (m as any).pastes,
            timestamp: m.ts,
          }));
          const live = messagesCacheRef.current.get(sessionId) || [];
          const liveById = new Map(live.map((message) => [message.id, message]));
          const restoredIds = new Set(restored.map((message) => message.id));
          const merged = [
            ...restored.map((message) => liveById.get(message.id) || message),
            ...live.filter((message) => !restoredIds.has(message.id)),
          ];
          messagesCacheRef.current.set(sessionId, merged);
          rebuildFileChanges(sessionId, merged, currentSessionRef.current === sessionId);
          // Only apply if the user hasn't switched away while we were reading.
          if (currentSessionRef.current === sessionId) setMessages(merged);
          recoverInterruptedTurn(sessionId, merged, { assumeCurrent: true });
        }
      } catch {
        /* transcript unreadable; fall through to executor attach */
      } finally {
        clearHistoryLoading(sessionId);
      }
    }

    // Attach the executor on switch so the SELECTED chat becomes live (green dot)
    // and is ready to prompt — regardless of whether messages are cached. (Archived
    // chats stay inert.) loadSession resumes the backend session WITHOUT re-streaming
    // history, so cached messages are never duplicated.
    const isArchived = !!sessions.find((s) => s.id === sessionId)?.archived;
    const needsLoad = !attachedIdsRef.current.has(sessionId) || !cached || cached.length === 0;
    if (!isArchived && needsLoad) {
      try {
        lastPromptedSessionRef.current = sessionId;
        markConnecting(sessionId); // flash while the executor attaches
        setSessionActivity(sessionId, '正在连接会话…');
        const res = await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
        addAttached(sessionId);
        // Deliberately NOT rebuilding here on res.freshBackend. This path runs for
        // EVERY warmed chat at boot, so it burned a model turn per chat the user
        // never opened -- and the cost grew over time, since a chat qualifies once
        // it has been primed even once. The rebuild is owned by the two "actually
        // being used" gates in main: acp:ensure-context (opened) and acp:prompt
        // (sent), which verify the same evidence (backend id + pid).
        void res;
      } catch {
        // Session might not be loadable
      } finally {
        clearConnecting(sessionId);
        // Do not clobber a rebuild status: ensureContext (below) can mark this chat
        // as owing a rebuild while the attach is still finishing, and its status is
        // the only thing telling the user why the chat is locked.
        if (!isRebuilding(sessionId)) {
          setSessionActivity(sessionId, null);
        }
      }
    }
    // Opening a chat is the point at which we know it is about to be used, so ask
    // main to verify the backend really holds this chat's history and rebuild it
    // if not. Unconditional, and outside the attach branch: an already-attached
    // chat skips loadSession entirely, and a `session/load` that "succeeded" is no
    // evidence either (kiro-cli does not persist ACP sessions). Without this the
    // rebuild only started once the user had typed and sent a message.
    if (!isArchived) {
      void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
    }
  }, [sessions]);

  // Send one loop iteration to a session that is not currently visible.
  // The response continues streaming into that session's cache while the user
  // works elsewhere; the durable transcript remains owned by the main process.
  const sendLoopBackground = useCallback(async (sessionId: string, text: string): Promise<boolean> => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    const appendStopped = (reason: string) => {
      mutateSessionMessages(sessionId, (current) => [
        ...current,
        {
          id: `loop_err_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content: `⚠️ Loop stopped: ${reason}`,
          timestamp: Date.now(),
        },
      ]);
    };

    if (!session || session.archived || sessionId.startsWith('pending_')) {
      appendStopped('session is unavailable');
      return false;
    }

    const activeModel = modelForSession(sessionId);
    const userMessageId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    mutateSessionMessages(sessionId, (current) => [
      ...current,
      { id: userMessageId, role: 'user', content: text, timestamp: Date.now() },
    ]);

    try {
      if (creatingRef.current.has(sessionId)) {
        try { await creatingRef.current.get(sessionId); } catch {}
      }
      if (!attachedIdsRef.current.has(sessionId)) {
        markConnecting(sessionId);
        try {
          await window.kiroApi.loadSession(sessionId, '~', activeModel);
          addAttached(sessionId);
        } finally {
          clearConnecting(sessionId);
        }
      }

      const turnToken = beginStreamingTurn(sessionId);
      addAttached(sessionId);
      lastPromptedSessionRef.current = sessionId;
      try {
        await window.kiroApi.prompt(
          sessionId,
          [{ type: 'text', text }],
          activeModel,
          projectForSession(sessionId),
          { messageId: userMessageId, displayText: text },
        );
        return true;
      } finally {
        finishStreamingTurn(sessionId, turnToken);
      }
    } catch (error: any) {
      if (loopsRef.current.has(sessionId)) {
        appendStopped(error?.message || 'send failed');
      }
      return false;
    }
  }, [mutateSessionMessages]);

  const sendMessage = useCallback(async (prompt: any[], localResponse?: string, attachments?: any[], model?: string, display?: { text?: string; pastes?: any[] }, targetSid?: string) => {
    // `targetSid` makes this send TARGET-ADDRESSED. Without it this function always
    // sent to whatever chat was focused, which is wrong for every caller that acts
    // on a specific chat: rerunFromMessage truncated the transcript of chat A (it
    // did receive the session id) and then sent the prompt through here, i.e. into
    // chat B. Observed live: an auto-resend for one chat truncated that chat --
    // making the user's two screenshots vanish from it -- and delivered the very
    // same message, screenshots included, into the unrelated chat that happened to
    // be open, which then answered it.
    let sid = targetSid || currentSessionRef.current || currentSessionId;
    const activeModel = model || modelForSession(sid);

    // Cancel-overwrite: if this session had a turn cancelled, the next submit
    // OVERWRITES the interrupted turn — truncate from that user message and
    // rerun with the new text (reuses the live session, no rebuild). Only for a
    // plain text submit (not localResponse-only echoes).
    if (sid && !localResponse && overwriteTargetRef.current.has(sid)) {
      const targetId = overwriteTargetRef.current.get(sid)!;
      clearInterrupted(sid);
      const textForOverwrite = prompt.find((p) => p.type === 'text' && !String(p.text).startsWith('<hidden>'))?.text || '';
      if (textForOverwrite.trim() && rerunFromMessageRef.current) {
        setConnectionError(null); // clear the "interrupted" banner on resubmit
        await rerunFromMessageRef.current(targetId, textForOverwrite, {
          prompt,
          attachments,
          pastes: display?.pastes,
          displayText: display?.text ?? textForOverwrite,
        }, sid);
        return;
      }
    }

    // Archived chats are inert: never attach an executor or prompt. They become
    // chattable only after being moved out of the archive (unarchived). The
    // composer is also disabled in the UI; this is the hard safety net.
    if (sid) {
      const curSess = sessions.find((s) => s.id === sid);
      if (curSess?.archived) return;
    }

    // The bubble/transcript show the DISPLAY text (paste placeholders kept short);
    // the prompt itself carries the fully expanded content for the model.
    const textContent = display?.text
      ?? (prompt.find(p => p.type === 'text' && !p.text.startsWith('<hidden>'))?.text || '');
    const pastes = display?.pastes?.length ? display.pastes : undefined;

    // Use one stable id in the renderer and append-only durable transcript so
    // later busy-Enter steering can target and materialize into this user turn.
    const userMessageId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticUserMessage: Message = {
      id: userMessageId,
      role: 'user',
      content: textContent,
      attachments,
      pastes,
      timestamp: Date.now(),
    };
    if (sid) mutateSessionMessages(sid, (current) => [...current, optimisticUserMessage]);
    else setMessages((current) => [...current, optimisticUserMessage]);

    if (localResponse) {
      const response: Message = {
        id: `msg_${Date.now()}`,
        role: 'assistant',
        content: localResponse,
        timestamp: Date.now(),
      };
      if (sid) mutateSessionMessages(sid, (current) => [...current, response]);
      else setMessages((current) => [...current, response]);
      return;
    }

    // If no session or session is pending, create a real one
    if (!sid || sid.startsWith('pending_')) {
      // Capture the pending id first: a duplicated session stashes its source
      // history under this id and needs it injected once the real session exists.
      const pendingId = sid;
      const pendingProjectId = pendingId && duplicateProjectRef.current.has(pendingId)
        ? duplicateProjectRef.current.get(pendingId)
        : projectForSession(pendingId);
      // If a creation is already in flight for this pending session (e.g. the
      // New Chat dialog just created it), await THAT creation instead of racing
      // a duplicate — otherwise the message lands on an orphaned session.
      if (pendingId && creatingRef.current.has(pendingId)) {
        try {
          sid = await creatingRef.current.get(pendingId)!;
          currentSessionRef.current = sid;
          sessionModelRef.current.set(sid, activeModel);
          setCurrentSessionId(sid);
        } catch { /* fall through to create below */ }
      }
      if (!sid || sid.startsWith('pending_')) {
        const newId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        try {
          await window.kiroApi.newSession(
            newId,
            '~',
            activeModel,
            pendingProjectId,
            undefined,
            permissionModeForSession(pendingId),
          );
          const prevId = sid;
          sid = newId;
          currentSessionRef.current = sid;
          sessionModelRef.current.set(sid, activeModel);
          setCurrentSessionId(sid);
          addAttached(sid);
          if (prevId && prevId.startsWith('pending_')) {
            const pendingMessages = messagesCacheRef.current.get(prevId);
            if (pendingMessages) {
              messagesCacheRef.current.set(sid, pendingMessages);
              messagesCacheRef.current.delete(prevId);
            }
            setSessions((prev) => prev.map((s) => (
              s.id === prevId ? { ...s, id: sid!, projectId: pendingProjectId } : s
            )));
            duplicateProjectRef.current.delete(prevId);
          } else {
            setSessions((prev) => [
              { id: sid!, title: 'New Chat', model: activeModel, timestamp: Date.now() },
              ...prev,
            ]);
          }
        } catch (err: any) {
          setConnectionError(err?.message || 'Failed to create session');
          return;
        }
      }

      // Duplicated session: inject the copied conversation history into the new
      // backend session as a single <hidden> priming block so the model has the
      // full prior context on this very first message.
      const dupHistory = pendingId ? duplicateHistoryRef.current.get(pendingId) : undefined;
      if (dupHistory) {
        duplicateHistoryRef.current.delete(pendingId!);
        if (dupHistory.length > 0) {
          const body = dupHistory
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          prompt = [
            {
              type: 'text',
              text: `<hidden>这是一个复制出来的会话，下面是它此前的完整对话历史。请把这些内容当作我们当前对话的已有上下文，在此基础上无缝继续，不要重复或复述这些历史：\n\n${body}</hidden>`,
            },
            ...prompt,
          ];
        }
      }
    }

    // A stable session rebuilt for edit-and-rerun also carries retained
    // history in duplicateHistoryRef. Unlike a fork, its key is already real.
    const rebuiltHistory = sid ? duplicateHistoryRef.current.get(sid) : undefined;
    if (rebuiltHistory) {
      duplicateHistoryRef.current.delete(sid!);
      if (rebuiltHistory.length > 0) {
        const body = rebuiltHistory
          .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
          .join('\n\n');
        prompt = [
          {
            type: 'text',
            text: `<hidden>下面是当前会话在编辑重跑点之前保留的完整历史。请把这些内容当作已有上下文，在此基础上回答新的用户消息，不要复述这些历史：\n\n${body}</hidden>`,
          },
          ...prompt,
        ];
      }
    }

    // Cross-session context sync: if this session is linked to one or more
    // sources, inject each source's NEW messages (delta since last sync) as a
    // single <hidden> block. Migrate link key if the id changed (pending -> real).
    if (currentSessionId && currentSessionId !== sid && contextLinksRef.current.has(currentSessionId)) {
      const moved = contextLinksRef.current.get(currentSessionId)!;
      contextLinksRef.current.delete(currentSessionId);
      contextLinksRef.current.set(sid!, moved);
      persistContextLinks();
    }
    const links = sid ? (contextLinksRef.current.get(sid) || []) : [];
    if (links.length > 0) {
      const sections: string[] = [];
      let changed = false;
      const updated: { sourceId: string; sourceTitle: string; syncedCount: number }[] = [];
      for (const link of links) {
        // Authoritative source: the durable transcript (uncapped, survives
        // restart, keyed by the stable KiroLex id). Fall back to the renderer
        // cache only if the transcript is empty/unreadable (e.g. a brand-new
        // source with nothing persisted yet).
        let srcMsgs: { role: string; content: string }[] = [];
        try {
          const t = await window.kiroApi.readTranscript(link.sourceId);
          srcMsgs = Array.isArray(t) && t.length > 0
            ? t
            : (messagesCacheRef.current.get(link.sourceId) || []);
        } catch {
          srcMsgs = messagesCacheRef.current.get(link.sourceId) || [];
        }
        const delta = srcMsgs.slice(link.syncedCount);
        if (delta.length > 0) {
          const body = delta
            .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n\n');
          sections.push(`【${link.sourceTitle}】\n${body}`);
          changed = true;
          updated.push({ ...link, syncedCount: srcMsgs.length });
        } else {
          updated.push(link);
        }
      }
      if (sections.length > 0) {
        prompt = [
          {
            type: 'text',
            text: `<hidden>下面是我提供给你参考的背景对话记录（来自我之前的几段对话），请把它们当作我们当前对话的已知信息，在回答我接下来的问题时加以利用：\n\n${sections.join('\n\n')}</hidden>`,
          },
          ...prompt,
        ];
      }
      if (changed) {
        contextLinksRef.current.set(sid!, updated);
        persistContextLinks();
      }
    }

    // Ensure the executor is attached before prompting: a just-created chat's
    // spawn may still be in flight (creatingRef). id is stable, so just wait.
    if (sid && creatingRef.current.has(sid)) {
      try { await creatingRef.current.get(sid); } catch {}
    }

    const turnToken = beginStreamingTurn(sid!);
    addAttached(sid!); // first use -> live
    lastPromptedSessionRef.current = sid;
    setSessionActivity(sid, '已发送，等待 Kiro 响应…');

    try {
      const res = await window.kiroApi.prompt(sid, prompt, activeModel, projectForSession(sid), { messageId: userMessageId, displayText: textContent, attachments, pastes });
      const notice = noticeForStopReason((res as any)?.stopReason, res) || noticeForEmptyTurn(res);
      if (notice && sid === currentSessionRef.current) setConnectionError(notice);
    } catch (err: any) {
      const msg = String(err?.message || '');
      // Session is busy with a long turn / context compaction — NOT a dropped
      // connection. Do not reconnect or show a raw remote-method error; show a
      // soft, clear status so it doesn't look broken. The message text stays put.
      if (msg.includes('active turn') || msg.includes('context compaction') || msg.includes('already in progress') || msg.includes('仍在后端运行') || msg.includes('change to finish')) {
        // The backend turn is genuinely still running (its stream notifications
        // keep arriving) -- ADOPT it: show the session as busy again instead of
        // leaving a dead-looking chat. Its turn-end event clears this normally.
        if (!msg.includes('change to finish')) addStreaming(sid);
        setSessionActivity(sid, '⏳ 当前回合仍在进行（可能在压缩上下文），请等它结束后再发送。');
      } else {
        // Not attached (dormant/reopened this run) -> attach the SAME session
        // (main resumes its kiro-cli session; the KiroLex id stays stable) and retry once.
        try {
          setSessionActivity(sid, '正在重新连接会话…');
          await window.kiroApi.loadSession(sid, '~', activeModel);
          setSessionActivity(sid, '已重连，重新发送…');
          await window.kiroApi.prompt(sid, prompt, activeModel, projectForSession(sid), { messageId: userMessageId, displayText: textContent, attachments, pastes });
        } catch (retryErr: any) {
          const msg = String(retryErr?.message || retryErr || '');
          // The backend's own busy guard is contention, not a conversation turn.
          // Writing it in as an assistant bubble put a raw IPC error string into
          // the user's chat (observed live). Surface it as a session activity
          // line; the un-answered user message is already marked for overwrite,
          // so re-submitting reruns that turn.
          if (/active turn|context compaction|still (busy|running)/i.test(msg)) {
            setSessionActivity(sid, '⏳ 上一轮仍在收尾，这条未发出；稍后可直接重发');
            removeStreaming(sid);
            return;
          }
          setMessages((prev) => [
            ...prev,
            { id: `err_${Date.now()}`, role: 'assistant', content: `⚠️ ${retryErr?.message || 'Failed to send message.'}`, timestamp: Date.now() },
          ]);
        }
      }
    } finally {
      setSessionActivity(sid, null);
      // Clear streaming only if no replacement prompt started after this turn.
      finishStreamingTurn(sid, turnToken);
    }

    // Title the new chat from its first message. Set a truncated fallback
    // immediately, then upgrade to an LLM-generated title in the background —
    // but only overwrite if the user hasn't manually renamed it in the meantime.
    const wasNewChat = sessionsRef.current.find((s) => s.id === sid)?.title === 'New Chat';
    const truncated = textContent.slice(0, 40) || 'New Chat';
    if (wasNewChat) {
      setSessions((prev) => prev.map((s) => (s.id === sid && s.title === 'New Chat' ? { ...s, title: truncated } : s)));
      if (textContent.trim()) {
        const firstAssistant = (messagesCacheRef.current.get(sid!) || [])
          .filter((m) => m.role === 'assistant' && !m.content.startsWith('💭 ') && !m.content.startsWith('🔧 '))
          .map((m) => m.content).pop();
        window.kiroApi.generateTitle?.(textContent, firstAssistant).then((r) => {
          if (r?.title) {
            setSessions((prev) => prev.map((s) => (
              s.id === sid && (s.title === truncated || s.title === 'New Chat') ? { ...s, title: r.title! } : s
            )));
          }
        }).catch(() => {});
      }
    }
  }, [currentSessionId, mutateSessionMessages]);

  // Keep background callbacks on the latest send implementation rather than a
  // render-time closure captured when a loop starts.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  const startLoop = useCallback((sessionId: string, text: string, intervalSec: number) => {
    const loopText = text.trim();
    if (!sessionId || !loopText || sessionId.startsWith('pending_')) return;

    clearLoopState(sessionId);
    const state: LoopState = {
      text: loopText,
      intervalSec: Math.max(0, Number.isFinite(intervalSec) ? intervalSec : 0),
      stopped: false,
      timer: null,
    };
    loopsRef.current.set(sessionId, state);
    setLoopingIds(Array.from(loopsRef.current.keys()));

    const iterate = async () => {
      if (state.stopped || loopsRef.current.get(sessionId) !== state) return;
      const ok = await sendLoopBackground(sessionId, state.text);
      if (!ok || state.stopped || loopsRef.current.get(sessionId) !== state) {
        clearLoopState(sessionId);
        return;
      }
      state.timer = setTimeout(() => { void iterate(); }, state.intervalSec * 1000);
    };

    void iterate();
  }, [clearLoopState, sendLoopBackground]);

  const stopLoop = useCallback(async (sessionId: string) => {
    if (!clearLoopState(sessionId)) return;
    activePromptTokenRef.current.delete(sessionId);
    try {
      await window.kiroApi.cancel(sessionId, modelForSession(sessionId), true);
    } catch {}
    removeStreaming(sessionId);
  }, [clearLoopState]);

  const rerunFromMessage = useCallback(async (messageId: string, editedText: string, override?: RerunOverride, targetSid?: string) => {
    const sid = targetSid || currentSessionRef.current;
    const text = editedText.trim();
    if (!sid || sid.startsWith('pending_') || !text) {
      setConnectionError(`重跑未执行：${!sid ? '当前无会话' : sid.startsWith('pending_') ? '会话尚未创建（先发一条消息）' : '编辑内容为空'}`);
      return;
    }
    // Editing does not touch the running turn. On Rerun submit, if a turn is
    // still streaming, abort it first (its partial output is discarded by the
    // truncation below), then reuse the live session to resend the edited text.
    if (streamingIdsRef.current.has(sid)) {
      try {
        await window.kiroApi.cancel(sid, modelForSession(sid), true);
      } catch { /* best-effort; truncation + resend still discards it */ }
      removeStreaming(sid);
    }

    const current = messagesCacheRef.current.get(sid) || [];
    let targetIndex = current.findIndex((message) => message.id === messageId);
    if (targetIndex < 0) {
      // The recorded id can legitimately disappear: steer messages are never
      // persisted and are stripped on turn-end reconcile, and a hydrate rebuilds
      // ids from the transcript. Fall back to the latest base user message so an
      // interrupted turn can still be rerun / overwritten.
      for (let i = current.length - 1; i >= 0; i--) {
        if (current[i].role === 'user' && !current[i].steer) { targetIndex = i; break; }
      }
    }
    if (targetIndex < 0) {
      setConnectionError('找不到要重跑的消息（该会话没有可重跑的用户消息）。');
      return;
    }
    while (targetIndex > 0 && current[targetIndex].steer) targetIndex--;
    const target = current[targetIndex];
    if (target.role !== 'user') {
      setConnectionError('重跑未执行：定位到的目标不是用户消息。');
      return;
    }
    const retained = current.slice(0, targetIndex).map((message) => ({
      ...message,
      attachments: message.attachments?.map((attachment) => ({ ...attachment })),
    }));

    setConnectionError(null);
    // A-mode rerun: REUSE the live backend session — never detach + rebuild.
    // Rewrite KiroLex's durable transcript + view to drop the superseded tail,
    // then send the edited message to the SAME live kiro-cli session. If the
    // executor is dormant, sendMessage resumes it via loadSession (stable id).
    // The backend keeps its own internal history (accepted A tradeoff), so the
    // rerun is instant and never shows "正在重建后端会话".
    try {
      // Rewrite the durable transcript to exactly the retained messages. Robust:
      // does NOT look up target.id in the transcript (which fails for messages
      // never persisted there, e.g. mid-turn steers). Thinking (💭) segments are
      // live-only and never belong in the transcript.
      const storedRetained = toStoredTranscript(retained);
      await window.kiroApi.rewriteTranscript(sid, storedRetained);

      pendingSteersRef.current.delete(sid);
      currentMessageRef.current = '';
      toolCallsRef.current.clear();

      // Truncate the view to retained; sendMessage appends the edited user
      // message and streams the new reply in the same flow (no rebuild step,
      // no priming — the live backend already holds the full context).
      messagesCacheRef.current.set(sid, retained);
      setMessages(retained);
      // CARRY THE ORIGINAL ATTACHMENTS. A rerun edits the TEXT; the images/files
      // that came with that message are still part of it. Dropping them meant the
      // model lost the picture you were asking about, the chips disappeared, and
      // the boot GC then deleted the now-unreferenced blobs.
      if (override?.prompt?.length) {
        // Overwrite path: send exactly what the composer produced. Display keeps the
        // placeholders (the expanded blob must not be dumped into the bubble) and the
        // attachments are the NEW ones the user just picked.
        await sendMessage(
          override.prompt,
          undefined,
          override.attachments?.length ? override.attachments : undefined,
          modelForSession(sid),
          (override.pastes?.length || override.displayText)
            ? { text: override.displayText ?? text, pastes: override.pastes }
            : undefined,
          sid, // the chat whose transcript was just truncated -- never the focused one
        );
        return;
      }
      const keptAttachments = target.attachments?.length
        ? target.attachments.map((a) => ({ ...a }))
        : undefined;
      const keptPastes = (target as any).pastes?.length ? (target as any).pastes : undefined;
      const rerunPrompt: any[] = [];
      if (keptAttachments?.length) {
        // Same hidden file-ref block the normal send path uses, so the backend can
        // re-read each file instead of being told about names it cannot open.
        const fileRefs = keptAttachments.map((f: any) => `file:${f.path}`).join('\n');
        rerunPrompt.push({ type: 'text', text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>` });
      }
      if (keptPastes?.length) {
        // Placeholders left in the edited text must reach the model as real content.
        // Matched by SEQ only: the line count in the label is cosmetic and the user
        // may well have edited the surrounding text.
        const bySeq = new Map<number, string>();
        await Promise.all(keptPastes.map(async (blk: any) => {
          const body = await window.kiroApi.readPaste?.(blk.path);
          if (typeof body === 'string') bySeq.set(Number(blk.seq), body);
        }));
        const filled = text.replace(
          /\[ 粘贴 #(\d+) · \d+ 行 \]/g,
          (whole, seq) => bySeq.get(Number(seq)) ?? whole,
        );
        rerunPrompt.push({ type: 'text', text: filled });
      } else {
        rerunPrompt.push({ type: 'text', text });
      }
      await sendMessage(
        rerunPrompt,
        undefined,
        keptAttachments,
        modelForSession(sid),
        keptPastes ? { text, pastes: keptPastes } : undefined,
        sid, // same chat that was truncated above; see sendMessage's targetSid
      );
    } catch (error: any) {
      messagesCacheRef.current.set(sid, current);
      setMessages(current);
      setConnectionError(error?.message || '编辑重跑失败。');
    }
  }, [sendMessage]);
  // Expose rerunFromMessage to the send path (cancel-overwrite) without a
  // circular useCallback dependency.
  rerunFromMessageRef.current = rerunFromMessage;

  // Send one queued follow-up to a specific existing session. Unlike the normal
  // composer path, this is target-addressed so queues keep draining even when
  // the user switches to another chat. The main process owns durable transcript
  // persistence; the renderer mirrors the user/error messages into the correct
  // session cache for immediate UI consistency.
  const sendQueuedMessage = useCallback(async (
    sessionId: string,
    text: string,
    attachments: any[] = [],
    options?: { mergeIntoMessageId?: string; onStarted?: () => void; displayText?: string; pastes?: any[] },
  ) => {
    const session = sessionsRef.current.find((candidate) => candidate.id === sessionId);
    if (!session || session.archived || sessionId.startsWith('pending_')) return;

    // Cancel/interrupt overwrite: if this session was interrupted (cancel or
    // mid-turn death set overwriteTargetRef), the NEXT queued item OVERWRITES
    // the interrupted turn — truncate the transcript to before that user message
    // first, so the queued message replaces it instead of appending after a
    // half-finished turn ("停当前、开始下一个、覆盖已输入").
    const overwriteId = overwriteTargetRef.current.get(sessionId);
    if (overwriteId) {
      clearInterrupted(sessionId);
      const cur = messagesCacheRef.current.get(sessionId) || [];
      const ti = cur.findIndex((m) => m.id === overwriteId);
      if (ti >= 0) {
        const retained = cur.slice(0, ti);
        const storedRetained = toStoredTranscript(retained);
        try { await window.kiroApi.rewriteTranscript(sessionId, storedRetained); } catch {}
        messagesCacheRef.current.set(sessionId, retained);
        if (sessionId === currentSessionRef.current) { setMessages(retained); setConnectionError(null); }
      }
    }

    const activeModel = modelForSession(sessionId);
    const prompt: any[] = [];
    if (attachments.length > 0) {
      const fileRefs = attachments.map((file) => `file:${file.path}`).join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }
    // Same rule as the normal send path: when there are attachments but no typed
    // text, the hidden file-ref block IS the instruction, so appending an empty
    // text part would send a meaningless blank message part to the backend.
    if (text.trim() || attachments.length === 0) prompt.push({ type: 'text', text });

    const updateSession = (updater: (messages: Message[]) => Message[]) => {
      if (currentSessionRef.current === sessionId) {
        setMessages(updater);
      } else {
        const cached = messagesCacheRef.current.get(sessionId) || [];
        messagesCacheRef.current.set(sessionId, updater(cached));
      }
    };

    const userMessageId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    // `text` is what the MODEL gets (pastes expanded); the bubble/transcript keep
    // the short placeholder form when the caller supplies one.
    const shownText = options?.displayText ?? text;
    const userMessage: Message = {
      id: userMessageId,
      role: 'user',
      content: shownText,
      attachments,
      ...(options?.pastes?.length ? { pastes: options.pastes } : {}),
      timestamp: Date.now(),
    };

    if (options?.mergeIntoMessageId) {
      updateSession((current) => {
        let merged = false;
        const next = current.map((message) => {
          if (message.id !== options.mergeIntoMessageId || message.role !== 'user') return message;
          merged = true;
          return {
            ...message,
            content: `${message.content}
${text}`,
            attachments: [...(message.attachments || []), ...attachments],
          };
        });
        return merged ? next : [...current, userMessage];
      });
    } else {
      updateSession((current) => [...current, userMessage]);
    }

    if (creatingRef.current.has(sessionId)) {
      try { await creatingRef.current.get(sessionId); } catch {}
    }
    if (!attachedIdsRef.current.has(sessionId)) {
      markConnecting(sessionId);
      try {
        await window.kiroApi.loadSession(sessionId, '~', activeModel);
        addAttached(sessionId);
      } finally {
        clearConnecting(sessionId);
      }
    }

    const turnToken = beginStreamingTurn(sessionId);
    options?.onStarted?.();
    addAttached(sessionId);
    lastPromptedSessionRef.current = sessionId;
    const display = {
      messageId: userMessageId,
      displayText: shownText,
      ...(options?.pastes?.length ? { pastes: options.pastes } : {}),
      ...(options?.mergeIntoMessageId ? { mergeIntoMessageId: options.mergeIntoMessageId } : {}),
    };
    let deliveryError: any = null;
    try {
      const res = await window.kiroApi.prompt(sessionId, prompt, activeModel, projectForSession(sessionId), { ...display, attachments });
      const notice = noticeForStopReason((res as any)?.stopReason, res) || noticeForEmptyTurn(res);
      if (notice && sessionId === currentSessionRef.current) setConnectionError(notice);
    } catch (firstError: any) {
      // A busy/reconfiguring rejection is authoritative: never disturb the
      // executor that is still handling the original turn or compaction.
      const message = String(firstError?.message || '');
      if (
        message.includes('active turn')
        || message.includes('already in progress')
        || message.includes('仍在后端运行')
        || message.includes('change to finish')
      ) {
        deliveryError = firstError;
      } else {
        try {
          await window.kiroApi.loadSession(sessionId, '~', activeModel);
          addAttached(sessionId);
          await window.kiroApi.prompt(sessionId, prompt, activeModel, projectForSession(sessionId), { ...display, attachments });
        } catch (retryError: any) {
          deliveryError = retryError;
        }
      }
    } finally {
      finishStreamingTurn(sessionId, turnToken);
    }

    if (deliveryError) {
      // Undo the optimistic user-message materialization. The caller can put a
      // failed queued item back at the head without duplicating its chat bubble.
      updateSession((current) => {
        if (!options?.mergeIntoMessageId) {
          return current.filter((message) => message.id !== userMessageId);
        }
        return current.map((message) => {
          if (message.id !== options.mergeIntoMessageId || message.role !== 'user') return message;
          const suffix = `\n${text}`;
          return {
            ...message,
            content: message.content.endsWith(suffix)
              ? message.content.slice(0, -suffix.length)
              : message.content,
            attachments: attachments.length > 0
              ? (message.attachments || []).slice(0, -attachments.length)
              : message.attachments,
          };
        });
      });
      throw deliveryError;
    }

    setSessions((prev) => prev.map((candidate) => (
      candidate.id === sessionId && candidate.title === 'New Chat'
        ? { ...candidate, title: text.slice(0, 40) || 'New Chat' }
        : candidate
    )));
  }, []);

  // Stop a turn. `targetSid` is REQUIRED for correctness in split view: this used
  // to read the `currentSessionId` state captured in the closure, so pressing Stop
  // in a pane cancelled whichever chat happened to be focused when the callback
  // was created — and back-filled THAT chat's prompt into the composer. That is
  // the prompt-crossing users saw. Falls back to the ref (always current), never
  // the stale state value.
  const cancelStream = useCallback(async (
    targetSid?: string | null,
    options?: { suppressInterruptionNotice?: boolean },
  ) => {
    const sessionForCancel = targetSid || currentSessionRef.current;
    if (sessionForCancel) {
      // Stop is the ONE escape from a loop, from every entry point — not just the
      // composer's loop-specific Stop button. Without this, stopping from anywhere
      // else (/stop, a background pane) cancelled the current iteration and the loop
      // immediately scheduled the next one, so the loop looked unstoppable.
      clearLoopState(sessionForCancel);
      await window.kiroApi.cancel(
        sessionForCancel,
        modelForSession(sessionForCancel),
        options?.suppressInterruptionNotice,
      );
      removeStreaming(sessionForCancel);
      // Put the interrupted turn's prompt back in the composer (including any
      // same-turn steers, which are merged into the one user bubble), and mark
      // that user message so the next submit OVERWRITES (reruns) this turn.
      const sid = sessionForCancel;
      const msgs = messagesCacheRef.current.get(sid) || [];
      let idx = -1;
      for (let i = msgs.length - 1; i >= 0; i--) {
        // Anchor to the turn's BASE user message, not the last steer: steer
        // messages are optimistic-only (main never persists them) and get
        // stripped when un-consumed steers are re-queued -- an overwrite /
        // rerun target pointing at one then fails to resolve.
        if (msgs[i].role === 'user' && !msgs[i].steer) { idx = i; break; }
      }
      if (idx >= 0) {
        const interrupted = msgs[idx];
        markInterrupted(sid, interrupted.id);
        if (interrupted.content.trim()) {
          setRestoredInputDraft({ id: Date.now(), text: interrupted.content, sessionId: sid });
        }
        setConnectionError('⚠️ 已中断当前回合；下一条消息将覆盖这一轮。');
      }
    }
  }, []);

  // Force-interrupt everything and reconnect, preserving the current view
  const forceStop = useCallback(async (model: string) => {
    clearLoopState();
    // Clear all streaming state immediately
    activePromptTokenRef.current.clear();
    streamingIdsRef.current.clear();
    setStreamingIds([]);
    // Try to cancel current turn
    if (currentSessionId) {
      try { await window.kiroApi.cancel(currentSessionId, modelForSession(currentSessionId)); } catch {}
    }
    // Kill all kiro-cli processes (interrupts all in-flight output)
    setStatus('connecting');
    try { await window.kiroApi.disconnect(); } catch {}
    // Reconnect (keeps currentSessionId; it becomes stale and will be
    // transparently recreated with context on the next message)
    try {
      await window.kiroApi.connect({ model });
      setStatus('connected');
    } catch (err: any) {
      setStatus('disconnected');
      setConnectionError(err?.message || 'Failed to reconnect');
    }
  }, [currentSessionId, clearLoopState]);

  const deleteSession = useCallback(async (sessionId: string) => {
    // Abort/clear this session's live state up front so a deleted chat never
    // looks like it is still running (main also disconnects its kiro-cli
    // process via detachExecutor on acp:delete-session).
    clearLoopState(sessionId);
    removeStreaming(sessionId);
    pendingSteersRef.current.delete(sessionId);
    activePromptTokenRef.current.delete(sessionId);
    attachedIdsRef.current.delete(sessionId);
    connectingRef.current.delete(sessionId);
    setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    // Drop any pending duplicate-history/project inheritance awaiting
    // materialization for this session.
    duplicateHistoryRef.current.delete(sessionId);
    duplicateProjectRef.current.delete(sessionId);
    // Clear local message cache
    messagesCacheRef.current.delete(sessionId);
    // Clean up context links: drop this session's own links and remove it as a
    // source from any other session (its message cache is now gone).
    let linksChanged = contextLinksRef.current.delete(sessionId);
    for (const [target, arr] of contextLinksRef.current) {
      const filtered = arr.filter((l) => l.sourceId !== sessionId);
      if (filtered.length !== arr.length) {
        if (filtered.length > 0) contextLinksRef.current.set(target, filtered);
        else contextLinksRef.current.delete(target);
        linksChanged = true;
      }
    }
    if (linksChanged) persistContextLinks();
    // Refresh the current session's link indicator (a source may have been removed)
    refreshContextLinks(currentSessionRef.current);
    // Delete session files from disk
    try {
      const res: any = await window.kiroApi.deleteSession(sessionId);
      // Never swallow this: a failed disk delete used to leave the chat on disk and
      // it came back at the next start. Main tombstones it so it stays hidden and
      // retries the removal, but the user should know the files are still there.
      if (res && res.ok === false) {
        setConnectionError(
          `会话已从列表移除，但磁盘文件暂时无法删除（${res.error || '未知原因'}）。已标记为待删除，下次启动会自动重试。`,
        );
      }
    } catch (error: any) {
      setConnectionError(`删除会话失败：${error?.message || error}。该会话可能在下次启动时重新出现。`);
    }
    if (currentSessionId === sessionId) {
      // Auto-switch to the most recent remaining chat instead of dumping the
      // user onto the empty welcome screen. Fall back to empty only if none.
      const next = sessionsRef.current
        .filter((s) => s.id !== sessionId && !String(s.id).startsWith('pending_') && !s.archived)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
      if (next) {
        void switchSession(next.id);
      } else {
        setCurrentSessionId(null);
        setMessages([]);
      }
    }
  }, [currentSessionId, switchSession, clearLoopState]);

  const renameSession = useCallback((sessionId: string, title: string) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, title } : s)
    );
  }, []);

  const reorderSessions = useCallback((newSessions: Session[]) => {
    setSessions(newSessions);
  }, []);

  const createFolder = useCallback((name: string) => {
    const folder: SessionFolder = {
      id: `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      collapsed: false,
    };
    setFolders((prev) => [...prev, folder]);
    return folder.id;
  }, []);

  const deleteFolder = useCallback((folderId: string) => {
    setFolders((prev) => prev.filter((f) => f.id !== folderId));
    // Move sessions in this folder back to root
    setSessions((prev) =>
      prev.map((s) => s.folderId === folderId ? { ...s, folderId: null } : s)
    );
  }, []);

  const renameFolder = useCallback((folderId: string, name: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, name } : f)
    );
  }, []);

  const toggleFolder = useCallback((folderId: string) => {
    setFolders((prev) =>
      prev.map((f) => f.id === folderId ? { ...f, collapsed: !f.collapsed } : f)
    );
  }, []);

  const moveSessionToFolder = useCallback((sessionId: string, folderId: string | null) => {
    setSessions((prev) =>
      prev.map((s) => s.id === sessionId ? { ...s, folderId } : s)
    );
  }, []);

  // Switch the named kiro-cli agent for one session. The main process starts a
  // replacement executor before retiring the old one, while the renderer shows
  // the normal connecting state and persists the selected agent per session.
  const changeSessionAgent = useCallback(async (sessionId: string, kiroAgent: string) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    commandsMapRef.current.delete(sessionId);
    if (sessionId === currentSessionRef.current) setCommands([]);
    markConnecting(sessionId);
    // Mark the session as reconfiguring: the switch intentionally releases and
    // reloads the backend, and the disconnect auto-recovery must NOT race it
    // (both would session/load the same id -> kiro-cli "Internal error").
    reconfiguringRef.current.add(sessionId);
    try {
      // Wait for the backend to be connected before switching (don't error with
      // "Session not connected"): if this session isn't attached yet, attach it
      // first, then perform the agent switch.
      if (!attachedIdsRef.current.has(sessionId)) {
        try { await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId)); addAttached(sessionId); } catch {}
      }
      const result = await window.kiroApi.switchKiroAgent(sessionId, kiroAgent);
      if (result?.ok) {
        setSessions((prev) => prev.map((session) => (
          session.id === sessionId
            ? { ...session, kiroAgent: result.kiroAgent || undefined }
            : session
        )));
        addAttached(sessionId);
      }
    } catch (err: any) {
      setConnectionError(err?.message || 'Failed to switch agent');
    } finally {
      reconfiguringRef.current.delete(sessionId);
      clearConnecting(sessionId);
    }
  }, []);

  // Replace an idle session's executor with the selected model. Main loads the
  // same ACP session into the replacement, so context survives and the change
  // applies atomically to the next message.
  const changeSessionModel = useCallback(async (sessionId: string, model: string) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    markConnecting(sessionId);
    reconfiguringRef.current.add(sessionId); // block disconnect auto-recovery
    try {
      // Wait for the backend to be connected before switching the model: attach
      // the session first if it isn't live yet, then switch.
      if (!attachedIdsRef.current.has(sessionId)) {
        try { await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId)); addAttached(sessionId); } catch {}
      }
      const result = await window.kiroApi.switchModel(sessionId, model);
      // Only the BACKEND decides what is in effect. A non-ok result used to leave
      // the selector showing the requested model while the executor kept running
      // the old (often retired) one -- the "selector says gpt-5.6-sol but every
      // send fails on claude-opus-5" drift.
      if (!result?.ok) {
        throw new Error(`切换模型未生效（后端仍在使用 ${modelForSession(sessionId)}）。请重试或选择其他模型。`);
      }
      sessionModelRef.current.set(sessionId, result.model);
      setSessions((prev) => prev.map((session) => (
        session.id === sessionId ? { ...session, model: result.model } : session
      )));
      addAttached(sessionId);
      return result.model as string;
    } catch (err: any) {
      setConnectionError(err?.message || 'Failed to switch model');
      throw err;
    } finally {
      reconfiguringRef.current.delete(sessionId);
      clearConnecting(sessionId);
    }
  }, []);


  // Auto/Ask changes are applied at the live ACP permission boundary. No
  // executor replacement is needed, so the session stays connected throughout.
  const changeSessionPermissionMode = useCallback(async (
    sessionId: string,
    permissionMode: 'auto-approve' | 'ask',
  ) => {
    if (!sessionId || sessionId.startsWith('pending_')) return;
    try {
      const result = await window.kiroApi.switchPermissionMode(sessionId, permissionMode);
      if (result?.ok) {
        setSessions((prev) => prev.map((session) => (
          session.id === sessionId
            ? { ...session, permissionMode: result.permissionMode }
            : session
        )));
      }
    } catch (err: any) {
      setConnectionError(err?.message || 'Failed to change tool permission mode');
      throw err;
    }
  }, []);

  // Assign a session to a project — WRITE-ONCE (design §6.4). Allowed only for
  // an unassigned (null/undefined) session; a pending session has no durable
  // record yet, so it is rejected until its real id exists.
  const assignProject = useCallback(async (sessionId: string, projectId: string) => {
    const pid = projectId.trim();
    if (!pid || sessionId.startsWith('pending_')) return;
    const target = sessions.find((s) => s.id === sessionId);
    if (target?.projectId) return; // already assigned — write-once
    try {
      await window.kiroApi.assignProject(sessionId, pid);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, projectId: pid } : s))
      );
      setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
    } catch (err) {
      console.error('assignProject failed:', err);
    }
  }, [sessions]);

  // Move a session to another project (or unassign with null). Not write-once —
  // an explicit user move. Backend resets the executor so the new project's
  // memory scope is used (no stale mixing); here we just update the sidebar's
  // grouping. No-op when the target equals the current project.
  const moveSession = useCallback(async (sessionId: string, projectId: string | null) => {
    if (sessionId.startsWith('pending_')) return;
    const pid = projectId && projectId.trim() ? projectId.trim() : null;
    const target = sessions.find((s) => s.id === sessionId);
    const current = target?.projectId ?? null;
    if (current === pid) return; // no change -> no executor reset
    try {
      await window.kiroApi.moveSession(sessionId, pid);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? { ...s, projectId: pid ?? undefined, archived: false } : s))
      );
      if (pid) setProjects((prev) => (prev.includes(pid) ? prev : [...prev, pid]));
      // UI polish: the backend reset (detached) this chat's executor. Reconnect
      // it now with a connecting flash so it comes back live under the NEW
      // project's memory scope, instead of silently going dormant until the next
      // send. Best-effort — if reconnect fails, the next send re-attaches.
      markConnecting(sessionId);
      try {
        await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
        addAttached(sessionId);
      } catch {
        /* stays dormant; next send will attach */
      } finally {
        clearConnecting(sessionId);
      }
      // The move RESET the executor, so this backend is definitively empty -- and it
      // may also have just been unarchived (archived:false above). Verify/rebuild
      // here; attach no longer does it, so otherwise the chat would answer the next
      // message with no history at all.
      void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
    } catch (err) {
      console.error('moveSession failed:', err);
    }
  }, [sessions]);

  // Archive / unarchive a session. Archiving hides it from the main list, frees
  // its executor slot (backend detaches), and switches away if it was current.
  // Unarchiving just restores it to the list (attaches lazily on next open).
  const archiveSession = useCallback(async (sessionId: string, archived: boolean) => {
    if (sessionId.startsWith('pending_')) return;
    try {
      await window.kiroApi.archiveSession(sessionId, archived);
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId
          ? { ...s, archived, ...(archived ? { projectId: undefined } : {}) }
          : s))
      );
      if (archived) {
        removeAttached(sessionId);
        clearConnecting(sessionId);
        // If we archived the chat we're viewing, jump to the most recent
        // non-archived session and WARM it (so it isn't left showing red).
        if (currentSessionRef.current === sessionId) {
          const next = sessions.find((s) => s.id !== sessionId && !s.archived);
          if (next) {
            setCurrentSessionId(next.id);
            if (!attachedIdsRef.current.has(next.id)) {
              markConnecting(next.id);
              try {
                await window.kiroApi.loadSession(next.id, '~', modelForSession(next.id));
                addAttached(next.id);
              } catch {
                /* next interaction will attach */
              } finally {
                clearConnecting(next.id);
              }
            }
            // This is a session SWITCH performed without switchSession (the id is
            // set directly), so the open-a-chat gate never runs for it. Verify it
            // here or the chat we just landed on looks connected on an empty backend.
            void window.kiroApi.ensureContext?.(next.id).catch(() => {});
          } else {
            setCurrentSessionId(null);
          }
        }
      } else {
        // Unarchive: warm it up now so it doesn't sit in the 'alert' (not-
        // connected) state — attach the executor (connecting -> warm/idle).
        if (!attachedIdsRef.current.has(sessionId)) {
          markConnecting(sessionId);
          try {
            await window.kiroApi.loadSession(sessionId, '~', modelForSession(sessionId));
            addAttached(sessionId);
          } catch {
            /* next select/send will attach */
          } finally {
            clearConnecting(sessionId);
          }
        }
        // An unarchived chat is a chat about to be used again, so verify its backend
        // really holds its history -- the same gate as opening one. Nothing else
        // covers this path: switchSession deliberately skips archived chats, and
        // attach no longer rebuilds on its own (it fired for every warmed chat at
        // boot). Without this the chat sits GREEN and connected on an empty backend
        // until the first send, which is exactly the "it only rebuilt after I
        // typed" behaviour ensure-context exists to remove.
        void window.kiroApi.ensureContext?.(sessionId).catch(() => {});
      }
    } catch (err) {
      console.error('archiveSession failed:', err);
    }
  }, [sessions]);

  // Create an (initially empty) project. Sessions join by drag-assign (§6.4).
  const createProject = useCallback((name: string) => {
    const n = name.trim();
    if (!n) return;
    setProjects((prev) => (prev.includes(n) ? prev : [...prev, n]));
  }, []);

  // Reorder PROJECTS. The `projects` array order IS the sidebar display order, so
  // moving an element here is the whole feature. A NEW project is appended (see
  // createProject), which puts it at the end of the project list — directly above
  // the Unassigned bucket, never below it: the Unassigned/Archived groups are
  // rendered outside this list and always come last.
  const reorderProjects = useCallback((name: string, target: string) => {
    if (!name || !target || name === target) return;
    setProjects((prev) => {
      const from = prev.indexOf(name);
      const to = prev.indexOf(target);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, name);
      return next;
    });
  }, []);

  // Rename a PROJECT (explicit admin op): relabel the project and bulk-update
  // every member session's projectId (durable via setProject).
  const renameProject = useCallback((oldName: string, newName: string) => {
    const n = newName.trim();
    if (!n || n === oldName) return;
    sessions.forEach((s) => {
      if (s.projectId === oldName) window.kiroApi.setProject(s.id, n).catch(() => {});
    });
    setProjects((prev) => Array.from(new Set(prev.map((p) => (p === oldName ? n : p)))));
    setSessions((prev) => prev.map((s) => (s.projectId === oldName ? { ...s, projectId: n } : s)));
  }, [sessions]);

  // Delete a PROJECT: fully clear it — delete every member chat, delete the
  // project's memory directory, and remove the label. (A later same-name project
  // therefore starts fresh with no inherited memory or chats.)
  const deleteProject = useCallback((name: string) => {
    const members = sessions.filter((s) => s.projectId === name);
    members.forEach((s) => { deleteSession(s.id); });
    window.kiroApi.deleteProjectMemory(name).catch(() => {});
    setProjects((prev) => prev.filter((p) => p !== name));
  }, [sessions, deleteSession]);

  // Pin/unpin a session (pinned sessions sort to the top of their group).
  const togglePin = useCallback((sessionId: string) => {
    setSessions((prev) => {
      const next = prev.map((s) => (s.id === sessionId ? { ...s, pinned: !s.pinned } : s));
      const nowPinned = !!next.find((s) => s.id === sessionId)?.pinned;
      // Persist to the durable record so the pin survives restart / origin change.
      window.kiroApi.setSessionPinned?.(sessionId, nowPinned).catch(() => {});
      return next;
    });
  }, []);

  // Clear a conversation's VISIBLE history (messages + local cache). Used by
  // /clear so the KiroLex view empties in step with the backend context reset.
  //
  // The durable transcript on disk is NOT touched, and that is intentional: KiroLex
  // does not delete the user's records on the strength of a slash command aimed at
  // the backend. The consequence is worth knowing: `/clear` resets kiro-cli's
  // context for this run, but KiroLex still holds the conversation, so after a
  // restart the context snapshot restores it. If the record itself should go, that
  // is a delete of the chat, not a clear of its context.
  const clearConversation = useCallback((sessionId?: string | null) => {
    const sid = sessionId || currentSessionRef.current;
    if (!sid) { setMessages([]); return; }
    messagesCacheRef.current.set(sid, []);
    if (sid === currentSessionRef.current) setMessages([]);
    planMapRef.current.delete(sid);
    fileChangesMapRef.current.delete(sid);
    if (sid === currentSessionRef.current) { setPlan([]); setFileChanges([]); }
  }, []);

  const resetSessionCredits = useCallback((sessionId?: string | null) => {
    const sid = sessionId || currentSessionRef.current;
    if (!sid) return;
    const previous = usageMapRef.current.get(sid);
    if (!previous) return;
    const next = { ...previous, credits: 0 };
    usageMapRef.current.set(sid, next);
    writeUsageMap(usageMapRef.current); // durable: see USAGE_MAP_KEY
    if (sid === currentSessionRef.current) setUsage(next);
  }, []);

  // Toggle a source session in the current session's context-sync set. Adding a
  // source starts it at syncedCount 0 (first send includes its existing history);
  // toggling it off removes it. Links are persistent and per-session.
  const toggleContextSource = useCallback((sourceSessionId: string, targetSessionId?: string) => {
    const target = targetSessionId || currentSessionRef.current;
    if (!target || !sourceSessionId || sourceSessionId === target) return;

    const arr = contextLinksRef.current.get(target) || [];
    const exists = arr.some((l) => l.sourceId === sourceSessionId);
    let next: { sourceId: string; sourceTitle: string; syncedCount: number }[];
    if (exists) {
      next = arr.filter((l) => l.sourceId !== sourceSessionId);
    } else {
      const sourceTitle =
        sessions.find((s) => s.id === sourceSessionId)?.title || 'another session';
      next = [...arr, { sourceId: sourceSessionId, sourceTitle, syncedCount: 0 }];
    }
    if (next.length > 0) contextLinksRef.current.set(target, next);
    else contextLinksRef.current.delete(target);
    persistContextLinks();
    const view = next.map((l) => ({ sourceId: l.sourceId, sourceTitle: l.sourceTitle }));
    if (currentSessionRef.current === target) setContextLinks(view);
    patchPane(target, { contextLinks: view });
  }, [sessions, patchPane]);


  const respondPermission = useCallback(async (optionId: string) => {
    const request = permissionRequest;
    if (!request) return;
    await window.kiroApi.respondPermission(
      request.requestId,
      optionId,
      request.sessionId,
    );
    setPermissionRequests((current) => {
      if (current[request.sessionId]?.requestId !== request.requestId) return current;
      const next = { ...current };
      delete next[request.sessionId];
      return next;
    });
  }, [permissionRequest]);

  // Derived: current view is streaming if the current session is in the streaming set
  const isStreaming = currentSessionId !== null && streamingIds.includes(currentSessionId);

  return {
    status,
    connectionError,
    clearConnectionError: () => setConnectionError(null),
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    busyBySession,
    /** Call off a pending/in-flight auto-resend for this chat. `recoveryCancelledRef`
     *  existed but was NEVER written, so an auto-resend could not be stopped at all
     *  -- Stop now routes here. */
    cancelAutoResend: (sid: string) => {
      if (!sid) return;
      recoveryCancelledRef.current.add(sid);
      recoveryCheckedRef.current.delete(sid);
      primeKickedRef.current.delete(sid);
      if (!isRebuilding(sid)) setSessionActivity(sid, null);
    },
    /** Force-rebuild a chat's backend context from KiroLex's own transcript.
     *  Needed when session/load "succeeded" onto a backend that was itself empty
     *  -- only the user can tell, so this is a manual entry point. */
    rebuildContext: async (sid: string, mode?: 'snapshot' | 'full') => {
      recoveryCancelledRef.current.delete(sid);   // an explicit rebuild re-arms recovery
      if (!sid) return { ok: false, error: 'no session' };
      // Whichever menu item was used IS the choice, so persist it before rebuilding.
      // That keeps the mode visible through the action instead of being hidden state.
      if (mode) { try { await window.kiroApi.setPrimeMode?.(sid, mode); } catch {} }
      if (!attachedIdsRef.current.has(sid)) {
        try {
          await window.kiroApi.loadSession(sid, '~', modelForSession(sid));
          addAttached(sid);
        } catch (err: any) {
          return { ok: false, error: err?.message || 'attach failed' };
        }
      }
      const res = await window.kiroApi.primeHistory?.(sid, true);
      if (res && !res.ok) setSessionActivity(sid, `⚠️ 上下文重建失败：${res.error || '未知原因'}`);
      return res || { ok: false, error: 'no ipc' };
    },
    interruptedSessionIds,
    connectingSessionIds,
    historyLoadingIds,
    paneViews,
    setPaneSessions,
    activeToolCall,
    usage,
    plan,
    fileChanges,
    activityStatus,
    turnStall,
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
    reorderSessions,
    folders,
    createFolder,
    deleteFolder,
    renameFolder,
    toggleFolder,
    moveSessionToFolder,
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
  };
}
