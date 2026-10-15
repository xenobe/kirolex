import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, execFile } from 'child_process';
import { AcpClient, resolveKiroCli, buildSshArgs, shellQuote, kiroTraceEnabled } from './acp-client';
import { rewriteImagePaths } from './imagePaths';
import { AgentProfile, DEFAULT_MODEL, MODEL_FALLBACK_ORDER, deriveProjectId, canAssignProjectId, loadActiveRemoteTarget, sessionCwd } from './config';
import * as loopVerify from './loopVerify';
import * as eventLog from './eventLog';
import * as store from './sessionStore';
import { parseSkillDoc, describeSkill, kiroSkillTarget, backupsToPrune } from './skillDoc.ts';
import { isSubagentListUpdate, parseSubagentList, mergeSubagentList, activeSubagents, type SubagentRow } from './subagents.ts';
import * as loopStore from './loopStore.ts';
import { createSchedule as newSchedule, describeSchedule, isDue, nextRunAt, recordRun, scheduleTerminal, scheduleTerminalLabel, validateSchedule, type ScheduleSpec } from './schedule.ts';
import * as scheduleStore from './scheduleStore.ts';
import * as projectStore from './projectStore.ts';
import { backupMemoryLayer, buildMemoryInjection, deleteProjectMemory, deleteSessionMemory, memoryLayerBytes, readMemory, writeMemory } from './memory';
import type { MemoryScope } from './memoryPolicy.ts';
import { shouldConsolidate, buildConsolidationPrompt, mergeSessionMemory, CONSOLIDATE_EVERY } from './sessionMemory.ts';
import { staleVerdict, staleRecoveryNote, isBareInternalError, POISONED_AFTER, RECREATE_COOLDOWN_MS } from './staleSession.ts';
import { isTransientTransportError as isTransientTransportErrorImpl } from './transientError.ts';
import { planRetry, retriesExhaustedNote, MAX_AUTO_RETRIES } from './promptRetry.ts';
import { cliErrorContext, kiroCliLogPath, trimHugeCliLogs } from './kiroCliLog.ts';
import { writeFailureBundle } from './failureBundle.ts';
import { logger } from './logger';

// Silence Electron's dev-only "Insecure Content-Security-Policy" console warning.
// It fires because the Vite dev server is served without a CSP (a strict CSP would
// break HMR's inline/eval), and only ever shows in an unpackaged/dev renderer with
// DevTools open -- it is never emitted in the packaged production app. Suppressing
// it keeps the auto-opened DevTools console clean on every startup.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
// True only once the renderer has completed its gated reveal (hydration + eager
// attach) via acp:reveal -> showMainWindow(). Until then, OS-driven show paths
// (macOS `activate` on launch/dock-click, `second-instance`, tray) must NOT
// reveal the still-loading window — otherwise the main UI flashes before load.
let mainWindowRevealed = false;
let tray: Tray | null = null;
let isQuitting = false;

