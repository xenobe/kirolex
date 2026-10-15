import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard, dialog, shell } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync, execFile } from 'child_process';
import { AcpClient, resolveKiroCli } from './acp-client';
import { rewriteImagePaths } from './imagePaths';
import { AgentProfile, DEFAULT_MODEL, MODEL_FALLBACK_ORDER, deriveProjectId, canAssignProjectId, loadActiveRemoteTarget, sessionCwd } from './config';
import * as store from './sessionStore';
import { buildMemoryInjection, deleteProjectMemory, deleteSessionMemory, readMemory, writeMemory } from './memory';
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
   *  Second guard for wedge detection, covering what CPU cannot: a tool that WAITS
   *  (a slow download, a remote API) burns nothing anywhere in the process tree, so it
   *  still reads as idle. An open tool call is the protocol stating outright that the
   *  turn is busy, so it suppresses the interrupt.
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
  /** whether layered memory has been injected on this executor's first prompt
   *  (design §6.4) — re-armed each time a fresh executor attaches. */
  memoryInjected: boolean;
  /** the projectId used in the last memory injection; re-inject if it changes. */
  injectedProjectId?: string;
  /** the exact memory block last injected; re-inject when the content changes
   *  (so same-project chats pick up each other's memory writes). */
  lastInjectedMemory?: string;
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
/** Start an executor for `profile`, falling back through MODEL_FALLBACK_ORDER
 *  when the requested model cannot start (unavailable / retired / throttled).
 *  Returns the live client plus the model that actually worked, so the caller can
 *  persist the effective model instead of a dead one. */
async function connectWithModelFallback(
  profile: AgentProfile,
  label: string,
): Promise<{ client: AcpClient; model: string }> {
  const candidates: string[] = [profile.preferredModel, profile.model, ...MODEL_FALLBACK_ORDER]
    .filter((m): m is string => !!m)
    .filter((m, i, arr) => arr.indexOf(m) === i);
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
  sessionClients.delete(sessionId);               // release single-process ownership
  try { await entry.client.disconnect(); } catch {}
  for (const model of candidates) {
    const profile: AgentProfile = { ...entry.profile, model };
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
      logger.warn('model', `${label}: '${failedModel}' unavailable at prompt time -> switched to '${model}'`);
      emitSessionModel(sessionId, model);
      return model;
    } catch (err: any) {
      logger.warn('model', `${label}: fallback '${model}' failed to take over: ${err?.message || err}`);
      try { await client.disconnect(); } catch {}
    }
  }
  return null;
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

/** Text an ACP tool call reported, across ALL of its content blocks.
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

/** Is this backend PROVEN to hold this chat's history? The marker is written only
 *  after a rebuild completed, and it pins both the ACP session id AND the pid --
 *  a successful `session/load` is not evidence, because kiro-cli does not persist
 *  ACP sessions (verified live: an ACP turn writes no row to its own
 *  data.sqlite3, while its `--no-interactive` chats do). */
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
  return true;
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
      .filter((m) => !(m.role === 'assistant' && m.content.startsWith('💭 ')));
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

/** The snapshot, worded to ride along with the user's own message rather than to
 *  be a standalone priming turn (so: no "reply OK", and it explicitly hands off to
 *  the real message that follows it). */
