import os from 'os';
import path from 'path';

/**
 * A session's execution profile. An executor process is bound to (model, host);
 * `projectId` is a WRITE-ONCE memory-scoping dimension (see design §4/§6.4).
 *
 * `remote` is present for forward-compatibility with the later Remote-SSH PR but
 * is unused in the session-foundation PR (#1) — every profile is local for now.
 */
export interface AgentProfile {
  /** Backend model, e.g. "claude-opus-4.6". Bound to the executor process. */
  model: string;

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
   * Remote target. Forward-compat placeholder — NOT wired in PR #1.
   * When the Remote-SSH PR lands, an executor with this set spawns over SSH.
   */
  remote?: {
    sshHost: string;
    sshPort?: number;
    identityFile?: string;
    remoteWorkdir?: string;
  };
}

export const DEFAULT_MODEL = 'claude-opus-4.6';

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

/** True if this profile targets a remote host (always false in PR #1). */
export function isRemoteProfile(p: AgentProfile): boolean {
  return !!p.remote?.sshHost;
}
