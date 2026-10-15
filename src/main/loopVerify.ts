/**
 * Out-of-band loop verification: run ONE command the user wrote and trust only its
 * exit code.
 *
 * Two constraints shape everything here, and neither is stylistic.
 *
 * 1. THE AGENT MUST NOT RUN THE CHECK. Handing `npm test` to the model and asking
 *    it to report the outcome produces the model's account of its own work: an L4
 *    judgement labelled L1, with producer and grader being the same model. So the
 *    command is executed by the main process, from a spec the user typed, and only
 *    the exit code decides pass/fail.
 *
 * 2. THE CHECK MUST RUN WHERE THE AGENT RUNS. For a remote session the agent edits
 *    files on the SSH host; a verifier running on the local machine would inspect an
 *    unrelated filesystem and pass forever. The remote/local decision therefore
 *    reuses `buildSshArgs` from acp-client, i.e. the same decision `connect()` makes,
 *    rather than a second copy that can drift.
 *
 * SECURITY. This module executes a shell command line, so it is by definition an
 * RCE surface, and it is reachable by anything that can talk to the renderer (in dev
 * that includes the CDP port on 127.0.0.1:9222). Three properties keep it as narrow
 * as it can be while still being useful:
 *
 *   - the command is passed as ONE argv element to `execFile`; nothing is
 *     concatenated into a shell string, so there is no interpolation point;
 *   - `loop:verify` only accepts a command that was REGISTERED when the user
 *     started the loop (see index.ts), so a later call cannot substitute a
 *     different one — in particular, model output never reaches this path;
 *   - every execution is logged with the command, host and exit code, so the audit
 *     trail exists even when the loop's own record does not.
 */

import { execFile } from 'child_process';
import type { RemoteTarget } from './config';

/** The SSH argument builders, INJECTED rather than imported.
 *
 *  They live in acp-client.ts and are used verbatim -- a verifier must be launched by
 *  the exact same rules as the executor it is checking, or it can end up on a
 *  different host. They are passed in rather than imported for a mundane reason: a
 *  value-level relative import makes this module unloadable by the test runner
 *  (`node --test` strips types but does not resolve extensionless specifiers), and a
 *  second copy of the ssh options -- the thing that would actually drift -- is worse
 *  than an injected parameter. See tests/loopVerification.test.ts, which injects the
 *  real functions from acp-client and asserts the resulting argv. */
export interface SshTools {
  buildSshArgs(remote: RemoteTarget, remoteCommand: string): string[];
  shellQuote(value: string): string;
}

/** Verifier output kept. Larger than the renderer's per-round cap so truncation is
 *  decided once, in the state machine, on complete data. */
export const MAX_VERIFIER_OUTPUT = 16000;

/** Hard bounds, applied in main rather than trusted from the caller. */
export const MIN_TIMEOUT_SEC = 1;
export const MAX_TIMEOUT_SEC = 900;
export const MAX_COMMAND_CHARS = 2000;

export interface VerifyRequest {
  command: string;
  timeoutSec: number;
  /** Working directory: the session's cwd locally, the remote workdir over SSH. */
  cwd: string;
  /** Present iff this session's executor runs over SSH. */
  remote?: RemoteTarget;
}