function buildHistoryRideAlong(sessionId: string): string {
  try {
    const stored = store.readTranscript(sessionId)
      .filter((m) => !(m.role === 'assistant' && m.content.startsWith('💭 ')));
    const lines = stored.map((m) => historyLine(m));
    if (!lines.join('').trim()) return '';
    return `${buildSnapshot(sessionId, stored, lines, { rideAlong: true })}\n\n---\n\n以上是恢复的上下文。下面是用户这一条新消息，请正常回答它：`;
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
      .filter((m) => !(m.role === 'assistant' && m.content.startsWith('💭 ')));
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

/** Race a session/load against a wall clock. Without this a wedged load (stale *  cliSessionId that keeps streaming and resetting the idle timer) never
 *  settles, so the reconfiguring flag is never cleared and EVERY later switch
 *  fails with "Another model, Agent, or permission change is still in progress." */
function withLoadTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`session/load 超时（${ms / 1000}s 无响应）`)), ms)),
  ]);
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
 *  runs on a remote server, so "slow" and "dead" are locally indistinguishable. Three
 *  OS-level corroborations were tried and measured to be useless — see the watchdog for
 *  the numbers.
 *
 *  The threshold is therefore user-tunable, since it is the whole judgement: a turn
 *  whose FIRST token is genuinely slow is indistinguishable from a hung one. Raise it if
 *  a legitimate slow turn is ever interrupted; set 0 to switch the interrupt off and keep
 *  only the advisory 5-minute notice. What makes the heuristic acceptable is that its
 *  consequence is cheap: a turn that produced nothing is auto-resent, and one that
 *  produced a partial reply is left alone for the user to decide. */
const WATCHDOG_TICK_MS = 30000;             // how often silence is re-checked
const WEDGE_CONFIRM_SECONDS_DEFAULT = 180;
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

/** How long the CPU-progress check watches the executor's process tree, and how
 *  much CPU counts as "working". Both numbers were MEASURED before being trusted,
 *  in the two directions that matter:
 *    - working: PowerShell 5.1 `ConvertFrom-Json` over a 7.6MB file, seen through
 *      an IDLE parent (the shape that got killed) -> +5.281s per 5s window.
 *    - idle floor: eight windows over two live, idle kiro-cli acp executors
 *      (5-pid trees, conhost + MCP children included) -> 0.000s..0.078s.
 *  0.25s (5% of one core) leaves 3x headroom over the worst idle window and sits
 *  21x below the working signal. Getting the floor wrong in the other direction is
 *  the dangerous one: a permanently vetoing check would resurrect the unbounded
 *  hang this whole mechanism exists to stop. One sample costs ~0.5s. */
const CPU_PROBE_WINDOW_MS = 5000;
const CPU_PROBE_MIN_SECONDS = 0.25;

/** Ceiling on how long CPU progress may postpone an interrupt, as a multiple of
 *  whichever limit gated the decision (30 min tool-stall default -> up to 90 min of
 *  extra grace, 2h total). A ceiling is MANDATORY, not tidiness: burning CPU and
 *  being hung are not exclusive — a spin-wait pegs a core forever — so an unbounded
 *  veto would restore the very hang the watchdog exists to end. Derived from the
 *  user's own setting so there is no second magic number to discover. */
const CPU_VETO_MAX_MULTIPLE = 3;

/** Cumulative CPU seconds PER PID for rootPid's whole descendant tree.
 *
 *  Per-pid, not one summed total, and that is the entire point. A summed tree CPU
 *  is NON-MONOTONIC — when a child exits its accrued time leaves the sum, so the
 *  total DROPS (measured: 3.02 -> 5.72 -> 3.25) and a busy turn reads as an idle
 *  one. Keeping pids separate lets the caller add up only POSITIVE per-pid deltas,
 *  where an exiting child merely drops out of the intersection.
 *
 *  An empty map means "could not tell", never "idle": the only consumer uses this
 *  to VETO an interrupt, so absent evidence changes nothing. */