process.on('uncaughtException', (error) => {
  logger.error('process', 'uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
  logger.error('process', 'unhandledRejection', reason);
});
logger.info('app', 'main process starting');
/** Startup clock. The window is revealed only AFTER hydrate + eager-attach, and the
 *  stretch between "main process starting" and the first attach -- measured at 17-26s
 *  all day, in dev AND production -- had NO logging at all, so "startup is slow" could
 *  not be attributed to anything. These marks make each phase attributable. */
const STARTUP_T0 = Date.now();
function startupMark(phase: string, extra?: string): void {
  logger.info('startup', `+${((Date.now() - STARTUP_T0) / 1000).toFixed(2)}s ${phase}${extra ? ' ' + extra : ''}`);
}

// PER-SESSION executors (design §3): exactly one AcpClient process per session,
// keyed by sessionId. Replaces the previous per-model pooling. This gives
// isolation by construction, per-session targets, and clean independent
// migrate/reconnect (later PRs).
interface SessionEntry {
  client: AcpClient;
  /** kiro-cli's session id for this executor. The Map key is the KiroLex id;
   *  client calls (sendPrompt/cancel/load) use THIS. */
  cliSessionId: string;
  profile: AgentProfile;
  /** Working directory used when creating/loading replacement executors. */
  cwd: string;
  /** accumulates the in-flight assistant response; flushed to the durable
   *  store only when the turn completes (asymmetric durability, §7). */
  assistantBuf: string;
  assistantMsgId: string | null;
  /** File-changing tool calls accumulated for the in-flight assistant turn. */
  fileChanges: store.StoredToolCall[];
  /** Tool calls the backend has OPENED and not yet closed, by toolCallId.
   *
   *  Second guard for wedge detection, and the only one left that is PROTOCOL TRUTH
   *  rather than a heuristic: an open tool call is the backend stating outright that the
   *  turn is busy, so it suppresses the interrupt (bounded by TOOL_STALL_MS).
   *
   *  Tracked separately from `fileChanges`, which only records calls that touched
   *  files or ran something and would therefore miss the rest.
   *
   *  Maps toolCallId -> the time its last update arrived, so the suppression is
   *  BOUNDED. Suppressing on mere openness was unbounded and turned one failure mode
   *  into another: a `search` call that never got its closing update left a turn
   *  hanging for over five hours with detection permanently off — the exact
   *  never-ending hang this feature exists to end. Past TOOL_STALL_MS with no update,
   *  an unclosed call is breakage rather than progress.
   *
   *  Refreshed on EVERY update, so a long command that reports intermediate progress
   *  keeps its session protected for as long as it keeps reporting. */
  openToolCalls?: Map<string, { startedAt: number; lastUpdate: number }>;
  /**
   * **这一轮后端开过几个工具调用** —— 自动重试的安全闸（见 `promptRetry`）。
   *
   * `fileChanges` 不能用来回答这个问题：它只记"动过文件/跑过命令"的那些，一轮里纯读取和
   * 查询类的调用不进去；`openToolCalls` 也不行，它只留还没关闭的。而"这一轮跑过工具吗"
   * 恰恰是决定能不能闭眼重发的那个事实 —— 实测挂掉的那一轮里有 `aws ssm send-command`，
   * 重发一次就是再执行一遍。所以单独数，每轮开始清零，`tool_call`（不含 update）时 +1。
   */
  toolsThisTurn?: number;
  /**
   * **这一轮最大的一次工具输出有多少字符**（未裁剪的原始长度）——「好像 curl 那个大 json 的时候断掉了」。
   *
   * kiro-cli 把工具输出放在 `tool_call_update` 的 content 里，KiroLex 自己存盘时会裁
   * （`clampToolOutput`），但**发给模型的那一份是 kiro-cli 自己攥着的、没裁**。所以一轮里
   * 冒出一个几百 KB 的 JSON 时，后端最后答的是 `EmptyResponse` / `Internal error` ——
   * 而界面上只有一句"生成不出回答"，看不出是被哪一步撑死的。
   *
   * 记原始长度就是为了把这句话说出来。只在这一轮失败时才用它。
   */
  maxToolOutputThisTurn?: number;
  /** kiro's native subagents for THIS chat, as last reported by `_kiro.dev/subagent/list_update`.
   *  Kept so the left rail can carry a tag for as long as one is still running. */
  subagents?: SubagentRow[];
  /* No memory-injection bookkeeping here on purpose: the block goes out on EVERY
     turn, so there is no "has it been sent yet / has it changed" decision to carry.
     Three fields used to exist for that decision and were the reason a standing rule
     was stated once and never repeated. The durable record of what was sent lives in
     record.json (`lastMemoryInjection`) and in the [memory] log line. */
  /** Set when a session is (re)attached onto a FRESH kiro-cli backend (resume
   *  failed, migrated session, or expired cli session). On the FIRST prompt,
   *  KiroLex rebuilds the full prior context from its OWN durable transcript and
   *  injects it, so the chat remembers its context regardless of whether kiro-cli
   *  still has its native session. Cleared after the first injection. */
  needsHistoryPrime?: boolean;
  /** True while a background history-priming turn is in flight. Its streamed
   *  output is fully suppressed (not shown, not persisted) — see wireSession. */
  priming?: boolean;
  /** LRU bookkeeping: last time this executor was created/attached/prompted.
   *  Used to pick an eviction victim when the attached-executor cap is hit. */
  lastUsedAt: number;
  /** true only while an interrupt-and-merge cancellation is settling. Chunks
   *  emitted after cancellation (for example the standard interruption notice)
   *  are control output and must not enter chat history. */
  suppressCancellationChunks?: boolean;
  /** true while a prompt turn is in flight — a busy executor is never evicted. */
  busy?: boolean;
  /** monotonic turn tag: only the invocation that set `busy` may clear it. */
  turnSeq?: number;
  /** ms timestamp of the last inbound stream activity (stall watchdog). */
  lastStreamAt?: number;
  /** Set ONLY when KiroLex's own timeout interrupted the turn. flushAssistant
   *  appends it to that turn's message, so the reason lands in the conversation
   *  permanently instead of living in a floating banner that outlives the turn
   *  it describes. Never set for a user-pressed Stop. */
  wedgeNote?: string;
  /** In-flight history rebuild, so a user prompt WAITS for it instead of being
   *  sent into an empty backend. Shared by the eager (post-attach) path and the
   *  lazy (pre-prompt) path so the rebuild happens exactly once. */
  primePromise?: Promise<{ ok: boolean; error?: string }>;
  /** Rebuild attempts so far. Informational only: there is NO attempt limit --
   *  the rebuild retries until it completes, the user presses Stop, or the user
   *  clears the history. Truncating the replay was rejected as a design: a
   *  partial history is indistinguishable from a complete one to the model. */
  primeAttempts?: number;
  /** Chunks already ACCEPTED by this backend. A retry resumes from here rather
   *  than re-sending accepted chunks, which would duplicate the history and push
   *  the conversation further past the limit it just failed at. Reset to 0 when
   *  the executor is replaced -- a new kiro-cli process starts empty. */
  primeCursor?: number;
  /** Chunk snapshot for the current rebuild so retries replay identical content
   *  (and the cursor keeps meaning the same thing). */
  primeChunks?: string[];
  /** Last rebuild error, shown in the status line while it keeps retrying. */
  primeLastError?: string;
  /** Human-readable rebuild progress ("重建历史上下文 2/5"), surfaced to the
   *  renderer with the busy event so a long rebuild is visible, not a freeze. */
  primeDetail?: string;
  /** User explicitly gave up on the rebuild (Stop). The session is RELEASED so it
   *  can be used again, accepting that the backend lacks history. A lock the user
   *  cannot escape is a worse failure than a context-less answer they chose. */
  primeAbandoned?: boolean;
  /** A ride-along context snapshot was marked as established but the request
   *  carrying it has NOT been accepted yet.
   *
   *  The marker is written before the send (so a crash mid-turn does not re-inject
   *  a history the backend already has), which means EVERY failure path afterwards
   *  has to take it back -- otherwise the next message sees "context established"
   *  for a snapshot that never reached the backend and gets answered from nothing,
   *  which is the exact failure this whole mechanism exists to prevent. Only the
   *  streaming catch used to undo it, leaving the busy rejection (thrown before
   *  that try block) able to strand the marker. */
  rideAlongUnconfirmed?: boolean;
  /** Message id of the user message of the turn currently in flight.
   *
   *  Mid-turn steers are not sent through acp:prompt, so they have no message of
   *  their own on disk; this is the id they merge into once the backend reports
   *  them CONSUMED (see acp:persist-steer). */
  currentUserMessageId?: string;
}
const sessionClients: Map<string, SessionEntry> = new Map();
// Serializes model/Agent replacement per session. Renderer locks are UX only;
// this guard is authoritative against racing IPC calls and background queues.
const reconfiguringSessions = new Set<string>();
/** requestId -> when the permission prompt was raised, so the answer can record how
 *  long the turn was blocked. Lives here (not on the entry) because a permission may
 *  be answered after a model swap replaced the executor. */
const permissionWaitStartedAt = new Map<string, number>();
/** Sessions with an attach (acp:load-session) in flight. kiro-cli owns a session
 *  from ONE process only, so an attach and a model/Agent switch racing on the
 *  same session both try to session/load it and the loser gets a bare
 *  -32603 "Internal error". These two sets make the operations mutually
 *  exclusive instead of letting them collide. */
const attachingSessions = new Set<string>();
/** In-flight attach promise per session, so concurrent acp:load-session calls for
 *  the SAME session share one executor instead of racing kiro-cli's
 *  single-process session ownership. */
const attachInFlight = new Map<string, Promise<any>>();
/** Wait (bounded) for an in-flight attach on this session to finish. */
async function awaitAttachIdle(sessionId: string, timeoutMs = 12000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (attachingSessions.has(sessionId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (attachingSessions.has(sessionId)) {
    throw new Error('会话正在重新连接，请稍候再切换模型/Agent。');
  }
}
/** Wait (bounded) for a model/Agent/permission switch on this session to finish.
 *
 *  The MIRROR of `awaitAttachIdle`, and it was missing: a switch waited politely
 *  for an attach, but an attach REJECTED outright while a switch was running
 *  ("会话正在切换模型/Agent，稍后会自动重连。"). That asymmetry is what surfaced as a
 *  raw `Error invoking remote method 'acp:load-session'` — and because a send
 *  attaches on demand, the rejection reached the user's message rather than any
 *  background task.
 *
 *  Waiting is not just cosmetic: a switch ENDS with the session attached again
 *  (`sessionClients` holds the new executor), so by the time this resolves the
 *  attach usually has nothing left to do and returns immediately. Rejecting threw
 *  away a request that was about to become trivially satisfiable.
 *
 *  Bounded, and the timeout still throws: a switch that never finishes must not
 *  turn every later attach into an unbounded hang. 30s covers a cold kiro-cli
 *  start plus a `session/load`, both of which a switch performs. */
async function awaitReconfigureIdle(sessionId: string, timeoutMs = 30000): Promise<void> {
  if (!reconfiguringSessions.has(sessionId)) return;
  const deadline = Date.now() + timeoutMs;
  logger.info('session', `attach waiting for model/Agent switch sessionId=${sessionId}`);
  while (reconfiguringSessions.has(sessionId) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (reconfiguringSessions.has(sessionId)) {
    throw new Error('会话切换模型/Agent 超过 30 秒仍未完成，暂时无法连接。');
  }
  logger.info('session', `attach resuming after model/Agent switch sessionId=${sessionId}`);
}
/** Start an executor for `profile`, falling back through MODEL_FALLBACK_ORDER
 *  when the requested model cannot start (unavailable / retired / throttled).
 *  Returns the live client plus the model that actually worked, so the caller can
 *  persist the effective model instead of a dead one. */
/**
 * 这个后端**证实过跑不了**的模型 —— 每次运行重新发现一次。
 *
 * ## 为什么必须记
 *
 * 关键在下面那段注释说的事实：kiro-cli **只在真跑一轮时**才报模型退役，`connect()` 一定成功。
 * 于是 `preferredModel` 排在候选第一位时，每条会话都会：连上死模型 → 第一轮报错 →
 * `swapSessionModel` 杀掉执行器、换模型、重载会话、重发 —— 实测这个窗口 **30 秒**，而且
 * 期间界面上一点动静都没有（那正是「第二个分屏的会话卡住了」看到的东西）。
 *
 * 不记的话每条会话各付一次。实测一次运行里就发生了两遍（两条不同会话，间隔 65 秒），
 * 而 `claude-opus-5` 压根不在这个 kiro-cli 的清单里（它只有 gpt-5.6-* / deepseek / minimax /
 * glm / qwen）。
 *
 * ## 为什么是**进程级**而不是落盘
 *
 * 模型清单会变（升级 kiro-cli、后端上线新模型）。落盘会把一次探测的结论永久钉住，
 * 而重启一次重新探测的代价只是一次 30 秒 —— 那个代价换来的是「装了新版本就自动恢复」。
 */
const modelsKnownDead = new Set<string>();

async function connectWithModelFallback(
  profile: AgentProfile,
  label: string,
): Promise<{ client: AcpClient; model: string }> {
  const all: string[] = [profile.preferredModel, profile.model, ...MODEL_FALLBACK_ORDER]
    .filter((m): m is string => !!m)
    .filter((m, i, arr) => arr.indexOf(m) === i);
  /*
    已知跑不了的排到**最后**而不是删掉：万一它们是唯一剩下的（清单探测错了、或者别的模型
    也都挂了），还得能试。删掉的话一次误判会让整个会话连不上，那比多等 30 秒糟得多。
  */
  const dead = all.filter((m) => modelsKnownDead.has(m));
  const candidates = dead.length ? [...all.filter((m) => !modelsKnownDead.has(m)), ...dead] : all;
  if (dead.length) {
    logger.info('model', `${label}: 跳过本次运行里已证实跑不了的模型（${dead.join(', ')}）—— 它们排到最后`);
  }
  let lastError: any = null;
  for (const model of candidates) {
    const client = new AcpClient(model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote);
    try {
      await client.connect();
      if (model !== profile.model) {
        // NB: `model` is simply the first candidate that started — with a
        // preferredModel it may WIN AHEAD of profile.model, which was then never
        // attempted. Don't claim profile.model was unavailable.
        logger.warn('model', `${label}: started on '${model}' (record model '${profile.model}', preferred '${profile.preferredModel || '-'}')`);
      }
      return { client, model };
    } catch (err: any) {
      lastError = err;
      logger.warn('model', `${label}: model '${model}' failed to start: ${err?.message || err}`);
      try { await client.disconnect(); } catch {}
    }
  }
  throw lastError || new Error('No usable model: every candidate failed to start.');
}

/** kiro-cli reports a retired/unavailable model only when the turn actually runs:
 *  the executor starts fine, then the response stream errors with
 *  "The model 'X' is not available. Please use '/model' ...". So model health
 *  CANNOT be established at connect time alone -- this matcher is what lets the
 *  prompt path fall back instead of dead-ending on every send. */
/* 传输层瞬时错误的判据在 `transientError.ts`（纯的、要给 `promptRetry` 复用）。 */
export const isTransientTransportError = isTransientTransportErrorImpl;

function isModelUnavailableError(text: string): boolean {
  return /model\s+'[^']+'\s+is not available/i.test(text) || /use\s+'\/model'\s+to select a different model/i.test(text);
}

/** Tell the renderer which model a session is REALLY running. Without this the
 *  composer selector shows whatever was last requested/persisted locally while
 *  the executor runs something else entirely (observed: selector said
 *  'gpt-5.6-sol' while every prompt failed on 'claude-opus-5'). */
function emitSessionModel(sessionId: string, model: string) {
  mainWindow?.webContents.send('acp:session-model', { sessionId, model });
}

/** Replace a live session's executor with one running `model`, keeping the same
 *  kiro-cli session id (so history/context is preserved), then persist + announce
 *  the effective model. Returns false if no candidate could take over, in which
 *  case the caller must surface the original failure. */
async function swapSessionModel(sessionId: string, failedModel: string, label: string, exclude?: Set<string>): Promise<string | null> {
  const entry = sessionClients.get(sessionId);
  if (!entry) return null;
  const candidates = MODEL_FALLBACK_ORDER.filter((m) => m && m !== failedModel && !exclude?.has(m));
  const cliSessionId = entry.cliSessionId;
  const cwd = entry.cwd;
  /*
    换执行器期间**必须报 busy**。

    这一段会杀掉执行器、连一个新的、重载会话、再重发 —— 实测 30 秒。而它一进来就
    `sessionClients.delete`，于是 `busyReason` 查不到 entry、返回 null：**一轮正在飞的对话
    在界面上显示为空闲**，没有活动指示、没有任何解释。那就是「第二个分屏的会话卡住了」
    看到的东西 —— 后端在干活（实测那一轮 47 个事件、4 分 24 秒后正常完成），界面一动不动。

    用已有的 `reconfiguringSessions`：`busyReason` 第一条就查它并返回 `'reconfiguring'`，
    界面本来就认得这个状态（用户手动换模型走的是同一条）。`finally` 里清，否则一次失败的
    换模型会把这条会话永久钉在「切换中」——`awaitReconfigureIdle` 会等 30 秒然后抛错。
  */
  reconfiguringSessions.add(sessionId);
  sessionClients.delete(sessionId);               // release single-process ownership
  try { await entry.client.disconnect(); } catch {}
  try {
  for (const model of candidates) {
    /*
      **偏好一并丢掉。**

      `MODEL_FALLBACK_ORDER` 上面那段写着「自动降级绝不覆盖 `preferredModel`，下次 attach 再试
      一遍真正被选中的那个」。那条规则对**连接失败**是对的（限流、一时抖动，下次也许就好了），
      但这里的失败不是那种：走到 `swapSessionModel` 的路径是 `isModelUnavailableError` ——
      kiro-cli 明说「这个模型不可用，请用 /model 换一个」。那是**确定性事实**，不是抖动。

      留着偏好的代价是实测过的：偏好在下次 attach 抢先连上（连接对死模型永远成功）→ 第一轮
      再报退役 → 再换一次 → 每次重启都付一遍那 30 秒的静默窗口。

      丢掉而不是改成 `model`：把一个自动选中的模型写成「你偏好的」正是上面那条规则要防的事。
      丢掉的意思是「你那个偏好在这个后端满足不了，先按记录里能跑的来」——想要回去，在 composer
      里重新选一次就会重新写上（手动切换同时更新 `model` 和 `preferredModel`）。
    */
    const profile: AgentProfile = { ...entry.profile, model, preferredModel: undefined };
    const client = new AcpClient(model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote);
    try {
      await client.connect();
      await withLoadTimeout(client.loadSession(cliSessionId, cwd));
      const next: SessionEntry = {
        ...entry, client, profile, lastUsedAt: Date.now(),
        assistantBuf: '', assistantMsgId: null, fileChanges: [],
      };
      sessionClients.set(sessionId, next);
      wireSession(sessionId, next);
      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      logger.warn('model', `${label}: '${failedModel}' unavailable at prompt time -> switched to '${model}'`
        + `${entry.profile.preferredModel === failedModel ? `（并清掉偏好 '${failedModel}' —— 轮次里报出的退役是确定性事实，留着它每次重启都要再付一次那 30 秒）` : ''}`);
      /*
        换成功了 = `failedModel` 在这个后端确实跑不了，记下来。不记的话下一条会话再付一次
        30 秒（实测一次运行里发生了两遍）。只在**换成功**时记：连接失败可能是限流或一时抖动，
        那种不该被当成「这个模型死了」。
      */
      modelsKnownDead.add(failedModel);
      emitSessionModel(sessionId, model);
      return model;
    } catch (err: any) {
      logger.warn('model', `${label}: fallback '${model}' failed to take over: ${err?.message || err}`);
      try { await client.disconnect(); } catch {}
    }
  }
  return null;
  } finally {
    reconfiguringSessions.delete(sessionId);
  }
}

/** Agent used for KiroLex's own background TEXT chores (chat titles, prompt
 *  suggestions). It has no tools, no MCP servers and no hooks, because the
 *  DEFAULT agent cold-loads 9 MCP servers on every one-shot spawn: measured 26.1s
 *  / 0.15 credits / ~190% CPU across 6 processes just to write three lines, and
 *  it repeated that per turn. With this agent the same call is 7.3s / 0.01
 *  credits and starts no MCP process at all. Lives in ~/.kiro/agents/. */
const LITE_AGENT = 'kirolex-lite';

/** Run a short text-only one-shot through the lite agent, trying the configured
 *  helper model first and the configured fallback second. Both live in Settings.
 *  If the lite agent itself is absent (it lives in the user's ~/.kiro, not in this
 *  repo) the call still goes through on the default agent — degraded, never broken.
 *
 *  Uses `resolveKiroCli()` rather than the bare name for the same reason as
 *  runKiroCli: on Windows, and on any install reachable only through KIRO_CLI_PATH,
 *  `kiro-cli` is not on PATH, and this call is what produces prompt suggestions and
 *  smart chat titles — both would have failed silently.
 *
 *  @param prompt The full one-shot prompt; passed as a single argv entry, so no
 *    shell is involved and no quoting is needed.
 *  @param label Log tag, e.g. 'suggestions' or 'title'.
 *  @returns The model's stdout, trimmed by the caller. Throws only if EVERY
 *    model/agent combination failed; the last error is rethrown. */
async function runLiteOneShot(prompt: string, label: string): Promise<string> {
  // Local requires: this predates the module-level imports and is left as-is because
  // execFile/promisify are needed nowhere else in this file's argv-array form.
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const run = promisify(execFile);
  const opts = { env: shellEnv, timeout: 60000, maxBuffer: 1024 * 1024 };
  const { model, fallback } = loadHelperModels();
  const models = [model, fallback].filter((m, i, arr) => !!m && arr.indexOf(m) === i);
  let lastError: any = null;
  for (const m of models) {
    for (const withAgent of [true, false]) {
      const args = withAgent
        ? ['chat', '--no-interactive', '--agent', LITE_AGENT, '--model', m, prompt]
        : ['chat', '--no-interactive', '--model', m, prompt];
      try {
        const { stdout } = await run(resolveKiroCli() || 'kiro-cli', args, opts);
        if (m !== models[0]) {
          logger.warn(label, `helper model '${models[0]}' unusable -> answered with fallback '${m}'`);
        }
        return String(stdout);
      } catch (err: any) {
        lastError = err;
        const text = `${err?.message || ''} ${err?.stderr || ''}`;
        // Missing lite agent is the ONLY reason to retry the same model without
        // --agent; anything else means try the next model instead.
        const agentMissing = /agent/i.test(text) && /(not found|unknown|does not exist|no such)/i.test(text);
        if (withAgent && agentMissing) {
          logger.warn(label, `lite agent '${LITE_AGENT}' unavailable, retrying on the default agent (slower, pricier)`);
          continue;
        }
        logger.warn(label, `model '${m}' failed: ${err?.killed ? 'timeout/killed' : (err?.message || err)}`);
        break; // next model
      }
    }
  }
  throw lastError || new Error('No helper model could answer.');
}

/**
 * 会话记忆的自动维护 —— 「你在 memory 里加一个 session memory」。
 *
 * 三层记忆(全局 ⊕ project ⊕ 这个会话)早就在了,每一轮都注入;缺的是**没人写这一层** —— 它是个手填的
 * 文本框,而没人会在聊天中途停下来写笔记。所以每一轮结束后判断一次:攒够 CONSOLIDATE_EVERY 条新消息,
 * 就用和生成标题同一条便宜的一次性调用(`runLiteOneShot`)把最近这段压成几行事实,合并进那个文件。
 *
 * 失败一律静默:它是背景工作,不该为一次压缩失败弹任何东西 —— 但必须记日志,否则「记忆怎么没更新」
 * 就成了不可查的问题。
 */
const memoryConsolidating = new Set<string>();

async function maybeConsolidateSessionMemory(sessionId: string): Promise<void> {
  if (!isFeatureEnabled('sessionMemory')) return;
  try {
    const messages = store.readTranscript(sessionId) || [];
    const record = store.readRecord(sessionId);
    if (!record) return;
    if (!shouldConsolidate({
      messages: messages.length,
      consolidatedAt: (record as any).memoryConsolidatedAt || 0,
      inFlight: memoryConsolidating.has(sessionId),
    })) return;
    memoryConsolidating.add(sessionId);
    const projectId = (record.profile as any)?.projectId || undefined;
    const existing = readMemory(projectId, sessionId).session || '';
    /* 只喂最近这一段:更早的已经被上一次压缩吸收进 existing 了,再喂一遍是重复付钱 */
    const recent = messages
      .slice(-CONSOLIDATE_EVERY * 2)
      .map((m: any) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${String(m.content || '').slice(0, 800)}`)
      .join('\n\n');
    if (!recent.trim()) return;
    const produced = cleanLiteOutput(await runLiteOneShot(buildConsolidationPrompt(recent, existing), 'session-memory'));
    const merged = mergeSessionMemory(existing, produced);
    if (merged && merged !== existing) {
      writeMemory('session', projectId, sessionId, merged);
      logger.info('memory', `session ${sessionId}: consolidated at ${messages.length} messages (${merged.length} chars)`);
    }
    store.writeRecord({ ...record, memoryConsolidatedAt: messages.length } as any);
  } catch (err: any) {
    logger.warn('memory', `session ${sessionId}: consolidation failed (${err?.message || err})`);
  } finally {
    memoryConsolidating.delete(sessionId);
  }
}


/** Cap on the tool OUTPUT kept per tool call in the transcript.
 *
 *  Output was never persisted at all (StoredToolCall.content existed but no writer
 *  ever filled it), so a restart lost every command's stdout and every read result.
 *  Storing it in full is not an option either: one measured chat holds 324 tool calls
 *  in a 636KB transcript, and unbounded output could multiply that several times over.
 *
 *  HEAD AND TAIL are both kept, not a prefix: the head says what ran, while a failure
 *  message is almost always at the END — a head-only clamp would reliably discard the
 *  one part worth reading. */
const TOOL_OUTPUT_HEAD = 600;
const TOOL_OUTPUT_TAIL = 500;
function clampToolOutput(text: string): string {
  const total = text.length;
  if (total <= TOOL_OUTPUT_HEAD + TOOL_OUTPUT_TAIL) return text;
  const dropped = total - TOOL_OUTPUT_HEAD - TOOL_OUTPUT_TAIL;
  const marker = `\n…[省略 ${dropped} 字符]…\n`;
  // Clamping must never make the payload BIGGER. Just past the threshold the marker
  // costs more than the handful of characters it removes.
  if (marker.length >= dropped) return text;
  return text.slice(0, TOOL_OUTPUT_HEAD) + marker + text.slice(-TOOL_OUTPUT_TAIL);
}

/**
 * **"这一轮里最大的一次工具输出"那句提示** ——「好像 curl 那个大 json 的时候断掉了」。
 *
 * 实测那条会话：一轮里 109 个工具调用、里面有整段 `aws ec2 describe-*` 的 JSON，最后后端回
 * `EmptyResponse`（模型自己在日志里读到的原话），而界面上只有一句"生成不出回答"。
 * 发给模型的那一份输出是 kiro-cli 攥着的、没裁过，所以这个数字是唯一能指向原因的东西。
 *
 * 阈值 20000 字符：低于这个量的输出不值得提，提了只会变成每条错误后面的一句废话。
 */
function bigOutputHint(maxChars?: number): string {
  const n = Number(maxChars) || 0;
  if (n < 20000) return '';
  return `（其中最大的一次输出 ${Math.round(n / 1000)}K 字符 —— 后端很可能是在这上面答不出来的，`
    + '下次给那条命令加上 `--query` / `| head` 把输出截小）';
}

/** Text an ACP tool call reported
 *  The renderer's live path reads only block [0]; joining every block means a
 *  reopened chat cannot show less than the live one did. */
function extractToolOutput(blocks: unknown): string {
  return (Array.isArray(blocks) ? blocks : [])
    .map((block: any) => (typeof block?.content?.text === 'string' ? block.content.text : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

/** Strip kiro-cli's DECORATION from a one-shot answer so the text can be used as
 *  data. It emits ANSI colour plus a '> ' prompt marker ahead of the reply — the
 *  captured bytes for a title request are literally
 *  `\x1b[38;5;141m> \x1b[0m检查项目 Windows 兼容性`.
 *
 *  Central on purpose. This knowledge previously lived only as a comment inside the
 *  suggestions handler, so the title handler stripped the colour but not the marker
 *  and every generated chat title arrived as "> Foo". One place, so a third caller
 *  cannot inherit the same bug. */
function cleanLiteOutput(stdout: string): string {
  return String(stdout)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/^\s*(?:>\s*)+/, '')
    .trim();
}

/** Why a session's backend is currently occupied (null = free). The renderer
 *  renders this so an occupied session is VISIBLE up front instead of only
 *  surfacing as a "still in progress" / "Internal error" banner afterwards. */
type BusyReason = 'turn' | 'reconfiguring' | 'attaching' | 'priming' | 'prime-pending' | null;
function busyReasonFor(sessionId: string): BusyReason {
  if (reconfiguringSessions.has(sessionId)) return 'reconfiguring';
  if (attachingSessions.has(sessionId)) return 'attaching';
  const entry = sessionClients.get(sessionId);
  if (entry?.priming) return 'priming';
  if (entry?.busy) return 'turn';
  // Context owed. This OCCUPIES the session on purpose: a chat whose backend has
  // no history must not accept a new message that would be answered from nothing.
  // New messages queue behind the rebuild instead.
  if (entry?.needsHistoryPrime) {
    // …unless the user abandoned it. That is the ONLY release: there is no
    // attempt limit any more, so a rebuild keeps the session occupied until it
    // finishes, the user presses Stop, or the user clears the history.
    if (entry.primeAbandoned) return null;
    return 'prime-pending';
  }
  return null;
}
function emitSessionBusy(sessionId: string) {
  const reason = busyReasonFor(sessionId);
  const detail = reason === 'priming' ? sessionClients.get(sessionId)?.primeDetail : undefined;
  mainWindow?.webContents.send('acp:session-busy', { sessionId, reason, detail });
  /*
    只要还在报 prime-pending,就确保有一次重建排着 —— 「这次还是没有重试」。

    上一版只在**刚被标记**的那一刻排一次:一个在这段代码存在之前就已经被标成 prime-pending 的会话
    (或者那次排空因为执行器不在而被跳过的),就永远等不到第二次。这里是每次上报状态都过一遍,而
    `schedulePrime` 本身是幂等的(已在队列或在跑就直接返回),所以不会堆叠。
  */
  if (reason === 'prime-pending') schedulePrime(sessionId);
}

/**
 * 欠着的重建要有人去跑 —— 「我的两个会话重启之后为什么检测到会话正忙就不再恢复了」。
 *
 * `prime-pending` 是**占用**状态,而且故意没有次数上限:它只在重建完成、你按 Stop、或者你清掉历史时释放。
 * 可重启之后没有任何东西去**启动**那次重建 —— 主进程只在执行器被换掉(切模型/切 agent)时自动踢一次,
 * 渲染端的兜底只踢你正打开的那一个。于是后台那几条会话就一直「忙」着,而根本没有活在跑:看着就是
 * 「检测到正忙,然后再也不恢复」。
 *
 * 所以「欠着」这件事本身就去排一次重建。两个限制是必须的,理由都写在原注释里:
 *   并发 2   启动时十几条会话同时 attach,一起打到模型上会把每一条都拖慢(原来靠渲染端只踢一条来避免)
 *   间隔     排空之间留一点空隙,让真正的用户操作插得进去
 */
const MAX_CONCURRENT_PRIMES = 2;
const primeWaiting: string[] = [];
const primeInFlight = new Set<string>();

function drainPrimeQueue(): void {
  while (primeInFlight.size < MAX_CONCURRENT_PRIMES) {
    const sessionId = primeWaiting.shift();
    if (!sessionId) return;
    const entry = sessionClients.get(sessionId);
    // 排队期间情况可能已经变了：执行器没了、你放弃了、或者别人已经重建完了
    if (!entry || entry.primeAbandoned || entry.priming || !entry.needsHistoryPrime) continue;
    primeInFlight.add(sessionId);
    logger.info('prime', `auto-start sessionId=${sessionId} (owed rebuild, ${primeWaiting.length} still waiting)`);
    void primeHistoryNow(sessionId)
      .catch((err: any) => logger.warn('prime', `auto-start failed sessionId=${sessionId}: ${err?.message || err}`))
      .finally(() => {
        primeInFlight.delete(sessionId);
        setTimeout(drainPrimeQueue, 400);
      });
  }
}

function schedulePrime(sessionId: string): void {
  if (primeInFlight.has(sessionId) || primeWaiting.includes(sessionId)) return;
  primeWaiting.push(sessionId);
  setTimeout(drainPrimeQueue, 300);
}


/** Render one transcript message for history priming. Attachments are carried
 *  as `file:<path>` refs so a fresh backend can RE-READ an image/file the user
 *  sent earlier -- without this the transcript only has the visible text and an
 *  earlier image is forgotten completely.
 *
 *  Tool calls are summarised too, and that is load-bearing: everything the
 *  assistant actually DID (files created, edited, read, commands run) lives in
 *  `toolCalls`, never in `content`. A rebuild from `content` alone therefore
 *  produced a model that could not name a single document it had written -- some
 *  turns are literally 0 chars of text with 4 tool calls. Only title/kind/paths
 *  are carried, never `diffs`: the diffs hold whole file bodies (403KB of the
 *  810KB transcript in one real chat) and the file itself is the source of truth,
 *  so pointing at the path is both smaller and more accurate.
 */
const HISTORY_TOOLS_PER_MESSAGE = 12;
/** Tool kinds that RUN something rather than touch a file.
 *
 *  Deliberately a set of candidates, not one guessed string: across every recorded
 *  session (327 tool calls) the only kinds ever persisted were `edit` and `read`, so
 *  the exact spelling kiro-cli uses for a shell command has never been observed here.
 *  ACP's vocabulary says `execute`; the aliases cost nothing and avoid silently
 *  dropping commands again if it differs. `unobservedToolKinds` below logs whatever
 *  actually arrives, so this can be narrowed on evidence instead of guesswork. */
const RUN_KINDS = new Set(['execute', 'run', 'bash', 'shell', 'command', 'terminal']);
/** Tool-call kinds seen with neither locations nor diffs, logged once each. This is
 *  the missing evidence: it tells us what kiro-cli really calls a command. */
const unobservedToolKinds = new Set<string>();
/**
 * **哪些消息能发给模型** ——「这他妈什么玩意，为什么按照会话发出去了」。
 *
 * 两类要挡住：
 *   · 思考流水（`💭 `）—— 它是过程，不是内容；
 *   · **KiroLex 自己说的话**（`kirolex: true`）：「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」
 *     「♻️ 已经换成新的后端会话」「⏳ 已排队」。它们是对**你**说的，原来以 `role: 'user'` 落进
 *     transcript，而快照和 history.md 都是从 transcript 建的 —— 于是模型下一轮真的读到
 *     "我现在跑在 gpt-5.6-sol 上"，还当成你的指令。
 *
 * 三条发给模型的路径（history.md、ride-along 快照、逐段重建）共用这一个判据 ——
 * 分开写必然漏掉一条，而漏掉的那条就是模型看到它的那条。
 */
function modelFacing(m: { role: string; content: string; kirolex?: true }): boolean {
  if (m.kirolex) return false;
  if (legacyKirolexNote(m)) return false;
  return !(m.role === 'assistant' && String(m.content || '').startsWith('💭 '));
}

/**
 * **`kirolex` 标记之前写下的那些**，按开头认出来 —— 光加标记只管未来，而历史里已经躺着一堆：
 * 实测一条会话里 4 条（三次「♻️ 后端连着…」加一句被当成回复存下来的 `⚠️ Error invoking…`），
 * 它们每一轮都跟着快照发给模型。
 *
 * 判据故意窄：**这几句固定开头**，不是"以 emoji 开头就算"。后者会把你自己写的
 * 「⚠️ 这个接口别动」也吃掉，而那是真的对话内容 —— 宁可漏掉一条旧噪音，不能吃掉你说的话。
 */
const LEGACY_NOTE_OPENINGS = [
  '♻️ 后端连着',
  '♻️ 这条会话的后端会话 id',
  '⚠️ 这条会话现在跑在',
  '⏳ 已排队：',
  '🔀 后端连着',
  "⚠️ Error invoking remote method 'acp:",
];
function legacyKirolexNote(m: { content: string }): boolean {
  const t = String(m.content || '').trim();
  return LEGACY_NOTE_OPENINGS.some((head) => t.startsWith(head));
}

function historyLine(m: {
  role: string;
  content: string;
  attachments?: { name: string; path: string }[];
  toolCalls?: { title?: string; kind?: string; status?: string; locations?: string[] }[];
}): string {
  const who = m.role === 'user' ? 'User' : 'Assistant';
  // Every historical attachment is re-emitted here on EVERY turn, so an oversized
  // image referenced once keeps failing every later request in the chat. Resolve
  // each one to a copy within the backend's dimension limit -- see safeImageRef.
  const refs = (m.attachments || []).filter((a) => a?.path).map((a) => `file:${safeImageRef(a.path)}`);
  const tail = refs.length
    ? `\n[本条消息附带的文件/图片，需要时可直接读取]\n${refs.join('\n')}`
    : '';
  const tools = m.toolCalls || [];
  let actions = '';
  if (tools.length) {
    const seen = new Set<string>();
    const rows: string[] = [];
    for (const t of tools) {
      const paths = (t.locations || []).filter(Boolean);
      const key = `${t.kind || ''}|${t.title || ''}|${paths.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const failed = t.status === 'failed' ? '（失败）' : '';
      rows.push(`- [${t.kind || 'tool'}]${failed} ${t.title || ''}${paths.length ? `\n  ${paths.join('\n  ')}` : ''}`);
      if (rows.length >= HISTORY_TOOLS_PER_MESSAGE) break;
    }
    const more = tools.length > rows.length ? `\n- …另有 ${tools.length - rows.length} 项操作` : '';
    actions = `\n[本轮实际执行的操作与涉及的文件，内容以磁盘上的文件为准，需要时直接读取]\n${rows.join('\n')}${more}`;
  }
  // Cap EVERY image path in the finished line, not just the attachment refs above.
  // The tool rows carry original paths ("[read] Reading image /…/paste_x.png") and
  // the model happily re-reads them, so an oversized original kept coming back on
  // every turn even though the attachment refs were already capped. Prose paths get
  // the same treatment for the same reason. See capImagePathsInText.
  return capImagePathsInText(`${who}: ${m.content}${actions}${tail}`);
}

/** One rebuild prompt carries at most this many characters. A whole 100k+ char
 *  transcript sent as a SINGLE prompt is what used to fail (or instantly blow the
 *  context window and get compacted away), which silently left the chat with no
 *  memory of its own history. Chunking makes a large rebuild converge. */
const PRIME_CHUNK_CHARS = 24000;
/** NO cap on how much history is replayed, and NO attempt limit. Truncating the
 *  replay was rejected as a design: a silently shortened history is
 *  indistinguishable from a complete one on the model's side, which is exactly
 *  the failure this machinery exists to prevent. The rebuild instead retries with
 *  backoff until every chunk lands. The escape hatches are both explicit and
 *  user-initiated: Stop (abandon this rebuild) or clear the history. */
const PRIME_RETRY_BASE_MS = 5000;
const PRIME_RETRY_MAX_MS = 60000;
/** After this many consecutive failures on the SAME chunk, halve it and retry.
 *  Helps when the backend rejects a single oversized request; harmless when it
 *  does not. */
const PRIME_SPLIT_AFTER = 2;
/** Floor for that halving, so a hard failure cannot devolve into thousands of
 *  microscopic prompts. */
const PRIME_MIN_CHUNK_CHARS = 2000;
/** How much of the tail of the conversation a snapshot rebuild carries verbatim.
 *  Everything older is reachable through the rendered history file. */
const SNAPSHOT_RECENT_CHARS = 18000;
/** Model swaps allowed per rebuild cycle. Observed without a cap: 'sonnet-4.6'
 *  and 'sonnet-5' each reported unavailable and the loop ping-ponged between them
 *  16 times over 12 minutes, replacing the executor (and resetting the chunk
 *  cursor) every single time -- then chunk 1 succeeded on the model it had
 *  already rejected 8 times. The unavailability is transient, so after this many
 *  swaps the right move is to wait and retry, not to keep switching. */
const PRIME_MAX_MODEL_SWAPS = 2;
/** Models already tried in the current rebuild cycle, so a swap never returns to
 *  one that just failed. Cleared when the rebuild finishes or is called off. */
const primeModelsTried = new Map<string, Set<string>>();

function contextEstablished(sessionId: string, entry: SessionEntry): boolean {
  try {
    const rec = store.readRecord(sessionId);
    return !!rec
      && rec.contextEstablishedFor === entry.cliSessionId
      && rec.contextEstablishedPid === entry.client.pid;
  } catch { return false; }
}

/** Flag a chat whose backend cannot be shown to hold its history, so the session
 *  reports busy and queues instead of answering from nothing. Returns true when a
 *  rebuild is owed. Called from BOTH the send gate and session activation: doing
 *  it only on send meant the chat sat there looking idle after a restart and the
 *  rebuild began only once the user had already typed something. */
function markContextOwedIfUnverified(sessionId: string, trigger: string): boolean {
  const entry = sessionClients.get(sessionId);
  if (!entry) return false;
  if (entry.priming || entry.needsHistoryPrime) return true;
  if (entry.primeAbandoned) return false;                       // user opted out
  /**
   * flow 自己的那两种会话不欠重建 —— 「修改 flow 这个会话为什么会需要重建上下文，太荒谬了」。
   *
   * 荒谬在于**重放它的历史毫无意义**:
   *   `skill`(画布/注册那条)  它的全部内容就是一份生成提示词加一份 JSON 结构;而结构的权威副本在注册表里,
   *                           画布也是从那儿渲染的。后端换了执行器,正确的做法是把结构提示词**再发一次**,
   *                           不是把几万字的 JSON 一轮一轮重放 —— 那不但贵,还会把上下文塞满。
   *   `flow-worker`           一步的输入由 run 重新拼出来(`assembleStepPrompt`:起跑输入 + 上游材料 + 指令),
   *                           所以重跑一步比重放它的历史更准确,也是驱动本来就在做的事。
   * 而流程主会话(`flow-main`)不在这里:它是你和它商量状态的那条线程,历史有价值,照旧重建。
   */
  try {
    const purpose = store.readRecord(sessionId)?.purpose;
    if (purpose === 'skill' || purpose === 'flow-worker') {
      logger.info('prime', `skip rebuild for ${purpose} sessionId=${sessionId} trigger=${trigger} — 它的内容由结构/run 重新产生，重放没有意义`);
      return false;
    }
  } catch { /* 读不到记录就按普通会话处理 */ }
  if (store.transcriptFileSize(sessionId) <= 0) return false;    // nothing to restore
  if (contextEstablished(sessionId, entry)) return false;
  entry.needsHistoryPrime = true;
  entry.primeCursor = 0;
  entry.primeChunks = undefined;
  let establishedFor: string | undefined;
  let establishedPid: number | undefined;
  try {
    const rec = store.readRecord(sessionId);
    establishedFor = rec?.contextEstablishedFor;
    establishedPid = rec?.contextEstablishedPid;
  } catch {}
  logger.info('prime', `unverified backend sessionId=${sessionId} trigger=${trigger} cli=${entry.cliSessionId} pid=${entry.client.pid} establishedFor=${establishedFor} establishedPid=${establishedPid} -> rebuild owed`);
  emitSessionBusy(sessionId);
  // 欠着就去排一次 —— 占用状态必须伴随真的有活在跑，否则它就是个死锁
  schedulePrime(sessionId);
  return true;
}

/** The executor was just REPLACED (model or Agent switch). Decide how this chat's
 *  context comes back.
 *
 *  Both switches end on a brand new kiro-cli process, so `contextEstablished` --
 *  which pins the pid -- is necessarily false and the new backend really is empty.
 *  What was wrong was the response: both handlers used to mark the rebuild owed and
 *  fire `primeHistoryNow` immediately, which
 *
 *    1. contradicted `acp:ensure-context`, where the SAME conclusion ("this backend
 *       is empty") deliberately does nothing in snapshot mode, and
 *    2. actively FORECLOSED the free path: `!entry.needsHistoryPrime` is one of the
 *       ride-along preconditions, and marking the debt is the first thing
 *       `markContextOwedIfUnverified` does -- so switching model turned a zero-cost
 *       restore into a locked chat plus a dedicated model turn that can fail and
 *       retry (observed: three rebuild attempts in five minutes, all failing on an
 *       unavailable model, the chat unusable throughout).
 *
 *  In snapshot mode the correct action is NOTHING: the marker already fails, so the
 *  next message carries the snapshot in the same request, at no extra cost. The
 *  original justification -- "until the user types, the chat looks connected while
 *  remembering nothing" -- does not apply, because without a turn there is nothing
 *  that could answer from an empty context.
 *
 *  Verbatim ('full') mode still needs a real rebuild: one turn PER CHUNK cannot
 *  ride along on a single message. */
function restoreContextAfterExecutorSwap(sessionId: string, trigger: string): void {
  if (store.readRecord(sessionId)?.primeMode === 'full') {
    if (markContextOwedIfUnverified(sessionId, trigger)) {
      void primeHistoryNow(sessionId).catch(() => {});
    }
    return;
  }
  logger.info('prime', `context RIDES ALONG after ${trigger} sessionId=${sessionId} — no rebuild turn, chat stays usable`);
}

/** ONE prompt that restores what actually matters, instead of replaying the whole
 *  conversation turn by turn on every launch.
 *
 *  This is not the truncation that was rejected earlier. What made truncation
 *  unacceptable was that a shortened history is indistinguishable from a complete
 *  one on the model's side. Here the prompt states plainly that it is a digest,
 *  how many turns are not inlined, and the absolute path of the fully rendered
 *  history -- so the omitted text is retrievable rather than gone, and the model
 *  knows to go get it. */
/** Render this chat's transcript to `history.md` and return its path.
 *
 *  Called from the rebuild AND after every turn. The refresh matters because the
 *  snapshot hands the model this path and tells it to read the file for anything
 *  older than the inlined tail. Written only once at rebuild time, the file froze
 *  at that moment while the conversation moved on -- so hours later the model
 *  would read a file that OMITS everything since, while its own header claimed
 *  "全部 N 条消息，未删减". A stale-but-authoritative-looking history is exactly
 *  the failure mode this machinery exists to prevent. */
function renderHistoryFile(sessionId: string): { path: string; count: number } | null {
  try {
    const stored = store.readTranscript(sessionId)
      .filter(modelFacing);
    const lines = stored.map((m) => historyLine(m));
    if (!lines.join('').trim()) return null;
    const path = store.writeHistoryFile(
      sessionId,
      `# ${sessionId} — 完整对话历史（由 KiroLex 从自身记录渲染）\n`
      + `# 渲染时间 ${new Date().toISOString()}，共 ${lines.length} 条消息\n\n`
      + `${lines.join('\n\n---\n\n')}\n`,
    );
    return { path, count: lines.length };
  } catch (err: any) {
    logger.info('prime', `render history FAILED sessionId=${sessionId} err=${err?.message}`);
    return null;
  }
}

/** Mark this backend as holding this chat's history. Bound to BOTH the cli session
 *  id and the pid, because kiro-cli hands back the same id for a brand new empty
 *  conversation after a restart. */
function markContextEstablished(sessionId: string, entry: SessionEntry): void {
  try {
    const rec = store.readRecord(sessionId);
    if (!rec) return;
    rec.contextEstablishedFor = entry.cliSessionId;
    rec.contextEstablishedPid = entry.client.pid;
    store.writeRecord(rec);
  } catch {}
}

function clearContextEstablished(sessionId: string): void {
  try {
    const rec = store.readRecord(sessionId);
    if (!rec) return;
    delete rec.contextEstablishedFor;
    delete rec.contextEstablishedPid;
    store.writeRecord(rec);
  } catch {}
}

/** The hand-off line the ride-along block must end with, or the model answers the
 *  restored context instead of the message that follows it. */
const RIDE_ALONG_HANDOFF = '\n\n---\n\n以上是恢复的上下文。下面是用户这一条新消息，请正常回答它：';

/** Drop the archive header `writeLastInjection` puts on `last-injection.md`.
 *
 *  The Snapshot tab shows that file verbatim, so a block edited there arrives with the
 *  `# …` preamble and its `=====` rule. Those lines would be harmless to send but they
 *  claim a send time that is no longer true, so they are cut -- and only when the text
 *  before the rule really is all comments, so a conversation that happens to contain a
 *  row of `=` is left alone. */
function stripArchiveHeader(text: string): string {
  const rule = text.match(/^={10,}\s*$/m);
  if (!rule || rule.index === undefined) return text;
  const head = text.slice(0, rule.index);
  const allComments = head.split('\n').filter((l) => l.trim()).every((l) => l.trimStart().startsWith('#'));
  if (!allComments) return text;
  return text.slice(rule.index + rule[0].length).replace(/^\n+/, '');
}

/** The snapshot, worded to ride along with the user's own message rather than to
 *  be a standalone priming turn (so: no "reply OK", and it explicitly hands off to
 *  the real message that follows it). */
function buildHistoryRideAlong(sessionId: string): string {
  try {
    // A HAND-EDITED block wins over the generated one, and is used VERBATIM: what the
    // user sees in the Snapshot tab is what goes out, which is the only predictable
    // rule for something they curated themselves.
    const override = store.readContextOverride(sessionId);
    if (override) {
      let text = stripArchiveHeader(override.text).trimEnd();
      // …with one exception: the hand-off is restored if it was edited away. Without it
      // the model treats the restored history as the thing to reply to, which shows up
      // as "Kiro answered a question I did not ask".
      if (!text.includes('请正常回答它')) {
        text += RIDE_ALONG_HANDOFF;
        logger.info('prime', `context override had no hand-off line sessionId=${sessionId} -> appended`);
      }
      logger.info('prime', `context OVERRIDE (hand-edited) sessionId=${sessionId} chars=${text.length}`);
      return text;
    }
    const stored = store.readTranscript(sessionId)
      .filter(modelFacing);
    const lines = stored.map((m) => historyLine(m));
    if (!lines.join('').trim()) return '';
    return `${buildSnapshot(sessionId, stored, lines, { rideAlong: true })}${RIDE_ALONG_HANDOFF}`;
  } catch (err: any) {
    logger.info('prime', `ride-along build FAILED sessionId=${sessionId} err=${err?.message}`);
    return '';
  }
}

/** Refresh `history.md` at TURN END, immediately.
 *
 *  Measured on the transcripts here: 31ms for the largest (3.0MB read, 2.7MB
 *  rendered, atomic replace included), against a turn that takes seconds -- so
 *  debouncing bought nothing and cost two real things: a window in which the file
 *  the backend was told to read lagged the conversation, and a pending timer that
 *  could re-render from a transcript the user had just cleared.
 *
 *  Called ONLY at turn end, not on every append: the user message is already on
 *  disk by then, so one write per turn covers both halves of the exchange.
 *
 *  Only refreshes chats that already HAVE the file, i.e. ones whose backend was
 *  handed the path -- it never CREATES it for chats that were never primed. */
function refreshHistoryFile(sessionId: string): void {
  if (!isFeatureEnabled('historyFileRefresh')) return;
  if (!store.hasHistoryFile(sessionId)) return;
  const res = renderHistoryFile(sessionId);
  if (res) logger.info('prime', `history file refreshed sessionId=${sessionId} messages=${res.count}`);
}

function buildSnapshot(sessionId: string, stored: any[], lines: string[], opts?: { rideAlong?: boolean }): string {
  const rendered = renderHistoryFile(sessionId);
  const historyPath = rendered?.path || store.historyFilePath(sessionId);
  const recent: string[] = [];
  let acc = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (recent.length && acc + lines[i].length > SNAPSHOT_RECENT_CHARS) break;
    recent.unshift(lines[i]);
    acc += lines[i].length;
  }
  const omitted = lines.length - recent.length;
  const manifest = artifactManifest(stored);
  const parts = [
    opts?.rideAlong
      ? '以下是本会话之前的对话记录（由 KiroLex 保存并恢复；kiro-cli 不持久化 ACP 会话，所以每次重启后端都是空的）。不要复述它，也不要重新回答其中已经回答过的问题，只把它当作你和用户此前的共同上下文。'
      : '以下是本会话之前对话的恢复上下文（由 KiroLex 保存并恢复；kiro-cli 不持久化 ACP 会话，所以每次重启后端都是空的）。请只回复“OK”，不要复述、不要重新回答其中内容。',
    `完整历史原文（全部 ${lines.length} 条消息，未删减）保存在这个文件里：\n${historyPath}\n这个文件会随本会话继续更新，任何时候重新读它拿到的都是最新的完整记录。下面只内联了最近 ${recent.length} 条${omitted > 0 ? `，更早的 ${omitted} 条没有内联` : ''}。凡是需要更早的细节、原话或数字，直接读这个文件，不要凭印象作答，也不要说“不记得”。`,
  ];
  if (manifest) {
    parts.push(`本会话全程产出/修改过的文件（内容一律以磁盘上的文件为准，需要时直接读取）：\n${manifest}`);
  }
  parts.push(`最近 ${recent.length} 条对话原文：\n\n${recent.join('\n\n')}`);
  return parts.join('\n\n');
}

/** Every file the assistant created/edited across the WHOLE conversation, newest
 *  last. Cheap (a few hundred chars) and it is the single most important fact a
 *  rebuilt backend needs: what it produced and where. */
function artifactManifest(msgs: { toolCalls?: { kind?: string; title?: string; locations?: string[] }[] }[]): string {
  const MUTATING = new Set(['edit', 'create', 'write', 'delete', 'move', 'rename']);
  const seen = new Map<string, string>();
  for (const m of msgs) {
    for (const tc of m.toolCalls || []) {
      if (!MUTATING.has((tc.kind || '').toLowerCase())) continue;
      for (const p of tc.locations || []) if (p) seen.set(p, tc.title || '');
    }
  }
  if (!seen.size) return '';
  return Array.from(seen.entries()).map(([p, title]) => `- ${p}${title ? `  （${title}）` : ''}`).join('\n');
}

/** Split rendered history on MESSAGE boundaries so no single message is torn in
 *  half across two rebuild prompts. A message that is BY ITSELF over the limit
 *  (a full generated report easily is) gets hard-split on line boundaries --
 *  otherwise one such message reproduces the very problem this fixes: a single
 *  enormous prompt. */
function splitHistory(lines: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let cur = '';
  const flush = () => { if (cur) { chunks.push(cur); cur = ''; } };
  const add = (piece: string) => {
    if (cur && cur.length + piece.length + 2 > maxChars) flush();
    cur = cur ? `${cur}\n\n${piece}` : piece;
  };
  for (const line of lines) {
    if (line.length <= maxChars) { add(line); continue; }
    // Oversized single message: emit it as its own sequence of bounded pieces.
    flush();
    let buf = '';
    for (const seg of line.split('\n')) {
      if (buf && buf.length + seg.length + 1 > maxChars) { chunks.push(buf); buf = ''; }
      if (seg.length > maxChars) {
        // Pathological single line (minified blob / one-line table): hard slice.
        if (buf) { chunks.push(buf); buf = ''; }
        for (let i = 0; i < seg.length; i += maxChars) chunks.push(seg.slice(i, i + maxChars));
        continue;
      }
      buf = buf ? `${buf}\n${seg}` : seg;
    }
    if (buf) chunks.push(buf);
  }
  flush();
  return chunks;
}

/** Rebuild a fresh backend's context from KiroLex's OWN durable transcript.
 *
 *  Contract, and why it is written this way:
 *   - `needsHistoryPrime` is cleared ONLY after every chunk landed. A failure
 *     therefore leaves the flag set and gets retried, instead of permanently
 *     losing the history (the old code cleared it BEFORE sending and swallowed
 *     the error, so one failed send discarded the whole conversation silently).
 *   - Concurrent callers share one `primePromise`; the rebuild runs once.
 *   - Every outcome is logged. The old path logged success only, which made a
 *     lost history invisible in the log.
 */
async function primeHistoryNow(
  sessionId: string,
  opts?: { force?: boolean },
): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
  const entry = sessionClients.get(sessionId);
  const force = !!opts?.force;
  logger.info('prime', `requested sessionId=${sessionId} force=${force} attached=${!!entry} needs=${!!entry?.needsHistoryPrime} busy=${!!entry?.busy} priming=${!!entry?.priming}`);
  if (!entry) {
    logger.info('prime', `SKIP sessionId=${sessionId} reason=not-attached`);
    return { ok: false, error: '该会话尚未连接后端，先打开它再重建' };
  }
  if (entry.primePromise) {
    logger.info('prime', `JOIN sessionId=${sessionId} reason=already-in-flight`);
    return entry.primePromise;
  }
  // Forced rebuild (user-invoked). Needed because a SUCCESSFUL session/load says
  // nothing about whether kiro-cli actually restored any conversation: it can
  // resume an id that was itself created empty, and then KiroLex believes the
  // context is fine while the model knows nothing. That case is only detectable
  // by the human, so it needs a manual entry point.
  if (force) {
    entry.needsHistoryPrime = true;
    entry.primeAttempts = 0;
    entry.primeCursor = 0;
    entry.primeChunks = undefined;
    entry.primeAbandoned = false;   // an explicit rebuild request revokes the opt-out
  }
  if (!entry.needsHistoryPrime) {
    logger.info('prime', `SKIP sessionId=${sessionId} reason=not-needed`);
    return { ok: true, skipped: true };
  }
  if (entry.primeAbandoned) {
    logger.info('prime', `SKIP sessionId=${sessionId} reason=user-abandoned (右键「重建上下文」可重新发起)`);
    return { ok: true, skipped: true };
  }
  if (entry.busy) {
    // Do NOT fail: a turn (or context compaction) is settling. The flag is set, so
    // the rebuild runs before the next message is accepted. Queue, do not reject.
    emitSessionBusy(sessionId);
    logger.info('prime', `QUEUED sessionId=${sessionId} reason=backend-busy (will rebuild before next message)`);
    return { ok: true, queued: true } as any;
  }

  let stored: any[] = [];
  let lines: string[];
  try {
    stored = store.readTranscript(sessionId)
      .filter(modelFacing);
    lines = stored.map((m) => historyLine(m));
  } catch (err: any) {
    logger.info('prime', `read transcript FAILED sessionId=${sessionId} err=${err?.message}`);
    return { ok: false, error: 'read transcript failed' };
  }
  if (!lines.join('').trim()) {
    entry.needsHistoryPrime = false;
    logger.info('prime', `SKIP sessionId=${sessionId} reason=empty-transcript`);
    return { ok: true, skipped: true };
  }

  // How the context is restored. Default 'snapshot': one prompt (manifest + recent
  // turns + the path of the complete rendered history) instead of one model turn
  // per chunk on every launch. 'full' replays everything verbatim -- exact, but a
  // 3MB chat is 78 turns EVERY restart, because kiro-cli cannot restore an ACP
  // session. Small chats fit in a single chunk anyway, so they always go verbatim.
  let mode: 'snapshot' | 'full' = 'snapshot';
  try { if (store.readRecord(sessionId)?.primeMode === 'full') mode = 'full'; } catch {}
  const fullChunks = splitHistory(lines, PRIME_CHUNK_CHARS);
  if (fullChunks.length <= 1) mode = 'full';

  let chunks = entry.primeChunks && entry.primeChunks.length
    ? entry.primeChunks                      // retry: replay byte-identical content
    : mode === 'full'
      ? fullChunks
      : splitHistory([buildSnapshot(sessionId, stored, lines)], PRIME_CHUNK_CHARS);
  if (!entry.primeChunks) {
    // Full replay prepends the artifact manifest (never a substitute for the
    // history): "which files exist and where" is the fact that gets lost first,
    // and it costs a few hundred chars. Snapshot mode already embeds it.
    if (mode === 'full' && chunks.length > 1) {
      const manifest = artifactManifest(stored);
      if (manifest) {
        chunks = [`（以下先给出本会话全程产出/修改过的文件清单，内容一律以磁盘上的文件为准，需要时直接读取。随后是完整对话历史，共 ${chunks.length} 段。）\n\n${manifest}`, ...chunks];
        logger.info('prime', `manifest prepended sessionId=${sessionId} chars=${manifest.length}`);
      }
    }
    logger.info('prime', `plan sessionId=${sessionId} mode=${mode} messages=${lines.length} chars=${lines.reduce((n, l) => n + l.length, 0)} chunks=${chunks.length} (full replay would be ${fullChunks.length})`);
    entry.primeChunks = chunks;
    entry.primeCursor = 0;
  }
  entry.primeAttempts = (entry.primeAttempts || 0) + 1;

  const run = (async (): Promise<{ ok: boolean; error?: string }> => {
    entry.busy = true;
    entry.priming = true;
    try {
      let sameChunkFailures = 0;
      // Retry until every chunk is accepted. There is deliberately no attempt
      // limit and no truncation: the alternatives are giving the model a history
      // it believes is complete when it is not, or wedging the chat. Both were
      // rejected. The user's ways out are Stop (abandon) and clearing history.
      while ((entry.primeCursor || 0) < chunks.length) {
        // The executor can be replaced under us (model swap / re-attach). A new
        // kiro-cli process starts EMPTY, so this run's cursor is meaningless
        // there; stop and let that executor's own gate rebuild from scratch.
        if (sessionClients.get(sessionId) !== entry) {
          logger.info('prime', `ABORT sessionId=${sessionId} reason=executor-replaced (new backend will rebuild from 0)`);
          return { ok: false, error: '后端已被替换，将重新开始重建' };
        }
        if (entry.primeAbandoned) {
          logger.info('prime', `ABORT sessionId=${sessionId} reason=user-abandoned mid-rebuild cursor=${entry.primeCursor}/${chunks.length}`);
          return { ok: false, error: '用户已放弃重建' };
        }
        const i = entry.primeCursor || 0;
        const totalNow = chunks.length;
        const retryNote = sameChunkFailures ? `（第 ${sameChunkFailures + 1} 次尝试）` : '';
        entry.primeDetail = totalNow > 1
          ? `重建历史上下文 ${i + 1}/${totalNow}${retryNote}`
          : `重建历史上下文${retryNote}`;
        emitSessionBusy(sessionId);
        const head = totalNow > 1
          ? `以下是本会话之前对话历史的第 ${i + 1}/${totalNow} 部分（由 KiroLex 保存并恢复）。请只回复"OK"，不要复述、不要重新回答其中内容；全部部分接收完毕后把它们作为后续对话的已知上下文。`
          : `以下是本会话之前的完整对话历史（由 KiroLex 保存并恢复）。请只回复"OK"确认已读取，不要复述或重新回答其中内容；把它作为后续对话的已知上下文。`;
        try {
          await entry.client.sendPrompt(entry.cliSessionId, [
            { type: 'text', text: `<hidden>${head}\n\n${chunks[i]}</hidden>` },
          ]);
          logger.info('prime', `chunk ${i + 1}/${totalNow} ok sessionId=${sessionId} chars=${chunks[i].length}`);
          entry.primeCursor = i + 1;
          entry.primeLastError = undefined;
          sameChunkFailures = 0;
          continue;
        } catch (err: any) {
          // Surface WHY. kiro-cli answers many backend faults with a bare -32603
          // "Internal error" and puts the real reason in `error.data`; the first
          // version of this loop logged only `message`, which is why a 4-minute
          // chunk-7 failure was undiagnosable after the fact.
          let detail = '';
          try { detail = err?.data ? (typeof err.data === 'string' ? err.data : JSON.stringify(err.data)) : ''; } catch {}
          const msg = `${err?.message || 'prime failed'}${detail ? ` — ${detail}` : ''}`;
          entry.primeLastError = msg;
          sameChunkFailures++;
          logger.info('prime', `chunk ${i + 1}/${totalNow} FAILED sessionId=${sessionId} chars=${chunks[i].length} tries=${sameChunkFailures} err=${msg}`);

          // Model retired mid-rebuild: swapping replaces the executor, whose new
          // process is empty, so this run ends and the fresh one rebuilds from 0.
          // Bounded, and never back to a model this cycle already tried -- the
          // unbounded version ping-ponged between two unavailable models 16 times
          // and then succeeded on one it had rejected 8 times, i.e. the condition
          // was transient and switching was the wrong response.
          if (isModelUnavailableError(msg)) {
            const tried = primeModelsTried.get(sessionId) || new Set<string>();
            tried.add(entry.profile.model);
            primeModelsTried.set(sessionId, tried);
            if (tried.size <= PRIME_MAX_MODEL_SWAPS) {
              const swapped = await swapSessionModel(sessionId, entry.profile.model, `prime ${sessionId}`, tried);
              if (swapped) {
                logger.info('prime', `model unavailable during rebuild sessionId=${sessionId} swapped=${swapped} tried=${Array.from(tried).join(',')}`);
                return { ok: false, error: `模型不可用，已切换后端（${msg}）` };
              }
            }
            logger.info('prime', `model unavailable during rebuild sessionId=${sessionId} NOT swapping (tried=${Array.from(tried).join(',')}) -> backing off and retrying same model`);
          }
          // A turn is still settling in the backend (often context compaction).
          // Not an error state: wait it out and retry the SAME chunk.
          const stillBusy = /prompt already in progress|active turn|compaction/i.test(msg);
          // Repeated failure on one chunk: halve it. Helps if the backend is
          // rejecting this single request's size; harmless otherwise.
          if (!stillBusy && sameChunkFailures >= PRIME_SPLIT_AFTER && chunks[i].length > PRIME_MIN_CHUNK_CHARS) {
            const half = splitHistory([chunks[i]], Math.max(PRIME_MIN_CHUNK_CHARS, Math.floor(chunks[i].length / 2)));
            if (half.length > 1) {
              chunks.splice(i, 1, ...half);
              entry.primeChunks = chunks;
              sameChunkFailures = 0;
              logger.info('prime', `chunk ${i + 1} SPLIT into ${half.length} sessionId=${sessionId} sizes=${half.map((c) => c.length).join(',')} total=${chunks.length}`);
              continue;
            }
          }
          const wait = Math.min(PRIME_RETRY_MAX_MS, PRIME_RETRY_BASE_MS * Math.pow(2, Math.max(0, sameChunkFailures - 1)));
          entry.primeDetail = `重建历史上下文 ${i + 1}/${totalNow} 失败，${Math.round(wait / 1000)}s 后重试`;
          emitSessionBusy(sessionId);
          logger.info('prime', `retry in ${wait}ms sessionId=${sessionId} chunk=${i + 1}/${totalNow}`);
          await new Promise((r) => setTimeout(r, wait));
        }
      }
      // Success is the ONLY thing that clears the flag.
      entry.needsHistoryPrime = false;
      entry.primeChunks = undefined;
      primeModelsTried.delete(sessionId);
      // Persist WHICH backend holds the context -- id AND pid. `session/load`
      // reporting success is not evidence: kiro-cli does not persist ACP
      // sessions, so the same id in a new process is a blank conversation.
      try {
        const rec = store.readRecord(sessionId);
        if (rec) {
          rec.contextEstablishedFor = entry.cliSessionId;
          rec.contextEstablishedPid = entry.client.pid;
          store.writeRecord(rec);
        }
      } catch {}
      logger.info('prime', `history primed sessionId=${sessionId} mode=${mode} cli=${entry.cliSessionId} pid=${entry.client.pid} chunks=${chunks.length} chars=${chunks.reduce((n, c) => n + c.length, 0)} attempt=${entry.primeAttempts}`);
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message || 'prime failed';
      logger.info('prime', `history rebuild ABORTED sessionId=${sessionId} attempt=${entry.primeAttempts} cursor=${entry.primeCursor}/${chunks.length} err=${msg}`);
      return { ok: false, error: msg };
    } finally {
      const e = sessionClients.get(sessionId);
      if (e) {
        e.priming = false;
        e.busy = false;
        e.primeDetail = undefined;
        e.primePromise = undefined;
        e.assistantBuf = '';
        e.assistantMsgId = null;
      }
      emitSessionBusy(sessionId);
    }
  })();

  entry.primePromise = run;
  return run;
}

/**
 * **一次 `session/load` 最多等多久** ——「❌ Error invoking remote method 'acp:switch-model':
 * Error: session/load 超时（12s 无响应）」。
 *
 * 这个闸的目的是防**卡死**（一个 stale `cliSessionId` 不停流、把空闲计时器一直顶住，于是
 * `reconfiguring` 标记永远不清，之后每一次切换都答「Another model, Agent, or permission change
 * is still in progress.」）—— 它**不是**性能预算。原来的 12s 把这两件事混在一起了。
 *
 * 实测（2026-09-18 07:59 / 08:00，同一条会话连着两次失败）：切模型要起一个**冷的** kiro-cli，
 * 而同一时刻常规 attach 的 `session/load` 用了 **32 秒**（07:59:37 → 08:00:09 `resume ok`）。
 * 也就是说 12s 根本不够 —— 于是新执行器超时、回滚旧执行器又超时，会话被留在"没连着"的状态，
 * 而界面上只看到一句没头没尾的超时。45s 仍然是有界的（卡死照样会被打断），但把正常的冷启动放进去了。
 */
const LOAD_TIMEOUT_MS = 45000;
function withLoadTimeout<T>(p: Promise<T>, ms = LOAD_TIMEOUT_MS, what = 'session/load'): Promise<T> {
  const t0 = Date.now();
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    /* 实际耗时进日志 —— 下次要调这个数字时得有依据，而不是再猜一个 */
    p.then((v) => {
      const took = Date.now() - t0;
      if (took > 8000) logger.info('load', `${what} 用了 ${(took / 1000).toFixed(1)}s（上限 ${ms / 1000}s）`);
      return v;
    }),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} 超时（${ms / 1000}s 无响应）`)), ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}
// Sessions deleted during this runtime. Guards against a concurrent/in-flight
// acp:load-session (e.g. startup eager-attach) racing a delete and RECREATING the
// session's record.json on disk — which would resurrect a chat the user just
// closed (it reappears after restart via disk hydrate). In-memory only: after a
// restart the dir is gone so hydrate never re-adds it.
const deletedSessionIds = new Set<string>();
// Soft cap on ATTACHED executors (design §8). Dormant sessions are unbounded.
// Auto-sized from host resources (like MeshClaw's compute_max_subagents): each
// kiro-cli executor is a heavy process (~0.4GB), so bound by BOTH a memory
// budget (~half of total RAM) and CPU count, clamped to a sane [4, 16] range.
function computeExecutorCap(): number {
  const cpus = os.cpus()?.length || 4;
  const totalGB = os.totalmem() / 2 ** 30;
  const PER_EXEC_GB = 0.4;   // rough per-executor footprint
  const RAM_BUDGET = 0.5;    // use up to ~50% of total RAM for warm executors
  const memCap = Math.floor((totalGB * RAM_BUDGET) / PER_EXEC_GB);
  const cpuCap = cpus * 2;   // up to 2 executors per core
  return Math.max(4, Math.min(16, memCap, cpuCap));
}
const MAX_CONCURRENT_SESSIONS_AUTO = computeExecutorCap();
// User-configurable cap: persisted override in ~/.kirolex/config.json wins over
// the auto-sized value. 0/undefined = auto. Clamped to a sane range.
const KIROLEX_CONFIG_PATH = path.join(os.homedir(), '.kirolex', 'config.json');

/** ONE shared copy of the renderer's UI state (project groups, split layout,
 *  settings, panel widths…).
 *
 *  It lives on disk rather than in localStorage because localStorage is
 *  ORIGIN-scoped and this app has two renderer origins: `file://` for a normal
 *  start and `http://localhost:5173` in dev (Vite/HMR). Each therefore had its own
 *  private copy, so switching modes wiped the project groups, collapsed the split
 *  layout and reset the settings -- with the data itself perfectly intact, which is
 *  what made it look like chats had disappeared. Electron's leveldb was holding
 *  both origins at once; this file is the single source both of them read.
 *
 *  Same fix that was already applied to sessions/pinned/archived. These keys were
 *  what remained on the fragile store. */
/** Bedrock rejects a request when ANY image in it exceeds 2000px on a side, and
 *  the check applies to the WHOLE conversation, not just the new message. That made
 *  one oversized paste poison a chat permanently: a 3948x2188 Retina screenshot was
 *  read into the history, and every later turn re-sent it, so the session answered
 *  nothing but "image dimensions exceed max allowed size for many-image requests"
 *  -- compressing and re-attaching could not help, because the offending copy was
 *  already in the transcript the backend replays.
 *
 *  So images are capped BEFORE they can enter a conversation. 1500 (not 2000) keeps
 *  margin under the limit and cuts token cost; screenshots stay readable. */
const MAX_IMAGE_EDGE = 1500;
function capImageSize(img: Electron.NativeImage): { img: Electron.NativeImage; from?: string; to?: string } {
  const { width, height } = img.getSize();
  const longest = Math.max(width, height);
  if (!longest || longest <= MAX_IMAGE_EDGE) return { img };
  const scale = MAX_IMAGE_EDGE / longest;
  const next = img.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'good',
  });
  const size = next.getSize();
  return { img: next, from: `${width}x${height}`, to: `${size.width}x${size.height}` };
}

/** Capping at PASTE time is not enough, and this is why.
 *
 *  Attachments are handed to kiro-cli as `file:<path>` references, and kiro-cli --
 *  not KiroLex -- reads those files and base64-encodes them into the request. Every
 *  historical attachment is re-emitted as such a reference by `historyLine()` on
 *  every single turn (the ride-along snapshot). So ONE oversized file on disk keeps
 *  poisoning EVERY later request in that chat, forever:
 *
 *    messages.54.content.0.image ... exceed max allowed size for many-image
 *    requests: 2000 pixels          <- index 54 of the REPLAYED history
 *
 *  Observed live: six 3210x1496..4504x1912 screenshots under ~/.kirolex/pasted/,
 *  all pasted before the paste-time cap existed. Restarting did not help (the
 *  replay re-read them), and neither did re-pasting a smaller copy (the old paths
 *  are still in the transcript, so they are still replayed).
 *
 *  The gate therefore belongs on the REFERENCE, not on the paste: any path about to
 *  be shown to kiro-cli is resolved to a copy within limits. Non-destructive on
 *  purpose -- the original stays untouched so thumbnails and "open original" keep
 *  working (the renderer reads files directly and has no size limit); only what
 *  reaches the model is downscaled. Copies are deterministic and reused, so this
 *  costs one resize per distinct oversized image, not one per turn. */
const CAPPED_IMAGE_DIR = path.join(os.homedir(), '.kirolex', 'capped');
/** Shared by the file-preview reader and the thumbnail reader, so the two can
 *  never disagree about what counts as a previewable image. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
};
const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;
/** key: `path|mtime|size` -> safe path. Keyed on mtime+size so a replaced file is
 *  re-examined rather than served from a stale entry. */
const cappedImageRefs = new Map<string, string>();
/** Source paths already reported as capped, so the log states the fact once per
 *  process instead of once per turn (the snapshot re-resolves them every turn). */
const loggedCaps = new Set<string>();

function safeImageRef(filePath: string): string {
  try {
    if (!filePath || !IMAGE_PATH_RE.test(filePath) || !fs.existsSync(filePath)) return filePath;
    const st = fs.statSync(filePath);
    const key = `${filePath}|${st.mtimeMs}|${st.size}`;
    const cached = cappedImageRefs.get(key);
    if (cached) {
      // Log once per distinct source path per process. Without this a cache hit --
      // i.e. the normal case -- produced NO evidence the cap had run at all, so
      // diagnosing "still too large" meant reverse-engineering it from history.md.
      if (cached !== filePath && !loggedCaps.has(filePath)) {
        loggedCaps.add(filePath);
        logger.info('image', `ref capped (reusing copy): ${filePath} -> ${cached}`);
      }
      return cached;
    }
    const raw = nativeImage.createFromPath(filePath);
    if (raw.isEmpty()) { cappedImageRefs.set(key, filePath); return filePath; }
    const capped = capImageSize(raw);
    if (!capped.from) { cappedImageRefs.set(key, filePath); return filePath; }
    fs.mkdirSync(CAPPED_IMAGE_DIR, { recursive: true });
    const stem = path.basename(filePath).replace(/\.[^.]+$/, '');
    const out = path.join(CAPPED_IMAGE_DIR, `${stem}_${MAX_IMAGE_EDGE}px.png`);
    if (!fs.existsSync(out)) {
      fs.writeFileSync(out, capped.img.toPNG());
      logger.info('image', `ref capped ${capped.from} -> ${capped.to}: ${filePath} -> ${out}`);
    }
    cappedImageRefs.set(key, out);
    return out;
  } catch (err: any) {
    logger.warn('image', `safeImageRef failed ${filePath}: ${err?.message}`);
    return filePath;
  }
}

/** Rewrite every `file:` reference in a prompt/history text so no oversized image
 *  can reach the backend, whatever produced the reference -- a fresh send, a resend,
 *  a rerun, or the replayed history. This is the single choke point; the three
 *  renderer call sites that build these references do not need to know about it. */
function capImageRefsInText(text: string): string {
  if (!text) return text;
  return capImagePathsInText(text);
}

/** Cap every image path in an outgoing text.
 *
 *  The pattern and the reasoning behind it live in ./imagePaths (pure, and covered by
 *  tests/imagePaths.test.ts); safeImageRef is the mapper that turns an oversized
 *  original into its 1500px copy and returns anything else untouched. */
function capImagePathsInText(text: string): string {
  return rewriteImagePaths(text, safeImageRef);
}

const UI_STATE_PATH = path.join(os.homedir(), '.kirolex', 'ui-state.json');

/** Deleted chats are MOVED here instead of being destroyed, and only aged out
 *  later. Deleting a chat used to be irreversible: one accidental delete removed a
 *  37-message chat plus its rendered history, and with no Time Machine destination
 *  and no APFS local snapshots there was nothing to restore from. */
const SESSION_TRASH_DIR = path.join(os.homedir(), '.kirolex', 'trash');
/** Retention for trashed chats. Long enough to notice a mistake days later. */
const SESSION_TRASH_KEEP_DAYS = 30;
function pruneSessionTrash(): void {
  try {
    if (!fs.existsSync(SESSION_TRASH_DIR)) return;
    const cutoff = Date.now() - SESSION_TRASH_KEEP_DAYS * 86400_000;
    for (const name of fs.readdirSync(SESSION_TRASH_DIR)) {
      const p = path.join(SESSION_TRASH_DIR, name);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) {
          fs.rmSync(p, { recursive: true, force: true });
          logger.info('trash', `aged out ${name} (older than ${SESSION_TRASH_KEEP_DAYS} days)`);
        }
      } catch {}
    }
  } catch {}
}
function loadUiState(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(UI_STATE_PATH, 'utf-8'));
    if (raw && typeof raw === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
      return out;
    }
  } catch {}
  return {};
}
let uiStateCache: Record<string, string> | null = null;
function uiState(): Record<string, string> {
  if (!uiStateCache) uiStateCache = loadUiState();
  return uiStateCache;
}
let uiStateFlush: NodeJS.Timeout | null = null;
function setUiStateKey(key: string, value: string | null): void {
  if (!key || typeof key !== 'string') return;
  const state = uiState();
  if (value === null) delete state[key];
  else state[key] = String(value);
  // Coalesced: widths and drafts can change on every mouse move.
  if (uiStateFlush) clearTimeout(uiStateFlush);
  uiStateFlush = setTimeout(() => {
    uiStateFlush = null;
    try {
      fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
      const tmp = `${UI_STATE_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(uiState(), null, 2));
      fs.renameSync(tmp, UI_STATE_PATH);
    } catch { /* best-effort */ }
  }, 400);
}

/** Keys that were persisted by code that no longer exists.
 *
 *  They cannot be removed by editing ui-state.json by hand: `uiStateCache` holds the
 *  whole object and EVERY setUiStateKey rewrites the file from it, so an external
 *  edit is silently undone by the next panel resize or draft keystroke. And they
 *  cannot be removed once: the migration sweep below imports every `kirolex-*` key
 *  from the file:// origin's localStorage, where uiSet also mirrored them, so a
 *  deleted key comes straight back if ui-state.json is ever recreated. Hence a
 *  declared list, pruned at startup and excluded from the sweep.
 *
 *  kirolex-workspace-dir: the Workspace panel's location. Superseded by
 *  `lastWorkspaceDir` in ~/.kirolex/config.json (app:get/set-workspace-dir); no
 *  reader or writer for this key remains in src/. */
const DEAD_UI_STATE_KEYS = new Set(['kirolex-workspace-dir']);

/** Keys whose lifetime is ONE RUN: persisted while the app is up, wiped at boot.
 *
 *  kirolex-composer-drafts: half-written prompts, one per chat. They must survive
 *  anything that happens WITHIN a run -- switching chats, a layout change that
 *  remounts the composer, a renderer reload from HMR -- which is why they are on disk
 *  and not in a module variable. They must NOT survive a restart: text you typed
 *  yesterday, greeting you with no indication of its age, is worse than no text.
 *
 *  Clearing them here rather than in the renderer is deliberate: the renderer cannot
 *  tell a fresh launch from a reload of the same run (both are just a new page), and
 *  main is the only place that knows the process has just started. */
const RUN_SCOPED_UI_STATE_KEYS = new Set(['kirolex-composer-drafts']);
function clearRunScopedUiState(): void {
  const state = uiState();
  const dropped = [...RUN_SCOPED_UI_STATE_KEYS].filter((k) => Object.prototype.hasOwnProperty.call(state, k));
  if (dropped.length === 0) return;
  for (const k of dropped) delete state[k];
  try {
    fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
    const tmp = `${UI_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, UI_STATE_PATH);
    logger.info('ui-state', `cleared run-scoped key(s) at boot: ${dropped.join(', ')}`);
  } catch (err: any) {
    logger.warn('ui-state', `failed to clear run-scoped key(s): ${err?.message || err}`);
  }
}
function pruneDeadUiStateKeys(): void {
  const state = uiState();
  const dropped = [...DEAD_UI_STATE_KEYS].filter((k) => Object.prototype.hasOwnProperty.call(state, k));
  if (dropped.length === 0) return;
  for (const k of dropped) delete state[k];
  try {
    fs.mkdirSync(path.dirname(UI_STATE_PATH), { recursive: true });
    const tmp = `${UI_STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, UI_STATE_PATH);
    logger.info('ui-state', `pruned dead key(s): ${dropped.join(', ')}`);
  } catch (err: any) {
    logger.warn('ui-state', `failed to prune dead key(s) ${dropped.join(', ')}: ${err?.message || err}`);
  }
}

/** Dev mode = load the renderer from Vite (HMR) instead of the built bundle.
 *
 *  Detected from ARGV, not only NODE_ENV: the old `dev:main` script set it with
 *  `set NODE_ENV=development&&`, which is Windows CMD syntax and silently does
 *  NOTHING on macOS/Linux (verified: NODE_ENV stays undefined). So `npm run dev`
 *  ran the app in PRODUCTION mode off the built files, which is why every UI tweak
 *  needed a full `npm run build` + restart even though HMR was right there. An
 *  argv flag behaves identically on every platform and needs no extra dependency. */
const IS_DEV = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';

/** DEV ONLY: expose Chrome DevTools Protocol on 127.0.0.1:9222.
 *
 *  Why it is here at all: several UI defects in split view (a pane appearing to
 *  re-render when another is clicked, transcripts shifting) can only be settled by
 *  MEASURING the live window -- which DOM nodes mutate, what the real heights are.
 *  Without a port there is no way in, and diagnosing by reading code alone produced
 *  two wrong root causes.
 *
 *  SECURITY: an open CDP port is remote-code-execution equivalent for anything that
 *  can reach it. It is bound to loopback and gated on `--dev`, which a packaged build
 *  never passes, so it cannot reach a normal install. Do not widen it, do not remove
 *  the guard, and prefer removing this block once the layout work is done. */
if (IS_DEV) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222');
  app.commandLine.appendSwitch('remote-allow-origins', 'http://localhost:9222');
}
const DEV_SERVER_URL = process.env.KIROLEX_DEV_URL || 'http://localhost:5173';
// Paste blobs referenced by an UNSENT composer draft. Kept on disk (not in the
// renderer's localStorage) for two reasons: the draft is per-session and must
// survive a restart, and the boot GC has to see these paths — otherwise a blob
// that only a draft references looks like an orphan and gets deleted.
// Sessions the user deleted. Durable because the in-memory guard dies with the
// process: if the directory could not be removed (still locked), the chat used to
// reappear on the next start. A tombstoned id is hidden from hydrate and its files
// are retried at boot.
// Which interrupted prompt each session has ALREADY been auto-resent for, keyed by a
// hash of the prompt text. Durable, because the point is to survive restarts: without
// it every restart while a long turn is unfinished fires (and bills) another resend.
const AUTO_RESENT_PATH = path.join(os.homedir(), '.kirolex', 'auto-resent.json');
function loadAutoResent(): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTO_RESENT_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function saveAutoResent(map: Record<string, string>) {
  try {
    fs.mkdirSync(path.dirname(AUTO_RESENT_PATH), { recursive: true });
    const tmp = AUTO_RESENT_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, AUTO_RESENT_PATH);
  } catch { /* best-effort */ }
}

const TOMBSTONES_PATH = path.join(os.homedir(), '.kirolex', 'deleted-sessions.json');
function loadSessionTombstones(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(TOMBSTONES_PATH, 'utf-8'));
    return Array.isArray(raw) ? raw.filter((x) => typeof x === 'string') : [];
  } catch { return []; }
}
function saveSessionTombstones(ids: string[]) {
  try {
    fs.mkdirSync(path.dirname(TOMBSTONES_PATH), { recursive: true });
    const tmp = TOMBSTONES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(ids, null, 2));
    fs.renameSync(tmp, TOMBSTONES_PATH);
  } catch { /* best-effort */ }
}
function addSessionTombstone(id: string) {
  const ids = loadSessionTombstones();
  if (!ids.includes(id)) saveSessionTombstones([...ids, id]);
}
function clearSessionTombstone(id: string) {
  const ids = loadSessionTombstones();
  if (ids.includes(id)) saveSessionTombstones(ids.filter((x) => x !== id));
}

const DRAFT_PASTES_PATH = path.join(os.homedir(), '.kirolex', 'draft-pastes.json');
function loadDraftPastes(): Record<string, any[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(DRAFT_PASTES_PATH, 'utf-8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}
function saveDraftPastes(map: Record<string, any[]>) {
  try {
    fs.mkdirSync(path.dirname(DRAFT_PASTES_PATH), { recursive: true });
    const tmp = DRAFT_PASTES_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
    fs.renameSync(tmp, DRAFT_PASTES_PATH);
  } catch { /* best-effort */ }
}
function loadExecutorCapOverride(): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const n = Number(cfg?.executorCap);
    if (Number.isFinite(n) && n >= 1) return Math.max(1, Math.min(64, Math.floor(n)));
  } catch {}
  return 0;
}
function saveExecutorCapOverride(n: number) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.executorCap = n > 0 ? Math.max(1, Math.min(64, Math.floor(n))) : 0;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let MAX_CONCURRENT_SESSIONS = loadExecutorCapOverride() || MAX_CONCURRENT_SESSIONS_AUTO;

/** Wedge detection tuning.
 *
 *  Two inputs only: an OPEN TOOL CALL (protocol truth — never interrupt) and how long
 *  the turn has been silent (a heuristic). Nothing local can do better; the inference
 *  runs on a remote server, so "slow" and "dead" are locally indistinguishable. Several
 *  OS-level corroborations were tried, measured, and removed as uninformative — the last
 *  of them was the CPU probe; see the note where it used to be defined.
 *
 *  The threshold is therefore user-tunable, since it is the whole judgement: a turn
 *  whose FIRST token is genuinely slow is indistinguishable from a hung one. Raise it if
 *  a legitimate slow turn is ever interrupted; set 0 to switch the interrupt off and keep
 *  only the advisory 5-minute notice. What makes the heuristic acceptable is that its
 *  consequence is cheap: a turn that produced nothing is auto-resent, and one that
 *  produced a partial reply is left alone for the user to decide. */
const WATCHDOG_TICK_MS = 30000;             // how often silence is re-checked
/** 10 minutes, raised from 3.
 *
 *  180s was chosen while a CPU probe could still postpone the interrupt; with that probe
 *  gone this number IS the entire policy, and 3 minutes of silence is not enough evidence
 *  of a hang to spend a turn on. It also put the two signals in the wrong order: the
 *  advisory notice appears at 5 minutes (QUIET_NOTICE_MS), so at 180s the turn was already
 *  cut before the user was ever told anything -- the "no tool is running" branch of that
 *  notice was in practice unreachable. At 600s the notice comes first and carries a
 *  countdown, and the interrupt only follows if the silence really does continue. */
const WEDGE_CONFIRM_SECONDS_DEFAULT = 600;
const WEDGE_CONFIRM_SECONDS_MIN = 30;
const WEDGE_CONFIRM_SECONDS_MAX = 3600;
/** Persisted silence threshold in SECONDS. 0 means the user turned the interrupt off;
 *  an absent key means "never configured" and yields the default. */
function loadWedgeConfirmSeconds(): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const raw = cfg?.wedgeConfirmSeconds;
    if (raw === 0) return 0;                // explicitly disabled
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(WEDGE_CONFIRM_SECONDS_MIN, Math.min(WEDGE_CONFIRM_SECONDS_MAX, Math.floor(n)));
    }
  } catch { /* unreadable config -> default */ }
  return WEDGE_CONFIRM_SECONDS_DEFAULT;
}
function saveWedgeConfirmSeconds(n: number) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.wedgeConfirmSeconds = n > 0
    ? Math.max(WEDGE_CONFIRM_SECONDS_MIN, Math.min(WEDGE_CONFIRM_SECONDS_MAX, Math.floor(n)))
    : 0;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
/** 0 disables wedge interruption. Mutable: the Settings handler applies it live. */
let WEDGE_CONFIRM_MS = loadWedgeConfirmSeconds() * 1000;

/** How long an OPEN tool call may go without any update before it stops counting as
 *  progress. This bound is what keeps the tool-call guard from being a second way to
 *  hang forever (observed: a `search` call missing its closing update suppressed
 *  detection for 5+ hours). Generous by default because a legitimate long command may
 *  report nothing between start and finish — raise it if a real build is ever cut off. */
const TOOL_STALL_SECONDS_DEFAULT = 1800;   // 30 min
const TOOL_STALL_SECONDS_MIN = 60;
const TOOL_STALL_SECONDS_MAX = 86400;
function loadToolStallSeconds(): number {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const n = Number(cfg?.toolStallSeconds);
    if (Number.isFinite(n) && n > 0) {
      return Math.max(TOOL_STALL_SECONDS_MIN, Math.min(TOOL_STALL_SECONDS_MAX, Math.floor(n)));
    }
  } catch { /* unreadable config -> default */ }
  return TOOL_STALL_SECONDS_DEFAULT;
}
function saveToolStallSeconds(n: number) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.toolStallSeconds = Math.max(TOOL_STALL_SECONDS_MIN, Math.min(TOOL_STALL_SECONDS_MAX, Math.floor(n || TOOL_STALL_SECONDS_DEFAULT)));
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
let TOOL_STALL_MS = loadToolStallSeconds() * 1000;

/* The CPU-progress probe that used to live here is GONE, deliberately.
 *
 * It sampled the executor's process tree and postponed an interrupt while that tree was
 * burning CPU, on the rule "do not kill a process that is actively computing". It was
 * measured carefully, and it still could not answer the question that matters: CPU use
 * proves only that a process is NOT BLOCKED. A spin-wait or a livelock pegs a core
 * forever, and a turn waiting on remote inference burns none at all -- so the signal was
 * uninformative in BOTH directions. It also cost a 5s sample plus a full process sweep
 * (`ps -Ao` / one CIM query) per decision, and it made the timeout non-deterministic:
 * the same silence could be cut at 3 minutes or at 9, depending on unrelated activity.
 *
 * The two bounds are now the whole policy: silence past WEDGE_CONFIRM_MS, or an open tool
 * call that has stopped reporting for longer than TOOL_STALL_MS. Both are user-visible
 * settings, and both are deterministic. If a long, genuinely-working command is ever cut
 * short, the fix is to raise 「工具无进度多久判定卡死」 -- not to infer intent from CPU counters.
 */

/** USER-SELECTABLE FEATURES.
 *
 *  Every flag defaults to ON, so an untouched install behaves exactly as before.
 *  Read at the CALL SITE, never cached at boot -- that is the whole point: toggling
 *  one takes effect on the next operation, with no restart. Kept deliberately small
 *  and concrete; these are behaviours that have each caused a real problem at some
 *  point, so being able to switch one off without editing code is worth having. */
const FEATURE_DEFAULTS: Record<string, boolean> = {
  /** Prepend the history snapshot to the next message instead of spending a
   *  dedicated rebuild turn. Off = fall back to the chunked rebuild. */
  rideAlongContext: true,
  /** Re-render history.md at every turn end so the path handed to the backend
   *  never points at a frozen snapshot. Off = only written when a rebuild runs. */
  historyFileRefresh: true,
  /** Inject the layered memory block (global ⊕ project ⊕ this chat) into EVERY turn.
   *  Off = the model never sees the memory files at all. ~1.3k chars per turn. */
  memoryInjection: true,
  /** Generate chat titles with the helper model. */
  smartTitle: true,
  /** 会话记忆自动维护：一轮结束、攒够新消息就压一次（`sessionMemory.ts`） */
  sessionMemory: true,
  /** Store a large paste on disk and show a placeholder in the composer. */
  pasteFolding: true,
  /** Draggable dividers between split panes. */
  splitDragResize: true,
  /** Starter-prompt chips above an empty composer. */
  promptSuggestions: true,
};
function loadFeatureFlags(): Record<string, boolean> {
  const out = { ...FEATURE_DEFAULTS };
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    const f = cfg?.features;
    if (f && typeof f === 'object') {
      for (const key of Object.keys(FEATURE_DEFAULTS)) {
        if (typeof f[key] === 'boolean') out[key] = f[key];
      }
    }
  } catch {}
  return out;
}
/**
 * 某个**后端 session** 上连着失败了几次 ——「无法继续执行，总是断」。
 *
 * 键是 `cliSessionId`（不是 KiroLex 的会话 id）：要判的是"这段后端对话是不是坏了"，而重建会换掉
 * 这个 id —— 换完计数自然从零开始，正好。成功一轮就清零：连续性是这个判据的全部内容。
 *
 * 实测那条会话：一次 `write` 工具失败之后，每次发送都回 `Kiro failed to generate a response`，
 * 8 秒一次连着 6 次，pid 从头到尾没变 —— 而原来的重建判据只认 pid 不一致，所以永远不触发。
 */
const cliFailStreak = new Map<string, number>();
/**
 * **这条会话上一次换后端会话是什么时候** ——「我他妈说的是最近那几次 workshop 的」。
 *
 * 查到底的结论：那几次不是这条对话的问题。kiro-cli 自己存的会话状态里，换出来的新会话
 * 上下文只占 3.82% / 3.85%（几乎是空的）照样连着失败，而最后好了的那个反而是最大的 9.11%；
 * 失败按时间聚堆（07:30–07:54 十三失败一成功，07:55 之后九成功一失败），kiro-cli 日志里
 * 全是 `err=EmptyResponse`。换会话对这种故障没用 —— 判据见 `staleVerdict` 里的 `lastRecreateAgoMs`。
 */
const cliRecreatedAt = new Map<string, number>();
/**
 * **这条会话连着几次被后端拒绝生成**（`Internal error` / `EmptyResponse` 那一族）——
 * 「首先换成 sol 没好。是我后来换成 kiro-cli 才好了。」「这个问题很严重必须修好」。
 *
 * 和 `cliFailStreak` 的区别是**键**：那个按后端 session 记，而换会话会把它清零 ——
 * 于是"换了三个后端会话、每个都失败两次"在它眼里永远只是 2，永远推不出"该换模型了"。
 * 这个按 KiroLex 会话记，跨换会话累计，成功一轮清零。
 */
const bareFailStreak = new Map<string, number>();

function noteInSession(sessionId: string, body: string): boolean {
  const sid = String(sessionId || '').trim();
  const text = String(body || '').trim();
  if (!sid || !text) return false;
  const messageId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_note`;
  try {
    /**
     * **标成 KiroLex 自己说的话** ——「这他妈什么玩意，为什么按照会话发出去了」。
     *
     * 这些是对**你**说的（换模型了、换后端会话了、排队了），原来以 `role: 'user'` 落盘，
     * 而快照 / history.md / 逐段重建都是从 transcript 建的 —— 模型下一轮真的读到
     * 「⚠️ 这条会话现在跑在 gpt-5.6-sol 上」并当成你的指令。
     *
     * 界面照旧显示（可见性是这些话存在的理由），但每一条发给模型的路径都跳过它（`modelFacing`）。
     */
    store.appendMessage(sid, { id: messageId, role: 'user', content: text, ts: Date.now(), kirolex: true });
    refreshHistoryFile(sid);
    mainWindow?.webContents.send('acp:user-message', {
      sessionId: sid, messageId, content: text, ts: Date.now(), kirolex: true,
    });
    return true;
  } catch { return false; }
}

function isFeatureEnabled(key: keyof typeof FEATURE_DEFAULTS | string): boolean {
  const flags = loadFeatureFlags();
  return flags[key] !== false;
}
function saveFeatureFlag(key: string, enabled: boolean): Record<string, boolean> {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  if (!cfg.features || typeof cfg.features !== 'object') cfg.features = {};
  if (key in FEATURE_DEFAULTS) cfg.features[key] = !!enabled;
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  const tmp = `${KIROLEX_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, KIROLEX_CONFIG_PATH);
  logger.info('features', `${key}=${!!enabled} (takes effect on the next operation, no restart)`);
  return loadFeatureFlags();
}

/** Models used for KiroLex's own background TEXT chores (chat titles, prompt
 *  suggestions) -- NOT for the chats themselves. The primary is tried first and
 *  the fallback only if it cannot answer, so a throttled/retired helper model
 *  never silently kills titles and suggestions. User-adjustable in Settings and
 *  persisted in ~/.kirolex/config.json. */
const DEFAULT_HELPER_MODEL = 'claude-sonnet-5';
const DEFAULT_HELPER_FALLBACK_MODEL = 'gpt-5.6-terra';
function loadHelperModels(): { model: string; fallback: string } {
  try {
    const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
    return {
      model: String(cfg?.helperModel || '').trim() || DEFAULT_HELPER_MODEL,
      fallback: String(cfg?.helperFallbackModel ?? '').trim() || DEFAULT_HELPER_FALLBACK_MODEL,
    };
  } catch {
    return { model: DEFAULT_HELPER_MODEL, fallback: DEFAULT_HELPER_FALLBACK_MODEL };
  }
}
function saveHelperModels(model: string, fallback: string) {
  let cfg: any = {};
  try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
  cfg.helperModel = String(model || '').trim() || DEFAULT_HELPER_MODEL;
  // Empty fallback is a legitimate choice: "primary only, no second attempt".
  cfg.helperFallbackModel = String(fallback ?? '').trim();
  try { fs.mkdirSync(path.dirname(KIROLEX_CONFIG_PATH), { recursive: true }); } catch {}
  fs.writeFileSync(KIROLEX_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

/** Wire a freshly-created client's events, routing everything by sessionId. */
function wireSession(sessionId: string, entry: SessionEntry) {
  const { client } = entry;
  client.on('update', (data: any) => {
    // A background history-priming turn's output must never surface: don't
    // forward to the UI, accumulate, or persist it.
    //
    // This is the ONLY prompt KiroLex issues on its own behalf. There was briefly a
    // second kind -- a hidden `/clear` sent when the user cleared a chat -- and it
    // needed the same suppression, because without it kiro-cli's reply reached both
    // the screen (a ghost message in the chat just emptied) and `assistantBuf`, from
    // where the next real turn's flush wrote it into the transcript. That command is
    // gone: the user types `/clear` themselves and it travels as an ordinary turn,
    // so there is nothing to suppress and no second flag to keep in step with this
    // one. Anything added here later that sends a prompt the user did not type must
    // suppress it the same way.
    if (entry.priming) return;
    // Stall watchdog: any inbound stream activity proves the turn is alive.
    entry.lastStreamAt = Date.now();
    // Accumulate assistant text so we can persist the COMPLETE message on
    // turn end (never the in-flight partial, §7). The ACP session/update
    // payload is { sessionId, update: { sessionUpdate, content: { text } } }.
    try {
      const u = data?.update;
      if (
        entry.suppressCancellationChunks &&
        u?.sessionUpdate === 'agent_message_chunk'
      ) {
        return;
      }
      if (u?.sessionUpdate === 'agent_message_chunk') {
        entry.assistantBuf += u?.content?.text || '';
        if (!entry.assistantMsgId) entry.assistantMsgId = u?.messageId || `a_${Date.now()}`;
      }
      if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
        const toolCallId = u?.toolCallId || `tool_${Date.now()}`;
        /* 只数新开的调用（不数 update）—— 这是"这一轮动过东西没有"的依据，见 `toolsThisTurn`。 */
        if (u?.sessionUpdate === 'tool_call') entry.toolsThisTurn = (entry.toolsThisTurn || 0) + 1;
        const previous = entry.fileChanges.find((change) => change.toolCallId === toolCallId);
        const locations: string[] = Array.from(new Set<string>(
          (Array.isArray(u?.locations) ? u.locations : [])
            .map((location: any) => typeof location === 'string' ? location : location?.path)
            .filter((value: any): value is string => typeof value === 'string' && value.length > 0),
        ));
        const diffs = (Array.isArray(u?.content) ? u.content : [])
          .filter((block: any) => block?.type === 'diff' && typeof block.path === 'string' && typeof block.newText === 'string')
          .map((block: any) => ({ path: block.path, oldText: block.oldText ?? undefined, newText: block.newText }));
        const rawStatus = u?.status;
        const status: store.StoredToolCall['status'] =
          rawStatus === 'in_progress' || rawStatus === 'completed' || rawStatus === 'failed'
            ? rawStatus
            : 'pending';
        // A later update carrying no output must not erase what an earlier one
        // reported, hence the fallback to `previous`.
        const output = extractToolOutput(u?.content);
        /* 原始长度（裁剪之前）—— 见 `maxToolOutputThisTurn`：失败时要能说出是被哪一步撑死的 */
        if (output.length > (entry.maxToolOutputThisTurn || 0)) entry.maxToolOutputThisTurn = output.length;
        const next: store.StoredToolCall = {
          toolCallId,
          title: u?.title || previous?.title || 'Tool call',
          status,
          kind: u?.kind || previous?.kind,
          locations: locations.length > 0 ? locations : previous?.locations,
          diffs: diffs.length > 0 ? diffs : previous?.diffs,
          content: output ? clampToolOutput(output) : previous?.content,
        };
        // Outstanding-tool bookkeeping for wedge detection (see openToolCalls).
        // `lastUpdate` is rewritten on every update, so it measures STALENESS, not
        // age: a tool that keeps reporting keeps its session protected. `startedAt`
        // is kept separately so a finished call can report how long it took.
        const open = (entry.openToolCalls ??= new Map<string, { startedAt: number; lastUpdate: number }>());
        const finished = status === 'completed' || status === 'failed';
        const wasOpen = open.get(toolCallId);
        // BOUNDARY LOGGING, first and last update only. Between `received` and `done`
        // main used to log nothing whatsoever, so a 37-minute turn that ran 73 tool
        // calls was indistinguishable from a hung one both live and afterwards --
        // and the transcript could not help, because a turn's tool calls are only
        // persisted when it ends (asymmetric durability, sessionStore §1). Interior
        // updates stay silent: they repeat per tool and would bury everything else.
        const label = String(next.title).replace(/\s+/g, ' ').slice(0, 100);
        if (finished) {
          // A tool whose ONLY update is terminal (instant ones do that) was never
          // opened, so there is no start time to subtract — log it anyway, otherwise
          // it leaves no trace at all, which is the gap this logging exists to close.
          const took = wasOpen ? ` after=${((Date.now() - wasOpen.startedAt) / 1000).toFixed(1)}s` : '';
          logger.info('tool', `${status} sessionId=${sessionId} id=${toolCallId.slice(-8)}${took} ${label}`);
          // Same boundaries into the run event log, with the duration attached: a
          // StoredToolCall has no timestamp at all, so this is the only place a tool
          // span survives the process.
          eventLog.appendEvent(sessionId, {
            ts: Date.now(),
            type: 'tool_end',
            turn: entry.currentUserMessageId,
            toolCallId,
            title: label,
            kind: next.kind,
            status,
            ms: wasOpen ? Date.now() - wasOpen.startedAt : 0,
          });
          open.delete(toolCallId);
        } else if (wasOpen) {
          wasOpen.lastUpdate = Date.now();
        } else {
          const now = Date.now();
          open.set(toolCallId, { startedAt: now, lastUpdate: now });
          logger.info('tool', `start sessionId=${sessionId} id=${toolCallId.slice(-8)} kind=${next.kind || '-'} ${label}`);
          eventLog.appendEvent(sessionId, {
            ts: now,
            type: 'tool_start',
            turn: entry.currentUserMessageId,
            toolCallId,
            title: label,
            kind: next.kind,
          });
        }
        // Record a call when it touched files OR when it RAN something.
        //
        // Requiring locations/diffs dropped every command outright, which is why no
        // `execute` kind exists in any transcript. A turn that wrote a script and then
        // ran it was persisted as "created a script" and nothing else -- so when the
        // script is what actually produces the artifact (python-pptx writing a .pptx),
        // the causal chain lost its middle link and the output file looked like it came
        // from nowhere.
        const kindLower = (next.kind || '').toLowerCase();
        const ranSomething = RUN_KINDS.has(kindLower);
        if (!next.locations?.length && !next.diffs?.length && !unobservedToolKinds.has(kindLower)) {
          // One line per distinct kind, so the guess-set above can be replaced by fact.
          unobservedToolKinds.add(kindLower);
          logger.info('tool', `tool_call with no locations/diffs kind=${next.kind || '<none>'} recorded=${ranSomething} title=${String(next.title).slice(0, 120)}`);
        }
        if (next.locations?.length || next.diffs?.length || ranSomething) {
          const index = entry.fileChanges.findIndex((change) => change.toolCallId === toolCallId);
          if (index >= 0) entry.fileChanges[index] = next;
          else entry.fileChanges.push(next);
        }
      }
    } catch {}
    // WAITING FOR A HUMAN starts here. This is the single most valuable event in the
    // log: an unanswered permission prompt is the usual reason a turn took 20 minutes,
    // and it was previously persisted NOWHERE -- after a restart the wait was simply
    // invisible, so a slow turn and a turn waiting on you looked identical.
    // (`data.update`, not the `u` above: that one is scoped to the try block.)
    const pending = data?.update;
    if (pending?.sessionUpdate === 'permission_request') {
      const requestKey = String(pending?.requestId ?? '');
      if (requestKey) permissionWaitStartedAt.set(requestKey, Date.now());
      eventLog.appendEvent(sessionId, {
        ts: Date.now(),
        type: 'permission_request',
        turn: entry.currentUserMessageId,
        title: String(pending?.toolCall?.title || pending?.title || pending?.toolName || '需要批准的工具调用').slice(0, 120),
        detail: requestKey,
      });
      logger.info('permission', `asked sessionId=${sessionId} id=${requestKey}`);
    }
    /**
     * NATIVE SUBAGENTS — the roster, and WHOSE session each update really came from.
     *
     * Two facts measured with `scripts/acp-probe.mjs` meet here:
     *
     *   ① `_kiro.dev/subagent/list_update` is a full roster (name, worker agent, task, status) and it
     *      repeats until everything reads `terminated`. That is exactly the tag 「如果有subagent在运行
     *      左侧的会话上也应该有一个tag，直到subagent被关掉」 needs, so it is kept and broadcast rather
     *      than dropped into the generic `_kiro_internal` channel nothing consumes.
     *
     *   ② Most of a delegating turn's notifications DO NOT come from this chat's backend session: each
     *      subagent has its own ACP session id, and its tool calls and permission requests arrive under
     *      that id. The line below has to relabel them with the KiroLex id (that is what routes them to
     *      the right chat), but relabelling used to DESTROY the distinction — a subagent's output became
     *      indistinguishable from the parent's. `childSessionId` preserves it: present means "a subagent
     *      did this", and it is the child's real, addressable ACP session.
     */
    if (isSubagentListUpdate(data?.update?.method)) {
      const roster = parseSubagentList(data.update);
      entry.subagents = mergeSubagentList(entry.subagents, roster);
      const live = activeSubagents(entry.subagents);
      logger.info('subagent', `sessionId=${sessionId} roster=${roster.length} 运行中=${live.length}`);
      mainWindow?.webContents.send('acp:subagents', { sessionId, subagents: entry.subagents });
    }
    const originAcpSessionId = typeof data?.sessionId === 'string' ? data.sessionId : '';
    const childSessionId = originAcpSessionId && entry.cliSessionId && originAcpSessionId !== entry.cliSessionId
      ? originAcpSessionId
      : undefined;
    mainWindow?.webContents.send('acp:update', { ...data, sessionId, ...(childSessionId ? { childSessionId } : null) });
  });
  client.on('error', (error: any) => {
    logger.warn('session', `error event sessionId=${sessionId}`, error?.message || error);
    mainWindow?.webContents.send('acp:error', { ...error, sessionId });
  });
  client.on('disconnected', () => {
    logger.info('session', `disconnected sessionId=${sessionId} cli=${entry.cliSessionId} busy=${entry.busy} remote=${!!entry.profile.remote?.sshHost}`);
    // Identity guard: a detached executor's process 'close' fires asynchronously.
    // If the session was already re-attached (move-reset, LRU, reconnect), the
    // map now holds a DIFFERENT entry — this stale event must not delete it or
    // spuriously notify the renderer.
    if (sessionClients.get(sessionId) !== entry) return;
    sessionClients.delete(sessionId);
    const rec = store.readRecord(sessionId);
    if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
    mainWindow?.webContents.send('acp:disconnected', { sessionId });
  });
}

/** Flush the accumulated assistant message to the durable transcript (called on
 *  turn completion). No-op if nothing accumulated. */
function flushAssistant(sessionId: string) {
  const entry = sessionClients.get(sessionId);
  // A wedge note alone is enough to persist: a turn cut before it produced
  // anything still owes the user an explanation for why it stopped.
  if (!entry || (!entry.assistantBuf && entry.fileChanges.length === 0 && !entry.wedgeNote)) return;
  const finalId = entry.assistantMsgId || `a_${Date.now()}`;
  const finalText = entry.wedgeNote
    ? (entry.assistantBuf ? `${entry.assistantBuf}\n\n${entry.wedgeNote}` : entry.wedgeNote)
    : entry.assistantBuf;
  store.appendMessage(sessionId, {
    id: finalId,
    role: 'assistant',
    content: finalText,
    ts: Date.now(),
    ...(entry.fileChanges.length > 0 ? { toolCalls: entry.fileChanges } : {}),
  });
  // Keep the rendered history.md in step with the conversation, so the path the
  // backend was given never points at a frozen snapshot of an older turn.
  refreshHistoryFile(sessionId);
  // AUTHORITATIVE RECONCILE: main accumulates every chunk, the renderer can miss
  // trailing ones (its append is gated on the session still being marked
  // streaming). Ship the complete text so the on-screen message can never end up
  // shorter than what was actually produced (observed: reply cut mid-sentence in
  // the UI while the transcript on disk was complete).
  if (finalText && !entry.priming) {
    mainWindow?.webContents.send('acp:assistant-final', {
      sessionId,
      messageId: finalId,
      text: finalText,
    });
  }
  entry.assistantBuf = '';
  entry.assistantMsgId = null;
  entry.fileChanges = [];
  entry.wedgeNote = undefined;
}

/** Actively detach one session's executor: free the slot immediately, kill the
 *  kiro-cli process, mark the record dormant, and tell the renderer (dot ->
 *  dormant). The session's durable transcript + memory are untouched; a later
 *  prompt/open transparently re-attaches (loadSession). */
function detachExecutor(sessionId: string) {
  const entry = sessionClients.get(sessionId);
  if (!entry) return;
  sessionClients.delete(sessionId); // free the slot synchronously
  try { entry.client.disconnect(); } catch { /* process may already be gone */ }
  const rec = store.readRecord(sessionId);
  if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
  mainWindow?.webContents.send('acp:disconnected', { sessionId });
}

/** LRU auto-detach: before attaching another executor, evict the least-recently-
 *  used NON-busy executor(s) until there is room under the cap. This removes the
 *  hard ceiling — dormant sessions are unbounded and the coldest live one is
 *  recycled on demand. `excludeId` protects the session about to be (re)attached.
 *  If every live executor is busy (all mid-turn), we cannot evict and the caller
 *  falls back to rejecting, so a streaming turn is never killed. */
function ensureExecutorCapacity(excludeId?: string): boolean {
  /**
   * 回收谁 —— 先按「回收它的代价」分层,同层内才比最近使用时间。
   *
   * 「我要求这个窗口和功能修改不影响其他会话的进行」:正在跑的回合本来就不会被回收(下面 `e.busy` 那一跳),
   * 可**空闲**会话被回收之后并不是没事 —— 它再连上时后端已经没有这段历史了,于是欠一次重建,变成占用状态,
   * 它自己排着的消息也要等在重建后面。也就是说 flow 起几个会话,可能让你另一条对话「突然要重建」。
   *
   * 所以代价排序:
   *   0  没有 transcript —— 什么都不欠,回收它等于免费
   *   1  ride-along —— 上下文搭在下一条消息上,不需要单独一轮
   *   2  primeMode: 'full' —— 真的要一轮一轮重放,最贵,最后才动
   * 这不改变「不杀正在跑的」这条硬规则,只是在能选的人里选伤害最小的那个。
   */
  const evictionCost = (id: string): number => {
    try {
      if (store.transcriptFileSize(id) <= 0) return 0;
      return store.readRecord(id)?.primeMode === 'full' ? 2 : 1;
    } catch { return 1; }
  };
  while (sessionClients.size >= MAX_CONCURRENT_SESSIONS) {
    let victim: string | null = null;
    let best: { cost: number; used: number } | null = null;
    for (const [id, e] of sessionClients) {
      if (id === excludeId || e.busy) continue;
      const candidate = { cost: evictionCost(id), used: e.lastUsedAt ?? 0 };
      if (!best || candidate.cost < best.cost || (candidate.cost === best.cost && candidate.used < best.used)) {
        best = candidate;
        victim = id;
      }
    }
    if (!victim) return false; // all remaining executors are busy — cannot evict
    // 记下代价:一条对话「为什么突然要重建」必须查得出来
    logger.info('executor', `evicting ${victim} for ${excludeId || 'a new session'} (cost=${best?.cost}, idle since ${best?.used})`);
    detachExecutor(victim);
  }
  return true;
}

// Enforce single instance to prevent localStorage/leveldb corruption from
// multiple processes (the tray keeps the app alive after closing the window)
const gotSingleInstanceLock = app.requestSingleInstanceLock();
/** Distinct exit code so the dev supervisor can tell "another instance owns the
 *  lock" apart from "the code I just compiled is broken" -- retrying the first case
 *  forever is pointless, and that is what a bare non-zero exit looked like. */
const EXIT_CODE_ALREADY_RUNNING = 42;
if (!gotSingleInstanceLock) {
  // Say so. This used to quit in total silence, which is indistinguishable from
  // "the app will not start": a stale instance (e.g. one left behind by a dev
  // session whose window never rendered) holds the lock, so every relaunch died
  // instantly with nothing but `main process starting` in the log. Naming it is the
  // difference between a 30-second fix and a hunt.
  logger.info('app', 'another KiroLex instance already holds the single-instance lock -> exiting. '
    + 'If no window is visible, that instance is stale: quit it (Cmd-Q) or `pkill -f "kirolex/node_modules/electron"`.');
  app.exit(EXIT_CODE_ALREADY_RUNNING);
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance - focus our window instead, but
    // only if the initial gated reveal already happened (never force-show a
    // still-loading window).
    if (mainWindow && mainWindowRevealed) {
      if (!mainWindow.isVisible()) mainWindow.show();
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Load full shell environment (proxy, PATH, etc.) for subprocess spawning
function getShellEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PATH: process.platform === 'win32'
      ? process.env.PATH || ''
      : `${os.homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:${process.env.PATH || ''}`,
  };

  if (process.platform === 'win32') {
    // Read Windows system proxy from registry
    try {
      const regOutput = execSync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { encoding: 'utf-8', timeout: 3000 }
      );
      const proxyEnabled = regOutput.includes('0x1');

      if (proxyEnabled) {
        const serverOutput = execSync(
          'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
          { encoding: 'utf-8', timeout: 3000 }
        );
        const match = serverOutput.match(/ProxyServer\s+REG_SZ\s+(.+)/);
        if (match) {
          const proxyServer = match[1].trim();
          const proxyUrl = proxyServer.startsWith('http') ? proxyServer : `http://${proxyServer}`;
          env.HTTP_PROXY = proxyUrl;
          env.HTTPS_PROXY = proxyUrl;
          env.http_proxy = proxyUrl;
          env.https_proxy = proxyUrl;

          // Read NO_PROXY / ProxyOverride
          try {
            const overrideOutput = execSync(
              'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyOverride',
              { encoding: 'utf-8', timeout: 3000 }
            );
            const overrideMatch = overrideOutput.match(/ProxyOverride\s+REG_SZ\s+(.+)/);
            if (overrideMatch) {
              const noProxy = overrideMatch[1].trim().replace(/;/g, ',');
              env.NO_PROXY = noProxy;
              env.no_proxy = noProxy;
            }
          } catch {}
        }
      }
    } catch {}
  } else {
    // macOS/Linux: try sourcing shell profile to get proxy and other vars
    try {
      const shellOutput = execSync(
        'source ~/.zshrc 2>/dev/null || source ~/.bashrc 2>/dev/null; echo "HTTP_PROXY=$HTTP_PROXY"; echo "HTTPS_PROXY=$HTTPS_PROXY"; echo "ALL_PROXY=$ALL_PROXY"; echo "NO_PROXY=$NO_PROXY"',
        { encoding: 'utf-8', shell: '/bin/zsh', timeout: 3000 }
      ).trim();

      for (const line of shellOutput.split('\n')) {
        const [key, ...rest] = line.split('=');
        const value = rest.join('=');
        if (key && value) {
          env[key] = value;
        }
      }
    } catch {}
  }

  return env;
}

