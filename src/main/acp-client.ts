import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import type { PermissionMode, RemoteTarget } from './config';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: any;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params: any;
}

type JsonRpcId = number | string;
type PermissionOption = { optionId: string; name?: string; kind?: string };

// Mid-turn steer lifecycle discriminants carried on the `update.sessionUpdate`
// field of a `session/update` (kiro-cli v2.9) or `_kiro.dev/session/update`
// (v2.7) notification. Both the OLD (AgentExecution*) and NEW (steering_*)
// event names are recognized so a steer works across kiro-cli versions.
const STEER_DISCRIMINANTS = new Set([
  'steering_queued',
  'steering_consumed',
  'steering_cleared',
  'AgentExecutionUserMessageQueued',
  'AgentExecutionSteeringInjected',
]);

/** Wall/idle budget for the ACP `initialize` handshake. Deliberately much
 *  shorter than the generic request timeout: a healthy kiro-cli answers in a
 *  second or two, whereas a RETIRED model never answers at all — so this is the
 *  gate that decides how fast the model-fallback chain can move on. Kept
 *  generous enough to survive a cold start with several executors booting at
 *  once (MCP server loading). */
const INITIALIZE_TIMEOUT_MS = 45000;

/** Where kiro-cli might live, most specific first. */
export function kiroCliCandidates(): string[] {
  return [
    process.env.KIRO_CLI_PATH,
    // Windows
    `${process.env.LOCALAPPDATA}\\Kiro-Cli\\kiro-cli.exe`,
    `${process.env.LOCALAPPDATA}\\Programs\\kiro-cli\\kiro-cli.exe`,
    `${process.env.APPDATA}\\kiro-cli\\kiro-cli.exe`,
    // macOS/Linux
    `${process.env.HOME}/.local/bin/kiro-cli`,
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
  ].filter(Boolean) as string[];
}

/** The kiro-cli executable, or `null` if none of the known locations exist.
 *
 *  Exported because the ACP executor and the plain CLI helpers used to disagree:
 *  the executor SEARCHED these paths (so a chat worked), while `--list-models`,
 *  `--list-sessions`, `agent list` and `/usage` shelled out to the bare name
 *  `kiro-cli` and relied on PATH. On macOS that mostly held because PATH is
 *  augmented with ~/.local/bin and the Homebrew dirs, but it breaks whenever the
 *  binary is only reachable via KIRO_CLI_PATH -- and on WINDOWS it breaks by
 *  default, since PATH is left untouched there and the installer drops
 *  kiro-cli.exe under %LOCALAPPDATA%. Result: chats work, but the model list,
 *  agent list and usage panel all fail. One resolver for both paths. */
export function resolveKiroCli(): string | null {
  for (const p of kiroCliCandidates()) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable candidate */ }
  }
  return null;
}