async function sampleTreeCpu(rootPid: number | undefined): Promise<Map<number, number>> {
  const perPid = new Map<number, number>();
  if (!rootPid) return perPid;
  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const run = promisify(execFile);
  const rows: { pid: number; ppid: number; cpu: number }[] = [];
  try {
    if (process.platform === 'win32') {
      // ONE CIM query carries parentage AND cpu (100-ns units), so there is no
      // second query to join against. ~0.5s, and only ever run on demand.
      const { stdout } = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId,$_.ParentProcessId,($_.KernelModeTime + $_.UserModeTime) }",
      ], { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      for (const line of String(stdout).split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 3) continue;
        const pid = Number(f[0]), ppid = Number(f[1]), ticks = Number(f[2]);
        if (!Number.isFinite(pid) || !Number.isFinite(ppid) || !Number.isFinite(ticks)) continue;
        rows.push({ pid, ppid, cpu: ticks / 1e7 });
      }
    } else {
      const { stdout } = await run('ps', ['-Ao', 'pid=,ppid=,time='], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
      for (const line of String(stdout).split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 3) continue;
        const pid = Number(f[0]), ppid = Number(f[1]);
        // [dd-]hh:mm:ss — 1s granularity, which is why the window is 5s and not 2s.
        const parts = f[2].split('-');
        const clock = (parts.pop() || '').split(':').map(Number);
        let secs = 0;
        for (const c of clock) secs = secs * 60 + (Number.isFinite(c) ? c : 0);
        if (parts.length) secs += Number(parts[0]) * 86400;
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        rows.push({ pid, ppid, cpu: secs });
      }
    }
  } catch {
    return perPid;   // could not tell
  }
  const children = new Map<number, number[]>();
  for (const r of rows) {
    const list = children.get(r.ppid);
    if (list) list.push(r.pid); else children.set(r.ppid, [r.pid]);
  }
  const cpuOf = new Map(rows.map((r) => [r.pid, r.cpu]));
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop()!;
    if (perPid.has(pid)) continue;   // cycle guard
    const cpu = cpuOf.get(pid);
    if (cpu === undefined) continue;
    perPid.set(pid, cpu);
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return perPid;
}

/** Is rootPid's process tree DOING something right now? Two samples one window apart.
 *
 *  Strictly ONE-DIRECTIONAL. `true` means "provably alive, do not interrupt".
 *  `false` means "no evidence either way" and must never be read as "dead" — that
 *  inversion is exactly the mistake that made three earlier CPU-based designs fail,
 *  because a turn doing REMOTE inference burns no local CPU at all.
 *
 *  ACCRUED CPU IS THE ONLY VERDICT. New pids in the tree are counted and logged but
 *  deliberately do NOT vote: there is no evidence they indicate progress, while a
 *  backend that respawned a helper on a timer would veto forever and hand back the
 *  unbounded hang. An unproven signal does not get to disable the timeout. */
