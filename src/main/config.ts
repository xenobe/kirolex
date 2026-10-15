import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * A session's execution profile. An executor process is bound to (model, host);
 * `projectId` is a WRITE-ONCE memory-scoping dimension (see design §4/§6.4).
 *
 * When `remote` is set, the executor spawns `kiro-cli acp` on the remote host
 * over SSH instead of locally (Remote-SSH). The remote kiro-cli operates on the
 * REMOTE filesystem and loads the REMOTE host's own MCP/agent configuration, so
 * all file edits, shell commands, downloads and MCP servers happen on the remote
 * host — KiroLex is purely the chat/UI front-end over the SSH stdio pipe.
 */
export type PermissionMode = 'auto-approve' | 'ask';

/** Where and how to reach a remote kiro-cli executor over SSH. */
export interface RemoteTarget {
  /** SSH destination, e.g. "ec2-user@10.0.0.1" (may include the user). */
  sshHost: string;
  /** SSH port; 22 when omitted. */
  sshPort?: number;
  /** Absolute path to a private key passed to `ssh -i`. */
  identityFile?: string;
  /** Working directory kiro-cli uses on the remote host (session cwd). */
  remoteWorkdir?: string;
}

export interface AgentProfile {
  /** Backend model, e.g. "claude-opus-4.6". Bound to the executor process. */
  model: string;

  /** The model the USER actually wants. `model` may be temporarily replaced by a
   *  fallback when the preferred one is unavailable/throttled, and that effective
   *  model is persisted so startup does not re-pay a dead-model timeout every
   *  boot. Without this field that persistence silently DESTROYS the preference
   *  (choose Opus once -> one Opus outage -> permanently downgraded to Sonnet).
   *  It is therefore tried first on every attach, so the preferred model is
   *  reinstated automatically as soon as it is available again. */
  preferredModel?: string;

  /** Tool permission behavior. Undefined legacy records retain the historical
   * auto-approve behavior. KiroLex handles permission requests client-side so
   * this mode can switch between Auto and Ask without replacing the executor. */
  permissionMode?: PermissionMode;

  /** Named kiro-cli agent launched via `kiro-cli acp --agent <name>`.
   * Undefined means kiro-cli's built-in default agent. */
  kiroAgent?: string;

  /**
   * Project identity for the layered memory store. WRITE-ONCE:
   *  - may be set at session creation, OR
   *  - assigned once to a session that has none (null -> projectId), OR
   *  - left undefined (an unassigned / scratch session -> global memory only).
   * It is NEVER changed project->project and never un-set. Callers must enforce
   * this via `canAssignProjectId` before mutating.
   */
  projectId?: string;

  /**
   * Remote target. When set, this profile's executor spawns over SSH (see the
   * RemoteTarget docstring). Undefined means local execution.
   */
  remote?: RemoteTarget;
}

/** Ordered fallback chain: KiroLex tries these in order and uses the first one
 *  that actually starts, so an unavailable / throttled / retired model no longer
 *  leaves a chat dead.
 *
 *  NO CLAUDE MODEL IS IN IT, on purpose. It used to lead with `claude-sonnet-5`
 *  then `claude-sonnet-4.6`, which produced exactly the outcome this chain exists
 *  to avoid: during a Claude-wide outage (measured 2026-08-10 23:42-23:47 —
 *  kiro-cli listed NO claude model at all) a chat created on `claude-opus-5`
 *  silently ended up displaying `claude-sonnet-4.6`, a model nobody had ever
 *  chosen, reached only after a wasted failed hop on `claude-sonnet-5`. A fallback
 *  whose first stops share the failure mode of the thing that just failed is not a
 *  fallback.
 *
 *  Exactly three entries, chosen by the user: `gpt-5.6-sol` first (2.40x credits,
 *  the strongest GPT), `gpt-5.6-terra` next (1.00x, same as `auto`), and
 *  `deepseek-3.2` last (0.25x) as the final keep-the-chat-alive stop. Nothing else
 *  is listed — `gpt-5.6-luna` and the minimax/glm models are deliberately absent,
 *  and if all three of these are down, failing loudly beats silently seating the
 *  chat on some model that was never asked for.
 *
 *  This is a keep-the-chat-alive net, not a model choice: an automatic fallback
 *  never overwrites `preferredModel`, so the next attach retries what was actually
 *  picked (see the `preferredModel` note in the attach handler). */
