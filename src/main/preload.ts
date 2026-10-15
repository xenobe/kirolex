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
  /** The context blocks the LAST send actually carried (archived at send time), plus
   *  whether a hand-edited override is pinned for this chat -- the Snapshot tab has to
   *  say which of the two the next message will carry. */
  readLastInjection: (sessionId?: string) => ipcRenderer.invoke('acp:read-last-injection', sessionId),
  /** Pin a hand-edited context block; the next send uses it verbatim. Saving an empty
   *  string means "stop overriding", not "send an empty context". */
  writeContextOverride: (sessionId: string, text: string) => ipcRenderer.invoke('acp:write-context-override', sessionId, text),
  /** Drop the override and go back to the generated snapshot. */
  clearContextOverride: (sessionId: string) => ipcRenderer.invoke('acp:clear-context-override', sessionId),
  /** 清掉后端的活动上下文（`/clear`）—— flow 复用会话时用，transcript 不动。见 flowContext.ts */
  clearContext: (sessionId: string) => ipcRenderer.invoke('acp:clear-context', sessionId),
  writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => ipcRenderer.invoke('acp:write-memory', scope, projectId, sessionId, content),
  /** 三层记忆各自的字节数。每轮注入后主进程也会主动推 `acp:memory-bytes`；这个 invoke 是给
   *  「打开就要看到」和「手动清理完立刻更新」两个时机用的。 */
  memoryBytes: (projectId?: string, sessionId?: string) => ipcRenderer.invoke('acp:memory-bytes', projectId, sessionId),
  /** 压缩某一层记忆前先备份（每层各留最近 3 份）。让模型重写自己的记忆文件而没有备份太危险 ——
   *  删会话时 memory 是硬删不进 trash，已经真实丢过一次。 */
  backupMemory: (scope: 'global' | 'project' | 'session', projectId?: string, sessionId?: string) =>
    ipcRenderer.invoke('acp:backup-memory', scope, projectId, sessionId),

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
  /** Persist a renderer-produced assistant note (currently: why a loop ended).
   *  Same reason as persistSteer -- a message created in the renderer never reaches
   *  the durable transcript on its own, so the reason a loop stopped would die with
   *  the window. */
  persistNote: (sessionId: string, text: string) =>
    ipcRenderer.invoke('acp:persist-note', sessionId, text),

  /** This session's RUN EVENT LOG (events.jsonl): timestamped prompt/tool/permission
   *  boundaries. A separate file from the transcript on purpose -- the transcript has
   *  one timestamp per message, so tool durations and time spent waiting for a human
   *  are not recoverable from it. */
  readEvents: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke('acp:read-events', sessionId, limit),

  /** Declare the verification command for this session's loop. Only a command
   *  registered here can later be executed by `loopVerify` -- the agent must never
   *  be able to choose its own check, or maker/checker separation is gone. Passing
   *  an empty command clears the registration (a level-0 loop). */
  loopRegisterVerifier: (sessionId: string, command: string, timeoutSec: number) =>
    ipcRenderer.invoke('loop:register-verifier', sessionId, command, timeoutSec),
  /** Run that command ONCE, out of band, on the same host as the agent (over SSH for
   *  a remote session). Resolves to a result even when the command could not start:
   *  `ran: false` is "the checker is broken", which the loop must not read as "the
   *  work is not done yet". */
  loopVerify: (sessionId: string, command: string, timeoutSec: number) =>
    ipcRenderer.invoke('loop:verify', sessionId, command, timeoutSec),
  respondPermission: (requestId: number | string, optionId: string, sessionId: string) =>
    ipcRenderer.invoke('acp:request-permission-response', requestId, optionId, sessionId),

  /* ── DURABLE LOOPS ──
   *
   * The round counter lives in MAIN. It used to live in this window, so closing or
   * reloading the window reset it and a declared round cap silently became a fresh
   * budget on every restart. */

  /** Write the run down (spec + counters + terminal), at every round boundary. */
  loopPersist: (sessionId: string, run: any) => ipcRenderer.invoke('loop:persist', sessionId, run),
  /** Charge one round against the DURABLE counter, checkpointed before the send. Returns
   *  the updated run, or a terminal when the budget is spent. */
  loopBeginRound: (sessionId: string) => ipcRenderer.invoke('loop:begin-round', sessionId),
  loopRead: (sessionId: string) => ipcRenderer.invoke('loop:read', sessionId),
  /** Loops that were still running when the app last closed. */
  loopListLive: () => ipcRenderer.invoke('loop:list-live'),
  loopClear: (sessionId: string) => ipcRenderer.invoke('loop:clear', sessionId),

  /* ── SKILL FLOWS ──
   *
   * The step-by-step half of a skill: declared steps, out-of-band checks, human
   * approval gates, per-item idempotency on writes. The run lives in MAIN (and on
   * disk), not here: a gate has to survive this window being closed, which is exactly
   * what a renderer-owned run cannot do. */

  /* ── SCHEDULED TASKS (replaced loop mode) ──
   *
   * The ticker runs in MAIN, so "every Monday 9am" fires with no window open -- the old
   * loop's setTimeout lived in this window and stopped when it closed. */
  scheduleCreate: (sessionId: string, spec: any) => ipcRenderer.invoke('schedule:create', sessionId, spec),
  scheduleList: () => ipcRenderer.invoke('schedule:list'),
  schedulePause: (id: string, paused: boolean) => ipcRenderer.invoke('schedule:pause', id, paused),
  scheduleRemove: (id: string) => ipcRenderer.invoke('schedule:remove', id),
  onScheduleChanged: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('schedule:changed', handler);
    return () => ipcRenderer.removeListener('schedule:changed', handler);
  },

  /** THE SKILLS KIRO HAS: ~/.kiro/skills/<name>/SKILL.md, parsed. Read-only -- a kiro
   *  skill is triggered by the MODEL matching its frontmatter description, not by a
   *  command, so KiroLex observes it and does not drive it. */

  /* ── RUNS: a project's instances of a registered skill ── */
  /** `name` 是你给这次运行起的名字（可省）—— 序号说不清这次跑的是什么，见 `StoredRun.name`。 */
  /** 给一次运行改名。传空字符串 = 清掉名字，回到显示 `#N`。 */
  /** 让这个 run 换上新版定义 —— 只有没跑过的部分能换，动到跑过的会被拒（见 `runAdopt`）。 */
  /** A project rename is a migration for its runs — they live under its name. */
  /** 退回这些步骤（连带下游）并释放它们的会话 —— 「关闭旧 session 然后重起新 session」 */
  /** 打开一个 run 时对一次账：把「写着 running 但没人在驱动」的节点补上记账（见 runReconcile.ts） */
  /** 某一步交出来的材料：按它 produces 声明的名字存进 run，下一步靠这个名字取 */
  /**
   * 一个 `file:` 产出的正文 —— 门上要能逐段 comment 它。
   *
   * 「这个门引用了一个文件，我无法对文件进行 comment 和要求修改」：`file:` 的产出不进 run `values`，
   * 所以门上原来只有一个链接按钮。路径的算法和 `fileOutputs` 那条检查同一套（见主进程 `run:read-file`）。
   */
  /** 太长装不进提示词的上游材料，落到工作目录里，返回给它的路径（`~/…`）。 */
  /** 你在画布上填的输入：存在 run 上，刷新还在，另一个窗口也看得到 */
  /** 在流程窗口里加的一步：只写进这个 run 的 draft 副本，定义和指纹都不动 */
  /** 把会话的角色写进记录（flow 主会话的删除保护靠它，必须活过重启） */
  /** 会话标题落盘 —— 不落盘的话一刷新就退回 `New Chat`（见 `acp:rename-session`） */
  renameSessionOnDisk: (sessionId: string, title: string) => ipcRenderer.invoke('acp:rename-session', sessionId, title),
  markSessionPurpose: (sessionId: string, purpose: string, flow?: string) =>
    ipcRenderer.invoke('acp:mark-session-purpose', sessionId, purpose, flow),
  /** 把一个 flow 从这个 project 移出（配置动作，历史不动） */
  /** project 的工作目录 —— 它的会话都在这儿干活（空 = 家目录） */
  projectGetWorkspace: (project: string) => ipcRenderer.invoke('project:get-workspace', project),
  projectSetWorkspace: (project: string, workspace: string) =>
    ipcRenderer.invoke('project:set-workspace', project, workspace),
  /** 删掉某个 flow 在这个 project 的全部运行历史（进回收站，返回条数） */
  /** A skill's execution environment: which kiro agent its steps run under. */
  /** 注册表变了(保存/确认/配 agent/配模型/删除)。画布靠它按文件重画 */
  onFlowRegChanged: (callback: (data: { name: string }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    return () => ipcRenderer.removeListener('flowreg:changed', handler);
  },
  /** Refused unless that chat is in the run's own project — 「在跑的必须是project里面的会话」. */
  openRunWindow: (project: string, id: string) => ipcRenderer.invoke('window:open-run', project, id),
  /** From the run window: bring the main window forward on the chat that ran a step. */
  focusSession: (sessionId: string) => ipcRenderer.invoke('window:focus-session', sessionId),
  onFocusSessionRequest: (handler: (payload: { sessionId: string }) => void) => {
    const listener = (_e: unknown, payload: { sessionId: string }) => handler(payload);
    ipcRenderer.on('session:focus-request', listener);
    return () => ipcRenderer.removeListener('session:focus-request', listener);
  },
  /** Main owns run state; every window hears about a change. Returns an unsubscribe. */
  onRunChanged: (handler: (payload: { project: string; id: string }) => void) => {
    const listener = (_e: unknown, payload: { project: string; id: string }) => handler(payload);
    return () => ipcRenderer.removeListener('run:changed', listener);
  },

  /** Validate a flow file and return its parsed shape, without running anything. */
  /** Start a run and drive it to its first stopping point (a gate, a failure, or done). */
  /** Answer a gate. The run is re-read from disk first, so an approval given after a
   *  restart lands on the real state rather than on a copy this window remembers. */
  /** Every run on disk, pending gates included -- the way back to a paused flow when
   *  no id survived in memory. */
  /** One run in full (steps + ledger + flowPath), for the visualiser. */
  onFlowUpdate: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('flow:update', handler);
    return () => ipcRenderer.removeListener('flow:update', handler);
  },
  onFlowNote: (cb: (payload: any) => void) => {
    const handler = (_e: any, payload: any) => cb(payload);
    ipcRenderer.on('flow:note', handler);
    return () => ipcRenderer.removeListener('flow:note', handler);
  },
  
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
  /** 开/关 kiro-cli 的 trace 日志 —— 一个代价按 GB 计的开关，界面上必须看得见（见 `app:get-features`） */
  setKiroTrace: (enabled: boolean) => ipcRenderer.invoke('app:set-kiro-trace', enabled),
  setFeature: (key: string, enabled: boolean) => ipcRenderer.invoke('app:set-feature', key, enabled),
  setExecutorCap: (n: number) => ipcRenderer.invoke('app:set-executor-cap', n),
  /** Silence threshold, in seconds, before a protocol-silent turn is treated as wedged
   *  and interrupted. 0 = never interrupt. Protocol silence is the WHOLE rule now: the
   *  CPU corroboration was removed as uninformative. */
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

  /* Registered skills: a skill must be registered (structure rewritten, reviewed, frozen) before a
     project can select it. Stored under ~/.kirolex/flows, never under ~/.kiro. */
  /** Confirming carries the fingerprint the human was looking at; main refuses a mismatch. */
  /** 重命名：注册表 + run 记录 + 会话记录上的 flow 引用一起迁（主进程编排，见 `flowreg:rename`） */
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
  /** Watch exactly these files for on-disk edits, replacing any previous set.
   *  Main watches their parent directories (a save is usually write+rename, which a
   *  per-file watcher stops following), and reports each change once, debounced. */
  workspaceWatchFiles: (sessionId: string | null | undefined, paths: string[]) =>
    ipcRenderer.invoke('workspace:watch-files', sessionId, paths),
  /** One watched file changed on disk (or disappeared: `exists: false`). */
  onWorkspaceFileChanged: (callback: (data: { path: string; exists: boolean; mtimeMs: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('workspace:file-changed', handler);
    return () => ipcRenderer.removeListener('workspace:file-changed', handler);
  },
  
  // Events
  onUpdate: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:update', handler);
    return () => ipcRenderer.removeListener('acp:update', handler);
  },
  /** 主进程在启动清扫里收掉了这些会话（无主的 flow worker）—— 渲染层要按 id 把它们从侧栏摘掉，
   *  否则会留下一排点进去是空的行，要到下次启动才消失。 */
  /**
   * 主进程记完一步的账之后推一把 —— run 可能有新的一波能跑了。
   *
   * 驱动器在渲染层，而它那条 promise 链会随窗口重载一起消失（见 `run:advance` 的注释）。
   */
  onRunAdvance: (callback: (data: { project: string; id: string }) => void) => {
    const handler = (_e: unknown, data: { project: string; id: string }) => callback(data);
    return () => ipcRenderer.removeListener('run:advance', handler);
  },
  onSessionsPurged: (callback: (data: { sessionIds: string[] }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:sessions-purged', handler);
    return () => ipcRenderer.removeListener('acp:sessions-purged', handler);
  },
  /** 每轮注入后播报的三层记忆体积。横幅靠它自动出现和自动消失。 */
  onMemoryBytes: (callback: (data: {
    sessionId: string; projectId: string | null; global: number; project: number; session: number;
  }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:memory-bytes', handler);
    return () => ipcRenderer.removeListener('acp:memory-bytes', handler);
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
  /**
   * KIRO'S NATIVE SUBAGENTS for one chat, as kiro reports them (`_kiro.dev/subagent/list_update`).
   * The full roster every time — the last one of a turn is the one that says everything terminated,
   * which is what ends the left-rail tag.
   */
  onSubagents: (callback: (data: {
    sessionId: string;
    subagents: Array<{ sessionId: string; name: string; agentName: string; task: string; statusType: string; statusMessage?: string; group?: string; createdAtMs?: number }>;
  }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:subagents', handler);
    return () => ipcRenderer.removeListener('acp:subagents', handler);
  },
  getBusyMap: (): Promise<Record<string, string>> => ipcRenderer.invoke('acp:get-busy-map'),
  /** Is a turn RUNNING for this chat, and what has it produced so far? Lets a reloaded window
   *  adopt a turn that never stopped, instead of resending the question and billing it twice. */
  peekTurn: (sessionId: string): Promise<{ live: boolean; messageId: string | null; text: string; startedAt: number | null }> =>
    ipcRenderer.invoke('acp:peek-turn', sessionId),
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
   *  turn keeps running; KiroLex never interrupts a long task by itself.
   *
   *  `boundBy`/`boundSeconds` say WHICH threshold the countdown comes from, so the
   *  notice can name it: with a tool call open the governing bound is the tool
   *  no-progress limit, not the silence threshold shown first in Settings. */
  onTurnQuiet: (callback: (data: { sessionId: string; quietSeconds: number; openTools?: number; toolIdleSeconds?: number; interruptInSeconds?: number | null; boundBy?: 'tool' | 'quiet'; boundSeconds?: number }) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('acp:turn-quiet', handler);
    return () => ipcRenderer.removeListener('acp:turn-quiet', handler);
  },
  /** Unlike onTurnQuiet this is NOT advisory: the silence outlasted the threshold and
   *  main has already interrupted the turn. `produced` reports whether a partial reply
   *  survived — it is what decides auto-resend vs. asking the user. */
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