export interface VerifyResult {
  /** Did the command actually execute? False means the verifier is broken (missing
   *  binary, SSH failure, timeout) — the caller must treat that as `blocked`, not as
   *  a failing check, or the loop grinds against something that never had a chance. */
  ran: boolean;
  exitCode: number | null;
  output: string;
  host: 'local' | 'remote';
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

/**
 * The exact process invocation, as a pure function so it can be asserted in tests
 * without spawning anything.
 *
 * Local runs go through `sh -lc <command>` — a login shell because a verifier is
 * typically `npm test` or a project script that depends on the user's PATH, exactly
 * like the remote side already does for kiro-cli. The command remains a single argv
 * element: the shell is invoked deliberately, not by string assembly.
 */
export function buildVerifierArgv(req: VerifyRequest, ssh: SshTools): { file: string; args: string[]; cwd?: string } {
  if (req.remote?.sshHost) {
    // `cd` into the agent's own workdir first: a relative verifier command
    // ("npm test") must resolve against the same tree the agent is editing.
    const remoteLine = `cd ${ssh.shellQuote(req.cwd)} && ${req.command}`;
    return { file: 'ssh', args: ssh.buildSshArgs(req.remote, `bash -lc ${ssh.shellQuote(remoteLine)}`) };
  }
  if (process.platform === 'win32') {
    const shell = process.env.ComSpec || 'cmd.exe';
    return { file: shell, args: ['/d', '/s', '/c', req.command], cwd: req.cwd };
  }
  return { file: '/bin/sh', args: ['-lc', req.command], cwd: req.cwd };
}

/**
 * Did the SHELL fail to find the verifier itself?
 *
 * 126/127 are the shell's own codes for "not found" (127) and "found but not
 * executable" (126). They reach us as an ordinary non-zero exit, which would make a
 * typo'd verifier command indistinguishable from a failing check — and that mistake is
 * expensive in exactly one direction: the loop would read "the checker does not exist"
 * as "the work is broken" and spend its whole round budget re-prompting the model to fix
 * code nothing ever checked. A checker that cannot be found is a broken checker.
 *
 * The output is matched as well as the code, because 126/127 can also come from INSIDE a
 * verifier that ran perfectly well (a test script whose own helper is missing, or a
 * command ending in `exit 127`). Only the shell's own complaint about the command line
 * we handed it counts as "never ran" — and it must be the FIRST thing the shell said, or
 * a passing check that merely prints those words would be misread as absent.
 */
export function shellCouldNotFindCommand(exitCode: number, output: string): boolean {
  if (exitCode !== 127 && exitCode !== 126) return false;
  const head = String(output ?? '').trim().split('\n')[0] || '';
  // `sh: <cmd>: command not found`, `bash: line 1: <cmd>: No such file or directory`,
  // and the 126 permission case -- all of which name the command before the reason.
  if (/(?:^|:\s)(?:command not found|not found|No such file or directory|Permission denied|cannot execute)/i.test(head)) {
    return true;
  }
  // cmd.exe puts the command FIRST, quoted: `'x' is not recognized as an internal or
  // external command, operable program or batch file.`
  return /is not recognized as an internal or external command/i.test(head);
}

export function truncateOutput(text: string, limit = MAX_VERIFIER_OUTPUT): string {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `…（前 ${value.length - limit} 字符已省略）\n${value.slice(value.length - limit)}`;
}

/** Reject a request before spawning anything. Returns null when it is acceptable. */
export function rejectRequest(command: string, timeoutSec: number): string | null {
  if (!command || !command.trim()) return 'empty verifier command';
  if (command.length > MAX_COMMAND_CHARS) return `verifier command longer than ${MAX_COMMAND_CHARS} chars`;
  if (!Number.isFinite(timeoutSec) || timeoutSec < MIN_TIMEOUT_SEC || timeoutSec > MAX_TIMEOUT_SEC) {
    return `verifier timeout must be ${MIN_TIMEOUT_SEC}-${MAX_TIMEOUT_SEC}s`;
  }
  return null;
}

/**
 * Run the verifier once. Never throws: a verifier that cannot start is a RESULT
 * (`ran: false`), because the loop has to distinguish "the check says no" from "the
 * check is broken" and an exception at this boundary erases that difference.
 */
export function runVerifier(req: VerifyRequest, env: NodeJS.ProcessEnv, ssh: SshTools): Promise<VerifyResult> {
  const host: 'local' | 'remote' = req.remote?.sshHost ? 'remote' : 'local';
  const { file, args, cwd } = buildVerifierArgv(req, ssh);
  const startedAt = Date.now();
  return new Promise<VerifyResult>((resolve) => {
    execFile(file, args, {
      encoding: 'utf-8',
      env,
      cwd,
      timeout: Math.round(req.timeoutSec * 1000),
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
      // No `shell: true`. The command is already one argv element handed to an
      // explicit shell; letting Node build a command string as well would
      // reintroduce the interpolation this avoids.
      windowsHide: true,
    }, (err: any, stdout, stderr) => {
      const durationMs = Date.now() - startedAt;
      // Both streams: a failing test run puts the useful part on stdout, a missing
      // binary or an SSH failure only on stderr.
      const output = truncateOutput([String(stdout ?? ''), String(stderr ?? '')].filter(Boolean).join('\n'));
      if (!err) {
        resolve({ ran: true, exitCode: 0, output, host, durationMs, timedOut: false });
        return;
      }
      const timedOut = err.killed === true || err.signal === 'SIGKILL';
      if (timedOut) {
        resolve({
          ran: false, exitCode: null, output, host, durationMs, timedOut: true,
          error: `校验命令超过 ${req.timeoutSec} 秒未结束，已终止`,
        });
        return;
      }
      if (typeof err.code === 'number') {
        if (shellCouldNotFindCommand(err.code, output)) {
          // The shell could not find or execute the command we handed it: the check
          // never happened. Reporting this as a failing check would let a typo in the
          // verifier command burn a loop's entire round budget.
          resolve({
            ran: false, exitCode: null, output, host, durationMs, timedOut: false,
            error: `找不到校验命令（shell 退出码 ${err.code}）：${output.trim().split('\n')[0] || '命令不存在或不可执行'}`,
          });
          return;
        }
        // A real non-zero exit: the check RAN and said no.
        resolve({ ran: true, exitCode: err.code, output, host, durationMs, timedOut: false });
        return;
      }
      // ENOENT / EACCES / ssh could not connect: the check never happened.
      resolve({
        ran: false, exitCode: null, output, host, durationMs, timedOut: false,
        error: err?.message || 'verifier could not be started',
      });
    });
  });
}