export const MODEL_FALLBACK_ORDER = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'deepseek-3.2',
];

/** PREFERRED model for a new chat. Opus is the wanted default; the chain above is
 *  only the safety net for when it is unavailable/throttled, so a transient Opus
 *  outage degrades to a working model instead of a dead chat. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Default project identity for a working directory: its basename. This aligns
 * with kiro-cli's own cwd-scoped native session store, and lets a local dir and
 * a (future) remote dir with the same basename share one project memory layer.
 */
export function deriveProjectId(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const resolved = cwd === '~' ? os.homedir() : cwd;
  const base = path.basename(resolved.replace(/[\\/]+$/, ''));
  return base || undefined;
}

/**
 * Enforce the WRITE-ONCE rule for projectId. Returns true only for the allowed
 * transition null/undefined -> a concrete projectId. Any project->project change
 * or un-set (project -> null) is rejected. (Design §6.4.)
 */
export function canAssignProjectId(current: string | undefined, next: string | undefined): boolean {
  if (!next) return false;              // never un-set / assign empty
  if (current && current !== next) return false; // never change between projects
  return current === undefined || current === next;
}

/** True if this profile targets a remote host (executor spawns over SSH). */
export function isRemoteProfile(p: AgentProfile): boolean {
  return !!p.remote?.sshHost;
}

/**
 * Persisted KiroLex agent entry in ~/.kirolex/config.json. The file holds an
 * `agents` array plus an `activeAgentId`; an agent may declare a `remote` block.
 * All fields are optional/untrusted here — the loader validates before use.
 */
interface PersistedAgentConfig {
  id?: string;
  label?: string;
  kind?: string;
  remote?: {
    enabled?: boolean;
    sshHost?: string;
    sshPort?: number;
    identityFile?: string;
    remoteWorkdir?: string;
  };
}

/**
 * Read the ACTIVE agent's remote target from ~/.kirolex/config.json.
 *
 * Returns undefined (→ local execution) when the file is absent/invalid, no
 * agent is active, or the active agent's remote block is missing/disabled or has
 * no sshHost. The active agent is the one whose id matches `activeAgentId`,
 * falling back to the first agent in the list. Never throws.
 */
export function loadActiveRemoteTarget(configPath: string): RemoteTarget | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const agents: PersistedAgentConfig[] = Array.isArray(cfg?.agents) ? cfg.agents : [];
    if (agents.length === 0) return undefined;
    const active =
      agents.find((a) => a && a.id === cfg?.activeAgentId) || agents[0];
    const r = active?.remote;
    if (!r || r.enabled === false || !r.sshHost) return undefined;
    return {
      sshHost: r.sshHost,
      sshPort: typeof r.sshPort === 'number' ? r.sshPort : undefined,
      identityFile: r.identityFile || undefined,
      remoteWorkdir: r.remoteWorkdir || undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Default working directory for a remote target that omits `remoteWorkdir`.
 * Derives the login user from an "user@host" sshHost and returns that user's
 * conventional Linux home (`/root` for root, `/home/<user>` otherwise). Falls
 * back to "~" when no user is present, which the remote login shell expands.
 */
export function defaultRemoteWorkdir(sshHost: string): string {
  const user = sshHost.includes('@') ? sshHost.split('@')[0].trim() : '';
  if (!user) return '~';
  if (user === 'root') return '/root';
  return `/home/${user}`;
}

/**
 * The working directory kiro-cli's session should use for this profile:
 *  - remote profile → the target's remoteWorkdir (or a derived default),
 *  - local profile  → the provided local default (a per-session scratch dir).
 */
export function sessionCwd(profile: AgentProfile, localDefault: string): string {
  if (profile.remote?.sshHost) {
    return profile.remote.remoteWorkdir || defaultRemoteWorkdir(profile.remote.sshHost);
  }
  return localDefault;
}