export class AcpClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private nextId = 0;
  private pendingRequests: Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout>; idleMs: number }> = new Map();
  private model: string;
  private kiroAgent?: string;
  private permissionMode: PermissionMode;
  private pendingPermissions = new Map<JsonRpcId, PermissionOption[]>();
  private buffer = '';
  private env: Record<string, string>;
  private remote?: RemoteTarget;

  constructor(
    model: string,
    env?: Record<string, string>,
    kiroAgent?: string,
    permissionMode: PermissionMode = 'auto-approve',
    remote?: RemoteTarget,
  ) {
    super();
    this.model = model;
    this.kiroAgent = kiroAgent;
    this.permissionMode = permissionMode;
    this.env = env || (process.env as Record<string, string>);
    this.remote = remote;
    // A client can receive stderr (e.g. SSH warnings) BEFORE the owner attaches
    // its listeners (wireSession runs after connect/loadSession). An unlistened
    // 'error' emit makes Node throw ERR_UNHANDLED_ERROR, which crashed the main
    // process and surfaced as "Internal error" on IPCs like acp:switch-model.
    // This no-op keeps 'error' always listened; real handling is additive.
    this.on('error', () => {});
  }

  async connect(): Promise<any> {
    return new Promise((resolve, reject) => {
      let command: string;
      let args: string[];

      if (this.remote?.sshHost) {
        // Remote executor: run `kiro-cli acp` on the remote host over SSH. ACP is
        // line-delimited JSON-RPC on stdio, which SSH pipes transparently, so the
        // rest of this client is unchanged. The remote kiro-cli operates on the
        // remote filesystem and loads the remote host's own MCP/agent config.
        command = 'ssh';
        args = buildSshArgs(this.remote, buildRemoteKiroCommand(this.model, this.kiroAgent));
      } else {
        // Local executor: search for the kiro-cli binary on this machine.
        const possiblePaths = kiroCliCandidates();

        let cliPath: string | null = null;
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            cliPath = p;
            break;
          }
        }

        if (!cliPath) {
          reject(new Error(
            `kiro-cli not found. Searched:\n${possiblePaths.join('\n')}\n\nPlease install kiro-cli or set KIRO_CLI_PATH environment variable.`
          ));
          return;
        }

        command = cliPath;
        args = ['acp'];
        if (this.kiroAgent) args.push('--agent', this.kiroAgent);
        args.push('--model', this.model);
        // Do not pass --trust-all-tools here. That launch-time flag prevents
        // kiro-cli from emitting permission requests, so an Auto session cannot
        // later switch back to Ask. Auto mode is implemented below by selecting
        // an allow option immediately when session/request_permission arrives.
      }

      this.process = spawn(command, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
      });

      this.process.stdout!.on('data', (data: Buffer) => {
        this.buffer += data.toString('utf-8');
        this.processBuffer();
      });

      this.process.stderr!.on('data', (data: Buffer) => {
        const msg = data.toString('utf-8').trim();
        if (msg) {
          this.emit('error', { type: 'stderr', message: msg });
        }
      });

      this.process.on('close', (code) => {
        this.emit('disconnected', { code });
        this.rejectAllPending(new Error(`Process exited with code ${code}`));
      });

      this.process.on('error', (err) => {
        reject(err);
      });

      // Send initialize
      setTimeout(async () => {
        try {
          // Bounded handshake. The default request timeout (120s) meant a RETIRED
          // model — kiro-cli never answers initialize for one — stalled the whole
          // executor start for two minutes before the model fallback could kick in.
          // With N sessions warming at boot that alone wedged the splash screen.
          const result = await this.sendRequest('initialize', {
            protocolVersion: 1,
            clientInfo: { name: 'KiroLex', version: '0.1.0' },
            capabilities: {},
          }, INITIALIZE_TIMEOUT_MS);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }, 500);
    });
  }

  /**
   * Release this executor. kiro-cli holds SINGLE-PROCESS OWNERSHIP of a session
   * and only releases it when the process exits cleanly: closing stdin makes it
   * exit 0 and free the session, whereas killing it leaves a STALE lock so any
   * later session/load fails with "Session is active in another process (PID n)"
   * even though that PID is gone. So: close stdin, wait for a clean exit, and
   * only escalate to a kill if it does not exit in time.
   */
  async disconnect() {
    const proc = this.process;
    this.process = null;
    if (proc) {
      const exited = new Promise<void>((resolve) => {
        proc.once('close', () => resolve());
      });
      try { proc.stdin?.end(); } catch { /* already closed */ }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), 5000);
      });
      const outcome = await Promise.race([exited.then(() => 'exited' as const), timeout]);
      if (timer) clearTimeout(timer);
      if (outcome === 'timeout') {
        try { proc.kill(); } catch { /* already gone */ }
      }
    }
    this.rejectAllPending(new Error('Disconnected'));
  }

  /**
   * Change how future ACP permission requests are handled without replacing
   * the executor. KiroLex deliberately starts kiro-cli without
   * --trust-all-tools so both Auto and Ask remain reversible at runtime.
   */
  setPermissionMode(mode: PermissionMode) {
    this.permissionMode = mode;
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode;
  }

  async newSession(cwd: string): Promise<{ sessionId: string }> {
    return this.sendRequest('session/new', {
      cwd,
      mcpServers: [],
    });
  }

  async loadSession(sessionId: string, cwd: string): Promise<any> {
    return this.sendRequest('session/load', {
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  async sendPrompt(sessionId: string, prompt: any[]): Promise<any> {
    // NO client-side idle abort for prompts. kiro-cli performs context
    // compaction (and long silent tool steps) INSIDE session/prompt while
    // emitting nothing at all, which used to trip the idle timer: KiroLex gave
    // up on a turn that was still running in the backend, cleared `busy`, and
    // every resend/rerun then hit kiro-cli's "Prompt already in progress".
    // A turn is terminated by the user (session/cancel) or by disconnect --
    // never by a local stopwatch.
    return this.sendRequest('session/prompt', {
      sessionId,
      prompt,
    }, 0);
  }

  async cancelPrompt(sessionId: string) {
    this.sendNotification('session/cancel', { sessionId });
  }

  /**
   * Inject a mid-turn steer into the CURRENTLY RUNNING turn via kiro-cli's
   * `_session/steer` ext-method (kiro-cli >= 2.7). Fire-and-forget by design:
   * the in-flight `session/prompt` read loop is the SINGLE consumer of this
   * process's stdout, so we must NOT await a JSON-RPC response here — a second
   * awaiting reader would steal the running turn's own streamed messages and
   * corrupt the stream. We therefore write the request with a fresh id but
   * register NO pending handler; kiro-cli's `{queued:true}` ack lands in
   * handleMessage(), finds no matching pendingRequests entry (which is keyed by
   * our numeric id — string/number ids alike simply miss), and is harmlessly
   * ignored. Nothing is cancelled and no new turn is started.
   *
   * Delivery is confirmed asynchronously by the `steering_consumed` lifecycle
   * notification (normalized to `steer_consumed` in handleNotification), NOT by
   * this call. The message is wrapped in <user_message> tags so kiro-cli's
   * concatenated multi-steer snapshot keeps an unambiguous per-message boundary.
   *
   * Returns false (not steered) for an empty message or a dead/unwritable pipe;
   * true once the request bytes are written. Never throws — a write failure is
   * reported as false so the caller can fall back to the queue.
   */
  steer(sessionId: string, message: string): boolean {
    const text = (message || '').trim();
    if (!text) return false;
    if (!this.process?.stdin?.writable) return false;
    const wrapped = `<user_message>\n${text}\n</user_message>`;
    try {
      // Raw fire-and-forget write. NOT sendRequest() (which registers a pending
      // promise + idle timeout that would later reject unhandled), and NOT a
      // notification (kiro-cli expects a request id to ack). The id is consumed
      // from the same counter so it never collides with a tracked request; its
      // ack is intentionally unhandled.
      const id = this.nextId++;
      this.send({ jsonrpc: '2.0', id, method: '_session/steer', params: { sessionId, message: wrapped } });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this backend supports mid-turn steer (`_session/steer`). KiroLex
   * targets kiro-cli only, whose ACP implements the ext-method from v2.7. An
   * older binary answers -32601 to the fire-and-forget request, which is
   * ignored (no steer, no crash); callers still fall back to the queue on a
   * false `steered` result so a message is never dropped.
   */
  get supportsSteer(): boolean {
    return true;
  }

  /** OS pid of the kiro-cli child, or undefined once it has exited. Used to bind
   *  a "history was primed" marker to the process that actually holds it: ACP
   *  sessions are in-memory only, so the same session id in a NEW process is a
   *  blank conversation. */
  get pid(): number | undefined {
    return this.process?.pid;
  }

  async respondToPermission(requestId: JsonRpcId, decision: boolean | string) {
    const options = this.pendingPermissions.get(requestId) || [];
    this.pendingPermissions.delete(requestId);
    const option = typeof decision === 'string'
      ? options.find((candidate) => candidate.optionId === decision)
      : pickPermissionOption(options, decision);
    this.send({
      jsonrpc: '2.0',
      id: requestId,
      result: option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    });
  }

  // Reset the idle timers of all pending requests (called on any inbound data,
  // so long-running requests stay alive as long as the agent is producing output)
  private resetPendingTimers() {
    for (const [id, pending] of this.pendingRequests) {
      if (pending.idleMs <= 0) continue; // never-expiring request (session/prompt)
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          pending.reject(new Error(`Request timed out (no activity)`));
        }
      }, pending.idleMs);
    }
  }

  /** idleMs <= 0 means the request NEVER expires locally (see sendPrompt). */
  private sendRequest(method: string, params: any, idleMs: number = 120000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;

      const timer = idleMs > 0
        ? setTimeout(() => {
            if (this.pendingRequests.has(id)) {
              this.pendingRequests.delete(id);
              reject(new Error(`Request ${method} timed out`));
            }
          }, idleMs)
        : (undefined as unknown as NodeJS.Timeout);

      this.pendingRequests.set(id, { resolve, reject, timer, idleMs });

      const request: JsonRpcRequest = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.send(request);
    });
  }

  private sendNotification(method: string, params: any) {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.send(notification);
  }

  private send(msg: any) {
    if (!this.process?.stdin?.writable) {
      throw new Error('Process not connected');
    }
    const line = JSON.stringify(msg) + '\n';
    this.process.stdin.write(line);
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      
      try {
        const msg = JSON.parse(trimmed);
        this.handleMessage(msg);
      } catch {
        // Skip non-JSON lines (e.g., log output)
      }
    }
  }

  private handleMessage(msg: any) {
    // Any inbound data means the agent is alive - keep pending requests from timing out
    this.resetPendingTimers();

    // Response to a request we made
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if ('error' in msg) {
          // Attach the JSON-RPC error.data so callers can surface WHY (kiro-cli
          // often sends a bare "Internal error" message with the real reason in
          // data, e.g. a stale session lock or bad session state).
          const e: any = new Error(msg.error.message || JSON.stringify(msg.error));
          if (msg.error.data !== undefined) e.data = msg.error.data;
          if (msg.error.code !== undefined) e.code = msg.error.code;
          pending.reject(e);
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Notification from agent
    if ('method' in msg && !('id' in msg)) {
      this.handleNotification(msg);
      return;
    }

    // Request from agent (e.g., session/request_permission)
    if ('method' in msg && 'id' in msg) {
      this.handleAgentRequest(msg);
      return;
    }
  }

  private handleNotification(msg: any) {
    const { method, params } = msg;

    // Mid-turn steer lifecycle rides on `session/update` (kiro-cli v2.9) or
    // `_kiro.dev/session/update` (v2.7); the `update.sessionUpdate` discriminant
    // distinguishes it from ordinary updates / subagent activity. Normalize BOTH
    // the old/new event names AND the old/new payload fields (v2.7 `message` on
    // queued / `content` on consumed; v2.9 `content` for both; `content` may be a
    // bare string OR a { text } object) into one stable renderer shape so the
    // renderer handles a single { sessionUpdate: 'steer_queued'|'steer_consumed'
    // |'steer_cleared', text } set of names.
    if (method === 'session/update' || method === '_kiro.dev/session/update') {
      const update = params?.update;
      const disc = update?.sessionUpdate;
      if (disc && STEER_DISCRIMINANTS.has(disc)) {
        const kind = (disc === 'steering_queued' || disc === 'AgentExecutionUserMessageQueued')
          ? 'steer_queued'
          : (disc === 'steering_consumed' || disc === 'AgentExecutionSteeringInjected')
          ? 'steer_consumed'
          : 'steer_cleared';
        const rawContent = update.content ?? update.message;
        const text = typeof rawContent === 'string' ? rawContent : (rawContent?.text || '');
        this.emit('update', { sessionId: params?.sessionId, update: { sessionUpdate: kind, text } });
        return;
      }
    }

    if (method === 'session/update') {
      this.emit('update', params);
    } else if (method.startsWith('_kiro.dev/')) {
      // Kiro-specific notifications (mcp init, commands, etc.)
      this.emit('update', { 
        sessionId: params?.sessionId, 
        update: { sessionUpdate: '_kiro_internal', method, ...params }
      });
    } else {
      this.emit('update', { method, params });
    }
  }

  private handleAgentRequest(msg: any) {
    const { method, id, params } = msg;
    
    if (method === 'session/request_permission') {
      const options: Array<{ optionId: string; kind?: string }> = params?.options || [];
      if (this.permissionMode === 'auto-approve') {
        const allow = pickPermissionOption(options, true);
        this.send({
          jsonrpc: '2.0',
          id,
          result: allow
            ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
            : { outcome: { outcome: 'cancelled' } },
        });
        return;
      }

      this.pendingPermissions.set(id, options);
      this.emit('update', {
        sessionId: params?.sessionId,
        update: {
          sessionUpdate: 'permission_request',
          requestId: id,
          ...params,
        },
      });
    } else {
      // Auto-approve unknown requests
      this.send({ jsonrpc: '2.0', id, result: {} });
    }
  }

  private rejectAllPending(error: Error) {
    for (const [, { reject, timer }] of this.pendingRequests) {
      clearTimeout(timer);
      reject(error);
    }
    this.pendingRequests.clear();
    this.pendingPermissions.clear();
  }
}