async function treeIsWorking(rootPid: number | undefined): Promise<{ working: boolean; cpuSeconds: number; newPids: number }> {
  const before = await sampleTreeCpu(rootPid);
  if (before.size === 0) return { working: false, cpuSeconds: 0, newPids: 0 };
  await new Promise((r) => setTimeout(r, CPU_PROBE_WINDOW_MS));
  const after = await sampleTreeCpu(rootPid);
  let cpuSeconds = 0;
  let newPids = 0;
  for (const [pid, cpu] of after) {
    const prior = before.get(pid);
    if (prior === undefined) { newPids++; continue; }   // logged only, does not vote
    if (cpu > prior) cpuSeconds += cpu - prior;
  }
  return { working: cpuSeconds >= CPU_PROBE_MIN_SECONDS, cpuSeconds, newPids };
}

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
  /** Inject the memory block (preferences/projects/history) into the first prompt. */
  memoryInjection: true,
  /** Generate chat titles with the helper model. */
  smartTitle: true,
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
          open.delete(toolCallId);
        } else if (wasOpen) {
          wasOpen.lastUpdate = Date.now();
        } else {
          const now = Date.now();
          open.set(toolCallId, { startedAt: now, lastUpdate: now });
          logger.info('tool', `start sessionId=${sessionId} id=${toolCallId.slice(-8)} kind=${next.kind || '-'} ${label}`);
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
    mainWindow?.webContents.send('acp:update', { ...data, sessionId });
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
  while (sessionClients.size >= MAX_CONCURRENT_SESSIONS) {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [id, e] of sessionClients) {
      if (id === excludeId || e.busy) continue;
      const t = e.lastUsedAt ?? 0;
      if (t < oldest) { oldest = t; victim = id; }
    }
    if (!victim) return false; // all remaining executors are busy — cannot evict
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
  startupMark('ui-state migration done');
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
      // composer holding a placeholder that can never expand again.
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
    const entry: SessionEntry = { client, cliSessionId, profile, cwd: cliCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], memoryInjected: false, lastUsedAt: Date.now() };
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
  async function sendPromptOnce(sessionId: string, prompt: any[], projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }, _model?: string): Promise<any> {
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
    if (reconfiguringSessions.has(sessionId)) {
      throw new Error('Wait for the model, Agent, or permission change to finish before sending a message.');
    }
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
    try {
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
    // Inject layered memory (global ⊕ project) on the first prompt AND whenever
    // the memory CONTENT changes (project switch, or another chat wrote to the
    // shared file). Rebuilt from disk each prompt; only re-injected when it
    // differs from the last injection. AFTER persisting the user message so
    // memory never lands in the transcript.
    try {
      const block = isFeatureEnabled('memoryInjection')
        ? buildMemoryInjection(effectiveProjectId, sessionId)
        : '';
      if (block && block !== entry.lastInjectedMemory) {
        prompt = [{ type: 'text', text: block }, ...prompt];
        entry.lastInjectedMemory = block;
        entry.memoryInjected = true;
        entry.injectedProjectId = effectiveProjectId;
        const rec = store.readRecord(sessionId);
        if (rec) { rec.lastMemoryInjection = { charCount: block.length, at: Date.now() }; store.writeRecord(rec); }
      }
    } catch {}
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
          entry.wedgeNote = undefined;   // never let one turn's note reach another
          let noticeSent = false;
          let interrupting = false;
          let wedgeHandled = false;
          let probing = false;        // a CPU probe from an earlier tick is in flight
          let vetoLogged = false;     // one CPU-VETO log line per turn, not per tick
          let cpuBusy = false;        // last probe found the tree computing, not blocked
          let cpuVetoLeftMs = 0;      // postponement still available (0 = none)
          let firstVetoAt = 0;        // when CPU progress first bought this turn time
          let vetoExhausted = false;  // computing, but the postponement budget ran out
          const watchdog = setInterval(() => {
            const e = sessionClients.get(sessionId);
            if (!e || e !== entry) return;
            const quietFor = Date.now() - (e.lastStreamAt || Date.now());
            // Freshest update among the OPEN tool calls; -1 when none are open.
            const freshestToolUpdate = e.openToolCalls?.size
              ? Math.max(...Array.from(e.openToolCalls.values(), (v) => v.lastUpdate))
              : -1;
            const toolIdleFor = freshestToolUpdate >= 0 ? Date.now() - freshestToolUpdate : -1;
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
                // From the CPU probe of the previous tick: lets the UI explain why a
                // half-hour-silent turn is being left alone, and for how much longer.
                cpuBusy,
                cpuVetoLeftSeconds: cpuBusy ? Math.round(cpuVetoLeftMs / 1000) : 0,
                // null = the interrupt is switched off in Settings, so nothing is
                // counting down and the UI must not imply otherwise.
                interruptInSeconds: WEDGE_CONFIRM_MS
                  ? Math.max(
                      0,
                      Math.round(Math.max(
                        WEDGE_CONFIRM_MS - quietFor,
                        toolIdleFor >= 0 ? TOOL_STALL_MS - toolIdleFor : 0,
                      ) / 1000),
                    )
                  : null,
              });
            }

            if (wedgeHandled || interrupting || probing) return;
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

            // LAST GATE, and it is a POLICY, not a diagnosis. Be precise about what the
            // OS can actually tell us: accrued CPU proves the tree is NOT BLOCKED. It
            // does not prove progress — a spin-wait or a livelock burns a whole core
            // forever, so "computing" and "hung" are not mutually exclusive. What this
            // buys is the narrower, still worthwhile rule "do not kill a process that is
            // actively computing", which is what went wrong once: a call 30 minutes
            // without a protocol update was PowerShell 5.1 parsing a 7.6MB JSON at ~100%
            // of a core, and it got killed.
            //
            // Used in ONE direction only. `working` postpones; NOT working proves nothing
            // and changes nothing, because a turn awaiting remote inference burns no local
            // CPU at all — that inversion is what sank three earlier CPU-based designs.
            //
            // And BOUNDED, because a veto that can repeat forever is the unbounded hang
            // this whole watchdog exists to stop, re-entering through a different door
            // (the openToolCalls suppression made exactly this mistake: 5+ hours). CPU
            // progress can only ever BUY TIME, never immunity.
            // Cost is confined to this moment: nothing is sampled until an interrupt is
            // otherwise due, and a veto is simply re-tested on the next tick.
            probing = true;
            void (async () => {
              let probe = { working: false, cpuSeconds: 0, newPids: 0 };
              try { probe = await treeIsWorking(entry.client.pid); }
              catch { /* no evidence; fall through to the interrupt */ }
              finally { probing = false; }

              // The probe window is 5s of real time, so re-establish every fact.
              const e2 = sessionClients.get(sessionId);
              if (!e2 || e2 !== entry) return;
              if (wedgeHandled || interrupting) return;
              // MUST be checked because of the await above: the entry object outlives
              // individual turns, so "same entry" does not mean "same turn". Without
              // the turn tag a probe still in flight when the turn ended would cancel
              // whatever ran next. (The synchronous version could not hit this.)
              if (!e2.busy || e2.turnSeq !== myTurn) return;
              const quietNow = Date.now() - (e2.lastStreamAt || Date.now());
              if (quietNow <= WEDGE_CONFIRM_MS) return;   // output resumed mid-probe

              const freshestNow = e2.openToolCalls?.size ? Math.max(...Array.from(e2.openToolCalls.values(), (v) => v.lastUpdate)) : -1;
              const toolIdleNow = freshestNow >= 0 ? Date.now() - freshestNow : -1;
              const staleToolCount = toolIdleNow >= 0 ? e2.openToolCalls!.size : 0;

              // The veto's total budget, derived from whichever limit actually gated this
              // decision, so it scales with the value the user tuned instead of being a
              // second magic number to discover.
              const gatingLimit = staleToolCount ? TOOL_STALL_MS : WEDGE_CONFIRM_MS;
              const vetoBudget = gatingLimit * CPU_VETO_MAX_MULTIPLE;
              if (probe.working) {
                if (!firstVetoAt) firstVetoAt = Date.now();
                const spent = Date.now() - firstVetoAt;
                if (spent < vetoBudget) {
                  cpuBusy = true;
                  cpuVetoLeftMs = vetoBudget - spent;
                  if (!vetoLogged) {
                    vetoLogged = true;   // one line per turn, not one per tick
                    logger.info('prompt', `CPU-VETO sessionId=${sessionId} cli=${e2.cliSessionId} quiet=${Math.round(quietNow / 1000)}s -- tree burned ${probe.cpuSeconds.toFixed(2)}s CPU (+${probe.newPids} new pid(s)) in ${CPU_PROBE_WINDOW_MS / 1000}s: not blocked, postponing up to ${Math.round(vetoBudget / 1000)}s`);
                  }
                  return;   // re-tested on the next tick
                }
                // Budget spent and STILL burning CPU. This is the spin-wait shape, so the
                // interrupt goes ahead: computing forever is a hang too.
                vetoExhausted = true;
                logger.warn('prompt', `CPU-VETO EXHAUSTED sessionId=${sessionId} cli=${e2.cliSessionId} -- ${Math.round(spent / 1000)}s of postponement used up while still burning CPU (${probe.cpuSeconds.toFixed(2)}s/${CPU_PROBE_WINDOW_MS / 1000}s), interrupting anyway`);
              }
              cpuBusy = false;
              cpuVetoLeftMs = 0;

              wedgeHandled = true;
              interrupting = true;
              const produced = !!(e2.assistantBuf || e2.fileChanges.length);
              const quietSeconds = Math.round(quietNow / 1000);
              const cpuVerdict = vetoExhausted
                ? 'still burning CPU but postponement budget spent'
                : 'no CPU progress';
              const why = staleToolCount
                ? `${staleToolCount} tool call(s) open but stale for ${Math.round(toolIdleNow / 1000)}s, ${cpuVerdict}`
                : `no open tool call, ${cpuVerdict}`;
              // Written into the turn's own message (see flushAssistant). Phrased as OUR
              // timeout firing, not as a backend fault: a measured case had the tool
              // genuinely still working (PowerShell 5.1 parsing a 7.6MB JSON at ~100% of
              // a core), so blaming the backend would have been false.
              const dur = (ms: number) => (ms < 90000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60000)} 分钟`);
              // The two endings differ in what the user should DO about it, so they must
              // not read the same: "nothing was running" vs "it never stopped computing".
              const cpuTail = vetoExhausted
                ? `进程树一直在占用 CPU，已经因此多等了 ${dur(vetoBudget)}，但仍然没有任何输出 —— 空转的死循环同样是挂死，所以还是中断了。`
                : '中断前复查确认进程树没有在占用 CPU。';
              e2.wedgeNote = staleToolCount
                ? `⚠️ 这一轮被 KiroLex 按超时中断：静默 ${dur(quietNow)}，其中 ${staleToolCount} 个工具调用有 ${dur(toolIdleNow)}没有进度更新。${cpuTail}这不是模型或后端报的错 —— 工具本身可能仍在后台继续跑。上限可在设置「工具无进度上限」里调整。`
                : `⚠️ 这一轮被 KiroLex 按超时中断：静默 ${dur(quietNow)}，没有工具在运行。${cpuTail}阈值可在设置「无响应中断阈值」里调整。`;
              logger.warn('prompt', `WEDGED sessionId=${sessionId} cli=${entry.cliSessionId} quiet=${quietSeconds}s produced=${produced} -- ${why}, interrupting`);
              // `produced` is the whole payload the renderer acts on: it decides
              // auto-resend vs. leaving the partial reply alone. The human-readable
              // reason travels in wedgeNote instead, inside the turn's own message,
              // because a floating banner outlives the turn it describes.
              mainWindow?.webContents.send('acp:turn-wedged', { sessionId, produced });

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
          try {
            const result = await entry.client.sendPrompt(entry.cliSessionId, prompt);
            // Our OWN cancel ended this turn. kiro-cli does not always label it
            // A turn now ends ONLY because kiro-cli ended it or because the user
            // pressed Stop. There is no automatic cancel/retry any more, so any
            // stopReason we see is the backend's own verdict and is reported as-is.
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
            if (isModelUnavailableError(text) && modelSwaps < MAX_MODEL_SWAPS) {
              modelSwaps++;
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
      }
    } catch (err: any) {
      flushAssistant(sessionId); // persist whatever completed before the error
      // Surface WHY: kiro-cli returns a bare JSON-RPC -32603 "Internal error"
      // for many backend faults (bad session state, stale lock, concurrent
      // prompt). Log the full error + any JSON-RPC `data` detail so it is
      // diagnosable, and enrich the thrown message when it's the bare form.
      let detail = '';
      try { detail = err?.data ? ` — ${typeof err.data === 'string' ? err.data : JSON.stringify(err.data)}` : ''; } catch {}
      logger.warn('prompt', `error sessionId=${sessionId} cli=${entry.cliSessionId}: ${err?.message || err}${detail}`);
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
      if (/^internal error$/i.test(String(err?.message || '')) && detail) {
        const e2: any = new Error(`${err.message}${detail}`);
        throw e2;
      }
      throw err;
    }
  }

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

  ipcMain.handle('acp:delete-session', async (_event, sessionId: string) => {
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

    if (error) {
      logger.warn('delete-session', `${sessionId}: files not fully removed (${error}); tombstoned and will retry at next start`);
      return { ok: false, tombstoned: true, error };
    }
    clearSessionTombstone(sessionId); // fully gone — no need to keep the marker
    return { ok: true };
  });

  // Named kiro-cli agents available to the composer selector. The CLI has no
  // JSON mode for this command, so parse its stable tabular output from both
  // stdout and stderr (some kiro-cli versions write the listing to stderr).
  ipcMain.handle('kiro:list-agents', async () => {
    try {
      const output = await runKiroCli('agent list 2>&1', 15000);
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
        memoryInjected: oldEntry.memoryInjected,
        injectedProjectId: oldEntry.injectedProjectId,
        lastInjectedMemory: oldEntry.lastInjectedMemory,
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
      // though the session id is unchanged. Mark and rebuild now: the send gate
      // would also catch it, but only after the user has typed -- and until then
      // the chat would look connected and idle while remembering nothing.
      if (markContextOwedIfUnverified(sessionId, 'switch-model')) {
        void primeHistoryNow(sessionId).catch(() => {});
      }
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
        memoryInjected: false,
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
      // empty. Rebuild now rather than waiting for the user's next message.
      if (markContextOwedIfUnverified(sessionId, 'switch-agent')) {
        void primeHistoryNow(sessionId).catch(() => {});
      }
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
    // 10s and non-blocking. This was `execSync` with no timeout and no catch, and
    // it runs on every renderer load -- the single worst place in the app for a
    // wedged kiro-cli to reach. On failure the renderer falls back to the model
    // list cached in ui-state (`kirolex-models`).
    const result = await runKiroCli('chat --list-models --format json', 10000);
    return JSON.parse(result);
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
    if (!isFeatureEnabled('smartTitle')) return { ok: false, skipped: true, reason: 'feature disabled' };
    const prompt = `Generate a very short chat title (3-6 words) summarizing the topic below. Reply with ONLY the title on a single line — no quotes, no trailing punctuation, no preamble.\n\n${convo}`;
    try {
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
      return title ? { title } : { error: 'empty' };
    } catch (err: any) {
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
    if (reconfiguringSessions.has(sessionId)) {
      throw new Error('会话正在切换模型/Agent，稍后会自动重连。');
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
      entry = { client, cliSessionId, profile, cwd: cliCwd, assistantBuf: '', assistantMsgId: null, fileChanges: [], memoryInjected: false, lastUsedAt: Date.now(), needsHistoryPrime: verbatimOwed };
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
      // Persist the model that ACTUALLY started. Without this the record keeps
      // pointing at a retired model (e.g. claude-opus-5), so EVERY later startup
      // burns a full initialize timeout on it before falling back again — which is
      // exactly what wedged the splash at "Connecting sessions… (0/N)".
      if (rec.profile.model !== profile.model) {
        logger.info('model', `attach ${sessionId}: persisting effective model '${profile.model}' (was '${rec.profile.model}', preferred '${profile.preferredModel}')`);
        rec.profile.model = profile.model;
        // Preference is sticky: it is retried first on the next attach.
        rec.profile.preferredModel = profile.preferredModel;
        // Announce it: otherwise the composer selector keeps showing the model the
        // renderer last knew about while the executor runs a different one.
        emitSessionModel(sessionId, profile.model);
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
      const rec = store.readRecord(sessionId);
      if (!rec) return { ok: false, error: 'no record' };
      rec.primeMode = primeMode === 'full' ? 'full' : 'snapshot';
      store.writeRecord(rec);
      const entry = sessionClients.get(sessionId);
      if (entry) { entry.primeChunks = undefined; entry.primeCursor = 0; }
      logger.info('prime', `mode set sessionId=${sessionId} primeMode=${rec.primeMode}`);
      return { ok: true, primeMode: rec.primeMode };
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
    return entry.client.respondToPermission(requestId, optionId);
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
    }));
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
  }));  ipcMain.handle('app:set-feature', (_event, key: string, enabled: boolean) => {
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
    if (!sessionId) return { text: '', at: null, path: null };
    const rec = store.readLastInjection(sessionId);
    return {
      text: rec?.text ?? '',
      at: rec?.at ?? null,
      path: store.lastInjectionPath(sessionId),
    };
  });

  ipcMain.handle('acp:read-memory', async (_event, projectId?: string, sessionId?: string) => {
    return readMemory(projectId, sessionId);
  });  ipcMain.handle('acp:write-memory', async (_event, scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => {
    writeMemory(scope, projectId, sessionId, content);
    return { ok: true };
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