const shellEnv = getShellEnv();

// Apply proxy to Electron's own network stack
if (shellEnv.HTTP_PROXY || shellEnv.HTTPS_PROXY) {
  const proxyUrl = shellEnv.HTTPS_PROXY || shellEnv.HTTP_PROXY;
  app.commandLine.appendSwitch('proxy-server', proxyUrl!);
  if (shellEnv.NO_PROXY) {
    app.commandLine.appendSwitch('proxy-bypass-list', shellEnv.NO_PROXY);
  }
}

/** Run a CLI command WITHOUT blocking the main process. Always bounded.
 *
 *  `execSync` halts the ENTIRE Electron main process: the event loop stops, no IPC
 *  is serviced, no window repaints, every chat freezes -- for as long as the child
 *  takes. So a wedged `kiro-cli` did not just break one chat, it took the whole app
 *  down with it, which is never an acceptable coupling: the UI must survive its
 *  backend misbehaving.
 *
 *  Worst of the four call sites was `acp:list-models`, which had NO timeout and NO
 *  catch, and runs on EVERY renderer load (App.tsx populates the model list on
 *  mount) -- so one `kiro-cli chat --list-models` that never returned froze KiroLex
 *  permanently, with nothing logged because the logger could not run either.
 *
 *  `timeoutMs` is required, not optional: an unbounded external call is exactly the
 *  bug being removed here. On timeout the child is SIGKILLed and the promise
 *  rejects, so callers fall back (cached model list, empty listing) instead of
 *  waiting on a process that is never going to answer.
 *
 *  @param command Full shell command line (`shell: true`, so redirections such as
 *    `2>&1` work on both cmd.exe and POSIX shells).
 *  @param timeoutMs Hard wall-clock budget; the child is killed when it elapses.
 *  @returns The child's stdout. Rejects on timeout, non-zero exit, or spawn failure.
 */