function pickPermissionOption(
  options: Array<{ optionId: string; kind?: string }>,
  granted: boolean,
): { optionId: string; kind?: string } | undefined {
  if (granted) {
    return options.find((option) => option.kind === 'allow_once')
      || options.find((option) => option.kind === 'allow_always')
      || options.find((option) => option.kind?.startsWith('allow'))
      || options[0];
  }
  return options.find((option) => option.kind === 'reject_once')
    || options.find((option) => option.kind === 'reject_always')
    || options.find((option) => option.kind?.startsWith('reject'));
}

/** POSIX single-quote a value so it is safe to embed in a remote shell command. */
function shellQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the command string run on the remote host by SSH. It launches
 * `kiro-cli acp` under a login shell (`bash -lc`) so the remote PATH picks up
 * kiro-cli's default install dir (~/.local/bin). The session working directory
 * is supplied later via ACP `session/new` cwd, so no `cd` is needed here.
 */
function buildRemoteKiroCommand(model: string, kiroAgent?: string): string {
  let cli = `kiro-cli acp --model ${shellQuote(model)}`;
  if (kiroAgent) cli += ` --agent ${shellQuote(kiroAgent)}`;
  return `bash -lc ${shellQuote(`exec ${cli}`)}`;
}

/**
 * Assemble `ssh` arguments for a remote target. BatchMode avoids interactive
 * password prompts (key-only auth), ConnectTimeout fails fast on an unreachable
 * host (instead of the ~75s+ default TCP timeout, which would otherwise stall
 * the connect until initialize's idle timeout fires), keepalives detect dead
 * links after connect, and accept-new avoids a first-connect host-key prompt
 * while still pinning the key thereafter. Values originate from the user's local
 * trusted config; the remote command is passed as a single argument.
 */
function buildSshArgs(remote: RemoteTarget, remoteCommand: string): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (remote.identityFile) args.push('-i', remote.identityFile);
  if (remote.sshPort && remote.sshPort !== 22) args.push('-p', String(remote.sshPort));
  args.push(remote.sshHost, remoteCommand);
  return args;
}