function runCli(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, {
      encoding: 'utf-8',
      env: shellEnv,
      shell: true,
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        // On Windows there are no real signals; Node still sets `killed` when it
        // terminates the child for exceeding `timeout`, so that is the primary test.
        const timedOut = (err as any).killed === true || (err as any).signal === 'SIGKILL';
        if (timedOut) logger.warn('cli', `timed out after ${timeoutMs}ms (killed): ${command}`);
        reject(timedOut ? new Error(`\`${command}\` did not answer within ${timeoutMs}ms`) : err);
        return;
      }
      resolve(String(stdout ?? ''));
    });
  });
}

/** Run a `kiro-cli …` command line against the RESOLVED executable.
 *
 *  These helpers used to shell out to the bare name `kiro-cli`, i.e. they depended on
 *  PATH, while the ACP executor resolved the binary by searching known install
 *  locations. The two disagreed in two real cases:
 *    - the binary is reachable only through `KIRO_CLI_PATH`, with PATH untouched;
 *    - WINDOWS, where `getShellEnv()` deliberately leaves PATH alone and the
 *      installer drops `kiro-cli.exe` under %LOCALAPPDATA%.
 *  In both, chats worked while the model list, agent list, session list and the usage
 *  panel silently failed. Routing through the same resolver keeps them consistent.
 *
 *  The path is quoted because install locations can contain spaces. If nothing
 *  resolves, the bare name is used as a last resort so a PATH-only install still works.
 *
 *  @param argsLine Everything after the executable, e.g. `chat --list-models --format json`.
 *  @param timeoutMs Hard wall-clock budget, forwarded to runCli.
 */
/**
 * SINGLE-FLIGHT 槽位：这两条命令在渲染进程挂载时会被并发发起两次，而每次 spawn 都要付 kiro-cli
 * 完整启动开销（含加载全部 MCP server）—— 两个一起启就双双超时。实测裸跑 2.6–3.7 秒，应用里却在
 * 10s/15s 被 kill 了 13 次。合并成一次调用是治因，不是调参。
 */
let listModelsInFlight: Promise<any> | null = null;
let listAgentsInFlight: Promise<string> | null = null;

function runKiroCli(argsLine: string, timeoutMs: number): Promise<string> {
  const bin = resolveKiroCli();
  return runCli(`${bin ? `"${bin}"` : 'kiro-cli'} ${argsLine}`, timeoutMs);
}

// Each session gets its own directory to avoid cwd collision
const sessionsBaseDir = path.join(os.homedir(), '.kirolex', 'sessions');
function getSessionDir(sessionId?: string): string {
  const id = sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(sessionsBaseDir, id);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// (per-model getClient removed — executors are now created per-session in the
//  acp:new-session / acp:load-session handlers, keyed by sessionId.)

function createWindow() {
  startupMark('createWindow: start');
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#1a1a1a',
    autoHideMenuBar: true,
    show: false, // Hidden until connected
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Remove menu bar entirely on Windows/Linux
  if (process.platform !== 'darwin') {
    mainWindow.setMenuBarVisibility(false);
    mainWindow.setMenu(null);
  }

  // EVERY web link leaves the app — always to the OS default browser, never into
  // an Electron window. The renderer already routes normal clicks through
  // openExternal, but that only covers plain left-clicks on our own anchors:
  // cmd/middle-click, target=_blank, window.open and dropping a URL onto the
  // window all bypass it. Without these two guards the first opens a bare
  // Electron window and the second NAVIGATES THE APP AWAY from its own UI
  // (looks like KiroLex crashed and needs a restart). Local file paths are
  // unaffected: they never become real hrefs — they open in KiroLex's own viewer.
  const EXTERNAL_SCHEME = /^(https?:|mailto:|tel:)/i;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (EXTERNAL_SCHEME.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() || '';
    if (url === current) return;            // in-page reload
    if (/^(file:|http:\/\/localhost:5173)/i.test(url) && !EXTERNAL_SCHEME.test(url)) return; // own UI
    event.preventDefault();
    if (EXTERNAL_SCHEME.test(url)) void shell.openExternal(url);
  });

  // Renderer load lifecycle: this is the phase that owns most of the unexplained
  // gap (dev serves hundreds of unbundled modules; production loads one bundle).
  mainWindow.webContents.on('did-start-loading', () => startupMark('renderer: did-start-loading'));
  mainWindow.webContents.on('dom-ready', () => startupMark('renderer: dom-ready'));
  mainWindow.webContents.on('did-finish-load', () => startupMark('renderer: did-finish-load'));
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => startupMark('renderer: did-fail-load', `code=${code} ${desc}`));

  if (IS_DEV) {
    // Vite dev server = renderer HMR: editing src/renderer/** takes effect in
    // milliseconds with no rebuild and no restart. Retry the load, because the
    // supervisor may launch Electron before Vite has finished binding the port --
    // without this the window just sits blank and looks like a crash.
    const loadDevServer = (attempt = 1) => {
      mainWindow?.loadURL(DEV_SERVER_URL).catch(() => {
        if (attempt <= 30 && mainWindow && !mainWindow.isDestroyed()) {
          logger.info('app', `dev server not up yet (${DEV_SERVER_URL}), retry ${attempt}/30`);
          setTimeout(() => loadDevServer(attempt + 1), 500);
        }
      });
    };
    loadDevServer();
    // DevTools no longer auto-opens in dev; opt in with KIROLEX_DEVTOOLS=1.
    if (process.env.KIROLEX_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools();
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Minimize to tray on close instead of quitting
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Lightning bolt (⚡) drawn programmatically — the packaged app only ships
  // dist/, so there is no icon file on disk to load here.
  //
  // Hand-crafted at 16x16 but rasterized at 2x: Windows scales tray icons to the
  // display DPI and 125%/150% is the laptop default, so a 16x16 source is visibly
  // blurry. Declaring scaleFactor keeps it a logical 16x16 image.
  const LOGICAL = 16;
  const SCALE = 2;
  const size = LOGICAL * SCALE;
  const canvas = Buffer.alloc(size * size * 4);

  // NOTE: nativeImage raw bitmaps are BGRA-ordered, not RGBA — writing R first
  // rendered the bolt sky-blue instead of gold.
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= LOGICAL || y < 0 || y >= LOGICAL) return;
    for (let dy = 0; dy < SCALE; dy++) {
      for (let dx = 0; dx < SCALE; dx++) {
        const idx = ((y * SCALE + dy) * size + (x * SCALE + dx)) * 4;
        canvas[idx] = b;
        canvas[idx + 1] = g;
        canvas[idx + 2] = r;
        canvas[idx + 3] = a;
      }
    }
  };

  // Lightning bolt pixels (hand-crafted 16x16)
  const boltPixels = [
    [8,0],[9,0],[10,0],
    [7,1],[8,1],[9,1],
    [6,2],[7,2],[8,2],
    [5,3],[6,3],[7,3],
    [4,4],[5,4],[6,4],[7,4],[8,4],[9,4],[10,4],[11,4],
    [4,5],[5,5],[6,5],[7,5],[8,5],[9,5],[10,5],
    [7,6],[8,6],[9,6],[10,6],
    [8,7],[9,7],[10,7],
    [7,8],[8,8],[9,8],
    [6,9],[7,9],[8,9],
    [5,10],[6,10],[7,10],
    [4,11],[5,11],[6,11],
    [5,12],[6,12],
    [6,13],[7,13],
    [7,14],
    [8,15],
  ];

  for (const [x, y] of boltPixels) {
    setPixel(x, y, 255, 184, 0, 255); // Golden yellow
  }

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size, scaleFactor: SCALE });

  tray = new Tray(icon);
  tray.setToolTip('KiroLex');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show KiroLex',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 320,
    height: 200,
    frame: false,
    resizable: false,
    transparent: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    backgroundColor: '#1a1a1a',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const splashHtml = `
    <html>
    <body style="margin:0; display:flex; align-items:center; justify-content:center; height:100vh; background:#1a1a1a; border-radius:0; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e8e8e8; user-select:none;">
      <div style="text-align:center;">
        <div style="font-size:40px; margin-bottom:12px;">⚡</div>
        <div style="font-size:16px; font-weight:600; margin-bottom:16px;">KiroLex</div>
        <div id="splash-status" style="font-size:12px; color:#a0a0a0; margin-bottom:12px;">Starting…</div>
        <div style="width:120px; height:3px; background:#333; border-radius:2px; margin:0 auto; overflow:hidden;">
          <div style="width:40px; height:100%; background:#7c6fe0; border-radius:2px; animation:loading 1.2s ease-in-out infinite;"></div>
        </div>
      </div>
      <style>
        html, body {
          -webkit-app-region: drag;
          app-region: drag;
          cursor: grab;
        }
        body:active { cursor: grabbing; }
        @keyframes loading {
          0% { transform: translateX(-40px); }
          100% { transform: translateX(120px); }
        }
      </style>
    </body>
    </html>
  `;

  splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  splashWindow.center();
  splashWindow.show();
}

function showMainWindow() {
  if (splashWindow) {
    splashWindow.close();
    splashWindow = null;
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    mainWindowRevealed = true;
  }
}

app.whenReady().then(async () => {
  startupMark('app ready');
  // Carry the UI state off the origin-scoped localStorage BEFORE any window opens:
  // preload hands the renderer a synchronous snapshot, so the shared store has to
  // be populated by then or the first paint uses defaults (no project groups, 1x1
  // split) even though the data exists.
  try { await migrateUiStateFromFileOrigin(); } catch {}
  // Immediately after the migration, so a key the sweep might have re-imported is
  // gone before the renderer ever receives its snapshot.
  try { pruneDeadUiStateKeys(); } catch {}
  // A fresh process means a fresh composer: drafts are kept on disk so they survive a
  // renderer reload mid-run, and dropped here so they never survive a restart.
  try { clearRunScopedUiState(); } catch {}
  startupMark('ui-state migration done');
  // Age out trashed chats (30 days). Deliberately after the migration and before
  // anything else touches the sessions tree.
  /**
   * **kiro-cli 那几个日志超限就就地截断** ——「这些进程仍持有已经删除的 kiro-chat.log、lsp.log，
   * 共占 21.72GB」。
   *
   * kiro-cli 自己不轮转它们（实测一个执行器就攥着 7.86 GB + 5.60 GB），而 KiroLex 只管自己那份。
   * 判据和"为什么是截断不是删除"都在 `trimHugeCliLogs` 里 —— 删掉的话正在写它的进程会把空间
   * 一直攥到退出为止，那就是这次 21.72 GB 的成因。
   *
   * 放在起执行器**之前**：这时候还没有人持着新 fd，截断最干净。
   */
  const trimCliLogsNow = (why: string) => {
    try {
      const trim = trimHugeCliLogs();
      if (trim.trimmed.length) {
        logger.warn('logs', `kiro-cli 日志超限已就地截断（${why}），回收 ${(trim.freed / 2 ** 30).toFixed(2)} GB：`
          + trim.trimmed.map((f) => `${f.name} ${(f.bytes / 2 ** 30).toFixed(2)}GB`).join('、'));
      }
    } catch {}
  };
  trimCliLogsNow('启动');
  /**
   * **每半小时再扫一次** ——「一次启动检查兜不住」。
   *
   * 实测这台机器上 app 能连着跑 24 小时以上，而 `lsp.log` 在那段时间里长到 5.6 GB ——
   * 只在启动时看一眼，等于把上限交给"你多久重启一次"。半小时一次：日志再怎么长也就多那半小时的量，
   * 而截断本身是一次 `truncate`（不读内容、不复制），代价可以忽略。
   */
  setInterval(() => trimCliLogsNow('定时'), 30 * 60 * 1000).unref?.();
  // Age out trashed chats (30 days). Deliberately after the migration and before
  // anything else touches the sessions tree.
  try { pruneSessionTrash(); } catch {}
  startupMark('trash pruned');
  // No executors survive a restart — reset any stale live executorState so the
  // durable records are truthful from boot.
  try { store.markAllExecutorsDetached(); } catch {}
  // Retry deletions that could not finish last run (locked files) and keep those
  // ids suppressed so a half-deleted chat never comes back.
  try {
    const pending = loadSessionTombstones();
    if (pending.length) {
      const stillThere: string[] = [];
      for (const id of pending) {
        deletedSessionIds.add(id);
        const dir = path.join(os.homedir(), '.kirolex', 'sessions', id);
        try {
          if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
          if (fs.existsSync(dir)) stillThere.push(id);
        } catch { stillThere.push(id); }
      }
      saveSessionTombstones(stillThere);
      logger.info('delete-session', `retried ${pending.length} pending deletion(s); ${stillThere.length} still locked`);
    }
  } catch {}

  // Sweep leftovers nothing else owns:
  //   *.bak / *.bak.<ts>  — one-off backups from past migrations/scripts. Nothing in
  //                         the app writes these, so an old one is pure residue.
  //   *.tmp               — every durable write is "write .tmp then rename", which is
  //                         atomic and leaves no trace. A .tmp that survived is the
  //                         debris of a crash mid-write, and it will never be reused.
  // Both are age-gated so an in-flight write or a backup taken minutes ago is safe.
  try {
    const home = os.homedir();
    const BAK_MAX_AGE_MS = 30 * 24 * 3600 * 1000; // keep a month of manual backups
    const TMP_MAX_AGE_MS = 24 * 3600 * 1000;      // a real .tmp lives milliseconds
    const dirs = [path.join(home, '.kirolex')];
    const sessionsDir = path.join(home, '.kirolex', 'sessions');
    try {
      for (const id of fs.readdirSync(sessionsDir)) {
        const d = path.join(sessionsDir, id);
        if (fs.statSync(d).isDirectory()) dirs.push(d);
      }
    } catch { /* no sessions yet */ }
    let removed = 0;
    let bytes = 0;
    for (const dir of dirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        const isBak = /\.bak(\.|$)/.test(name);
        const isTmp = name.endsWith('.tmp');
        if (!isBak && !isTmp) continue;
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (!st.isFile()) continue;
          const age = Date.now() - st.mtimeMs;
          if (age < (isBak ? BAK_MAX_AGE_MS : TMP_MAX_AGE_MS)) continue;
          fs.unlinkSync(full);
          removed++; bytes += st.size;
        } catch { /* skip anything we cannot stat/remove */ }
      }
    }
    if (removed) {
      logger.info('cleanup', `removed ${removed} stale .bak/.tmp file(s), ${Math.round(bytes / 1024)} KB`);
    }
  } catch {}

  // GC of pasted blobs — images AND text — in ONE reference-aware pass.
  //
  // The image directory used to be wiped wholesale on every boot ("leftover temp
  // files"), which silently destroyed every image the user had pasted into a chat:
  // the transcript kept the attachment path, the file was gone, so reopening the
  // chat showed a dead chip and history re-injection handed the model a `file:`
  // reference to nothing. A pasted blob is NOT a temp file — it is the only copy of
  // that message's content. So delete exactly what no surviving transcript
  // references (chat deleted, or a blob abandoned before sending) and keep the rest.
  try {
    const home = os.homedir();
    const dirs = [
      path.join(home, '.kirolex', 'pasted'),  // images
      path.join(home, '.kirolex', 'pastes'),  // text blobs
    ].filter((d) => fs.existsSync(d));
    if (dirs.length) {
      const referenced = new Set<string>();
      for (const rec of store.listSessions()) {
        for (const m of store.readTranscript(rec.id) as any[]) {
          for (const a of (m?.attachments || [])) if (a?.path) referenced.add(path.resolve(a.path));
          for (const p of (m?.pastes || [])) if (p?.path) referenced.add(path.resolve(p.path));
        }
      }
      // An unsent draft's blobs are referenced too — deleting them would leave the
      // composer holding a placeholder that can never expand again. Only THIS run's
      // drafts can matter: composer text is no longer restored across a restart, so
      // yesterday's entries reference blobs no composer will ever ask for again. They
      // are cleared below, after the GC has had its look, and the 24h grace above
      // still protects anything pasted recently.
      for (const blocks of Object.values(loadDraftPastes())) {
        for (const b of (blocks || [])) if (b?.path) referenced.add(path.resolve(b.path));
      }
      const GRACE_MS = 24 * 3600 * 1000; // freshly pasted, not yet in any draft/transcript
      let removed = 0;
      let kept = 0;
      for (const dir of dirs) {
        for (const f of fs.readdirSync(dir)) {
          const full = path.resolve(path.join(dir, f));
          if (referenced.has(full)) { kept++; continue; }
          try {
            if (Date.now() - fs.statSync(full).mtimeMs < GRACE_MS) { kept++; continue; }
            fs.unlinkSync(full); removed++;
          } catch {}
        }
      }
      logger.info('pastes', `GC kept ${kept} referenced/recent blob(s), removed ${removed} orphan(s)`);
    }
  } catch {}

  // Start with no draft paste references. Composer text does not survive a restart any
  // more, so every entry here belongs to a draft that no longer exists; keeping them
  // would pin their blobs against the GC forever. The renderer re-registers a session's
  // blocks as soon as something is pasted in this run.
  try {
    const stale = Object.keys(loadDraftPastes()).length;
    if (stale) {
      saveDraftPastes({});
      logger.info('pastes', `dropped draft paste refs for ${stale} chat(s): drafts do not survive a restart`);
    }
  } catch { /* best-effort */ }

  createTray();
  createSplashWindow();
  createWindow();

  // The main window is revealed ONLY by the renderer after disk hydration,
  // initial transcript restore, and eager session attach complete. There is no
  // time-based fallback: a slow load must stay behind the splash rather than
  // exposing a partially-loaded chat UI.

  // IPC handlers
  ipcMain.handle('acp:connect', async () => {
    // Backend readiness only — does NOT reveal. The window is shown via
    // acp:reveal after the renderer finishes warming sessions behind the splash.
    return { connected: true };
  });

  // Update the splash status line while the renderer warms sessions behind it.
  ipcMain.handle('acp:splash-status', async (_event, text: string) => {
    try {
      if (splashWindow && !splashWindow.isDestroyed()) {
        await splashWindow.webContents.executeJavaScript(
          `(function(){var e=document.getElementById('splash-status'); if(e) e.textContent=${JSON.stringify(String(text))};})()`
        );
      }
    } catch { /* splash may have closed */ }
    return { ok: true };
  });

  // Reveal the main window only after the renderer explicitly reports that
  // hydration, initial transcript restore, and eager attach are complete.
  ipcMain.handle('acp:reveal', async () => {
    startupMark('reveal: window shown (hydrate + eager-attach finished)');
    showMainWindow();
    return { revealed: true };
  });

  ipcMain.handle('acp:disconnect', async () => {
    for (const [, entry] of sessionClients) {
      try { await entry.client.disconnect(); } catch {}
    }
    sessionClients.clear();
  });

  ipcMain.handle('acp:new-session', async (
    _event,
    kiroLexId: string,
    cwd: string,
    model: string,
    projectId?: string,
    kiroAgent?: string,
    permissionMode: 'auto-approve' | 'ask' = 'auto-approve',
  ) => {
    if (!ensureExecutorCapacity()) {
      throw new Error('All live sessions are busy; cannot start another right now.');
    }
    const sessionDir = getSessionDir(kiroLexId);
    const resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    const derived = resolvedCwd === os.homedir() ? undefined : deriveProjectId(resolvedCwd);
    // A remote-enabled active agent (see ~/.kirolex/config.json) makes this
    // session's executor spawn kiro-cli over SSH; otherwise it stays local.
    const remote = loadActiveRemoteTarget(KIROLEX_CONFIG_PATH);
    const profile: AgentProfile = {
      model: model || DEFAULT_MODEL,
      // Set at creation, NOT left undefined. An absent preference used to be
      // back-filled on the next attach from profile.model — which by then may
      // already be an automatic fallback, laundering a model the user never chose
      // into their "preferred" one permanently.
      preferredModel: model || DEFAULT_MODEL,
      permissionMode: permissionMode === 'ask' ? 'ask' : 'auto-approve',
      projectId: projectId ?? derived,
      kiroAgent: kiroAgent || undefined,
      remote,
    };
    // Remote sessions run kiro-cli on the remote host, so its working directory
    // must be a REMOTE path, not the local per-session scratch dir.
    const cliCwd = sessionCwd(profile, sessionDir);
    // Model fallback: use the first candidate that actually starts, and persist
    // the effective model so the session isn't stuck pointing at a dead one.
    const started = await connectWithModelFallback(profile, 'new-session');
    const client = started.client;
    profile.model = started.model;
    const { sessionId: cliSessionId } = await client.newSession(cliCwd);
    const entry: SessionEntry = { client, cliSessionId, profile, cwd: cliCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], lastUsedAt: Date.now() };
    sessionClients.set(kiroLexId, entry);
    wireSession(kiroLexId, entry);
    // Durable record (design §4), keyed by the KiroLex id; store the cli mapping.
    const rec = store.createSession(kiroLexId, profile);
    rec.cliSessionId = cliSessionId;
    rec.executorState = 'attached';
    store.writeRecord(rec);
    mainWindow?.webContents.send('session:ready-for-first-prompt', { sessionId: kiroLexId, projectId: profile.projectId });
    return { sessionId: kiroLexId };
  });

  ipcMain.handle('acp:prompt', async (_event, sessionId: string, prompt: any[], model?: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }) => {
    /**
     * 已经删掉的会话不许再发东西进去 —— 否则那一发**会把它复活**。
     *
     * `acp:prompt` 一路会走到 `store.appendMessage`，而写 transcript 会把目录重新建出来（记录本来就是
     * 「第一次 prompt 创建」的）。attach 那两处早就有这道守卫（『Session was deleted; not re-attaching.』），
     * 唯独发送这条路没有。
     *
     * 实测的样子：flow 重置一步 → 那条 worker 被回收进回收站 → **7 秒后**它那一发在途的 prompt 到了 →
     * 目录重新出现，成了一条没有任何节点引用的孤儿 worker。这就是「很多没用的子会话还在那」的来源之一。
     */
    if (deletedSessionIds.has(sessionId)) {
      logger.warn('prompt', `refused: sessionId=${sessionId} was deleted —— 不再复活它`);
      throw new Error('这个会话已经被删除了，不再向它发送。');
    }
    try {
      return await sendPromptOnce(sessionId, prompt, projectId, display, model);
    } catch (err) {
      // LAST LINE OF DEFENCE for the ride-along marker. sendPromptOnce writes it
      // before the send and only its streaming catch used to take it back, so
      // anything that throws EARLIER left the marker asserting a history the
      // backend never got -- and the next message would then be answered from an
      // empty conversation while KiroLex believed the context was there.
      //
      // The reachable one was the busy rejection: it is thrown outside that try
      // block, so neither catch saw it. Sequence: a send fails, its catch drops the
      // marker and awaits a model swap while `busy` is still set; a second message
      // arrives in that window, finds no marker, rides along (writing the marker),
      // and is then rejected as busy and queued -- the snapshot never went out, but
      // the marker says it did. Clearing it here covers that and every other
      // pre-send throw, without wrapping 400 lines in another try.
      const e = sessionClients.get(sessionId);
      if (e?.rideAlongUnconfirmed) {
        e.rideAlongUnconfirmed = false;
        clearContextEstablished(sessionId);
        logger.info('prime', `send failed before the snapshot was accepted sessionId=${sessionId} -> context marker withdrawn, next message will inject again`);
      }
      throw err;
    }
  });

  /** One send attempt. Kept as a named function (rather than an inline handler) so
   *  the failure classification below stays readable. */
  async function sendPromptOnce(sessionId: string, prompt: any[], projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }, _model?: string, attempt = 0): Promise<any> {
    // `let`, not `const`: a mid-flight model swap (retired model) replaces this
    // session's executor, and the rest of the turn must continue on the new one.
    let entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');
    logger.info('prompt', `received sessionId=${sessionId} cli=${entry.cliSessionId} busy=${entry.busy}`);
    // EVERY outgoing `file:` reference is resolved to a within-limits copy here.
    // This is the one place all send paths converge -- fresh send, auto-resend,
    // rerun, overwrite, queue drain -- and it is the only reason capping works at
    // all: a rerun re-sends the attachment PATHS stored in the transcript, so it
    // never passes through the paste-time cap. Capping only at paste left every
    // pre-existing oversized screenshot able to re-enter a conversation, and once
    // inside, the backend replays it on every later turn:
    //   messages.48.content.0.image ... exceed max allowed size ... 2000 pixels
    prompt = (prompt || []).map((block: any) => (
      block && block.type === 'text' && typeof block.text === 'string'
        ? { ...block, text: capImageRefsInText(block.text) }
        : block
    ));
    // A model/Agent switch is replacing this session's executor. WAIT for it
    // rather than rejecting the message: the renderer queues on the pushed
    // 'reconfiguring' state, but that state travels over IPC, so a send fired in
    // the same instant as the switch would otherwise be answered with an error on
    // the user's own message. `entry` is re-read afterwards because the switch
    // installs a NEW executor for the same session.
    await awaitReconfigureIdle(sessionId);
    const afterSwitch = sessionClients.get(sessionId);
    if (!afterSwitch) throw new Error('Session not connected');
    entry = afterSwitch;
    // The backend was rebuilt from scratch (resume failed) and its context has NOT
    // been restored yet -> WAIT for the rebuild, then send. Sending now would hand
    // the model an empty conversation, which looked like "Kiro forgot everything it
    // just wrote". Runs before the busy check on purpose: priming marks the entry
    // busy, and that must not be reported as "an active turn".
    // Verify, lazily, that THIS backend has actually been given this chat's
    // history -- before letting a message reach it.
    //
    // Why here and not at attach: attach fires for every warmed session at
    // startup, and some transcripts here are 3MB / 5000+ messages, so deciding
    // eagerly would mass-replay chats nobody opened. Deciding at send time means
    // only the chat you actually use pays the (bounded) cost, exactly once --
    // after a successful rebuild `contextEstablishedFor` matches the backend and
    // this never fires again for it.
    //
    // A "successful" session/load is NOT evidence: it can resume an id that was
    // itself created empty in an earlier run. Absent/mismatched marker means we
    // have no proof the backend holds anything, so treat it as missing.
    // Verify, lazily, that THIS backend has actually been given this chat's
    // history -- before letting a message reach it. Runs before the busy check on
    // purpose: priming marks the entry busy, and that must not be reported as "an
    // active turn". Session activation performs the same check (see
    // acp:ensure-context), so by the time you type this has usually already run.
    // RIDE-ALONG CONTEXT (no rebuild turn at all).
    //
    // kiro-cli does not persist ACP sessions, so a restart always means an empty
    // backend -- that part is unavoidable. What IS avoidable is paying a dedicated
    // model turn to refill it. The snapshot is just text, so it is prepended to the
    // message the user was going to send anyway: same bytes, ZERO extra turns, no
    // locked session, no queue, no waiting, and nothing at all for chats never
    // opened. This is the same mechanism the memory block already uses below.
    //
    // Verbatim mode ('full') cannot ride along -- it is one turn PER CHUNK by
    // definition -- so that path keeps the chunked, retried rebuild.
    const rideAlong = isFeatureEnabled('rideAlongContext')
      && !contextEstablished(sessionId, entry)
      && !entry.primeAbandoned
      && !entry.priming
      && !entry.needsHistoryPrime
      && store.readRecord(sessionId)?.primeMode !== 'full'
      && store.transcriptFileSize(sessionId) > 0;
    // The context snapshot exactly as sent, kept for the Snapshot view. Captured here
    // rather than re-derived later: it is built from the transcript, so rebuilding it
    // afterwards describes the CURRENT conversation, not the one this turn carried.
    // Memory layers are deliberately NOT captured — they are editable in their own
    // tabs, so copying them in would just be noise.
    let sentContextSnapshot = '';
    // Built and MARKED here, but not prepended until after the user message has
    // been persisted -- see the deferred prepend below for why the order matters.
    let rideAlongBlock = '';
    if (rideAlong) {
      rideAlongBlock = buildHistoryRideAlong(sessionId);
      if (rideAlongBlock) {
        sentContextSnapshot = rideAlongBlock;
        // Marked here, before the bytes go out, so a crash mid-turn does not
        // re-inject a history the backend already received. That makes it OWED
        // bookkeeping: `rideAlongUnconfirmed` says the claim is not yet backed by
        // an accepted request, and every failure path takes the marker back (the
        // acp:prompt wrapper below catches the ones that throw before the
        // streaming try block, which is how the busy rejection used to strand it).
        markContextEstablished(sessionId, entry);
        entry.rideAlongUnconfirmed = true;
        logger.info('prime', `context RIDE-ALONG sessionId=${sessionId} chars=${rideAlongBlock.length} cli=${entry.cliSessionId} pid=${entry.client.pid} (no rebuild turn)`);
      }
    }
    markContextOwedIfUnverified(sessionId, 'prompt');
    if (entry.priming || entry.needsHistoryPrime) {
      const primed = await primeHistoryNow(sessionId);
      entry = sessionClients.get(sessionId) || entry;
      // The user opted out (Stop). Respect it: send WITHOUT the history rather
      // than blocking the message -- they were told the context is incomplete.
      if (entry.primeAbandoned) {
        logger.info('prime', `proceeding WITHOUT history sessionId=${sessionId} (user abandoned the rebuild)`);
      } else if (!primed.ok && !primed.skipped) {
        // Do NOT silently continue on an empty backend. Surfacing this is the
        // whole point: the flag stays set, so the next send retries the rebuild.
        throw new Error(`历史上下文重建未完成（${primed.error || '未知原因'}），这条消息未发出以免在空上下文上作答。重建会继续自动重试；不想等就按 Stop 放弃重建（这一条消息会照常发出，只是后端没有历史）。`);
      }
    }
    // Kiro CLI performs context compaction inside the active session/prompt
    // request. Keep that original request authoritative until it fully settles;
    // queued follow-ups must never overlap it or run during compaction.
    if (entry.busy) {
      throw new Error('Wait for the active turn (including context compaction) to finish before sending the queued message.');
    }
    // Most-recently-used: protect this session from LRU eviction this turn.
    entry.lastUsedAt = Date.now();
    // Reconcile the renderer's authoritative projectId onto the executor + record
    // (covers assignment after attach, and executor/profile drift).
    if (projectId !== undefined && projectId !== entry.profile.projectId) {
      entry.profile.projectId = projectId;
      const r = store.readRecord(sessionId);
      if (r) { r.profile.projectId = projectId; store.writeRecord(r); }
    }
    const effectiveProjectId = projectId ?? entry.profile.projectId;
    // Persist the user message the instant it is sent (asymmetric durability, §7).
    const userMessageId = display?.messageId || `u_${Date.now()}`;
    entry.currentUserMessageId = userMessageId;
    /**
     * **自动重发的那几次不能再落一遍盘** —— `appendMessage` 是无条件追加（见 sessionStore），
     * 所以重发一次 transcript 里就多一条同样的用户消息；而 ride-along 快照正是从 transcript 建的，
     * 于是"重试了 3 次"会变成"同一个问题在历史里问了 4 遍"。`attempt > 0` 时这条已经在盘上了。
     */
    if (attempt > 0) {
      /* 这一条早就在盘上了（见上面）—— 什么都不做 */
    } else try {
      const promptText = Array.isArray(prompt)
        ? prompt.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
        : String(prompt ?? '');
      store.appendMessage(sessionId, {
        id: userMessageId,
        role: 'user',
        content: display?.displayText ?? promptText,
        ts: Date.now(),
        ...(display?.mergeIntoMessageId ? { mergeIntoMessageId: display.mergeIntoMessageId } : {}),
        ...(display?.attachments?.length
          ? {
              attachments: display.attachments.map((a: any) => ({
                id: a?.id, name: a?.name, path: a?.path, isImage: !!a?.isImage,
              })),
            }
          : {}),
        // Where the `[ 粘贴 #N · M 行 ]` placeholders in `content` resolve to.
        ...(display?.pastes?.length
          ? {
              pastes: display.pastes.map((p: any) => ({
                seq: Number(p?.seq) || 0,
                lines: Number(p?.lines) || 0,
                chars: Number(p?.chars) || 0,
                path: String(p?.path || ''),
              })).filter((p: any) => p.path),
            }
          : {}),
      });
    } catch {}
    // Inject layered memory (global ⊕ project ⊕ this chat) on EVERY turn.
    //
    // It used to go out only when the block's CONTENT changed, which is right for
    // "background facts" and wrong for the rules people actually put in there. A rule
    // like 「每次回复的结尾都必须打印本轮最终生成物的完整路径」 has to hold for every
    // reply, but it was stated once and then never again: measured on one chat, a single
    // injection at 17:07 followed by 7 turns that carried nothing, at 66.5% context. The
    // block is also deliberately kept OUT of the transcript and history.md, so nothing
    // restates it after a compaction either -- once it falls out of the live context it
    // is simply gone, invisibly.
    //
    // Cost is small and bounded: this block is ~1.3k chars (~300 tokens) per turn.
    // Rebuilt from disk each time, so an edit takes effect on the next message.
    //
    // Prepended BEFORE the ride-along snapshot below, which means it ends up AFTER it in
    // the final array -- i.e. as close to the user's own text as possible. A standing
    // instruction buried in front of a 19k-char history dump is the position least likely
    // to be honoured.
    try {
      const block = isFeatureEnabled('memoryInjection')
        ? buildMemoryInjection(effectiveProjectId, sessionId)
        : '';
      if (block) {
        prompt = [{ type: 'text', text: block }, ...prompt];
        const rec = store.readRecord(sessionId);
        if (rec) { rec.lastMemoryInjection = { charCount: block.length, at: Date.now() }; store.writeRecord(rec); }
        // Logged per turn on purpose: without it "was the memory actually delivered?"
        // could only be answered by reading record.json, and only for the LAST turn.
        logger.info('memory', `injected sessionId=${sessionId} chars=${block.length} project=${effectiveProjectId || '(none)'}`);
      }
    } catch {}
    /**
     * 顺路播报三层各自的体积 —— 这是横幅「压缩完自己消失」的依据。
     *
     * 放在这里而不是单独轮询：这一轮刚刚把这些文件读过一遍，`statSync` 拿个 size 几乎零成本，
     * 而且时机天然正确 —— 压缩那一轮结束后的下一轮就会带上新的数字。
     *
     * 刻意**不**放在上面那个 try 里：那一块被 `memoryInjection` feature flag 门控，寄生进去
     * 会让关掉 flag 静默杀死横幅，而且没有任何报错。
     */
    try {
      const bytes = memoryLayerBytes(effectiveProjectId, sessionId);
      mainWindow?.webContents.send('acp:memory-bytes', {
        sessionId, projectId: effectiveProjectId || null, ...bytes,
      });
    } catch {}
    // DEFERRED PREPEND. The snapshot joins the request only now, AFTER the user
    // message is on disk, for the same reason the memory block does: `promptText`
    // above is derived from `prompt`, so a block prepended earlier is inside the
    // fallback that runs whenever `display.displayText` is absent -- and that
    // fallback would write the ENTIRE history snapshot into the transcript as if
    // the user had typed it. It would then be rendered into history.md, be carried
    // by the NEXT snapshot, and grow on itself. Every current renderer call site
    // does pass displayText, so nothing was corrupted; this removes the trap
    // instead of relying on all future call sites remembering.
    if (rideAlongBlock) prompt = [{ type: 'text', text: rideAlongBlock }, ...prompt];
    // History rebuild already happened above (awaited, chunked, retried) before
    // this message was accepted, so there is nothing to inject inline here. The
    // old inline path prepended the ENTIRE transcript onto the user's own prompt
    // in one shot -- for a large chat that is 100k+ chars, which either failed or
    // was immediately compacted away.
    // Archive the context snapshot at the moment it goes out. Without this it existed
    // only on the wire — the log kept a char count and nothing else, so "what
    // background was this session given?" was unanswerable, and unrecoverable once the
    // transcript moved on. One file per session, overwritten each send.
    if (sentContextSnapshot) {
      try {
        store.writeLastInjection(sessionId, sentContextSnapshot);
      } catch { /* diagnostics must never block a send */ }
    }
    try {
      entry.busy = true; // in-flight turn — exempt from LRU eviction
      emitSessionBusy(sessionId);
      // Tag this turn so a *rejected duplicate* invocation can never clear the
      // busy flag belonging to the turn that is actually running.
      const myTurn = (entry.turnSeq = (entry.turnSeq || 0) + 1);
      try {
        // QUIET MONITOR — OBSERVE ONLY, NEVER INTERRUPT. An earlier version
        // cancelled a turn after 3 minutes of silence and resent it, on the theory
        // that silence meant "wedged". That was wrong: a long tool call, a big
        // context compaction or plain long model thinking legitimately emits
        // nothing for many minutes, so the watchdog threw away real work and
        // reported it as "已自动中断并重试". The user always has Stop, which makes
        // an automatic kill all cost and no benefit. So now we only REPORT the
        // silence (so a genuinely hung turn is visible) and let the turn run.
        const QUIET_NOTICE_MS = 300000;   // 5 min of silence -> inform, do not act
        let modelSwaps = 0;
        /* 空响应换模型**一轮最多一次** —— 真的整段时间都在返空响应时，把回退链全走一遍
           就是几分钟的静默；换一次够了，剩下的交给退避重发和那句说明。 */
        let emptySwaps = 0;
        // Every model already proven dead THIS turn. Without carrying this across
        // swaps the chain ping-pongs between the first two entries and never
        // reaches a working one (see the swap call below).
        const triedModels = new Set<string>();
        // One attempt per chain entry. `triedModels` makes repeats impossible, so
        // the walk terminates on its own and the budget is just the chain length —
        // a fixed 2 stopped short whenever several dead models led the chain.
        const MAX_MODEL_SWAPS = MODEL_FALLBACK_ORDER.length;
        for (;;) {
          entry.lastStreamAt = Date.now();
          // Stale entries from a previous turn would otherwise suppress detection
          // forever: a turn killed mid-tool never sends the closing update.
          entry.openToolCalls?.clear();
          entry.toolsThisTurn = 0;       // 这一轮的工具计数从零开始（自动重试的安全闸）
          entry.maxToolOutputThisTurn = 0;
          entry.wedgeNote = undefined;   // never let one turn's note reach another
          let noticeSent = false;
          let interrupting = false;
          let wedgeHandled = false;
          const watchdog = setInterval(() => {
            const e = sessionClients.get(sessionId);
            if (!e || e !== entry) return;
            const quietFor = Date.now() - (e.lastStreamAt || Date.now());
            // Freshest update among the OPEN tool calls; -1 when none are open.
            const freshestToolUpdate = e.openToolCalls?.size
              ? Math.max(...Array.from(e.openToolCalls.values(), (v) => v.lastUpdate))
              : -1;
            const toolIdleFor = freshestToolUpdate >= 0 ? Date.now() - freshestToolUpdate : -1;
            // The interrupt needs BOTH bounds passed (see the two `return`s below), so
            // the time left is the LATER of the two -- computed once here because the
            // notice below has to name which one it came from.
            const quietLeftMs = WEDGE_CONFIRM_MS - quietFor;
            const toolLeftMs = toolIdleFor >= 0 ? TOOL_STALL_MS - toolIdleFor : 0;
            if (quietFor > QUIET_NOTICE_MS) {
              // Name the open tool and its idle time: "still running" alone gave no way
              // to tell a working command from one whose completion was never reported.
              const toolNote = toolIdleFor >= 0
                ? ` (${e.openToolCalls!.size} tool call(s) open, last update ${Math.round(toolIdleFor / 1000)}s ago)`
                : ' (no tool call open)';
              if (!noticeSent) {
                noticeSent = true;   // the LOG stays one-shot; the UI does not
                logger.info('prompt', `quiet sessionId=${sessionId} cli=${e.cliSessionId} quiet=${Math.round(quietFor / 1000)}s${toolNote} -- still running, NOT interrupting`);
              }
              // Re-sent EVERY tick, not once. A one-shot froze the on-screen elapsed
              // time at its first value, so a turn that went on to hang for half an
              // hour kept claiming "5 minutes" — and the eventual timeout interrupt
              // arrived with no warning. Carrying the countdown makes it expected.
              mainWindow?.webContents.send('acp:turn-quiet', {
                sessionId,
                quietSeconds: Math.round(quietFor / 1000),
                openTools: toolIdleFor >= 0 ? e.openToolCalls!.size : 0,
                toolIdleSeconds: toolIdleFor >= 0 ? Math.round(toolIdleFor / 1000) : 0,
                // null = the interrupt is switched off in Settings, so nothing is
                // counting down and the UI must not imply otherwise.
                interruptInSeconds: WEDGE_CONFIRM_MS
                  ? Math.max(0, Math.round(Math.max(quietLeftMs, toolLeftMs) / 1000))
                  : null,
                // WHICH of the two thresholds the countdown comes from, and its value.
                //
                // Without this the UI could only show the remaining time, and the number
                // looked like a contradiction: with a tool open the countdown is derived
                // from TOOL_STALL_MS (30 min by default), while Settings prominently
                // shows the silence threshold (10 min) -- so a notice saying "23 more
                // minutes" appeared to disagree with the 600 on screen. Both were right;
                // the interrupt needs BOTH bounds passed, so the later one governs.
                boundBy: toolLeftMs > quietLeftMs ? 'tool' : 'quiet',
                boundSeconds: Math.round(
                  (toolLeftMs > quietLeftMs ? TOOL_STALL_MS : WEDGE_CONFIRM_MS) / 1000,
                ),
              });
            }

            if (wedgeHandled || interrupting) return;
            if (!WEDGE_CONFIRM_MS) return;   // interrupt disabled in Settings
            // PROTOCOL TRUTH, and the only hard fact available: a tool the backend has
            // not closed means the turn is legitimately busy. Long commands (builds,
            // test suites, scripts) report nothing between the opening and closing
            // update, so without this every one of them looks like a hang.
            // Suppress while a tool call is plausibly still working — but BOUNDED. An
            // open call that has not been updated for TOOL_STALL_MS is treated as
            // breakage, otherwise a missing closing update disables detection for the
            // whole turn (measured: 5+ hours of silence with the interrupt switched off).
            if (toolIdleFor >= 0 && toolIdleFor < TOOL_STALL_MS) return;
            if (quietFor <= WEDGE_CONFIRM_MS) return;

            // Both bounds have passed, so this turn is wedged. There is deliberately no
            // third check: the CPU probe that used to postpone here was removed because
            // it could not distinguish computing from spinning, and made the timeout
            // non-deterministic. See the note where it used to be defined.
            wedgeHandled = true;
            interrupting = true;
            const staleToolCount = toolIdleFor >= 0 ? e.openToolCalls!.size : 0;
            const produced = !!(e.assistantBuf || e.fileChanges.length);
            const quietSeconds = Math.round(quietFor / 1000);
            const why = staleToolCount
              ? `${staleToolCount} tool call(s) open but stale for ${Math.round(toolIdleFor / 1000)}s`
              : 'no open tool call';
            // Written into the turn's own message (see flushAssistant). Phrased as OUR
            // timeout firing, not as a backend fault: a measured case had the tool
            // genuinely still working, so blaming the backend would have been false.
            const dur = (ms: number) => (ms < 90000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`);
            e.wedgeNote = staleToolCount
              ? `⚠️ 这一轮被 KiroLex 按超时中断：静默 ${dur(quietFor)}，其中 ${staleToolCount} 个工具调用有 ${dur(toolIdleFor)}没有进度更新（上限 ${Math.round(TOOL_STALL_MS / 60000)} 分钟）。工具本身可能仍在后台继续跑。可在设置「工具无进度多久判定卡死」里调大。`
              : `⚠️ 这一轮被 KiroLex 按超时中断：静默 ${dur(quietFor)}（上限 ${Math.round(WEDGE_CONFIRM_MS / 60000)} 分钟），没有工具在运行。可在设置「静默多久判定卡死」里调大。`;
            logger.warn('prompt', `WEDGED sessionId=${sessionId} cli=${entry.cliSessionId} quiet=${quietSeconds}s produced=${produced} -- ${why}, interrupting`);
            // `produced` is the whole payload the renderer acts on: it decides
            // auto-resend vs. leaving the partial reply alone. The human-readable
            // reason travels in wedgeNote instead, inside the turn's own message,
            // because a floating banner outlives the turn it describes.
            mainWindow?.webContents.send('acp:turn-wedged', { sessionId, produced });

            // Only the teardown is async now that nothing is probed before deciding.
            void (async () => {
              // Polite first: a cancel notification lets kiro-cli end the turn and
              // report its own stopReason.
              try { await entry.client.cancelPrompt(entry.cliSessionId); } catch { /* pipe may be dead */ }
              const deadline = Date.now() + 15000;
              while (entry.busy && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 250));
              }
              // A process blocked on a socket read may never service stdin, so the
              // cancel can go unanswered. Tearing down the executor rejects the
              // pending session/prompt, which is what actually releases the turn
              // (the catch below then flushes whatever was produced).
              if (entry.busy && sessionClients.get(sessionId) === entry) {
                logger.warn('prompt', `WEDGED sessionId=${sessionId} ignored session/cancel -- replacing executor`);
                try { await entry.client.disconnect(); } catch { /* already gone */ }
              }
            })();
          }, WATCHDOG_TICK_MS);
          // RUN EVENT LOG (events.jsonl, see eventLog.ts). Written here rather than
          // derived from the transcript because the transcript has one timestamp per
          // MESSAGE: the moment a turn starts and the moment it ends are otherwise
          // unrecoverable, and so is everything in between.
          const turnKey = entry.currentUserMessageId || `turn_${Date.now()}`;
          const turnStartedAt = Date.now();
          eventLog.appendEvent(sessionId, {
            ts: turnStartedAt,
            type: 'prompt_start',
            turn: turnKey,
            model: entry.profile.model,
            // What was actually SENT, memory block and ride-along snapshot included.
            // The transcript stores only the user's own text, so this is the one
            // record of how big the real request was.
            chars: prompt.reduce((sum: number, block: any) => sum + (typeof block?.text === 'string' ? block.text.length : 0), 0),
          });
          try {
            const result = await entry.client.sendPrompt(entry.cliSessionId, prompt);
            // Our OWN cancel ended this turn. kiro-cli does not always label it
            // A turn now ends ONLY because kiro-cli ended it or because the user
            // pressed Stop. There is no automatic cancel/retry any more, so any
            // stopReason we see is the backend's own verdict and is reported as-is.
            /* 这一轮成了 —— 那条后端对话是好的，两个连续失败计数都清零 */
            if (entry.cliSessionId) cliFailStreak.delete(entry.cliSessionId);
            bareFailStreak.delete(sessionId);
            const producedOutput = !!(entry.assistantBuf || entry.fileChanges.length);
            flushAssistant(sessionId); // turn complete -> persist the full assistant msg
            // The request was accepted and answered, so the snapshot it carried IS
            // in this backend now: the claim written before the send is confirmed.
            // Re-marked against the CURRENT entry rather than just clearing the
            // flag, because a mid-turn model swap replaced the executor (new pid,
            // and the catch below dropped the marker) -- the resend carried the same
            // snapshot, so the new backend is the one that must be recorded.
            if (rideAlong && entry.rideAlongUnconfirmed) {
              markContextEstablished(sessionId, entry);
              entry.rideAlongUnconfirmed = false;
            }
            // Surface WHY the turn ended. A non-end_turn reason (max_tokens,
            // refusal, ...) is exactly the "reply stopped mid-sentence with no
            // error" case -- it must not look like a normal completion.
            logger.info('prompt', `done sessionId=${sessionId} stopReason=${String(result?.stopReason ?? 'n/a')} produced=${producedOutput}`);
            eventLog.appendEvent(sessionId, {
              ts: Date.now(),
              type: 'prompt_end',
              turn: turnKey,
              ms: Date.now() - turnStartedAt,
              model: entry.profile.model,
              stopReason: String(result?.stopReason ?? 'n/a'),
              produced: producedOutput,
            });
            // 一轮结束就看看要不要压一次会话记忆 —— 不等它，也不让它影响这一轮的返回
            void maybeConsolidateSessionMemory(sessionId);
            // Tag the result so the renderer can flag an abnormal end even when
            // kiro-cli reports no stopReason at all (silent empty turn).
            return { ...(result || {}), __kirolex: { produced: producedOutput } };
          } catch (err: any) {
            // MODEL RETIRED MID-FLIGHT. The executor started fine, so the
            // connect-time fallback chain never saw a problem; the failure only
            // shows up here, in the response stream. Previously this dead-ended
            // every single send with a raw "Internal error — The model 'X' is not
            // available". Now: take over the SAME kiro-cli session with the next
            // model in the chain, persist + announce it, and resend once.
            let detail = '';
            try { detail = err?.data ? (typeof err.data === 'string' ? err.data : JSON.stringify(err.data)) : ''; } catch {}
            const text = `${err?.message || ''} ${detail}`;
            // The ride-along context was part of THIS failed request, so the backend
            // may never have received it. Drop the marker: the next message injects
            // again rather than assuming a history that was never delivered.
            // `rideAlongUnconfirmed` deliberately stays SET -- if this failure leads
            // to a model swap and the resend succeeds, the success path above
            // re-marks against the new executor.
            if (rideAlong) clearContextEstablished(sessionId);
            eventLog.appendEvent(sessionId, {
              ts: Date.now(),
              type: 'prompt_error',
              turn: turnKey,
              ms: Date.now() - turnStartedAt,
              model: entry.profile.model,
              detail: String(err?.message || err).slice(0, 300),
            });
            /**
             * **连着被拒绝生成 → 换模型重发**，用的是 model-unavailable 那条路同一套机器
             * （杀执行器、换模型、重载会话、`acp:turn-restart`、原样重发）。
             *
             * 为什么要有这一条：实测那 25 分钟里，换后端会话换了三个都没用（新会话上下文只占
             * 3.8% 照样失败），而人自己换个别的跑法就好了 —— 也就是说这种故障要动的是**模型**，
             * 不是会话。原来只有 kiro-cli 明说"这个模型不可用"才会换，而它对空响应从来不这么说。
             *
             * 两道闸：
             *   · `bareFailStreak >= POISONED_AFTER` —— 单次 Internal error 太常见，换模型是有代价的
             *     （~30 秒静默窗口，还会换掉你选的模型）；
             *   · **这一轮什么都没产出** —— 跑过工具的轮子换模型重发等于把副作用再做一遍。
             */
            const bareStreak = bareFailStreak.get(sessionId) || 0;
            const producedThisTurn = !!entry.assistantBuf || (entry.toolsThisTurn || 0) > 0;
            if (isBareInternalError(text) && bareStreak >= POISONED_AFTER && !producedThisTurn
                && emptySwaps < 1 && modelSwaps < MAX_MODEL_SWAPS) {
              modelSwaps++;
              emptySwaps++;
              const failedModel = entry.profile.model;
              triedModels.add(failedModel);
              eventLog.appendEvent(sessionId, {
                ts: Date.now(),
                type: 'model_swap',
                turn: turnKey,
                model: failedModel,
                detail: `后端连着 ${bareStreak + 1} 次拒绝生成（空响应），换模型重发`,
              });
              const swapped = await swapSessionModel(sessionId, failedModel, `prompt ${sessionId} 空响应`, triedModels);
              if (swapped) {
                const next = sessionClients.get(sessionId);
                if (next) {
                  logger.warn('prompt', `连着 ${bareStreak + 1} 次空响应，模型 '${failedModel}' → '${swapped}' 重发 sessionId=${sessionId}`);
                  noteInSession(sessionId, `🔀 后端连着 ${bareStreak + 1} 次拒绝为这一轮生成回答（kiro-cli 日志里是 `
                    + `\`EmptyResponse\`，流开了但一个 token 都没发）。换后端会话对这种情况没用`
                    + `（实测换三个都失败），所以这次换的是模型：${failedModel} → ${swapped}，原话原样重发。`);
                  entry = next;
                  entry.busy = true;
                  entry.turnSeq = myTurn;
                  entry.assistantBuf = '';
                  entry.assistantMsgId = null;
                  entry.fileChanges = [];
                  entry.toolsThisTurn = 0;
                  mainWindow?.webContents.send('acp:turn-restart', { sessionId });
                  continue;
                }
              }
            }
            if (isModelUnavailableError(text) && modelSwaps < MAX_MODEL_SWAPS) {
              modelSwaps++;
              eventLog.appendEvent(sessionId, {
                ts: Date.now(),
                type: 'model_swap',
                turn: turnKey,
                model: entry.profile.model,
                detail: `${entry.profile.model} 不可用，按回退链换模型重发`,
              });
              const failedModel = entry.profile.model;
              // An unavailable model CONNECTS fine and only fails once a turn runs,
              // so swapSessionModel cannot tell a dead candidate from a live one. It
              // therefore has to be told which ones already failed — otherwise it
              // hands back a model this turn has provably just rejected.
              triedModels.add(failedModel);
              const swapped = await swapSessionModel(sessionId, failedModel, `prompt ${sessionId}`, triedModels);
              if (swapped) {
                const next = sessionClients.get(sessionId);
                if (next) {
                  entry = next;                    // continue on the new executor
                  entry.busy = true;
                  entry.turnSeq = myTurn;
                  entry.assistantBuf = '';
                  entry.assistantMsgId = null;
                  entry.fileChanges = [];
                  mainWindow?.webContents.send('acp:turn-restart', { sessionId });
                  continue;                        // resend the same prompt
                }
              }
            }
            throw err;
          } finally {
            clearInterval(watchdog);
          }
        }
      } finally {
        const e = sessionClients.get(sessionId);
        if (e && e.turnSeq === myTurn) { e.busy = false; e.lastUsedAt = Date.now(); }
        emitSessionBusy(sessionId);
        /**
         * 一轮对话结束 —— 如果这条会话正在替某个 flow 节点干活，**在这里**把账记上。
         *
         * ## 为什么记账必须在主进程
         *
         * 原来这件事只发生在渲染层（那条驱动链已随 flow 移出这一版）。
         * 那个回调活在窗口的 JS 堆里，窗口一刷新（`Cmd+R`、dev-hot、崩一次）它就没了 —— 而**回复是主进程
         * 写进 transcript 的**，于是答案在磁盘上、账没记、节点永远停在 `running`。实测丢过一次 35 418 字
         * 的日历数据（靠 A 那套对账捞回来的）。
         *
         * 这一段就是本文件 3560 行那条注释说的原则的落地：「一件必须活过窗口的事，不能写在会跟窗口一起
         * 死的那一侧」；`acp:prompt` 本来就 owns turn completion。
         *
         * ## 为什么不需要新的登记表
         *
         * 「这条会话正在替哪个节点干活」磁盘上已经写着了：那个节点是 `running`、`sessionId` 是它、还存了
         * 实际发出去的 `prompt`。所以直接复用 `reconcileRun` —— 它按 `prompt` 在 transcript 里认领回复
         * （会话是复用的，只看"最后一条"会认错人）。同一个函数管三件事：这里、打开 run、启动。
         *
         * ## 位置的三个讲究
         *
         *   1. 在 `busy = false` **之后**：对账见到 busy 会让路（那是 A 的分界：不抢正在飞的那一轮）。
         *   2. 成功路径上 `flushAssistant`（3272）已经把回复落盘了，所以认领得到。
         *   3. 出错路径的 `flushAssistant`（3367）在这个 `finally` **之后**才跑，所以这里会判 `failed` ——
         *      这是对的：一段半截的输出不该被当成这一步的产出。判完就不是 `running` 了，后面那次落盘也
         *      不会让它被提拔成 `done`。而**出错原本是完全没人管的**：`.then` 不会在 reject 时执行，
         *      所以以前一次失败的发送同样把节点永久留在 `running` 上。
         *
         * 整段包在 try 里：记账再重要也不能让一轮正常的对话失败。
         */
        try {
          const rec = store.readRecord(sessionId) as any;
        } catch (err: any) {
          logger.warn('run', `post-turn reconcile skipped for ${sessionId}: ${err?.message || err}`);
        }
      }
    } catch (err: any) {
      flushAssistant(sessionId); // persist whatever completed before the error
      // Surface WHY: kiro-cli returns a bare JSON-RPC -32603 "Internal error"
      // for many backend faults (bad session state, stale lock, concurrent
      // prompt). Log the full error + any JSON-RPC `data` detail so it is
      // diagnosable, and enrich the thrown message when it's the bare form.
      let detail = '';
      try { detail = err?.data ? ` — ${typeof err.data === 'string' ? err.data : JSON.stringify(err.data)}` : ''; } catch {}
      /* 这一轮的规模跟着错误一起进日志 —— 「好像 curl 那个大 json 的时候断掉了」这种判断
         原来只能靠人去翻 tool 行数。 */
      logger.warn('prompt', `error sessionId=${sessionId} cli=${entry.cliSessionId}`
        + ` 工具=${entry.toolsThisTurn || 0} 最大工具输出=${entry.maxToolOutputThisTurn || 0}字符`
        + `: ${err?.message || err}${detail}`);
      /**
       * **去 kiro-cli 自己的日志里拿那句真话** ——「还是不知道为什么会断」。
       *
       * ACP 上回来的是万能包装（`Internal error — Kiro failed to generate a response`），
       * 而同一秒 kiro-cli 的日志里写的是 `err=EmptyResponse` / `dispatch failure` /
       * `ValidationException` —— 五种完全不同的病，在界面上长得一模一样。判据在 `kiroCliLog`。
       */
      const cliWhy = cliErrorContext();
      if (cliWhy) logger.warn('prompt', `kiro-cli 那边的原因 sessionId=${sessionId}: ${cliWhy}`);
      /**
       * **把这一刻整包留下来** —— 见 `failureBundle`。查到最后卡在"同一时间同一模型，
       * kiro-cli 里好的、KiroLex 里不好"，而故障不能按需复现；下一次犯的时候要能对着差异看，
       * 而不是再猜一轮。同一条会话 1 分钟内只落一包、每条只留最近 5 包。
       */
      const bundle = writeFailureBundle({
        sessionId,
        cliSessionId: entry.cliSessionId,
        promptText: (prompt || []).map((b: any) => (typeof b === 'string' ? b : b?.text || '')).join(''),
        error: `${err?.message || err}${detail}`,
        model: entry.profile.model,
        pid: entry.client.pid,
        toolsThisTurn: entry.toolsThisTurn || 0,
        maxToolOutput: entry.maxToolOutputThisTurn || 0,
        cliLogPath: kiroCliLogPath(),
        /* trace 开着的时候日志涨得极快，多抄一些才盖得住这一次请求 */
        cliLogTailBytes: kiroTraceEnabled() ? 8 * 1024 * 1024 : undefined,
      });
      if (bundle) logger.info('prompt', `失败现场已存档 sessionId=${sessionId} -> ${bundle}`);
      // kiro-cli refuses a second session/prompt while one is still running.
      // That is NOT a dead session: the earlier turn is alive in the backend
      // (often mid context-compaction). Say so plainly instead of leaking a raw
      // "Internal error", and keep the wording matchable as an active turn.
      if (/prompt already in progress/i.test(`${err?.message || ''}${detail}`)) {
        throw new Error('上一回合仍在后端运行（active turn，可能在压缩上下文）。请等它结束，或点 Stop 中断后再发送。');
      }
      // NOTE: an oversized image is deliberately NOT recovered from here.
      //
      // It genuinely poisons the backend's conversation -- Bedrock re-validates every
      // image in the replayed history, so once one is in, every later request in that
      // conversation is rejected regardless of what is sent next, and regardless of the
      // file on disk having since been shrunk. Swapping the backend did cure it, but it
      // is a compensation at the wrong layer: ~10s of teardown plus a deliberate
      // disconnect that reads as the chat dying, all to work around a constraint only
      // kiro-cli can actually enforce (it is the one party that holds the bytes AND
      // builds the request, so downscaling belongs in its image read).
      //
      // PREVENTION is what is kept, and it covers everything KiroLex hands over:
      // capImagePathsInText on this path and on steer, plus historyLine for the
      // snapshot. The only remaining hole is a file the MODEL picks itself, which
      // cannot be intercepted at all -- tool calls arrive as a `session/update`
      // NOTIFICATION (no response to veto) and KiroLex declares `capabilities: {}` so
      // reads never route through it. For that case the error is reported as-is.
      /* 这条后端对话又坏了一次 —— 连着到阈值就当它毒了（判据在 `staleVerdict`） */
      const failKey = entry.cliSessionId || '';
      const streak = (cliFailStreak.get(failKey) || 0) + 1;
      if (failKey) cliFailStreak.set(failKey, streak);
      /* 跨换会话累计的那一份 —— 换模型的判据要用它（见 bareFailStreak） */
      if (isBareInternalError(`${err?.message || ''}${detail}`)) {
        bareFailStreak.set(sessionId, (bareFailStreak.get(sessionId) || 0) + 1);
      }
      const verdict = staleVerdict({
        error: `${err?.message || ''}${detail}`,
        contextPid: store.readRecord(sessionId)?.contextEstablishedPid,
        clientPid: entry.client.pid,
        /**
         * **预算是 `MAX_AUTO_RETRIES` 次，不是一次** ——「你难道不能让它自动重试吗，挂了你他妈也不管啊」。
         *
         * 实测那条会话要换**三个**后端会话才通（9a74213c → f45ba8b6 → a9085b1c，最后
         * `produced=true`）。原来这里是 `alreadyRetried: retriedStale`，一次用户发送只肯自救一次，
         * 于是"换三次"被摊到三次手动重发上 —— 人看到的就是"总是断，也没人管"。
         */
        alreadyRetried: attempt >= MAX_AUTO_RETRIES,
        consecutiveFailures: streak,
        /* 刚换过一个几乎空的新会话又是同一个错 → 别再换（见 cliRecreatedAt） */
        lastRecreateAgoMs: cliRecreatedAt.has(sessionId) ? Date.now() - cliRecreatedAt.get(sessionId)! : undefined,
      });
      const errText = `${err?.message || ''}${detail}`;
      /**
       * **这一轮到底能不能自己重发** —— 判据在 `promptRetry`（纯的、有测试）。
       * 三条恢复路径（换会话、传输层抖动、后端笼统 Internal error）全部共用它，
       * 所以"已经跑过工具就不重发"这条硬闸不可能只在其中一条上生效。
       */
      const plan = planRetry({
        error: errText,
        attempt,
        producedText: !!entry.assistantBuf,
        toolsRan: entry.toolsThisTurn || 0,
      });
      if (verdict === 'recreate') {
        let made: { sessionId: string } | null = null;
        try {
          const oldId = entry.cliSessionId;
          /* 和 attach 那边同一个来源 —— cwd 不一致的话新会话会落在别的目录上 */
          const cwd = entry.cwd || sessionCwd(entry.profile, os.homedir());
          made = await entry.client.newSession(cwd);
          entry.cliSessionId = made.sessionId;
          const rec2 = store.readRecord(sessionId);
          if (rec2) { rec2.cliSessionId = made.sessionId; store.writeRecord(rec2); }
          /* 新会话里当然什么都没有 —— 清掉"已建立"，让上下文跟着这一次重发带过去 */
          clearContextEstablished(sessionId);
          markContextOwedIfUnverified(sessionId, 'stale-session-recreate');
          /* 换完 id，那条旧对话的失败计数就没意义了 */
          cliFailStreak.delete(oldId);
          cliRecreatedAt.set(sessionId, Date.now());
          const poisoned = streak >= POISONED_AFTER;
          const note = poisoned
            ? `后端连着 ${streak} 次拒绝为这段对话生成回答（${String(err?.message || '').slice(0, 60)}）——`
              + `pid 没变，所以不是"会话过期"，是这段历史本身后端咽不下去（常见成因：某次工具调用的结果）。`
              + `已经换成新的后端会话（${made.sessionId.slice(0, 8)}…）并把上下文带过去；磁盘上的对话记录一条都没动。`
            : staleRecoveryNote(oldId, made.sessionId,
              store.readRecord(sessionId)?.contextEstablishedPid ?? 0, entry.client.pid ?? 0);
          logger.warn('prompt', `${poisoned ? 'poisoned' : 'stale'} cli session recreated sessionId=${sessionId}: ${note}`);
          /*
            **在会话里说一句** —— 不说的话你看到的是"前几条都失败、这一条突然成了"，
            而中间换过后端会话这件事解释了为什么。只在"毒了"这条路上说：pid 不一致那条是常规现象
            （kiro-cli 不持久化 ACP 会话），每次都播报只会变成噪音。
          */
          if (poisoned) {
            noteInSession(sessionId, `♻️ ${note}`);
          }
        } catch (again: any) {
          /* 换会话本身失败了（连不上进程之类）—— 照实报原来那个错，不是这里的新错。 */
          logger.warn('prompt', `stale recreate FAILED sessionId=${sessionId}: ${again?.message || again}`);
          made = null;
        }
        /**
         * **换完会话要不要顺手重发** —— 这是"自动重试"和"自动重做副作用"的分界线。
         *
         * 这一轮已经跑过工具（或者已经流出过文字）时**只换会话、不重发**：后端会话换新的，
         * 下一条消息就落在干净的后端上，点一下重跑就能继续；而闭眼重发会把那 13 个
         * `aws ssm send-command` 再跑一遍。什么都没产出时才重发 —— 那时重发是幂等的。
         */
        if (made && !plan.retry && (plan.reason === 'side-effects' || plan.reason === 'produced')) {
          logger.warn('prompt', `换了新后端会话但不重发 sessionId=${sessionId}: `
            + `这一轮已产出（文字=${!!entry.assistantBuf} 工具=${entry.toolsThisTurn || 0} `
            + `最大工具输出=${entry.maxToolOutputThisTurn || 0} 字符），重发会重复副作用`);
          throw new Error(`${errText}\n\n`
            + `（这一轮已经跑了 ${entry.toolsThisTurn || 0} 个工具调用${bigOutputHint(entry.maxToolOutputThisTurn)}，`
            + '重发会把它们再执行一遍，所以 KiroLex 只换了新的后端会话'
            + `（${made.sessionId.slice(0, 8)}…）、没有自动重发。点重跑或者再发一条就会落在新会话上。）`
            + (cliWhy ? `\n\n${cliWhy}` : ''));
        }
        if (made && plan.retry) {
          await new Promise((r) => setTimeout(r, plan.delayMs));
          logger.info('prompt', `换完后端会话自动重发 sessionId=${sessionId} attempt=${attempt + 1}/${MAX_AUTO_RETRIES}`);
          return await sendPromptOnce(sessionId, prompt, projectId, display, _model, attempt + 1);
        }
      }
      /**
       * **自己重发** —— 「你难道不能让它自动重试吗，挂了你他妈也不管啊」。
       *
       * 两类错走这一条：传输层抖动（`dispatch failure`，实测一条会话上 9 次、6 次挤在 20 秒内）和
       * kiro-cli 的笼统 `Internal error`（"生成不出回答"）。两者的共同点是**重发有可能就好**，
       * 而原来两者都是把原话甩到界面上、等人再发一遍。
       *
       * 闸全在 `planRetry` 里（`producedText` / `toolsRan` / 预算），所以这里只剩"发"。
       * 递增间隔：瞬时故障立刻重试还是同一个结果。
       */
      if (plan.retry) {
        logger.warn('prompt', `自动重发 ${attempt + 1}/${MAX_AUTO_RETRIES}（等 ${plan.delayMs}ms）`
          + ` sessionId=${sessionId}: ${errText.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, plan.delayMs));
        return await sendPromptOnce(sessionId, prompt, projectId, display, _model, attempt + 1);
      }
      /* 预算用光了：说清试过几次 —— 不然看着像"它就是不行"，而实际上已经试了 4 次。 */
      if (plan.reason === 'budget') {
        logger.warn('prompt', `自动重发用光预算（${attempt} 次）sessionId=${sessionId}: ${errText.slice(0, 160)}`);
        const why = cliWhy ? `\n\n${cliWhy}` : '';
        throw new Error(isTransientTransportError(errText)
          ? `连不上后端（${errText.slice(0, 120)}）—— KiroLex 自己重发了 ${attempt} 次都失败。检查网络/VPN 后再发一次。${why}`
          : retriesExhaustedNote(errText, attempt) + why);
      }
      if (/^internal error$/i.test(String(err?.message || '')) && detail) {
        const e2: any = new Error(`${err.message}${detail}${cliWhy ? `\n\n${cliWhy}` : ''}`);
        throw e2;
      }
      /* 报出去之前把 kiro-cli 那句真话带上 —— 光一句 Internal error 谁也不知道该干什么 */
      if (cliWhy && isBareInternalError(errText)) throw new Error(`${errText}\n\n${cliWhy}`);
      throw err;
    }
  }

  /**
   * WHAT IS THIS SESSION DOING RIGHT NOW, and what has it produced so far.
   *
   * Exists so an interrupted-looking chat can be RECOVERED BY ADOPTION rather than by resending.
   * A window reload does not stop a turn: this process holds the ACP connection, keeps filling
   * `assistantBuf`, and flushes the complete text when the turn ends. The renderer had no way to
   * learn that, so it resent the question and paid for the same answer twice.
   *
   * Live state only -- `sessionClients`, never the transcript on disk. A completed turn is
   * already IN the transcript; the whole point here is the part that is not.
   */
  ipcMain.handle('acp:peek-turn', (_event, sessionId: string) => {
    const entry = sessionId ? sessionClients.get(sessionId) : undefined;
    // `priming` is a turn KIROLEX issued (a history rebuild), and its output is suppressed
    // everywhere -- not forwarded, not accumulated, not persisted. Reporting it as live would
    // be the one way that internal reply could still reach the user's chat.
    if (!entry || !entry.busy || entry.priming) {
      return { live: false, messageId: null, text: '', startedAt: null };
    }
    return {
      live: true,
      messageId: entry.assistantMsgId,
      text: entry.assistantBuf || '',
      startedAt: entry.lastUsedAt ?? null,
    };
  });

  ipcMain.handle('acp:cancel', async (
    _event,
    sessionId: string,
    _model?: string,
    suppressInterruptionNotice = false,
  ) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) return { idle: true };
    // Stop DURING a rebuild = the user opting out of the rebuild. Earlier this was
    // refused outright, which left them with no way to stop anything at all (Stop
    // became a no-op and even a pending auto-resend could not be called off). A
    // lock the user cannot escape is worse than the problem it prevents, so: abort
    // the rebuild, release the session, and keep the flag so it can be retried
    // later from the right-click menu.
    if (entry.priming) {
      entry.primeAbandoned = true;
      primeModelsTried.delete(sessionId);
      logger.info('prime', `ABANDONED by user (stop) sessionId=${sessionId} — releasing session, history stays incomplete (cursor=${entry.primeCursor}/${entry.primeChunks?.length ?? '?'})`);
      try { await entry.client.cancelPrompt(entry.cliSessionId); } catch {}
      emitSessionBusy(sessionId);
      return { idle: false, abandonedPrime: true };
    }
    // Stop while a rebuild is merely OWED: cancel the obligation rather than
    // silently doing nothing, so the chat becomes usable immediately.
    if (entry.needsHistoryPrime && !entry.primeAbandoned) {
      entry.primeAbandoned = true;
      primeModelsTried.delete(sessionId);
      logger.info('prime', `pending rebuild ABANDONED by user (stop) sessionId=${sessionId}`);
      emitSessionBusy(sessionId);
      return { idle: true, abandonedPrime: true };
    }
    entry.suppressCancellationChunks = suppressInterruptionNotice;
    try {
      await entry.client.cancelPrompt(entry.cliSessionId);

      // session/cancel is a notification, so wait for the in-flight prompt RPC to
      // settle before allowing an interrupt-and-steer prompt onto the same client.
      const deadline = Date.now() + 10000;
      while (entry.busy && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (entry.busy) throw new Error('Timed out waiting for the active turn to stop.');
      flushAssistant(sessionId); // preserve partial output produced before cancel
      return { idle: true };
    } finally {
      entry.suppressCancellationChunks = false;
    }
  });

  // Mid-turn steer: inject text into the CURRENTLY RUNNING turn via kiro-cli's
  // _session/steer, on the SAME executor/connection. Unlike acp:prompt this does
  // NOT set busy, does NOT start a new turn, and does NOT cancel the in-flight
  // prompt — the steered reply streams back inside the same session/prompt and
  // is accumulated by wireSession like any other chunk. Returns { steered,
  // reason } so the renderer can fall back to the queue (never dropping the
  // message) when the turn is not steerable.
  //
  // The steered user message is deliberately not persisted HERE, because a steer
  // that is written into the turn is not yet a steer the backend accepted: an
  // un-consumed one is reconciled back into the queue and re-sent through
  // acp:prompt, which persists it there, so writing it now would double it. It IS
  // persisted — on the CONSUMED notification, via acp:persist-steer below. Until
  // that existed, a consumed steer never reached the transcript at all, and since
  // the ride-along snapshot and history.md are both rendered from the transcript, a
  // restored chat showed the model answering a question nobody had asked.
  ipcMain.handle('acp:steer', async (_event, sessionId: string, message: string) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) return { steered: false, reason: 'not-connected' };
    if (reconfiguringSessions.has(sessionId)) return { steered: false, reason: 'reconfiguring' };
    // A history rebuild is a LOCKED task, not a conversational turn. Steering into
    // it would inject the user's text into a hidden priming turn (invisible, and
    // answered without the very context being restored). Report it as queueable so
    // the renderer parks the message until the rebuild finishes.
    if (entry.priming) {
      logger.info('prime', `steer REFUSED during rebuild sessionId=${sessionId} -> renderer should queue`);
      return { steered: false, reason: 'priming' };
    }
    if (!entry.client.supportsSteer) return { steered: false, reason: 'unsupported' };
    // A steer only makes sense while a turn is actually in flight. If the turn
    // already finished (race between the renderer deciding to steer and this IPC
    // arriving), report idle so the renderer queues it instead — it will drain
    // immediately on the now-idle session.
    if (!entry.busy) return { steered: false, reason: 'idle' };
    entry.lastUsedAt = Date.now();
    // Same cap as the prompt path: a steer can carry attachments too.
    const steered = entry.client.steer(entry.cliSessionId, capImageRefsInText(message));
    return { steered, reason: steered ? undefined : 'write-failed' };
  });

  /** Persist a steer that the backend reported CONSUMED.
   *
   *  Steers bypass acp:prompt entirely (they are written into the turn already
   *  running), so this is the only writer for them. Without it the durable
   *  transcript kept the assistant reply that answered a steer but not the steer,
   *  which matters beyond display: the ride-along context snapshot and history.md
   *  are both rendered FROM that transcript, so every restored chat showed the
   *  model answering a question that was not in the conversation.
   *
   *  Stored as an append-only merge event rather than a standalone message, using
   *  the machinery that already exists for it (`mergeIntoMessageId`, folded into the
   *  base user message by readTranscript) — which is also exactly how the renderer
   *  renders it: one user bubble, the steers as separate paragraphs inside it.
   *
   *  Called on CONSUMED only. An un-consumed steer goes back to the queue and is
   *  re-sent through acp:prompt, which persists it there. */
  ipcMain.handle('acp:persist-steer', async (_event, sessionId: string, text: string, messageId?: string) => {
    if (!sessionId || !text) return { ok: false, error: 'no text' };
    const entry = sessionClients.get(sessionId);
    // The turn's own user message is the merge target. If it is unknown (a steer
    // into a turn this process did not start — e.g. after a hot restart), fall back
    // to a standalone user message: out of order is still better than lost.
    const mergeInto = entry?.currentUserMessageId;
    try {
      store.appendMessage(sessionId, {
        id: messageId || `steer_${Date.now()}`,
        role: 'user',
        content: text,
        ts: Date.now(),
        ...(mergeInto ? { mergeIntoMessageId: mergeInto } : {}),
      });
      logger.info('prompt', `steer persisted sessionId=${sessionId} chars=${text.length} mergeInto=${mergeInto || '<none, standalone>'}`);
      return { ok: true, merged: !!mergeInto };
    } catch (err: any) {
      logger.warn('prompt', `steer persist FAILED sessionId=${sessionId} err=${err?.message || err}`);
      return { ok: false, error: err?.message || 'append failed' };
    }
  });

  /** Persist a note the RENDERER produced, as an assistant message.
   *
   *  Same reason `acp:persist-steer` exists: a message created in the renderer
   *  reaches `setMessages` and the in-memory cache but NOT the durable transcript,
   *  so it dies with the window. The loop's terminal reason is precisely the fact
   *  that must outlive the run — "why did this loop stop" is unanswerable after a
   *  restart otherwise, which is the defect this whole feature set is about.
   *
   *  Deliberately narrow: assistant role, one short text, no tool calls, and only
   *  for a session that already exists on disk. It is NOT a general-purpose writer
   *  for model output — that path stays with `acp:prompt`, which owns turn
   *  completion and the asymmetric-durability rule. */
  ipcMain.handle('acp:persist-note', async (_event, sessionId: string, text: string) => {
    if (!sessionId || !text || !text.trim()) return { ok: false, error: 'no text' };
    if (!store.readRecord(sessionId)) return { ok: false, error: 'unknown session' };
    const content = text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
    try {
      store.appendMessage(sessionId, {
        id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        role: 'assistant',
        content,
        ts: Date.now(),
      });
      logger.info('loop', `note persisted sessionId=${sessionId} chars=${content.length}`);
      return { ok: true };
    } catch (err: any) {
      logger.warn('loop', `note persist FAILED sessionId=${sessionId} err=${err?.message || err}`);
      return { ok: false, error: err?.message || 'append failed' };
    }
  });

  /** Verifier commands the USER approved by starting a loop, per session.
   *
   *  This is the guard that makes `loop:verify` narrower than "run anything":
   *  verification only accepts a command that is byte-identical to the one
   *  registered here, so a later call cannot substitute a different one. It matters
   *  because the whole value of out-of-band verification is that the agent does not
   *  choose the check — if model output could reach this map, the model could
   *  propose `true` and maker/checker separation would be gone on round one. */
  const registeredVerifiers = new Map<string, { command: string; timeoutSec: number }>();
  /** One verifier per session at a time: a slow check must not be re-entered by the
   *  next round while it is still running. */
  const verifiersInFlight = new Set<string>();

  ipcMain.handle('loop:register-verifier', (_event, sessionId: string, command: string, timeoutSec: number) => {
    if (!sessionId) return { ok: false, error: 'no session' };
    if (!command || !command.trim()) {
      registeredVerifiers.delete(sessionId);
      logger.info('loop', `verifier cleared sessionId=${sessionId}`);
      return { ok: true, registered: false };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ok: false, error: rejected };
    registeredVerifiers.set(sessionId, { command, timeoutSec });
    logger.info('loop', `verifier registered sessionId=${sessionId} timeoutSec=${timeoutSec} command=${JSON.stringify(command)}`);
    return { ok: true, registered: true };
  });

  /** Run this session's registered verifier once, OUT OF BAND.
   *
   *  On the same host as the agent: a remote session's check runs over SSH in the
   *  remote workdir, because a verifier inspecting the local filesystem while the
   *  agent edits an EC2 box reports green forever. The remote decision comes from
   *  the session's own profile, exactly like the executor's. */
  ipcMain.handle('loop:verify', async (_event, sessionId: string, command: string, timeoutSec: number) => {
    if (!sessionId) return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: 'no session' };
    const approved = registeredVerifiers.get(sessionId);
    if (!approved || approved.command !== command) {
      // Not an error the user caused: it means something asked to run a command
      // this session's loop never declared.
      logger.warn('loop', `verify REFUSED sessionId=${sessionId} — command not registered by a loop start`);
      return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: '校验命令未经循环设置登记，已拒绝执行' };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: rejected };
    if (verifiersInFlight.has(sessionId)) {
      return { ran: false, exitCode: null, output: '', host: 'local', durationMs: 0, timedOut: false, error: '上一次校验尚未结束' };
    }
    const record = store.readRecord(sessionId);
    const profile = record?.profile;
    const entry = sessionClients.get(sessionId);
    const remote = profile?.remote?.sshHost ? profile.remote : undefined;
    // Prefer the LIVE executor's cwd for a local session: that is the directory the
    // agent is actually working in. Fall back to the profile's resolved session cwd.
    const cwd = remote
      ? sessionCwd(profile!, os.homedir())
      : (entry?.cwd || (profile ? sessionCwd(profile, os.homedir()) : os.homedir()));
    verifiersInFlight.add(sessionId);
    try {
      // The ssh builders come from acp-client, i.e. the executor's own: the check
      // has to be launched by the same rules as the agent it is checking.
      const result = await loopVerify.runVerifier(
        { command, timeoutSec, cwd, remote }, shellEnv, { buildSshArgs, shellQuote });
      logger.info('loop', `verify sessionId=${sessionId} host=${result.host} cwd=${cwd}`
        + ` exit=${result.exitCode ?? 'n/a'} ran=${result.ran} ms=${result.durationMs} command=${JSON.stringify(command)}`);
      return result;
    } finally {
      verifiersInFlight.delete(sessionId);
    }
  });

  /* ─────────────────────────── SCHEDULED TASKS ───────────────────────────
   *
   * Replaces loop mode. The loop re-sent a message and judged each round with a verifier
   * command, stopping when the check passed -- a coding shape. The real scenarios here
   * (weekly report, SFDC logging, oncall) are time-triggered: the previous run's result
   * does not change the next run's action, which is the only test of whether something is
   * a loop. So there is no goal and no verifier.
   *
   * THE TICKER LIVES HERE, not in the renderer, and that is the whole point: "every Monday
   * 9am" has to fire with no window open. The old loop's `setTimeout` lived in `useAcp`,
   * so closing the window stopped it.
   *
   * EACH RUN IS INDEPENDENT. Nothing from the previous run is injected -- KiroCrew's cron
   * calls accumulated context "the other half of the bug" (cron.py:204) and shipped a
   * stateless mode to switch it off, because carrying the last result forward is what makes
   * a scheduled job report the same thing every morning. */
  const SCHEDULE_TICK_MS = 20_000;
  /** Jobs currently mid-run, so a slow turn is never re-entered by the next tick. */
  const schedulesInFlight = new Set<string>();

  async function runScheduledJob(job: scheduleStore.StoredSchedule): Promise<void> {
    const { id, state } = job;
    if (schedulesInFlight.has(id)) return;
    schedulesInFlight.add(id);
    try {
      // CHARGE THE RUN FIRST, and flush it. Recording only on completion means a process
      // killed mid-run forgets it paid -- the shape of a job that bills a turn per restart.
      const charged = recordRun(state, Date.now());
      scheduleStore.writeSchedule(id, charged, os.homedir());

      let failure: string | undefined;
      try {
        await sendPromptOnce(state.sessionId, [{ type: 'text', text: state.spec.prompt }], undefined, {
          messageId: `sched_${id}_${Date.now()}`,
          displayText: state.spec.prompt,
        });
      } catch (err: any) {
        failure = err?.message || '发送失败';
      }

      // Re-read: the user may have paused or removed the job during the turn.
      const latest = scheduleStore.readSchedule(id, os.homedir());
      if (!latest) return;
      const settled = { ...latest.state, lastError: failure ?? null };
      const terminal = scheduleTerminal(settled);
      const final = terminal ? { ...settled, terminal } : settled;
      scheduleStore.writeSchedule(id, final, os.homedir());
      logger.info('schedule', `run id=${id} session=${state.sessionId} runs=${final.runs}/${final.spec.maxRuns}`
        + ` error=${failure ? JSON.stringify(failure) : 'none'} terminal=${terminal ?? 'none'}`);

      if (terminal) {
        try {
          store.appendMessage(state.sessionId, {
            id: `sched_end_${Date.now()}`,
            role: 'assistant',
            content: `⏰ 定时任务结束：${scheduleTerminalLabel(terminal)}\n${describeSchedule(final.spec)} · 共运行 ${final.runs} 次`,
            ts: Date.now(),
          });
        } catch {}
      }
      mainWindow?.webContents.send('schedule:changed', { id, state: final });
    } finally {
      schedulesInFlight.delete(id);
    }
  }

  const scheduleTicker = setInterval(() => {
    const now = Date.now();
    for (const job of scheduleStore.listSchedules(os.homedir())) {
      if (isDue(job.state, now)) void runScheduledJob(job);
    }
  }, SCHEDULE_TICK_MS);
  app.on('before-quit', () => clearInterval(scheduleTicker));

  ipcMain.handle('schedule:create', (_event, sessionId: string, spec: ScheduleSpec) => {
    if (!sessionId || sessionId.startsWith('pending_')) return { ok: false, error: '请先选择一个已创建的会话' };
    const problems = validateSchedule(spec);
    if (problems.length) return { ok: false, error: problems.join('；') };
    const id = `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const state = newSchedule(sessionId, spec, Date.now());
    scheduleStore.writeSchedule(id, state, os.homedir());
    logger.info('schedule', `created id=${id} session=${sessionId} ${describeSchedule(spec)} maxRuns=${spec.maxRuns}`);
    // Announced like every other mutation: the window that created the job learns of it the
    // same way as any other, so its banner appears without a reload. The end of a RUN used to
    // be the only broadcast, which left create/pause/remove invisible until the next reload.
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true, id, nextRunAt: nextRunAt(state), describe: describeSchedule(spec) };
  });

  ipcMain.handle('schedule:list', () => scheduleStore.listSchedules(os.homedir()).map((job) => ({
    id: job.id,
    sessionId: job.state.sessionId,
    prompt: job.state.spec.prompt,
    describe: describeSchedule(job.state.spec),
    runs: job.state.runs,
    maxRuns: job.state.spec.maxRuns,
    paused: job.state.paused,
    terminal: job.state.terminal,
    lastRunAt: job.state.lastRunAt,
    lastError: job.state.lastError,
    nextRunAt: nextRunAt(job.state),
  })));

  ipcMain.handle('schedule:pause', (_event, id: string, paused: boolean) => {
    const job = scheduleStore.readSchedule(id, os.homedir());
    if (!job) return { ok: false, error: '找不到这个定时任务' };
    const state = { ...job.state, paused };
    scheduleStore.writeSchedule(id, state, os.homedir());
    logger.info('schedule', `${paused ? 'paused' : 'resumed'} id=${id}`);
    mainWindow?.webContents.send('schedule:changed', { id, state });
    return { ok: true };
  });

  ipcMain.handle('schedule:remove', (_event, id: string) => {
    scheduleStore.removeSchedule(id, os.homedir());
    logger.info('schedule', `removed id=${id}`);
    // `state: null` says GONE. The renderer re-reads the list either way, but a payload that
    // omitted the outcome would make "removed" indistinguishable from "changed somehow".
    mainWindow?.webContents.send('schedule:changed', { id, state: null });
    return { ok: true };
  });

  /* ────────────────────── DURABLE LOOP COUNTER ──────────────────────
   *
   * The round counter is owned HERE, not in the window that started the loop. It used
   * to live in the renderer's `loopsRef`, which meant closing or reloading the window
   * reset it to zero -- so a loop declared "at most 20 rounds" got a fresh 20 on every
   * restart, and its budget was not a budget at all.
   *
   * The send path is still driven from the renderer (it needs the streaming state and
   * the message list). What moved is the part that must survive: the count, the budget
   * decision, and the recorded reason a run ended. */
  ipcMain.handle('loop:persist', (_event, sessionId: string, run: any) => {
    if (!sessionId || !run?.spec?.stop) return { ok: false, error: 'no run' };
    try {
      loopStore.writeLoop(sessionId, run, os.homedir());
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'persist failed' };
    }
  });

  /** Charge a round against the DURABLE counter and checkpoint it before it is sent.
   *  The renderer must call this instead of counting locally, or the count goes back to
   *  being per-window. */
  ipcMain.handle('loop:begin-round', (_event, sessionId: string) => {
    const result = loopStore.beginRound(sessionId, os.homedir(), Date.now());
    if (result.run) {
      logger.info('loop', `round sessionId=${sessionId} iteration=${result.run.iteration}`
        + `/${result.run.spec.stop.maxIterations} terminal=${result.terminal ?? 'none'}`);
    }
    return result;
  });

  ipcMain.handle('loop:read', (_event, sessionId: string) => loopStore.readLoop(sessionId, os.homedir()));
  ipcMain.handle('loop:list-live', () => loopStore.listLiveLoops(os.homedir()));
  ipcMain.handle('loop:clear', (_event, sessionId: string) => {
    loopStore.clearLoop(sessionId, os.homedir());
    return { ok: true };
  });

  /* ─────────────────────────── SKILL FLOWS ───────────────────────────
   *
   * A flow is the reliable, step-by-step half of a skill: declared steps, out-of-band
   * checks, human approval gates, and per-item idempotency for anything that writes to
   * an external system.
   *
   * The DRIVER lives in flowDriver.ts and the DECISIONS in flowRun.ts; this section is
   * only the wiring — it supplies the three effects the driver cannot perform itself
   * (send a prompt, run a check, write the record) and exposes them over IPC.
   *
   * Runs in flight, so a gate's answer reaches the run that is waiting for it. NOT the
   * source of truth: that is the file on disk, which is why a run answered after a
   * restart still works. */
  const liveFlowRuns = new Map<string, { sessionId: string; flowPath?: string; driving: boolean }>();

  /** Verifier commands a FLOW declared, per run. Same guard as the loop's registry and
   *  for the same reason: `loop:verify` only executes a command a human put in a file,
   *  never one that came back from a model. A flow's commands are read from flow.yaml
   *  at load time and registered here, before any step runs. */
  const flowVerifiers = new Map<string, Set<string>>();

  /** Run one flow step's check out of band, on the agent's own host. Deliberately built
   *  on the same `loopVerify` module as the loop: a second copy of the remote/local
   *  decision is exactly the thing that drifts and silently verifies the wrong host. */
  async function runFlowVerify(runId: string, sessionId: string, command: string, timeoutSec: number) {
    const allowed = flowVerifiers.get(runId);
    if (!allowed?.has(command)) {
      logger.warn('flow', `verify REFUSED runId=${runId} — command not declared by the flow file`);
      return { ran: false, exitCode: null, output: '', error: '校验命令不在流程声明中，已拒绝执行' };
    }
    const rejected = loopVerify.rejectRequest(command, timeoutSec);
    if (rejected) return { ran: false, exitCode: null, output: '', error: rejected };
    const record = store.readRecord(sessionId);
    const profile = record?.profile;
    const entry = sessionClients.get(sessionId);
    const remote = profile?.remote?.sshHost ? profile.remote : undefined;
    const cwd = remote
      ? sessionCwd(profile!, os.homedir())
      : (entry?.cwd || (profile ? sessionCwd(profile, os.homedir()) : os.homedir()));
    const result = await loopVerify.runVerifier(
      { command, timeoutSec, cwd, remote }, shellEnv, { buildSshArgs, shellQuote });
    logger.info('flow', `verify runId=${runId} host=${result.host} exit=${result.exitCode ?? 'n/a'}`
      + ` ran=${result.ran} ms=${result.durationMs} command=${JSON.stringify(command)}`);
    return result;
  }

  /**
   * RUNS — the instances a project owns. 「只把在运行中的skill归属到project」.
   *
   * Main is the single source of truth on purpose: the run canvas opens in its OWN window (the user's
   * choice), and two windows agreeing about a status is only possible if neither of them owns it. Every
   * change is broadcast to every window.
   */
  /**
   * 注册表变了就说一声 —— 「flow 应该在第一次生成的时候就保存,这样可以直接通过写文件的方式刷新」。
   *
   * 有了它,画布就不必靠内存里那份状态活着:落盘 → 广播 → 界面按文件重画。一份真相,重启也一致。
   */
  const broadcastFlowReg = (name: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('flowreg:changed', { name });
    }
  };

  const broadcastRun = (project: string, id: string) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('run:changed', { project, id });
    }
  };

  /**
   * 打开一个 run 的时候对一次账。
   *
   * 启动那一遍收拾的是"上次退出时留下的"；这一遍收拾的是"窗口刷新之后那一轮才答完的"—— 主进程没重启，
   * 所以启动清扫不会再跑，而那一轮完成时已经没有渲染层在等它了。你回来看这个 run 的时候正好是该发现
   * 它的时候。
   */
  /**
   * 清掉一条会话在后端的活动上下文 —— flow 复用会话时用。
   *
   * 「flow 里面确实存在几个步骤在同一个会话里面跑，但这些应该只保留关键信息，否则可能长期跑 flow
   * 会变得臃肿」。走 kiro-cli 的 `/clear`，和你在输入框里敲它是同一条路：**只清模型那一侧的对话，
   * 磁盘上的 transcript 不动**，所以这一步之前发生过什么仍然查得到，审计链完整。
   *
   * 为什么不是"每步调一次模型压缩"：那要花钱，而且压缩本身会丢东西。而该留的关键信息**已经结构化地
   * 留在别处了** —— 每一步的产出按 `produces` 进 run 的 `values`，下一步按 `consumes` 拼进自己的提示词。
   * 赖在会话里的那一份是纯冗余。判据（哪些步骤可以清）见 `flowContext.shouldClearBeforeStep`。
   *
   * `display` 不给可见文本：这是流程的内务，不该在你的对话里留下一条"用户说了 /clear"。
   */
  ipcMain.handle('acp:clear-context', async (_event, sessionId: string) => {
    if (!sessionId?.trim()) return { ok: false, error: '没有指定会话' };
    try {
      await sendPromptOnce(sessionId, [{ type: 'text', text: '/clear' }], undefined, {
        messageId: `flow_clear_${Date.now()}`,
      });
      logger.info('flow', `cleared context sessionId=${sessionId}`);
      return { ok: true };
    } catch (err: any) {
      // 清不掉不该让这一步跑不了 —— 最坏结果是上下文继续臃肿，而那是可以忍的
      logger.warn('flow', `clear context failed sessionId=${sessionId}: ${err?.message || err}`);
      return { ok: false, error: err?.message || 'clear failed' };
    }
  });

  /**
   * project 的工作目录 —— 它的会话都在这儿干活。
   *
   * 读:界面要显示当前值。写:先校验(不存在 / 不是目录 / 不是绝对路径都当场说),因为它错了的表现是
   * 「所有会话都起不来」,那时候人只会看到一条抽象的失败。
   */
  ipcMain.handle('project:get-workspace', async (_event, project: string) => ({
    workspace: projectStore.readProject(os.homedir(), project).workspace || '',
  }));

  ipcMain.handle('project:set-workspace', async (_event, project: string, workspace: string) => {
    const why = projectStore.whyNotWorkspace(workspace);
    if (why) return { ok: false, error: why };
    projectStore.writeProject(os.homedir(), project, { workspace });
    logger.info('project', `${project} workspace=${workspace || '(cleared → home)'}`);
    return { ok: true };
  });

  /**
   * OPEN THE CHAT THAT RAN A STEP — from the run window, in the main window.
   *
   * A run's steps each execute in their own session, and 「执行状态要在普通对话 UI 里看得见」: the canvas says
   * WHICH step is running, and the conversation is where you read what it actually said. The run window has no
   * chat of its own on purpose — there is no single conversation for a whole run.
   */
  ipcMain.handle('window:focus-session', async (_event, sessionId: string) => {
    if (!sessionId?.trim()) return { ok: false, error: '没有会话 id' };
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: '主窗口不在' };
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('session:focus-request', { sessionId });
    return { ok: true };
  });

  /**
   * THE RUN CANVAS GETS ITS OWN WINDOW — the user's decision, and it needs main to own the state (above).
   *
   * Same renderer bundle, different view, chosen by query string: `?view=run`. One window per run, so asking
   * twice focuses the one already open rather than opening a second copy of the same thing.
   */
  const runWindows = new Map<string, BrowserWindow>();
  ipcMain.handle('window:open-run', async (_event, project: string, id: string) => {
    const key = `${project}/${id}`;
    const open = runWindows.get(key);
    if (open && !open.isDestroyed()) { open.focus(); return { ok: true, focused: true }; }
    const win = new BrowserWindow({
      width: 1180,
      height: 720,
      minWidth: 640,
      minHeight: 420,
      backgroundColor: '#1a1a1a',
      autoHideMenuBar: true,
      title: `运行 · ${id}`,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    runWindows.set(key, win);
    win.on('closed', () => runWindows.delete(key));
    const query = `view=run&project=${encodeURIComponent(project)}&run=${encodeURIComponent(id)}`;
    if (IS_DEV) win.loadURL(`${DEV_SERVER_URL}/?${query}`);
    else win.loadFile(path.join(__dirname, '../renderer/index.html'), { search: query });
    logger.info('run', `opened window for ${key}`);
    return { ok: true };
  });

  const approvalLocks = new Map<string, Promise<void>>();

  /**
   * THE ACTUAL DELETE — no guard here on purpose.
   *
   * 「这些会话应该删不了才对，都得让 flow 自行处理」：worker 会话属于**那次运行**，不属于侧栏。所以手删被
   * 拒（上面那道守卫），而 flow 自己的回收（重置一步、删一次运行、删一个 flow 的历史）必须仍然收得掉它
   * —— 否则「不许手删」就等于「永远删不掉」。守卫放在 IPC 那一层，这个函数是两条路共用的动作。
   */
  const purgeSession = async (sessionId: string): Promise<{ ok: boolean; tombstoned?: boolean; error?: string }> => {
    // Kill this chat's executor first (frees a slot, stops the kiro-cli process)
    // so deleting a chat never leaves an orphaned process running.
    //
    // Log WHAT is being deleted before touching anything. This path used to log
    // nothing at all, so when a 37-message chat vanished the only trace was the
    // parent directory's mtime -- who deleted it, and what it contained, were
    // unrecoverable facts. Title and size make an accidental delete obvious.
    try {
      const doomed = store.readRecord(sessionId);
      const bytes = store.transcriptFileSize(sessionId);
      logger.info('delete-session', `requested sessionId=${sessionId} title=${JSON.stringify(doomed?.title || '')}`
        + ` project=${JSON.stringify(doomed?.profile?.projectId || '')} transcriptBytes=${bytes}`);
    } catch {}
    deletedSessionIds.add(sessionId); // block any racing/subsequent load-session resurrection
    // Durable tombstone FIRST: `deletedSessionIds` is in-memory only, so if the
    // directory cannot be removed right now (kiro-cli may still hold the
    // transcript open — disconnect is asynchronous) the chat used to come back on
    // the next boot. The tombstone hides it and gets the removal retried.
    addSessionTombstone(sessionId);
    detachExecutor(sessionId);

    // Remove the directory, retrying briefly: rmSync can fail with EBUSY/EPERM
    // while the just-disconnected process releases its file handles. The old code
    // called rmSync once with no try/catch, so a failure rejected the IPC — and the
    // renderer swallowed that error, leaving the chat on disk to be rehydrated.
    //
    // RECOVERABLE BY DEFAULT: the directory is MOVED to ~/.kirolex/trash/ rather
    // than destroyed. A real chat -- 37 messages, its rendered history, its whole
    // transcript -- was lost this way, and with no Time Machine destination and no
    // local snapshots on this machine there was nothing to restore from. A rename
    // is also atomic and cannot half-finish, unlike a recursive delete. Only the
    // trash is ever hard-deleted, and only once it ages out.
    const removeDir = (dir: string): string | null => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          if (!fs.existsSync(dir)) return null;
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const grave = path.join(SESSION_TRASH_DIR, `${sessionId}__${stamp}`);
          fs.mkdirSync(SESSION_TRASH_DIR, { recursive: true });
          fs.renameSync(dir, grave);
          if (!fs.existsSync(dir)) {
            logger.info('delete-session', `moved to trash: ${grave} (restore by moving it back to ${dir})`);
            return null;
          }
        } catch (err: any) {
          // A cross-device rename (or a locked directory) cannot be helped by
          // retrying forever; fall back to the destructive path on the last try so
          // "delete" never silently fails and resurrects the chat on next boot.
          if (attempt === 4) {
            try {
              fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
              logger.warn('delete-session', `could not move to trash (${err?.message}); removed permanently: ${dir}`);
              return fs.existsSync(dir) ? 'directory still present after retries' : null;
            } catch (hardErr: any) {
              return hardErr?.message || err?.message || String(err);
            }
          }
        }
      }
      return fs.existsSync(dir) ? 'directory still present after retries' : null;
    };

    let error: string | null = removeDir(path.join(sessionsBaseDir, sessionId));
    // Also delete this chat's session-specific memory.
    try { deleteSessionMemory(sessionId); } catch { /* best-effort */ }
    // Sweep any directory whose name embeds this session id (legacy layouts).
    try {
      if (fs.existsSync(sessionsBaseDir)) {
        for (const dir of fs.readdirSync(sessionsBaseDir)) {
          if (dir === sessionId || dir.includes(sessionId)) {
            const e = removeDir(path.join(sessionsBaseDir, dir));
            if (e && !error) error = e;
          }
        }
      }
    } catch { /* best-effort */ }
    // Drop draft paste refs for the gone chat so its blobs become collectable.
    try {
      const map = loadDraftPastes();
      if (map[sessionId]) { delete map[sessionId]; saveDraftPastes(map); }
    } catch {}

    /**
     * 告诉窗口这条会话没了 —— 在**唯一的回收入口**上广播，而不是让每个调用方各自记得回传 id。
     *
     * 「run 删了之后左侧还是显示有三个空的会话」：`run:remove` 里 `purgeRunSessions` 返回的是**个数**，
     * 会话 id 从来没回传给渲染层，而渲染层只 forget 了 `cascaded`（锚）—— 于是被真正关掉的 worker
     * 还留在侧栏，点进去是空的，要到下次启动才消失。
     *
     * 补在这里而不是补 `run:remove`：回收的入口有五六处（重置、删 run、删 flow 历史、清扫、手删），
     * 逐个补一遍，下一个新增的路径又会漏。这条广播在**文件真的移走之后**发，所以它说的是既成事实。
     *
     * 即使文件没能完全删掉（下面那个 error 分支）也要广播：那种情况已经立了墓碑、会话对 app 来说
     * 就是不存在了，留在侧栏才是错的。
     */
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('acp:sessions-purged', { sessionIds: [sessionId] });
    }
    if (error) {
      logger.warn('delete-session', `${sessionId}: files not fully removed (${error}); tombstoned and will retry at next start`);
      return { ok: false, tombstoned: true, error };
    }
    clearSessionTombstone(sessionId); // fully gone — no need to keep the marker
    return { ok: true };
  };

  /**
   * 按**会话记录**收掉一个 flow 在一个 project 里的会话 —— 不经过 run 文件。
   *
   * 为什么不能只有 `purgeFlowRunSessions`：那个函数遍历 run 去拿 `node.sessionId`，也就是说
   * **run 是会话的唯一索引**。于是「删运行」如果不先收会话，那些 worker 就再也枚举不到 —— 实测过一次：
   * 一个 project 里该 flow 的 run 一条不剩，而它的主会话和 3 条 worker 还躺在侧栏里，worker 又被
   * `acp:delete-session` 无条件拒绝手删，能带走它们的主会话则因为「这个 project 还在用这个 flow」
   * 而拒删 —— 三方互锁，没有任何入口能收。
   *
   * 所以判据换成记录自己带的 `flow` + `projectId`：它不依赖 run 还在不在，因此既是删运行时的正路，
   * 也能顺手收掉之前已经锁死的那些。
   *
   * `includeAnchor` 分开给：删**一条** run 时只该收这条 run 的 worker，主会话还锚着别的运行；只有这个
   * flow 在这个 project 里一条运行都不剩时，主会话才没有东西可锚。
   * 结构会话（`skill`／「修改 flow · X」）一律不收 —— 它对着的是**定义**，跟某次运行的存亡无关。
   */
  const purgeFlowSessionsByRecord = async (
    project: string,
    flow: string,
    opts: { includeAnchor: boolean; except?: string },
  ): Promise<string[]> => {
    const name = (flow || '').trim();
    const want = (project || '').trim();
    if (!name) return [];
    const purged: string[] = [];
    for (const other of store.listSessions()) {
      if (opts.except && other.id === opts.except) continue;
      const purpose = (other as any).purpose;
      if (purpose !== 'flow-worker' && !(opts.includeAnchor && purpose === 'flow-main')) continue;
      if ((other.flow || '').trim() !== name) continue;
      if ((((other as any).profile)?.projectId || '').trim() !== want) continue;
      try {
        await purgeSession(other.id);
        purged.push(other.id);
      } catch (err: any) {
        logger.warn('session', `cascade delete failed for ${other.id}: ${err?.message || err}`);
      }
    }
    return purged;
  };

  ipcMain.handle('acp:delete-session', async (_event, sessionId: string) => {
    /**
     * A FLOW'S MAIN SESSION IS NOT DELETABLE — refused HERE, not only in the menu.
     *
     * 「这个会话不能被用户手动删掉」/「只能通过 flow 内部的按钮删会话，不能通过左侧的删除会话按钮」。
     * 菜单把它置灰，但目录是在这里真的消失的，而只写在菜单里的规则离被绕过只差一个快捷键或一条以后新增的
     * 代码路径。flow 自己的回收走 `purgeSession`（不经过这道守卫），所以「不许手删」不等于「永远删不掉」。
     */
    // 这条记录既被下面的守卫用，也被再下面的级联用，所以读一次、共用一份。
    const rec = store.readRecord(sessionId);
    {
      /**
       * 子会话（`flow-worker` / `skill`）：无条件拒。它们由流程创建、由流程关闭，进度和上下文也由
       * 流程自己保留；手删一条正在跑某一步的 worker，run 记录里那个 sessionId 就指向一个不存在的
       * 会话 —— 那一步既不会完成也不会失败。
       *
       * 不看「project 还在不在用这个 flow」：worker 属于**某一次运行**，不属于那个使用关系。
       * 流程自己的回收走 `purgeSession`（见上），所以这条守卫不会挡住它该做的清理。
       */
      if (rec?.purpose === 'flow-worker') {
        const flow = (rec.flow || '').trim();
        const project = ((rec.profile as any)?.projectId || '').trim();
        /**
         * 和主会话**同一套判据**：`!detached && definitionExists && runsLeft > 0`。
         *
         * 只有在流程还活着的时候拦才有意义 —— 那时候流程界面能删它。一旦这个 flow 的运行被清空
         * （或被移出 project、或定义已从库里删掉），流程界面就够不着这条 worker 了，再拦着就是死锁：
         * 实测磁盘上有 3 条这样的 worker（flow「SFDC activity」的 run 已全部清零），侧栏删不掉、
         * 流程界面里也不存在。
         */
        void project;
      }
      if (rec?.purpose === 'flow-main') {
        const flow = (rec.flow || '').trim();
        const project = ((rec.profile as any)?.projectId || '').trim();
      }
    }
    /**
     * 级联：删掉 flow 的锚（主会话 / skill 会话）时，把属于它的 worker 子会话一起删 ——
     * 「删的时候需要把它所属的子会话也删掉」。
     *
     * 为什么必须级联：worker 被禁止手删（上面那道守卫），所以如果删锚不带走它们，它们就成了永远
     * 删不掉的孤儿 —— 侧栏里躺着一堆属于已经不存在的流程的会话，而唯一能删它们的入口（流程界面）
     * 也随着锚一起没了。
     *
     * 归属的判据是 `flow` + `project`，和已有的 `removeFlowRuns(home, project, flow)` 同一套口径 ——
     * 记录里没有 parentSessionId，这两个字段是现有的唯一线索。
     *
     * 走 `purgeSession` 而不是递归回这个 handler：那样会被 worker 的守卫拒掉。这正是那句注释说的
     * 「flow 自己的回收走 purgeSession，所以『不许手删』不等于『永远删不掉』」。
     */
    const cascaded: string[] = [];
    if (rec?.purpose === 'flow-main' || rec?.purpose === 'skill') {
      const flow = (rec.flow || '').trim();
      const project = ((rec.profile as any)?.projectId || '').trim();
      if (flow) {
        for (const other of store.listSessions()) {
          if (other.id === sessionId) continue;
          if (other.purpose !== 'flow-worker') continue;
          if ((other.flow || '').trim() !== flow) continue;
          if ((((other as any).profile)?.projectId || '').trim() !== project) continue;
          try {
            await purgeSession(other.id);
            cascaded.push(other.id);
          } catch (err: any) {
            logger.warn('session', `cascade delete failed for ${other.id}: ${err?.message || err}`);
          }
        }
      }
      if (cascaded.length) {
        logger.info('session', `deleting ${rec.purpose} ${sessionId}: cascaded ${cascaded.length} worker session(s) of ${flow}`);
      }
    }
    const result = await purgeSession(sessionId);
    // `cascaded` 交给渲染层：它是按 id 从列表里摘会话的，不然这些会话要到下次启动才消失。
    return { ...result, cascaded };
  });


  // Named kiro-cli agents available to the composer selector. The CLI has no
  // JSON mode for this command, so parse its stable tabular output from both
  // stdout and stderr (some kiro-cli versions write the listing to stderr).
  ipcMain.handle('kiro:list-agents', async () => {
    try {
      // 和 list-models 同一个病：日志里 `agent list` 也在 15s 反复被 kill，同样是挂载时并发双发。
      // single-flight + 30s，理由见 `acp:list-models` 那段注释。
      //
      // 共享的是**原始输出**而不是解析结果：解析在下面，第二个调用者拿到字符串再自己走同一段解析，
      // 语义完全一致；如果直接把解析后的对象缓存起来共享，就得把这段解析抽出去，而它只有一个用处。
      if (!listAgentsInFlight) {
        listAgentsInFlight = runKiroCli('agent list 2>&1', 30000)
          .finally(() => { listAgentsInFlight = null; });
      }
      const output = await listAgentsInFlight;
      const agents: Array<{
        name: string;
        isDefault: boolean;
        source: 'built-in' | 'global' | 'local';
      }> = [];
      for (const raw of output.split('\n')) {
        const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
        const match = line.match(/^(\*)?\s+([A-Za-z0-9_.\-]+)\s{2,}(\(Built-in\)|Global|Local)(?:\s|$)/);
        if (match) {
          const source = match[3] === '(Built-in)'
            ? 'built-in'
            : match[3].toLowerCase() as 'global' | 'local';
          agents.push({ name: match[2], isDefault: !!match[1], source });
        }
      }
      const builtInOrder = ['kiro_default', 'kiro_help', 'kiro_planner'];
      agents.sort((left, right) => {
        const leftRank = builtInOrder.indexOf(left.name);
        const rightRank = builtInOrder.indexOf(right.name);
        if (leftRank >= 0 && rightRank >= 0) return leftRank - rightRank;
        if (leftRank >= 0) return -1;
        if (rightRank >= 0) return 1;
        return 0;
      });
      return { agents };
    } catch (err: any) {
      return { agents: [], error: err?.message || String(err) };
    }
  });

  const resolveKiroAgentConfigPath = (
    sessionId: string,
    agentName: string,
    source?: 'built-in' | 'global' | 'local',
  ): { path?: string; error?: string } => {
    if (!/^[A-Za-z0-9_.-]+$/.test(agentName)) {
      return { error: 'Invalid Agent name.' };
    }
    if (source === 'built-in') {
      return { error: `${agentName} is a built-in Agent and cannot be edited.` };
    }

    const workspaceDirectory = sessionClients.get(sessionId)?.cwd || process.cwd();
    const localDirectory = path.join(workspaceDirectory, '.kiro', 'agents');
    const globalDirectory = path.join(os.homedir(), '.kiro', 'agents');
    const directories = source === 'local'
      ? [localDirectory]
      : source === 'global'
      ? [globalDirectory]
      : [localDirectory, globalDirectory];

    const findConfigInDirectory = (directory: string): string | undefined => {
      // Most user-created Agents use <name>.json, so keep the zero-scan path.
      const directPath = path.join(directory, `${agentName}.json`);
      if (fs.existsSync(directPath)) return directPath;
      if (!fs.existsSync(directory)) return undefined;

      // AIM-managed configs can carry a package prefix in the filename (for
      // example AmazonBuilderCoreAIAgents-apollo-deployment-assistant.json).
      // The JSON `name` field is the authoritative displayed Agent name.
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const candidate = path.join(directory, entry.name);
        try {
          const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
          if (parsed?.name === agentName) return candidate;
        } catch {
          // Ignore unrelated invalid JSON here; the editor validates the
          // selected config after it has been resolved.
        }
      }
      return undefined;
    };

    const configPath = directories
      .map(findConfigInDirectory)
      .find((candidate): candidate is string => !!candidate);

    return configPath
      ? { path: configPath }
      : { error: `No ${source || 'local or global'} configuration file was found for ${agentName}.` };
  };

  ipcMain.handle('kiro:open-agent-config', async (
    _event,
    sessionId: string,
    agentName: string,
    source?: 'built-in' | 'global' | 'local',
  ) => {
    const resolved = resolveKiroAgentConfigPath(sessionId, agentName, source);
    if (!resolved.path) return { opened: false, error: resolved.error };

    try {
      return {
        opened: true,
        path: resolved.path,
        content: await fs.promises.readFile(resolved.path, 'utf-8'),
      };
    } catch (error: any) {
      return { opened: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('kiro:save-agent-config', async (
    _event,
    sessionId: string,
    agentName: string,
    source: 'built-in' | 'global' | 'local' | undefined,
    content: string,
  ) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error: any) {
      return { saved: false, error: `Invalid JSON: ${error?.message || String(error)}` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { saved: false, error: 'Agent configuration must be a JSON object.' };
    }

    const resolved = resolveKiroAgentConfigPath(sessionId, agentName, source);
    if (!resolved.path) return { saved: false, error: resolved.error };

    const temporaryPath = `${resolved.path}.kirolex-${process.pid}.tmp`;
    try {
      const originalMode = (await fs.promises.stat(resolved.path)).mode;
      await fs.promises.writeFile(temporaryPath, content, {
        encoding: 'utf-8',
        mode: originalMode,
      });
      await fs.promises.rename(temporaryPath, resolved.path);
      return { saved: true, path: resolved.path };
    } catch (error: any) {
      try { await fs.promises.unlink(temporaryPath); } catch {}
      return { saved: false, error: error?.message || String(error) };
    }
  });

  // A model is bound at kiro-cli process launch. Replace the executor while
  // loading the SAME ACP session so conversation context survives and the new
  // model applies to the next prompt. The old executor stays live on failure.
  ipcMain.handle('acp:switch-model', async (_event, sessionId: string, model: string) => {
    const oldEntry = sessionClients.get(sessionId);
    if (!oldEntry) throw new Error('Session not connected');
    if (oldEntry.busy) throw new Error('Wait for the current response to finish before switching models.');
    if (reconfiguringSessions.has(sessionId)) throw new Error('Another model, Agent, or permission change is still in progress.');

    const normalizedModel = model.trim() || DEFAULT_MODEL;
    if (oldEntry.profile.model === normalizedModel) return { ok: true, model: normalizedModel };

    // Never release/reload a session while an attach is mid-flight on it --
    // that race is what produced the bare "Internal error" from kiro-cli.
    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    // An EXPLICIT user choice also becomes the new preference (retried first on
    // later attaches), unlike an automatic fallback which leaves it untouched.
    const profile: AgentProfile = { ...oldEntry.profile, model: normalizedModel, preferredModel: normalizedModel };
    const cliSessionId = oldEntry.cliSessionId;
    const cwd = oldEntry.cwd;
    // kiro-cli enforces single-process ownership of a session: session/load on an
    // id still held by another process fails with
    //   "Failed to start session: Session is active in another process (PID n)".
    // So the OLD executor must release the session BEFORE the replacement loads
    // it; starting the replacement first can never succeed. On failure we restore
    // the previous executor (old model) so the chat is not left detached.
    const restoreOldExecutor = async () => {
      const previous = new AcpClient(
        oldEntry.profile.model, shellEnv, oldEntry.profile.kiroAgent,
        oldEntry.profile.permissionMode, oldEntry.profile.remote,
      );
      try {
        await previous.connect();
        await withLoadTimeout(previous.loadSession(cliSessionId, cwd));
        const restored: SessionEntry = {
          ...oldEntry, client: previous, lastUsedAt: Date.now(),
          assistantBuf: '', assistantMsgId: null, fileChanges: [],
        };
        sessionClients.set(sessionId, restored);
        wireSession(sessionId, restored);
      } catch (restoreError) {
        logger.warn('switch-model', `failed to restore previous executor sessionId=${sessionId}`, restoreError);
        try { await previous.disconnect(); } catch {}
        /*
          **回滚也失败了 → 把盘上的状态说成实话** —— 实测这条路走过两次（07:59、08:00），
          而记录里还写着 `attached`：于是界面以为它连着，下一次发送答的是「Session not connected」。
          写成 detached 之后走的是常规的"没连着 → 连上"那条路（`ensureAttached` / 点一下会话），
          那条路本来就是可靠的。
        */
        const rec = store.readRecord(sessionId);
        if (rec) { rec.executorState = 'detached'; store.writeRecord(rec); }
        emitSessionBusy(sessionId);
      }
    };

    sessionClients.delete(sessionId); // release the slot + ownership claim
    try { await oldEntry.client.disconnect(); } catch {}

    const client = new AcpClient(profile.model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote);
    try {
      await client.connect();
      await withLoadTimeout(client.loadSession(cliSessionId, cwd));
      const nextEntry: SessionEntry = {
        client,
        cliSessionId,
        profile,
        cwd,
        assistantBuf: '',
        assistantMsgId: null,
        fileChanges: [],
        lastUsedAt: Date.now(),
      };
      sessionClients.set(sessionId, nextEntry);
      wireSession(sessionId, nextEntry);

      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      // A model switch means a NEW kiro-cli process, i.e. a blank backend even
      // though the session id is unchanged. In snapshot mode the snapshot rides
      // along with the next message (nothing to do here); only verbatim mode owes
      // a real rebuild. See restoreContextAfterExecutorSwap.
      restoreContextAfterExecutorSwap(sessionId, 'switch-model');
      return { ok: true, model: normalizedModel };
    } catch (err) {
      try { await client.disconnect(); } catch {}
      await restoreOldExecutor();
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  });


  // Auto/Ask is handled at the ACP permission-request boundary, so it can be
  // changed instantly without replacing the executor or reloading the session.
  ipcMain.handle('acp:switch-permission-mode', async (
    _event,
    sessionId: string,
    permissionMode: 'auto-approve' | 'ask',
  ) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');

    const normalizedMode = permissionMode === 'ask' ? 'ask' : 'auto-approve';
    entry.client.setPermissionMode(normalizedMode);
    entry.profile.permissionMode = normalizedMode;

    const rec = store.readRecord(sessionId)
      || store.createSession(sessionId, entry.profile);
    rec.profile = { ...rec.profile, permissionMode: normalizedMode };
    rec.cliSessionId = entry.cliSessionId;
    rec.executorState = 'attached';
    store.writeRecord(rec);

    return { ok: true, permissionMode: normalizedMode };
  });

  // kiro-cli binds --agent at process launch, so changing agents requires a
  // fresh executor. Start the replacement first; only swap it into the live
  // map after it is ready, then disconnect the old executor. This avoids a
  // failed switch taking down an otherwise healthy session. The visible chat
  // and durable transcript remain; the selected agent starts fresh context and
  // receives the normal layered-memory injection on its next prompt.
  ipcMain.handle('acp:switch-kiro-agent', async (_event, sessionId: string, agentName: string) => {
    const oldEntry = sessionClients.get(sessionId);
    if (!oldEntry) throw new Error('Session not connected');
    if (oldEntry.busy) throw new Error('Wait for the current response to finish before switching agents.');
    if (reconfiguringSessions.has(sessionId)) throw new Error('Another model, Agent, or permission change is still in progress.');

    const normalizedAgent = agentName.trim() || undefined;
    if (oldEntry.profile.kiroAgent === normalizedAgent) {
      return { ok: true, kiroAgent: normalizedAgent || '' };
    }

    await awaitAttachIdle(sessionId);
    reconfiguringSessions.add(sessionId);
    emitSessionBusy(sessionId);
    const profile: AgentProfile = { ...oldEntry.profile, kiroAgent: normalizedAgent };
    const client = new AcpClient(profile.model, shellEnv, profile.kiroAgent, profile.permissionMode, profile.remote);
    try {
      await client.connect();
      const created = await client.newSession(oldEntry.cwd);
      const nextEntry: SessionEntry = {
        client,
        cliSessionId: created.sessionId,
        profile,
        cwd: oldEntry.cwd,
        assistantBuf: '',
        assistantMsgId: null,
        fileChanges: [],
        lastUsedAt: Date.now(),
      };
      sessionClients.set(sessionId, nextEntry);
      wireSession(sessionId, nextEntry);
      try { await oldEntry.client.disconnect(); } catch {}

      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.profile = profile;
      rec.cliSessionId = created.sessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      mainWindow?.webContents.send('session:ready-for-first-prompt', {
        sessionId,
        projectId: profile.projectId,
      });
      // Agent switch is even more destructive than a model switch: a brand new
      // process AND a brand new cli session id, so the backend is unquestionably
      // empty. That still does not make a dedicated rebuild turn the right answer
      // in snapshot mode -- the snapshot is built from KiroLex's own transcript, so
      // it restores a fresh cli session just as well while riding along with the
      // next message. Same policy as the model switch, deliberately one function.
      restoreContextAfterExecutorSwap(sessionId, 'switch-agent');
      return { ok: true, kiroAgent: normalizedAgent || '' };
    } catch (err) {
      try { await client.disconnect(); } catch {}
      throw err;
    } finally {
      reconfiguringSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
  });

  ipcMain.handle('app:get-home-dir', () => {
    return os.homedir();
  });

  ipcMain.handle('app:get-logs', (_event, maxLines?: number) => {
    return { text: logger.tail(maxLines || 500), path: logger.logPath };
  });

  ipcMain.handle('app:open-logs', async () => {
    try {
      shell.showItemInFolder(logger.logPath);
      return { ok: true };
    } catch (error: any) {
      logger.error('open-logs', 'failed to reveal log file', error);
      return { ok: false, error: error?.message || String(error) };
    }
  });

  const WORKSPACE_PREVIEW_MAX_BYTES = 512 * 1024;

  // Open a URL in the default browser, or a file/folder path in the OS. Used by
  // clickable links/paths rendered in chat messages.
  ipcMain.handle('app:open-external', async (_event, target: string, sessionId?: string) => {
    if (!target) return { ok: false };
    try {
      if (/^(https?:|mailto:|tel:)/i.test(target)) {
        await shell.openExternal(target);
      } else {
        // Resolve the SAME way app:path-exists / workspace:read do, so a relative
        // or ~-prefixed path handed over from chat still points at the real file
        // instead of being resolved against the app process cwd.
        let p = String(target).trim().replace(/^file:\/\//, '');
        if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
        if (!path.isAbsolute(p)) {
          const entry = sessionId ? sessionClients.get(sessionId) : undefined;
          p = path.resolve(entry?.cwd || os.homedir(), p);
        }
        const err = await shell.openPath(p);
        if (err) return { ok: false, error: err };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }
  });

  // Read an image straight off disk as a data URL, with NO session involved.
  //
  // Attachment thumbnails used to go through `workspace:read`, which starts with
  // `if (!entry) throw new Error('This chat is not connected.')` -- so a purely
  // local file read was gated behind that chat having a live kiro-cli. A chat that
  // was dormant (or simply not attached yet when its messages first rendered) showed
  // 🖼️ + "Screenshot 1" instead of the picture, and never retried. The bytes on
  // disk have nothing to do with the backend, so nothing here asks about one.
  ipcMain.handle('app:image-data-url', (_event, filePath: string) => {
    try {
      if (!filePath) return null;
      let p = String(filePath).trim().replace(/^file:\/\//, '');
      if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
      if (!path.isAbsolute(p)) p = path.resolve(os.homedir(), p);
      const mime = IMAGE_MIME_BY_EXT[path.extname(p).toLowerCase()];
      if (!mime) return null;
      const stats = fs.statSync(p);
      if (!stats.isFile() || stats.size > 25 * 1024 * 1024) return null;
      return { path: p, dataUrl: `data:${mime};base64,${fs.readFileSync(p).toString('base64')}` };
    } catch {
      return null; // missing/unreadable: the caller falls back to an icon
    }
  });


  ipcMain.handle('app:path-exists', (_event, filePath: string, sessionId?: string) => {
    try {
      if (!filePath) return false;
      const entry = sessionId ? sessionClients.get(sessionId) : undefined;
      if (entry?.profile.remote?.sshHost) return true;
      let p = filePath.trim().replace(/^file:\/\//, '');
      if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
      if (!path.isAbsolute(p)) {
        const base = entry?.cwd || os.homedir();
        p = path.resolve(base, p);
      }
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  /** Where to start browsing, and what relative paths are relative TO.
   *
   *  A session is an optional HINT here, never a requirement. The whole workspace
   *  trio used to open with `if (!entry) throw new Error('This chat is not
   *  connected.')`, so the file browser died with that message whenever the focused
   *  chat had no live kiro-cli -- which is the normal state for a dormant chat, and
   *  the state of every chat before its executor attaches. Listing a local directory
   *  has nothing to do with whether a backend exists. `app:path-exists` and
   *  `app:open-external` already take sessionId as an optional resolution base for
   *  exactly this reason; these three now match them.
   *
   *  A REMOTE session's cwd is a path on the other host, so it is deliberately not
   *  used as a local base -- it would only ENOENT. Home is used instead and the
   *  panel's path bar shows where it actually landed. */
  function workspaceBase(sessionId?: string | null): string {
    const entry = sessionId ? sessionClients.get(sessionId) : undefined;
    if (entry && !entry.profile.remote?.sshHost && entry.cwd) return entry.cwd;
    return os.homedir();
  }

  /** Expand `file://` and `~`, then resolve relatives against workspaceBase. */
  function resolveUserPath(filePath: string, sessionId?: string | null): string {
    let p = String(filePath).trim().replace(/^file:\/\//, '');
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    if (!path.isAbsolute(p)) p = path.resolve(workspaceBase(sessionId), p);
    return p;
  }

  ipcMain.handle('workspace:list', (_event, sessionId?: string | null, directory?: string) => {
    const target = path.resolve(directory || workspaceBase(sessionId));
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .map((dirent) => ({ name: dirent.name, isDir: dirent.isDirectory() }))
      .sort((left, right) => (
        left.isDir === right.isDir
          ? left.name.localeCompare(right.name)
          : left.isDir ? -1 : 1
      ));
    return { path: target, parent: path.dirname(target), entries };
  });

  ipcMain.handle('workspace:read', (_event, sessionId: string | null | undefined, filePath: string) => {
    // No session required: see workspaceBase. The session, when present, only
    // decides what a relative path is relative to.
    filePath = resolveUserPath(filePath, sessionId);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) throw new Error('Path is a directory, not a file.');

    // Image files: return a base64 data URL so the renderer can show them inline
    // as an <img> instead of the "binary — no preview" fallback.
    const IMG_MIME = IMAGE_MIME_BY_EXT;
    const ext = path.extname(filePath).toLowerCase();
    if (IMG_MIME[ext]) {
      const IMG_MAX_BYTES = 25 * 1024 * 1024;
      if (stats.size > IMG_MAX_BYTES) {
        return {
          path: filePath,
          content: `图片过大（${(stats.size / 1048576).toFixed(1)} MB），请下载后查看。`,
          binary: true,
          truncated: false,
        };
      }
      const data = fs.readFileSync(filePath);
      return {
        path: filePath,
        image: true,
        dataUrl: `data:${IMG_MIME[ext]};base64,${data.toString('base64')}`,
        content: '',
      };
    }

    const descriptor = fs.openSync(filePath, 'r');
    try {
      const previewSize = Math.min(stats.size, WORKSPACE_PREVIEW_MAX_BYTES);
      const buffer = Buffer.alloc(previewSize);
      fs.readSync(descriptor, buffer, 0, previewSize, 0);
      if (buffer.includes(0)) {
        return {
          path: filePath,
          content: '(binary file — preview unavailable)',
          binary: true,
          truncated: false,
        };
      }
      return {
        path: filePath,
        content: buffer.toString('utf-8'),
        truncated: stats.size > WORKSPACE_PREVIEW_MAX_BYTES,
      };
    } finally {
      fs.closeSync(descriptor);
    }
  });

  /** Files the viewer currently has open, watched so an edit on disk refreshes it.
   *
   *  Watching the PARENT DIRECTORY rather than the file is deliberate: a save is very
   *  often write-to-temp + rename (editors do it, and so does KiroLex's own atomic
   *  write), which replaces the inode. `fs.watch` on the file path follows the old
   *  inode and goes silent after exactly one such save -- the failure mode would be a
   *  viewer that refreshes once and then never again. A directory watcher sees the
   *  rename as a `rename` event for the basename, so it keeps working.
   *
   *  One watcher per directory, shared by every open file in it, and events are
   *  debounced: a single save can emit several (`rename` + `change`), and a build can
   *  rewrite a file many times a second. */
  const viewerWatchers = new Map<string, fs.FSWatcher>();   // dir -> watcher
  const viewerFiles = new Map<string, Set<string>>();       // dir -> basenames
  const viewerDebounce = new Map<string, NodeJS.Timeout>(); // full path -> timer

  function stopViewerWatch(): void {
    for (const w of viewerWatchers.values()) { try { w.close(); } catch { /* already closed */ } }
    viewerWatchers.clear();
    viewerFiles.clear();
    for (const t of viewerDebounce.values()) clearTimeout(t);
    viewerDebounce.clear();
  }

  /** Replace the watched set with exactly these files. Returns how many are watched. */
  ipcMain.handle('workspace:watch-files', (_event, sessionId: string | null | undefined, paths: string[]) => {
    stopViewerWatch();
    const wanted = (Array.isArray(paths) ? paths : []).slice(0, 32);   // the viewer caps tabs
    for (const raw of wanted) {
      let full: string;
      try { full = resolveUserPath(String(raw), sessionId); } catch { continue; }
      const dir = path.dirname(full);
      const base = path.basename(full);
      const names = viewerFiles.get(dir) || new Set<string>();
      names.add(base);
      viewerFiles.set(dir, names);
      if (viewerWatchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, (_type, changed) => {
          if (!changed) return;
          const name = String(changed);
          if (!viewerFiles.get(dir)?.has(name)) return;   // some other file in the dir
          const full2 = path.join(dir, name);
          const prev = viewerDebounce.get(full2);
          if (prev) clearTimeout(prev);
          viewerDebounce.set(full2, setTimeout(() => {
            viewerDebounce.delete(full2);
            let exists = true;
            let mtimeMs = 0;
            try { mtimeMs = fs.statSync(full2).mtimeMs; } catch { exists = false; }
            mainWindow?.webContents.send('workspace:file-changed', { path: full2, exists, mtimeMs });
          }, 180));
        });
        watcher.on('error', () => { try { watcher.close(); } catch {} viewerWatchers.delete(dir); });
        viewerWatchers.set(dir, watcher);
      } catch (err: any) {
        // An unreadable or deleted directory is not an error worth failing the call
        // over: the viewer simply does not auto-refresh that file.
        logger.info('workspace', `watch skipped ${dir}: ${err?.message || err}`);
      }
    }
    return { ok: true, watching: wanted.length, dirs: viewerWatchers.size };
  });

  ipcMain.handle('workspace:download', async (_event, sessionId: string | null | undefined, filePath: string) => {
    filePath = resolveUserPath(filePath, sessionId);
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) throw new Error('Path is not a file.');
    const options = {
      title: 'Save workspace file',
      defaultPath: path.join(os.homedir(), 'Downloads', path.basename(filePath)),
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      fs.copyFileSync(filePath, result.filePath);
      return { ok: true, path: result.filePath };
    } catch (copyError: any) {
      return { ok: false, error: copyError?.message || 'Download failed.' };
    }
  });

  ipcMain.handle('app:pick-files', async () => {
    const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => ({
      path: filePath,
      name: path.basename(filePath),
      isImage: /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath),
    }));
  });

  // Save the current clipboard image to a temp file so it can be attached and
  // read by the agent (attachments are referenced by file path). Returns the
  /** Cap an image FILE that is about to be attached. Returns the original path when
   *  it is already small enough, otherwise the path of a downscaled copy -- the
   *  user's file on disk is never modified. */
  ipcMain.handle('app:prepare-image-attachment', (_event, filePath: string) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { path: filePath };
      const raw = nativeImage.createFromPath(filePath);
      if (raw.isEmpty()) return { path: filePath };          // not a decodable image
      const capped = capImageSize(raw);
      if (!capped.from) return { path: filePath };            // already within limits
      const dir = path.join(os.homedir(), '.kirolex', 'attachments');
      fs.mkdirSync(dir, { recursive: true });
      const base = path.basename(filePath).replace(/\.[^.]+$/, '');
      const out = path.join(dir, `${base}_${MAX_IMAGE_EDGE}px_${Date.now()}.png`);
      fs.writeFileSync(out, capped.img.toPNG());
      logger.info('image', `attachment downscaled ${capped.from} -> ${capped.to}: ${filePath} -> ${out}`);
      return { path: out, downscaled: true, from: capped.from, to: capped.to };
    } catch (err: any) {
      logger.info('image', `prepare-image-attachment FAILED ${filePath}: ${err?.message}`);
      return { path: filePath };
    }
  });

  // path, filename, and a small thumbnail data URL for preview.
  ipcMain.handle('app:save-clipboard-image', () => {
    try {
      const raw = clipboard.readImage();
      if (raw.isEmpty()) return null;
      // Cap BEFORE writing: this file is what kiro-cli reads into the conversation.
      const capped = capImageSize(raw);
      const img = capped.img;
      if (capped.from) logger.info('image', `clipboard screenshot downscaled ${capped.from} -> ${capped.to} (max ${MAX_IMAGE_EDGE}px)`);
      const dir = path.join(os.homedir(), '.kirolex', 'pasted');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `paste_${Date.now()}.png`);
      fs.writeFileSync(filePath, img.toPNG());
      const { width } = img.getSize();
      const thumb = width > 160 ? img.resize({ width: 160 }) : img;
      return { path: filePath, name: path.basename(filePath), thumbnail: thumb.toDataURL() };
    } catch {
      return null;
    }
  });

  ipcMain.handle('acp:list-models', async () => {
    /**
     * SINGLE-FLIGHT，而且超时给足 —— 两者都是实测逼出来的。
     *
     * 现场：日志里 13 次 `timed out after 10000ms (killed)`，而同一时刻在终端裸跑同一条命令只要
     * 2.6–3.7 秒。关键线索是超时**成对出现**（同一毫秒两条，如 15:35:57.573 / .575）：渲染进程
     * 挂载时并发发起了两次，每次都要付 kiro-cli 完整启动开销（含加载全部 MCP server），两个一起
     * 启就超过 10 秒预算。于是永远走 `.catch()`，回退到缓存 —— 而那份缓存早先已被一次退化结果
     * 写坏（只剩 `auto`），所以「网恢复了却还是显示模型都不可用」。
     *
     * single-flight 消掉并发这个直接原因；30s 给 kiro-cli 冷启动留出真实余量（这个调用本来就是
     * 非阻塞的，等久一点没有代价，拿不到列表才有代价）。成功结果不在这里长期记忆：模型会上下线，
     * 该由渲染层用 `shouldReplaceModelCache` 决定要不要落盘。
     */
    if (!listModelsInFlight) {
      listModelsInFlight = runKiroCli('chat --list-models --format json', 30000)
        .then((result) => JSON.parse(result))
        .finally(() => { listModelsInFlight = null; });
    }
    return listModelsInFlight;
  });

  ipcMain.handle('acp:get-usage', async () => {
    try {
      const result = await runKiroCli('chat --no-interactive "/usage" 2>&1', 20000);
      const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean };
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean || 'Failed to get usage' };
    }
  });

  // Generate a concise chat title from the first message via a one-shot kiro-cli
  // call. execFile (args array) — user text is never shell-interpolated.
  ipcMain.handle('app:generate-title', async (_event, firstUser: string, firstAssistant?: string) => {
    const convo = `User: ${String(firstUser || '').slice(0, 1500)}`
      + (firstAssistant ? `\n\nAssistant: ${String(firstAssistant).slice(0, 1500)}` : '');
    if (!isFeatureEnabled('smartTitle')) {
      logger.info('title', 'skipped: smartTitle is off');
      return { ok: false, skipped: true, reason: 'feature disabled' };
    }
    const prompt = `Generate a very short chat title (3-6 words) summarizing the topic below. Reply with ONLY the title on a single line — no quotes, no trailing punctuation, no preamble.\n\n${convo}`;
    try {
      // Logged like `suggestions` next door. This handler used to log NOTHING, on any
      // branch -- including the silent `{ error: 'empty' }` one -- so "chats stopped
      // naming themselves" left no trace anywhere and got misdiagnosed twice.
      const stdout = await runLiteOneShot(prompt, 'title');
      const clean = cleanLiteOutput(stdout);
      const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
      let title = lines[lines.length - 1] || '';
      title = title
        // The marker is stripped from the whole reply above, but the title is taken
        // from the LAST line, which may carry its own.
        .replace(/^\s*(?:>\s*)+/, '')
        .replace(/^["'“”「『]+|["'“”」』]+$/g, '')
        .replace(/^title[:：]\s*/i, '')
        .replace(/[。.、,，]+$/, '')
        .trim()
        .slice(0, 60);
      if (!title) {
        logger.warn('title', `model answered but no usable title survived cleanup (${clean.length} chars in)`);
        return { error: 'empty' };
      }
      logger.info('title', `generated "${title}"`);
      return { title };
    } catch (err: any) {
      logger.warn('title', `failed: ${err?.killed ? 'timeout/killed' : ''} ${err?.message || err}`);
      return { error: err?.message || 'failed' };
    }
  });

  // Dynamic, conversation-aware prompt suggestions: given the recent transcript,
  // produce a few short follow-up prompts the user is likely to want next. One-
  // shot kiro-cli via execFile (args array — the convo text can't shell-inject).
  ipcMain.handle('app:generate-suggestions', async (_event, recentConvo: string) => {
    const convo = String(recentConvo || '').slice(0, 4000);
    if (!convo.trim()) return { suggestions: [] };
    const prompt = `Based on the conversation below, propose 3 short follow-up prompts the user might send next. Each must be a concrete, actionable next step in the SAME language as the conversation, max 12 words, no numbering, no quotes. Reply with ONLY the 3 prompts, one per line.\n\n${convo}`;
    try {
      const stdout = await runLiteOneShot(prompt, 'suggestions');
      const clean = cleanLiteOutput(stdout);
      const suggestions = clean
        .split('\n')
        // Per line, on top of the leading marker cleanLiteOutput already removed:
        // list bullets/numbering, and a marker on any line but the first.
        .map((l) => l.replace(/^\s*(?:>\s*)?[-*\d.)、]*\s*/, '').replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim())
        .filter((l) => l.length > 0 && l.length <= 80)
        .slice(-3);
      logger.info('suggestions', `generated ${suggestions.length}`);
      return { suggestions };
    } catch (err: any) {
      // Never fail silently: a killed/timed-out one-shot used to look exactly
      // like "suggestions are gone".
      logger.warn('suggestions', `failed: ${err?.killed ? 'timeout/killed' : ''} ${err?.message || err}`);
      return { suggestions: [], error: err?.message || 'failed' };
    }
  });

  ipcMain.handle('acp:list-sessions', async () => {
    try {
      const result = await runKiroCli('chat --list-sessions --format json', 10000);
      return JSON.parse(result);
    } catch {
      return { sessions: [] };
    }
  });

  let firstAttachMarked = false;
  ipcMain.handle('acp:load-session', async (_event, sessionId: string, cwd: string, model: string) => {
    if (!firstAttachMarked) { firstAttachMarked = true; startupMark('attach: first loadSession', `sessionId=${sessionId}`); }
    const resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    // Never re-attach (and thus recreate the record.json of) a session the user
    // deleted this runtime — prevents a racing startup eager-attach from
    // resurrecting a just-closed chat.
    if (deletedSessionIds.has(sessionId)) {
      throw new Error('Session was deleted; not re-attaching.');
    }
    // Mutual exclusion with model/Agent/permission switches: both paths do a
    // session/load on the same cliSessionId and kiro-cli allows only one owner.
    // WAIT for the switch instead of rejecting. A switch already waits for an
    // attach (awaitAttachIdle), and only this direction failed hard -- so a send
    // that lands while the model is being swapped (the send attaches on demand)
    // got a raw IPC error on the user's own message. A switch finishes WITH the
    // session attached, so after the wait this handler almost always returns
    // immediately with the new executor.
    await awaitReconfigureIdle(sessionId);
    // The switch may have been the last thing that touched this session before a
    // delete landed; re-check rather than attaching a corpse.
    if (deletedSessionIds.has(sessionId)) {
      throw new Error('Session was deleted; not re-attaching.');
    }
    // COALESCE concurrent attaches of the SAME session. The main window is now
    // revealed BEFORE the background warm-up finishes, so clicking a session that
    // is still attaching would otherwise start a second executor for the same
    // cliSessionId -- and kiro-cli allows exactly one owner ("Session is active in
    // another process (PID n)"). Joining the in-flight attach is both correct and
    // faster than serialising behind it.
    const inFlight = attachInFlight.get(sessionId);
    if (inFlight) return inFlight;
    const attachPromise = (async () => {
    attachingSessions.add(sessionId);
    emitSessionBusy(sessionId);
    try {
    let entry = sessionClients.get(sessionId);
    let freshBackendResult = false;
    if (!entry) {
      if (!ensureExecutorCapacity(sessionId)) {
        throw new Error('All live sessions are busy; cannot attach another right now.');
      }
      const existing = store.readRecord(sessionId);
      // ATTACH MUST NOT CREATE. `createSession` below used to run for any unknown
      // id, so attaching a stale entry (a chat deleted on disk, or deleted while the
      // renderer index still listed it) RE-CREATED its record — and the chat came
      // back at the next start, "deleted" but alive. Creation belongs to
      // acp:new-session only; resuming an id with no record on disk is an error.
      if (!existing) {
        throw new Error('该会话在磁盘上不存在（可能已被删除），不再重建。');
      }
      const derived = resolvedCwd === os.homedir() ? undefined : deriveProjectId(resolvedCwd);
      const projectId = existing?.profile.projectId ?? derived;
      const profile: AgentProfile = {
        model: model || existing?.profile.model || DEFAULT_MODEL,
        // ONLY a recorded preference, else the default. Deliberately does NOT fall
        // back to `model` or `existing.profile.model`: both carry the EFFECTIVE
        // model, which after an automatic fallback is a model the user never chose.
        // Back-filling from them turned one Opus outage into a permanent silent
        // downgrade (observed: preferred became 'claude-sonnet-4.6' on a session
        // created as 'claude-opus-5'). An explicit user switch is the only thing
        // that sets a preference — see acp:switch-model.
        preferredModel: existing?.profile.preferredModel || DEFAULT_MODEL,
        permissionMode: existing?.profile.permissionMode || 'auto-approve',
        projectId,
        kiroAgent: existing?.profile.kiroAgent,
        // Persisted remote target survives restarts; a remote session re-attaches
        // over SSH exactly as it was created.
        remote: existing?.profile.remote,
      };
      // For a remote session the executor's working directory is a REMOTE path,
      // not the local `cwd` the renderer passed in.
      const cliCwd = sessionCwd(profile, resolvedCwd);
      const started = await connectWithModelFallback(profile, `attach ${sessionId}`);
      const client = started.client;
      profile.model = started.model;
      // Resume the mapped kiro-cli session; fall back to id (legacy records where
      // KiroLex id WAS the cli id), and to a fresh session if resume fails.
      // The resume is raced against a FIXED wall-clock timeout (not the request's
      // idle timeout): resuming a stale cliSessionId -- from an old kiro-cli store,
      // a restored backup, or a version change -- can stream updates that keep
      // resetting the idle timer while the session/load response never arrives,
      // wedging the attach forever (sidebar dot stuck yellow "connecting"). On
      // timeout OR error we fall back to a fresh session so attach never hangs.
      let cliSessionId = existing?.cliSessionId || sessionId;
      let freshBackend = false;
      // Scale the wall-clock budget with how much history kiro-cli has to load.
      // A fixed 10s made every LARGE chat time out on every restart, silently
      // swapping in an empty backend -- that is what discarded the context.
      // Still bounded (and retried once) so a genuinely stale id cannot wedge
      // the attach forever.
      const historyBytes = store.transcriptFileSize(sessionId);
      const RESUME_TIMEOUT_MS = Math.min(90000, 20000 + Math.floor(historyBytes / 100000) * 15000);
      const tryResume = async () => {
        await Promise.race([
          client.loadSession(cliSessionId, cliCwd),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`session/load resume timed out after ${RESUME_TIMEOUT_MS}ms`)), RESUME_TIMEOUT_MS),
          ),
        ]);
      };
      try {
        try {
          await tryResume();
        } catch (first: any) {
          logger.info('attach', `resume attempt 1 failed sessionId=${sessionId} cli=${cliSessionId} bytes=${historyBytes} budget=${RESUME_TIMEOUT_MS}ms err=${first?.message}`);
          await tryResume();
          logger.info('attach', `resume attempt 2 succeeded sessionId=${sessionId} cli=${cliSessionId}`);
        }
      } catch (resumeErr: any) {
        logger.info('attach', `resume GAVE UP sessionId=${sessionId} cli=${cliSessionId} bytes=${historyBytes} budget=${RESUME_TIMEOUT_MS}ms err=${resumeErr?.message} -> fresh backend, history will be rebuilt`);
        const created = await client.newSession(cliCwd);
        cliSessionId = created.sessionId;
        // Backend is FRESH (resume failed / migrated / expired cli session).
        // Flag it so the context is rebuilt from KiroLex's own transcript BEFORE
        // the next user message is accepted -- the chat must remember its history
        // independent of whether kiro-cli could resume.
        freshBackend = true;
      }
      // A resume that "succeeded" is NOT proof the context is there. Verified
      // against kiro-cli's own store: it does NOT persist ACP sessions (none of a
      // real chat's five backend ids exist in data.sqlite3, while its
      // `--no-interactive` conversations do), so `session/load` accepts a known id
      // by starting an EMPTY conversation for it. The marker must therefore match
      // BOTH the id and the process that was actually fed -- a new pid means a
      // blank backend even when the id is unchanged.
      if (!freshBackend) {
        const establishedFor = existing?.contextEstablishedFor;
        const establishedPid = existing?.contextEstablishedPid;
        if (establishedFor !== undefined && (establishedFor !== cliSessionId || establishedPid !== client.pid)) {
          logger.info('attach', `resume ok but context is NOT in this backend sessionId=${sessionId} resumed=${cliSessionId} pid=${client.pid} establishedFor=${establishedFor} establishedPid=${establishedPid} -> will rebuild when the chat is used`);
          freshBackend = true;
        }
      }
      // Attach does NOT rebuild and does NOT lock the chat. With ride-along
      // context there is nothing to do here: the snapshot travels with the user's
      // first message, so a chat becomes ready at zero extra cost the moment it is
      // used, and chats never opened cost nothing at all. Only verbatim ('full')
      // mode still needs a real rebuild, and that one waits until the chat is used.
      const verbatimOwed = freshBackend && store.readRecord(sessionId)?.primeMode === 'full';
      if (freshBackend) {
        logger.info('prime', `context owed sessionId=${sessionId} mode=${verbatimOwed ? 'full (rebuild on first use)' : 'snapshot (rides along with the next message)'}`);
      }
      entry = { client, cliSessionId, profile, cwd: cliCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], lastUsedAt: Date.now(), needsHistoryPrime: verbatimOwed };
      freshBackendResult = verbatimOwed;
      // A delete may have landed during the async connect/resume above. If so,
      // tear the fresh client down and do NOT recreate the record on disk.
      if (deletedSessionIds.has(sessionId)) {
        try { await client.disconnect(); } catch {}
        throw new Error('Session was deleted during attach; aborted.');
      }
      sessionClients.set(sessionId, entry);
      wireSession(sessionId, entry);
      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      /*
        Persist the model that ACTUALLY started. Without this the record keeps
        pointing at a retired model (e.g. claude-opus-5), so EVERY later startup
        burns a full initialize timeout on it before falling back again — which is
        exactly what wedged the splash at "Connecting sessions… (0/N)".

        ── 但「降级」和「偏好抢先」是相反的两件事，不能共用这一次写 ────────────────

        `connectWithModelFallback` 返回的是**哪个候选连上了**，而连上对一个已退役的模型
        永远成立（见 `isModelUnavailableError` 上面那段：kiro-cli 只在真跑一轮时才报退役）。
        于是当 `preferredModel` 抢在记录的模型前面连上时，这里会把一个**从没成功跑过一轮**的
        模型写成「有效模型」，而被它盖掉的那个是上一次真跑成一轮挣来的。

        实测：记录里正确的 `gpt-5.6-sol` 被 `claude-opus-5` 反复盖掉，于是每次重启都从死模型
        开始 —— 换模型那 30 秒的静默窗口因此每次运行都要付一次（见 `modelsKnownDead`）。

        判据就在手边，300 行那段注释早就写了：偏好抢先时**记录的模型压根没被尝试过**，
        所以不能声称它不可用。所以只在**真的降级**时写（连上的不是偏好的那个 = 偏好确实失败了，
        或者压根没设偏好）。
      */
      const preferenceWonAhead = !!profile.preferredModel && profile.model === profile.preferredModel;
      if (rec.profile.model !== profile.model && !preferenceWonAhead) {
        logger.info('model', `attach ${sessionId}: persisting effective model '${profile.model}' (was '${rec.profile.model}', preferred '${profile.preferredModel}')`);
        rec.profile.model = profile.model;
        // Preference is sticky: it is retried first on the next attach.
        rec.profile.preferredModel = profile.preferredModel;
        // Announce it: otherwise the composer selector keeps showing the model the
        // renderer last knew about while the executor runs a different one.
        emitSessionModel(sessionId, profile.model);
      } else if (rec.profile.model !== profile.model) {
        logger.info('model', `attach ${sessionId}: 跑在偏好模型 '${profile.model}' 上，但**不写进记录**`
          + ` —— 记录里的 '${rec.profile.model}' 是上一次真跑成一轮挣来的，而"连上了"什么都不证明`);
      }
      store.writeRecord(rec);
      mainWindow?.webContents.send('session:ready-for-first-prompt', { sessionId, projectId: profile.projectId });
    }
    return { ok: true, freshBackend: freshBackendResult };
    } finally {
      attachingSessions.delete(sessionId);
      emitSessionBusy(sessionId);
    }
    })();
    attachInFlight.set(sessionId, attachPromise);
    try {
      const result = await attachPromise;
      // No rebuild is kicked here, and none is needed: the snapshot rides along
      // with the user's next message (zero extra turns). Verbatim ('full') chats do
      // owe a real rebuild and are marked as such, but it waits until the chat is
      // actually used -- firing N-turn replays at boot for chats nobody opened is
      // the cost this whole design exists to avoid.
      return result;
    } finally {
      attachInFlight.delete(sessionId);
    }
  });

  /** Manual rebuild. `force` also covers the case a successful session/load
   *  cannot rule out: kiro-cli resumed an id that was itself empty. */
  ipcMain.handle('acp:prime-history', async (_event, sessionId: string, force?: boolean) => {
    return primeHistoryNow(sessionId, { force: !!force });
  });

  /** The chat the user just opened. Verifies the backend really holds this chat's
   *  history and starts the rebuild if not.
   *
   *  Why a separate signal instead of doing it at attach: attach also fires for
   *  every session warmed at startup, and rebuilding all of them would be absurd.
   *  Why not leave it to the send gate: it meant a restored chat looked idle and
   *  the rebuild only began after the user had typed and sent something -- which is
   *  exactly what was observed. Activation is the earliest point where the intent
   *  to use this chat is known. */
  ipcMain.handle('acp:ensure-context', async (_event, sessionId: string) => {
    if (!sessionId || sessionId.startsWith('pending_')) return { ok: true, skipped: true };
    const entry = sessionClients.get(sessionId);
    if (!entry) return { ok: false, error: 'not attached' };
    // Opening a chat costs NOTHING for the default (snapshot) path: the context
    // rides along with the next message, so there is no rebuild to start and the
    // chat must not be locked. Verified from the logs that leaving this handler
    // rebuilding was exactly why "switching chats rebuilds every time" persisted
    // even after the ride-along was added: `trigger=activate` fired its own turn.
    // Only verbatim ('full') mode has a real rebuild to perform.
    if (store.readRecord(sessionId)?.primeMode !== 'full') {
      return { ok: true, skipped: true, rideAlong: true };
    }
    if (!markContextOwedIfUnverified(sessionId, 'activate')) return { ok: true, skipped: true };
    // Fire-and-forget: opening a chat must not block on the rebuild. The session
    // is already reported busy, so the composer queues instead of firing.
    void primeHistoryNow(sessionId).catch(() => {});
    return { ok: true, rebuilding: true };
  });

  /** Switch how this chat restores context: one snapshot prompt (default) or a
   *  verbatim replay of every chunk. Kept per session because the cost difference
   *  is enormous on big chats and only the user can judge whether the exactness is
   *  worth 78 model turns per launch. */
  ipcMain.handle('acp:set-prime-mode', async (_event, sessionId: string, primeMode: 'snapshot' | 'full') => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    try {
      /*
        `patchRecord` 而不是「读-改-写」：这个 IPC 也是在会话刚建出来时被调用的(flow 编辑会话交底那一步),
        而记录要到**第一次 prompt** 才创建 —— 读-改-写在那个窗口里必然失败,而且是静默的。实测:
        `purpose LOST … 等了 2s 记录还没出现` 之后 5 秒才有 `prompt received`。
      */
      const mode = primeMode === 'full' ? 'full' : 'snapshot';
      const where = store.patchRecord(sessionId, { primeMode: mode });
      const entry = sessionClients.get(sessionId);
      if (entry) { entry.primeChunks = undefined; entry.primeCursor = 0; }
      logger.info('prime', `mode set sessionId=${sessionId} primeMode=${mode} (${where})`);
      return { ok: true, primeMode: mode };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'failed' };
    }
  });


  // Initial occupancy snapshot: the renderer paints per-session busy state on
  // hydrate/session switch instead of waiting for the next push.
  ipcMain.handle('acp:get-busy-map', async () => {
    const map: Record<string, string> = {};
    const ids = new Set<string>([
      ...sessionClients.keys(),
      ...reconfiguringSessions,
      ...attachingSessions,
    ]);
    for (const id of ids) {
      const reason = busyReasonFor(id);
      if (reason) map[id] = reason;
    }
    return map;
  });

  ipcMain.handle('acp:request-permission-response', async (
    _event,
    requestId: number | string,
    optionId: string,
    sessionId: string,
  ) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');
    // Close the wait span. Measured from the REQUEST, not from when the dialog was
    // rendered: the wait the user cares about is the whole time the turn was blocked.
    const requestKey = String(requestId ?? '');
    const startedAt = permissionWaitStartedAt.get(requestKey);
    permissionWaitStartedAt.delete(requestKey);
    eventLog.appendEvent(sessionId, {
      ts: Date.now(),
      type: 'permission_response',
      turn: entry.currentUserMessageId,
      optionId,
      ms: startedAt ? Date.now() - startedAt : 0,
      detail: requestKey,
    });
    if (startedAt) {
      logger.info('permission', `answered sessionId=${sessionId} option=${optionId} waited=${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
    }
    return entry.client.respondToPermission(requestId, optionId);
  });

  /** Read this session's run event log (timeline + event stream views). */
  ipcMain.handle('acp:read-events', (_event, sessionId: string, limit?: number) => {
    if (!sessionId) return { events: [], path: '', truncated: false };
    return eventLog.readEvents(sessionId, Math.min(Math.max(1, Number(limit) || 4000), 20000));
  });

  // Write-once project assignment (design §6.4). Allowed only for the
  // null/undefined -> concrete transition; project->project or un-set is
  // rejected. Persists to the durable record and syncs any live executor.
  ipcMain.handle('acp:assign-project', async (_event, sessionId: string, projectId: string) => {
    const rec = store.readRecord(sessionId);
    if (!rec) throw new Error('No such session');
    if (!canAssignProjectId(rec.profile.projectId, projectId)) {
      throw new Error('projectId is write-once; it cannot be changed once set.');
    }
    rec.profile.projectId = projectId;
    store.writeRecord(rec);
    const entry = sessionClients.get(sessionId);
    if (entry) entry.profile.projectId = projectId; // keep live executor in sync
    return { sessionId, projectId };
  });

  // Project-level force set/clear (used by rename/delete PROJECT, an explicit
  // admin operation). Unlike acp:assign-project this bypasses the write-once
  // check on purpose; per-session Assign still goes through the checked path.
  ipcMain.handle('acp:set-project', async (_event, sessionId: string, projectId: string | null) => {
    const rec = store.readRecord(sessionId);
    if (!rec) return { sessionId, projectId };
    rec.profile.projectId = projectId ?? undefined;
    store.writeRecord(rec);
    const entry = sessionClients.get(sessionId);
    if (entry) entry.profile.projectId = projectId ?? undefined;
    return { sessionId, projectId };
  });

  // Move a session to another project (or unassign with null) WITH an executor
  // reset. Changing the project changes the injected memory scope; a live
  // executor already has the OLD project's memory in its context. We detach it
  // so a fresh executor attaches on next use, re-injecting ONLY the new scope's
  // memory (old injection state is discarded with the entry). The durable
  // transcript + memory are untouched; the backend session resumes on re-attach,
  // so the conversation is preserved. Unlike assign-project this is not
  // write-once — it is an explicit user move.
  ipcMain.handle('acp:move-session', async (_event, sessionId: string, projectId: string | null) => {
    const rec = store.readRecord(sessionId);
    if (rec) {
      rec.profile.projectId = projectId ?? undefined;
      rec.archived = false; // moving a chat brings it out of the archive
      store.writeRecord(rec);
    }
    detachExecutor(sessionId); // executor reset -> fresh memory scope on re-attach
    return { sessionId, projectId: projectId ?? null };
  });

  // Expose the auto-sized executor cap so the renderer warms the right number
  // of sessions at startup (instead of a hardcoded count).
  ipcMain.handle('acp:get-executor-cap', async () => MAX_CONCURRENT_SESSIONS);

  // Helper (background chore) models: chat titles + prompt suggestions. Exposed in
  // Settings so a throttled/retired helper model can be swapped without a rebuild.
  // Last browsed workspace directory. GLOBAL and stored in ~/.kirolex/config.json
  // rather than localStorage: it is a single app-wide preference, and this
  // project has already lost localStorage state when the origin changed.
  ipcMain.handle('app:get-workspace-dir', () => {
    try {
      const cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8'));
      const dir = String(cfg?.lastWorkspaceDir || '').trim();
      if (!dir) { logger.info('workspace', 'no remembered dir yet -> panel will open at its default'); return null; }
      if (fs.existsSync(dir)) { logger.info('workspace', `remembered dir: ${dir}`); return dir; }
      // The directory is gone (deleted, renamed, unmounted). Walk UP to the nearest
      // ancestor that still exists instead of dropping the user back at home: being
      // one level above where you were is far closer to "where I was" than $HOME.
      let up = path.dirname(dir);
      while (up !== path.dirname(up) && !fs.existsSync(up)) up = path.dirname(up);
      const fallback = fs.existsSync(up) ? up : null;
      logger.info('workspace', `remembered dir is gone (${dir}) -> nearest existing ancestor: ${fallback || '<none>'}`);
      return fallback;
    } catch { return null; }
  });
  ipcMain.handle('app:set-workspace-dir', (_event, dir: string) => {
    try {
      let cfg: any = {};
      try { cfg = JSON.parse(fs.readFileSync(KIROLEX_CONFIG_PATH, 'utf-8')); } catch {}
      cfg.lastWorkspaceDir = String(dir || '').trim();
      const tmp = `${KIROLEX_CONFIG_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
      fs.renameSync(tmp, KIROLEX_CONFIG_PATH);
      return { ok: true };
    } catch (error: any) {
      // A silent failure here means the directory is remembered for this run only
      // and is gone after a restart, with nothing anywhere saying why.
      logger.warn('workspace', `failed to remember dir ${dir}: ${error?.message || error}`);
      return { ok: false, error: error?.message || String(error) };
    }
  });

  ipcMain.handle('app:get-helper-models', async () => {
    const { model, fallback } = loadHelperModels();
    return { model, fallback, defaults: { model: DEFAULT_HELPER_MODEL, fallback: DEFAULT_HELPER_FALLBACK_MODEL } };
  });
  ipcMain.handle('app:set-helper-models', async (_event, model: string, fallback: string) => {
    saveHelperModels(model, fallback);
    const saved = loadHelperModels();
    logger.info('helper-models', `primary='${saved.model}' fallback='${saved.fallback || '(none)'}'`);
    return saved;
  });
  // Report the auto-computed cap + whether an override is active (for Settings UI).
  ipcMain.handle('app:get-executor-cap-info', async () => ({
    cap: MAX_CONCURRENT_SESSIONS,
    auto: MAX_CONCURRENT_SESSIONS_AUTO,
    overridden: loadExecutorCapOverride() > 0,
  }));
  // Set a persisted cap override (0 = revert to auto). Applies live.
  ipcMain.handle('app:set-executor-cap', async (_event, n: number) => {
    saveExecutorCapOverride(n);
    MAX_CONCURRENT_SESSIONS = (n > 0 ? Math.max(1, Math.min(64, Math.floor(n))) : MAX_CONCURRENT_SESSIONS_AUTO);
    return { ok: true, cap: MAX_CONCURRENT_SESSIONS };
  });

  ipcMain.handle('app:get-wedge-timeout', async () => ({
    seconds: Math.round(WEDGE_CONFIRM_MS / 1000),
    default: WEDGE_CONFIRM_SECONDS_DEFAULT,
    min: WEDGE_CONFIRM_SECONDS_MIN,
    max: WEDGE_CONFIRM_SECONDS_MAX,
  }));
  // 0 turns the wedge interrupt off (the advisory quiet notice stays). Applies live:
  // the watchdog reads WEDGE_CONFIRM_MS on every tick, so in-flight turns pick it up.
  ipcMain.handle('app:set-wedge-timeout', async (_event, n: number) => {
    saveWedgeConfirmSeconds(n);
    WEDGE_CONFIRM_MS = loadWedgeConfirmSeconds() * 1000;
    logger.info('features', `wedge interrupt threshold = ${WEDGE_CONFIRM_MS ? `${WEDGE_CONFIRM_MS / 1000}s` : 'off'}`);
    return { ok: true, seconds: Math.round(WEDGE_CONFIRM_MS / 1000) };
  });

  ipcMain.handle('app:get-tool-stall-timeout', async () => ({
    seconds: Math.round(TOOL_STALL_MS / 1000),
    default: TOOL_STALL_SECONDS_DEFAULT,
    min: TOOL_STALL_SECONDS_MIN,
    max: TOOL_STALL_SECONDS_MAX,
  }));
  ipcMain.handle('app:set-tool-stall-timeout', async (_event, n: number) => {
    saveToolStallSeconds(n);
    TOOL_STALL_MS = loadToolStallSeconds() * 1000;
    logger.info('features', `tool stall bound = ${TOOL_STALL_MS / 1000}s`);
    return { ok: true, seconds: Math.round(TOOL_STALL_MS / 1000) };
  });

  // Archive / unarchive a session. Archiving hides it from the main list and
  // frees its executor slot (a later unarchive/open re-attaches transparently);
  // the durable transcript + memory are untouched. Not a delete.
  ipcMain.handle('acp:archive-session', async (_event, sessionId: string, archived: boolean) => {
    const rec = store.readRecord(sessionId);
    if (rec) {
      rec.archived = !!archived;
      // Archiving detaches the chat from its project: it carries no project
      // memory while archived, and unarchive returns it to the Unassigned bucket.
      if (archived) rec.profile.projectId = undefined;
      store.writeRecord(rec);
    }
    if (archived) detachExecutor(sessionId); // give the warm slot back
    return { sessionId, archived: !!archived };
  });

  // Delete a project's memory directory (project deletion).
  ipcMain.handle('acp:delete-project-memory', async (_event, projectId: string) => {
    deleteProjectMemory(projectId);
    return { projectId };
  });

  // Memory editor UI: read/write layered memory.
  // Authoritative transcript read (design §4): the durable, uncapped,
  // per-KiroLex-id record. Used by cross-session context sync so it works for
  // chats beyond the renderer's 20-session cache and survives restart.
  // Pasted TEXT blobs live on disk, mirroring how pasted images already work: the
  // composer keeps only a `[ 粘贴 #N · M 行 ]` placeholder, the bytes go to a file.
  // NOT under ~/.kirolex/pasted (that whole directory is wiped on every boot for
  // image temp files) — a paste file is PRIMARY data: the transcript stores the
  // placeholder, so losing the file would lose the message's real content.
  ipcMain.handle('app:save-paste-text', (_event, text: string) => {
    try {
      const body = String(text ?? '');
      if (!body) return null;
      const dir = path.join(os.homedir(), '.kirolex', 'pastes');
      fs.mkdirSync(dir, { recursive: true });
      const name = `paste_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`;
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, body, 'utf-8');
      return {
        path: filePath,
        lines: body.split('\n').length,
        chars: body.length,
        preview: body.slice(0, 200),
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('app:get-auto-resent', () => loadAutoResent());
  ipcMain.handle('app:set-auto-resent', (_event, sessionId: string, key: string) => {
    if (!sessionId) return { ok: false };
    const map = loadAutoResent();
    if (key) map[sessionId] = String(key); else delete map[sessionId];
    saveAutoResent(map);
    return { ok: true };
  });

  ipcMain.handle('app:get-draft-pastes', () => loadDraftPastes());
  ipcMain.handle('app:set-draft-pastes', (_event, sessionId: string, blocks: any[]) => {
    if (!sessionId) return { ok: false };
    const map = loadDraftPastes();
    if (Array.isArray(blocks) && blocks.length) {
      map[sessionId] = blocks.map((b: any) => ({
        seq: Number(b?.seq) || 0,
        lines: Number(b?.lines) || 0,
        chars: Number(b?.chars) || 0,
        path: String(b?.path || ''),
      })).filter((b: any) => b.path);
    } else {
      delete map[sessionId];
    }
    saveDraftPastes(map);
    return { ok: true };
  });

  ipcMain.handle('app:read-paste', (_event, filePath: string) => {
    try {
      const dir = path.join(os.homedir(), '.kirolex', 'pastes');
      const resolved = path.resolve(String(filePath || ''));
      // Confine reads to the paste directory: this path comes from persisted
      // message metadata, so it must never be able to read arbitrary files.
      if (!resolved.startsWith(dir + path.sep)) return null;
      return fs.readFileSync(resolved, 'utf-8');
    } catch {
      return null;
    }
  });

  ipcMain.handle('acp:read-transcript', async (_event, sessionId: string) => {
    return store.readTranscript(sessionId);
  });

  ipcMain.handle('acp:truncate-transcript-before', async (
    _event,
    sessionId: string,
    messageId: string,
  ) => store.truncateTranscriptBefore(sessionId, messageId));

  // Rewrite the transcript to exactly the given messages (edit-and-rerun). Robust
  // against renderer messages that were never persisted under that id (steers).
  ipcMain.handle('acp:rewrite-transcript', async (
    _event,
    sessionId: string,
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: store.StoredToolCall[] }>,
  ) => {
    store.rewriteTranscript(sessionId, Array.isArray(messages) ? messages : []);
    return { ok: true };
  });

  // Durable session index (design §4): the on-disk record.json set is the
  // source of truth for which sessions exist. The renderer hydrates its sidebar
  // from this so an origin change (dev port drift) or a cleared localStorage can
  // never make sessions "disappear" — the transcripts on disk are intact.
  ipcMain.handle('acp:list-durable-sessions', async () => {
    // Hydrate: the renderer asking for the session list is the START of its own
    // work, so this mark separates "renderer booting" from "renderer hydrating".
    startupMark('hydrate: list-durable-sessions requested');
    const tombstoned = new Set([...loadSessionTombstones(), ...deletedSessionIds]);
    return store.listSessions().filter((rec) => !tombstoned.has(rec.id)).map((rec) => ({
      id: rec.id,
      title: rec.title,
      projectId: rec.profile?.projectId,
      model: rec.profile?.model,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      archived: !!rec.archived,
      pinned: !!rec.pinned,
      // 持久化的角色标记：删除保护和「别回收主会话」都要靠它，重启后必须还在
      ...(rec.purpose ? { purpose: rec.purpose } : null),
      ...(rec.flow ? { flow: rec.flow } : null),
      /**
       * 这条会话跑在哪个 agent 下 —— 记录里一直有（`profile.kiroAgent`），但从来没发给渲染层。
       *
       * `Session.kiroAgent` 因此只在你**手动切 agent** 时才有值，别的时候都是 undefined。撞到的后果：
       * 泳道复用要比 agent（会话的 agent 创建时就定了，换不了），比到的永远是 undefined，于是
       * 一个配了 agent 的 flow **每一步都另起一条会话** —— 复用被静默禁掉，而没有任何报错。
       */
      ...(rec.profile?.kiroAgent ? { kiroAgent: rec.profile.kiroAgent } : null),
    }));
  });

  /**
   * 把「这个会话是干什么的」写进记录 —— `flow-main` 的删除保护靠它，所以不能只活在 renderer 内存里。
   *
   * **等记录出现再写** —— 实测这个标记从来没写成功过:全部 11 份日志里 `[session] purpose` 出现 0 次,而
   * `~/.kirolex/sessions/s_1786935225555_jpec0z/record.json` 里 purpose 是空的。原因是调用时机:renderer 在
   * `newSession` 一返回就标记,那时记录还没落盘,`readRecord` 给 null,这里就 `return { ok:false }` 走了 ——
   * 而调用方是 `void`,没人看返回值,所以是**静默**丢失。后果一路传到分屏:purpose 没了,「flow 会话不进分屏」
   * 的判据就失效,自动 seed / 领养那两条效果照样把它塞进格子(改名同理,标题兜底也一起没了)。
   *
   * **等不是办法，挂起才是** —— 上一版让这里轮询 2 秒，方向就错了：记录不是「晚一点写」，而是**第一次 prompt
   * 才创建**。实测同一条会话：`03:53:54 purpose LOST … 等了 2s` → `03:53:59 prompt received`（记录此刻才有）。
   * 所以改成 `patchRecord`：记录在就直接写，不在就挂起，`createSession` 一建记录立刻应用。
   */
  ipcMain.handle('acp:mark-session-purpose', async (_event, sessionId: string, purpose: string, flow?: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    const patch: Partial<ReturnType<typeof store.readRecord> & object> = {
      purpose: (purpose || '').trim() || undefined,
    };
    if (flow !== undefined) (patch as any).flow = (flow || '').trim() || undefined;
    const where = store.patchRecord(sessionId, patch as any);
    logger.info('session', `purpose ${sessionId} = ${(purpose || '').trim() || '(cleared)'}${flow ? ' flow=' + flow : ''} (${where})`);
    return { ok: true, deferred: where === 'pending' };
  });

  /**
   * 会话标题落盘 —— 「这个 project 里面还是有一条没用的 new chat」的一半原因。
   *
   * `renameSession` 一直**只改渲染层内存**（`setSessions(... { ...s, title })`），主进程连一个改标题的
   * IPC 都没有。于是标题一刷新就退回磁盘上的 `New Chat` —— 实测 SFDC 那个 project 下四条会话
   * （一条主会话 + 三条 worker）在磁盘上**全都叫 `New Chat`**，而侧栏上它们本来显示着步骤名。
   *
   * flow 起的会话尤其吃亏：它们的名字是驱动器现取的（`${flow} · ${步骤名}`），而一条没有名字的
   * 子会话在侧栏里就是"一条没用的 new chat"，你没法判断它属于谁、能不能动。
   *
   * 走 `patchRecord`（和 `acp:mark-session-purpose` 一样）：它能处理"记录还没建出来"的情况 ——
   * flow 的 worker 恰好就是这种，记录是第一次 prompt 才创建的，而改名发生在那之前。
   */
  ipcMain.handle('acp:rename-session', async (_event, sessionId: string, title: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    const next = String(title || '').trim();
    if (!next) return { ok: false, error: 'empty title' };
    const where = store.patchRecord(sessionId, { title: next } as any);
    logger.info('session', `renamed ${sessionId} -> ${JSON.stringify(next)} (${where})`);
    return { ok: true, deferred: where === 'pending' };
  });

  // Persist pin state to the durable record so it survives restart / origin
  // changes. Writes directly (no updatedAt bump) so pinning never reorders the list.
  ipcMain.handle('acp:set-session-pinned', async (_event, sessionId: string, pinned: boolean) => {
    const rec = store.readRecord(sessionId);
    if (rec) {
      rec.pinned = !!pinned;
      try {
        const p = path.join(os.homedir(), '.kirolex', 'sessions', sessionId, 'record.json');
        const tmp = p + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
        fs.renameSync(tmp, p);
      } catch { /* best-effort */ }
    }
    return { sessionId, pinned: !!pinned };
  });

  /** User-selectable features. Reading is cheap and uncached on purpose, so the
   *  Settings panel and every call site always agree on the live value. */
  ipcMain.handle('app:get-features', () => ({
    flags: loadFeatureFlags(),
    defaults: { ...FEATURE_DEFAULTS },
    /**
     * **kiro-cli 的 trace 日志开着吗** —— 「配置中未发现人为启用特殊日志级别」。
     *
     * 那个开关不在 kiro 的配置里，而在 KiroLex 侧（`~/.kirolex/kiro-trace`），所以查 kiro 的配置
     * 一定查不到；而它一开就是每秒几十 KB、一天十几 GB。开着的时候界面上原来**一个字都没有** ——
     * 一个悄无声息、代价按 GB 计的开关，忘了关就是磁盘被填满。所以状态跟着这份 payload 一起给出去，
     * 侧栏挂一个显眼的标记（`kiroTrace`）。
     */
    kiroTrace: kiroTraceEnabled(),
  }));
  /** 开/关 kiro-cli 的 trace 日志（标记文件；下一次起执行器生效）。 */
  ipcMain.handle('app:set-kiro-trace', (_event, enabled: boolean) => {
    const file = path.join(os.homedir(), '.kirolex', 'kiro-trace');
    try {
      if (enabled) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, '');
      } else {
        fs.rmSync(file, { force: true });
      }
      logger.warn('logs', `kiro-cli trace 日志 -> ${enabled ? '开' : '关'}（下一次起执行器生效）`);
      return { ok: true, kiroTrace: kiroTraceEnabled() };
    } catch (err: any) {
      return { ok: false, error: String(err?.message || err) };
    }
  });  ipcMain.handle('app:set-feature', (_event, key: string, enabled: boolean) => {
    if (!key || !(key in FEATURE_DEFAULTS)) return { ok: false, error: `unknown feature: ${key}` };
    return { ok: true, flags: saveFeatureFlag(key, !!enabled) };
  });

  /** The EXACT block that would be injected on the next message, assembled from the
   *  same pure function the send path uses — so the preview cannot drift from reality.
   *  Injection was otherwise invisible: the record keeps only a char count, leaving no
   *  way to check what the model was actually told. */
  /** What the last send ACTUALLY carried, read back from the archive written at send
   *  time. Deliberately not re-derived: rebuilding the snapshot now would describe the
   *  current transcript, not the one this session was primed with. */
  ipcMain.handle('acp:read-last-injection', async (_event, sessionId?: string) => {
    if (!sessionId) return { text: '', at: null, path: null, override: false, overrideAt: null, overridePath: null };
    const rec = store.readLastInjection(sessionId);
    // The override is reported alongside, because the Snapshot tab has to say WHICH of
    // the two will actually be sent next -- an editor that silently shows the archive
    // while a curated block is in force would be the worst of both.
    const override = store.readContextOverride(sessionId);
    return {
      text: override?.text ?? rec?.text ?? '',
      at: rec?.at ?? null,
      path: store.lastInjectionPath(sessionId),
      override: !!override,
      overrideAt: override?.at ?? null,
      overridePath: store.contextOverridePath(sessionId),
      /** The archive, always -- so "restore the generated one" can show what it will
       *  go back to without a second round trip. */
      sentText: rec?.text ?? '',
    };
  });

  /** Pin a hand-edited context block for this chat. Used verbatim by the next send. */
  ipcMain.handle('acp:write-context-override', async (_event, sessionId: string, text: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    try {
      if (!text.trim()) {
        // Saving an empty editor means "stop overriding", not "send nothing".
        const cleared = store.clearContextOverride(sessionId);
        logger.info('prime', `context override cleared by empty save sessionId=${sessionId} existed=${cleared}`);
        return { ok: true, override: false };
      }
      store.writeContextOverride(sessionId, text);
      logger.info('prime', `context override SAVED sessionId=${sessionId} chars=${text.length} -> next message sends this instead of the generated snapshot`);
      return { ok: true, override: true, path: store.contextOverridePath(sessionId) };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'failed' };
    }
  });

  /** Back to the generated snapshot. */
  ipcMain.handle('acp:clear-context-override', async (_event, sessionId: string) => {
    if (!sessionId) return { ok: false, error: 'no sessionId' };
    const existed = store.clearContextOverride(sessionId);
    logger.info('prime', `context override removed sessionId=${sessionId} existed=${existed} -> generated snapshot again`);
    return { ok: true, existed };
  });

  ipcMain.handle('acp:read-memory', async (_event, projectId?: string, sessionId?: string) => {
    return readMemory(projectId, sessionId);
  });  ipcMain.handle('acp:write-memory', async (_event, scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => {
    writeMemory(scope, projectId, sessionId, content);
    return { ok: true };
  });

  /** 三层体积，按需取一次。给两个时机用：会话切换/启动（打开就能看到横幅），以及
   *  MemoryDialog 保存之后（你手动清理完立刻消失，不用等下一轮对话）。 */
  ipcMain.handle('acp:memory-bytes', async (_event, projectId?: string, sessionId?: string) => {
    return memoryLayerBytes(projectId, sessionId);
  });

  /** 压缩前备份某一层记忆。时间戳由主进程生成，渲染进程不需要关心命名规则。 */
  ipcMain.handle('acp:backup-memory', async (
    _event, scope: MemoryScope, projectId?: string, sessionId?: string,
  ) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const at = backupMemoryLayer(scope, projectId, sessionId, stamp);
    if (at) logger.info('memory', `backed up ${scope} -> ${at}`);
    else logger.warn('memory', `nothing to back up for scope=${scope}`);
    return { ok: !!at, at };
  });
});

/** Shared UI state. Registered OUTSIDE the app-ready IPC block because preload
 *  asks for it synchronously while the window is being created. */
ipcMain.on('app:ui-state-all', (event) => {
  event.returnValue = uiState();
});
ipcMain.on('app:ui-state-set', (_event, key: string, value: string | null) => {
  const isNew = value !== null && !Object.prototype.hasOwnProperty.call(uiState(), key);
  setUiStateKey(key, value);
  // Logged on first sight so a migration from the old per-origin localStorage is
  // observable rather than assumed.
  if (isNew) logger.info('ui-state', `adopted key=${key} chars=${String(value).length} -> ${UI_STATE_PATH}`);
});

/** One-time migration of the UI state out of the origin-scoped localStorage.
 *
 *  The real, current values live in the `file://` origin (a normal start). Dev mode
 *  runs on `http://localhost:5173`, whose localStorage holds a STALE copy from
 *  whenever dev last ran -- so dev must never seed the shared store from its own
 *  localStorage, and it also cannot read the good one directly.
 *
 *  So: open a hidden, EMPTY page on the file:// origin and read the keys from
 *  there. An empty page is used deliberately rather than the real index.html --
 *  loading the app again would boot a second renderer and attach every session.
 *
 *  Runs only while the shared store is still empty, i.e. exactly once, and it means
 *  `npm run dev:hot` needs no preparatory production launch. */
async function migrateUiStateFromFileOrigin(): Promise<void> {
  if (Object.keys(uiState()).length > 0) return;
  const htmlPath = path.join(__dirname, '..', 'renderer', '_ui-state-migrate.html');
  try {
    fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
    // Recreated on demand: `vite build` empties dist/renderer.
    fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><title>ui-state</title>');
  } catch (err: any) {
    logger.info('ui-state', `migration skipped (cannot write probe page): ${err?.message}`);
    return;
  }
  const probe = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await probe.loadFile(htmlPath);
    const dump = await probe.webContents.executeJavaScript(
      `(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) {`
      + ` const k = localStorage.key(i); if (k && k.indexOf('kirolex-') === 0) o[k] = localStorage.getItem(k); } return o; })()`,
    );
    let n = 0;
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(dump || {})) {
      // The sweep is a blanket `kirolex-*` import, so it would faithfully carry a
      // retired key back in. Filter here as well as pruning after.
      if (DEAD_UI_STATE_KEYS.has(k)) { skipped.push(k); continue; }
      // Same reason, different lifetime: a run-scoped key must start empty, so the
      // stale localStorage mirror from the PREVIOUS run must not be carried in.
      if (RUN_SCOPED_UI_STATE_KEYS.has(k)) { skipped.push(k); continue; }
      if (typeof v === 'string' && v) { setUiStateKey(k, v); n += 1; }
    }
    if (skipped.length) logger.info('ui-state', `skipped retired key(s) during migration: ${skipped.join(', ')}`);
    logger.info('ui-state', n > 0
      ? `migrated ${n} key(s) from the file:// origin -> ${UI_STATE_PATH} (${Object.keys(dump || {}).join(', ')})`
      : 'migration found no kirolex-* keys on the file:// origin (nothing to carry over)');
  } catch (err: any) {
    logger.info('ui-state', `migration FAILED: ${err?.message} -- start once with \`npm start\` to seed it`);
  } finally {
    try { probe.destroy(); } catch {}
  }
}

app.on('before-quit', () => {
  isQuitting = true;
  // Kill all per-session kiro-cli child processes so none are orphaned
  for (const [, entry] of sessionClients) {
    try { entry.client.disconnect(); } catch {}
  }
  sessionClients.clear();
});

/** Turn a supervisor's SIGTERM into a REAL app quit.
 *
 *  The dev supervisor relaunches Electron whenever main is recompiled. Without
 *  this, SIGTERM tears the process down without running `before-quit`, so each
 *  kiro-cli child dies without closing stdin -- which leaves a STALE session lock
 *  and makes the next `session/load` fail with "Session is active in another
 *  process (PID n)" even though that pid is long gone. Quitting properly is what
 *  makes "edit KiroLex inside KiroLex" survivable. */
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    logger.info('app', `${sig} received -> graceful quit (releasing kiro-cli sessions)`);
    try { app.quit(); } catch { process.exit(0); }
    // Backstop: if quit stalls (a busy turn, a hung child), leave anyway.
    setTimeout(() => process.exit(0), 5000);
  });
}

app.on('window-all-closed', () => {
  // Don't quit on Windows/Linux when window is hidden to tray
  if (process.platform === 'darwin') {
    // macOS: keep app running
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else if (mainWindowRevealed) {
    // Only restore on dock-click AFTER the initial gated reveal. Before that,
    // launch-time `activate` must not show the still-loading window.
    mainWindow.show();
  }
});
