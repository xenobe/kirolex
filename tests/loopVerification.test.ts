import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildVerifierArgv,
  rejectRequest,
  runVerifier,
  shellCouldNotFindCommand,
  truncateOutput,
  MAX_COMMAND_CHARS,
  MAX_TIMEOUT_SEC,
} from '../src/main/loopVerify.ts';
// The REAL ssh builders, injected below. loopVerify takes them as a parameter (see
// the SshTools docstring), so this test exercises the same code the executor uses
// rather than a re-implementation.
import { buildSshArgs, shellQuote } from '../src/main/acp-client.ts';

const SSH = { buildSshArgs, shellQuote };

const src = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', 'src', ...p), 'utf-8');
const MAIN = src('main', 'index.ts');
const VERIFY = src('main', 'loopVerify.ts');
const HOOK = src('renderer', 'hooks', 'useAcp.ts');
const CHAT = src('renderer', 'components', 'ChatArea.tsx');

/** Source with comments removed. Needed because these files EXPLAIN the rules they
 *  follow, so a naive scan for `shell: true` finds the comment that forbids it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Body of a named function/arrow in a source file, by brace matching. */
function bodyOf(text: string, needle: string): string {
  const start = text.indexOf(needle);
  assert.notEqual(start, -1, `not found: ${needle}`);
  let depth = 0;
  for (let i = text.indexOf('{', start); i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces after ${needle}`);
}

describe('the verifier runs out of band, as one argv element', () => {
  test('a local check runs through a login shell, command not concatenated', () => {
    const { file, args, cwd } = buildVerifierArgv({ command: 'npm test', timeoutSec: 60, cwd: '/tmp/work' }, SSH);
    assert.equal(file === '/bin/sh' || /cmd\.exe$/i.test(file), true);
    // The whole point: the command is ONE argument. Nothing is assembled into a
    // shell string, so there is no interpolation point.
    assert.ok(args.includes('npm test'));
    assert.equal(cwd, '/tmp/work');
  });

  test('a command with shell metacharacters is still a single argument', () => {
    const nasty = `echo "a b"; rm -rf $HOME && true`;
    const { args } = buildVerifierArgv({ command: nasty, timeoutSec: 60, cwd: '/tmp' }, SSH);
    assert.equal(args.filter((a) => a === nasty).length, 1);
  });

  test('a remote session is checked ON THE REMOTE HOST, in the agent workdir', () => {
    // A verifier running on this Mac while the agent edits an EC2 box inspects an
    // unrelated filesystem, and such a loop reports green forever.
    const { file, args } = buildVerifierArgv({
      command: 'npm test',
      timeoutSec: 60,
      cwd: '/home/ec2-user/work',
      remote: { sshHost: 'ec2-user@10.0.0.1', identityFile: '/keys/k.pem', sshPort: 2222 },
    }, SSH);
    assert.equal(file, 'ssh');
    assert.ok(args.includes('ec2-user@10.0.0.1'));
    assert.deepEqual([args.includes('-i'), args.includes('/keys/k.pem')], [true, true]);
    assert.deepEqual([args.includes('-p'), args.includes('2222')], [true, true]);
    const remoteCmd = args[args.length - 1];
    // Pinned literally, nested quoting included: the workdir is quoted for the inner
    // `cd`, then the whole line is quoted again as ONE ssh argument. The next test
    // proves this round-trips through a real shell.
    assert.equal(remoteCmd, `bash -lc 'cd '\\''/home/ec2-user/work'\\'' && npm test'`);
  });

  test('the nested quoting survives a real shell, with a space in the path', () => {
    // The remote line is built by two rounds of quoting, so "it looks right" is not
    // evidence. Run the exact string a login shell would receive.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kx loop '));   // space on purpose
    try {
      const { args } = buildVerifierArgv(
        { command: 'pwd && echo READY', timeoutSec: 30, cwd: dir, remote: { sshHost: 'h' } }, SSH);
      // `ssh h <line>` runs <line> through the remote user's shell; locally that is
      // the same thing as handing it to `sh -c`.
      const out = execFileSync('/bin/sh', ['-c', args[args.length - 1]], { encoding: 'utf-8' });
      assert.equal(out.trim().split('\n').pop(), 'READY');
      assert.equal(fs.realpathSync(out.trim().split('\n')[0]), fs.realpathSync(dir));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('exit codes decide, and a missing binary is "could not run"', async () => {
    // The distinction the loop depends on: a non-zero exit is a failing CHECK, while
    // a verifier that never started is `blocked`.
    const pass = await runVerifier({ command: 'echo fine', timeoutSec: 10, cwd: os.tmpdir() }, process.env, SSH);
    assert.deepEqual([pass.ran, pass.exitCode, pass.host], [true, 0, 'local']);
    assert.match(pass.output, /fine/);
    const fail = await runVerifier({ command: 'echo boom >&2; exit 3', timeoutSec: 10, cwd: os.tmpdir() }, process.env, SSH);
    assert.deepEqual([fail.ran, fail.exitCode], [true, 3]);
    assert.match(fail.output, /boom/);                       // stderr is kept too
    // A VERIFIER THAT DOES NOT EXIST NEVER RAN. This used to assert `ran: true`, on the
    // grounds that `sh -lc` exits 127 and therefore "the check ran and said no". That
    // reading contradicts this module's own contract (`ran: false` = "missing binary,
    // SSH failure, timeout") and it is the more damaging of the two: a typo in the
    // verifier command would be read as "the work is broken", so a loop would spend its
    // ENTIRE round budget re-prompting the model to fix code that was never checked.
    // A checker that cannot be found is the definition of a broken checker.
    const missing = await runVerifier({ command: 'kx-no-such-binary-9271', timeoutSec: 10, cwd: os.tmpdir() }, process.env, SSH);
    assert.equal(missing.ran, false);
    assert.equal(missing.exitCode, null);
    assert.match(String(missing.error), /找不到校验命令|command not found|No such file/);
    // An absolute path that does not exist is the same fact, reported differently by the
    // shell ("No such file or directory" rather than "command not found").
    const absent = await runVerifier({ command: '/nonexistent/kx-checker', timeoutSec: 10, cwd: os.tmpdir() }, process.env, SSH);
    assert.equal(absent.ran, false);
    // ...but a 127 from a verifier that DID run is still a real verdict. The signal is
    // the shell's own complaint on the FIRST line; a check that ran, said something, and
    // then exited 127 is a check that spoke.
    //
    // Note the limit of this classification, which is inherent rather than an oversight:
    // a nested shell whose own command is missing prints a byte-identical
    // "sh: x: command not found" as its first line, so it is indistinguishable from the
    // outer shell failing. That case is read as "could not run" -- the safer of the two
    // readings, since it retries the check instead of blaming the work.
    const spoke = await runVerifier({ command: 'echo checked 3 files; exit 127', timeoutSec: 10, cwd: os.tmpdir() }, process.env, SSH);
    assert.equal(spoke.ran, true);
    assert.equal(spoke.exitCode, 127);
    // A 126 (found, not executable) is the same class of broken checker as a 127.
    const notExec = path.join(os.tmpdir(), `kx-notexec-${process.pid}`);
    fs.writeFileSync(notExec, '#!/bin/sh\necho hi\n', { mode: 0o644 });
    const unexecutable = await runVerifier({ command: notExec, timeoutSec: 10, cwd: os.tmpdir() }, process.env, SSH);
    assert.equal(unexecutable.ran, false);
    fs.rmSync(notExec, { force: true });
    const slow = await runVerifier({ command: 'sleep 5', timeoutSec: 1, cwd: os.tmpdir() }, process.env, SSH);
    assert.deepEqual([slow.ran, slow.timedOut], [false, true]);
    assert.match(String(slow.error), /1 秒/);
  });

  test('the missing-checker classifier looks at the code AND the first line', () => {
    // Pinned directly, because the cost of each direction is asymmetric: calling a
    // broken checker a failing check makes a loop burn its budget on work nobody
    // checked, while calling a failing check "broken" only retries it.
    assert.equal(shellCouldNotFindCommand(127, 'sh: npm-typo: command not found'), true);
    assert.equal(shellCouldNotFindCommand(127, 'bash: line 1: /x/y: No such file or directory'), true);
    assert.equal(shellCouldNotFindCommand(126, '/tmp/x: Permission denied'), true);
    assert.equal(shellCouldNotFindCommand(127, "'x' is not recognized as an internal or external command"), true);
    // Not the shell's complaint: a real verdict that happens to use 127.
    assert.equal(shellCouldNotFindCommand(127, '3 tests failed'), false);
    assert.equal(shellCouldNotFindCommand(1, 'sh: x: command not found'), false);
    // The complaint has to be the FIRST thing said, or a passing check that merely
    // prints those words in its output would be misread as absent.
    assert.equal(shellCouldNotFindCommand(127, 'checked 3 files\nsh: x: command not found'), false);
    assert.equal(shellCouldNotFindCommand(0, ''), false);
  });

  test('the SSH argument builder is SHARED with the executor, not re-implemented', () => {
    // Same "is it remote" decision as AcpClient.connect(), or the check can end up on
    // a different host than the agent. The assertions above already ran against
    // acp-client's own functions; these pin the wiring that supplies them in
    // production and the absence of a second copy of the ssh options.
    assert.match(src('main', 'acp-client.ts'), /export function buildSshArgs/);
    assert.match(MAIN, /runVerifier\(\s*\{ command, timeoutSec, cwd, remote \}, shellEnv, \{ buildSshArgs, shellQuote \}\)/);
    assert.doesNotMatch(VERIFY, /BatchMode/);
  });

  test('no shell:true anywhere in the verifier runner', () => {
    assert.doesNotMatch(code(VERIFY), /shell:\s*true/);
    assert.match(VERIFY, /execFile\(file, args/);
  });

  test('bounds are enforced in main, not trusted from the caller', () => {
    assert.equal(rejectRequest('npm test', 60), null);
    assert.match(String(rejectRequest('', 60)), /empty/);
    assert.match(String(rejectRequest('x'.repeat(MAX_COMMAND_CHARS + 1), 60)), /longer than/);
    assert.match(String(rejectRequest('npm test', 0)), /timeout must be/);
    assert.match(String(rejectRequest('npm test', MAX_TIMEOUT_SEC + 1)), /timeout must be/);
  });

  test('output is truncated tail-first, where the failures are', () => {
    const long = 'x'.repeat(100) + 'FAILED: 3';
    assert.match(truncateOutput(long, 20), /FAILED: 3$/);
  });
});

describe('the agent cannot choose its own check', () => {
  test('loop:verify only runs a command registered by a loop START', () => {
    const body = bodyOf(MAIN, "ipcMain.handle('loop:verify'");
    // If model output could reach this path the model could propose `true`, and
    // maker/checker separation would be gone on round one.
    assert.match(body, /registeredVerifiers\.get\(sessionId\)/);
    assert.match(body, /approved\.command !== command/);
    assert.match(body, /ran: false/);                    // refusal is a result, not a throw
    assert.match(body, /verifiersInFlight/);             // one check at a time per chat
  });


});

describe('every way a loop can end names its reason', () => {
  test('clearLoopState is gone; endLoop takes a REQUIRED terminal', () => {
    // A convention each call site is supposed to remember leaves the next call site
    // free to default to "the user stopped it", i.e. to record a failure as an action.
    assert.doesNotMatch(HOOK, /clearLoopState\(/);
    assert.match(HOOK, /const endLoop = useCallback\(\(sessionId: string \| undefined, terminal: LoopTerminal\)/);
  });

  test('each call site states which terminal applies', () => {
    const calls = [...HOOK.matchAll(/endLoop\((?:sessionId|sid|sessionForCancel|undefined)?,\s*'([a-z-]+)'\)/g)]
      .map((m) => m[1]);
    // 7 call sites: executor death, all-disconnect, disconnect(), Stop, force-stop,
    // delete, and the send failure inside a round.
    //
    // Was 8. `superseded` disappeared with `startLoop`, which was the only thing that
    // produced it -- starting a loop replaced the one already on that chat. Scheduling has
    // no equivalent: several jobs may target one session, so nothing is superseded.
    assert.ok(calls.length >= 7, `only ${calls.length} qualified call sites`);
    for (const kind of ['blocked', 'torn-down', 'aborted', 'discarded']) {
      assert.ok(calls.includes(kind), `no call site ends a loop as ${kind}`);
    }
    // Teardown must NOT be recorded as a user action.
    const tearDownBody = bodyOf(HOOK, 'const disconnect = useCallback(');
    assert.match(tearDownBody, /endLoop\(undefined, 'torn-down'\)/);
  });

  test('the reason is persisted, not just shown', () => {
    const report = bodyOf(HOOK, 'const reportLoopEnd = useCallback(');
    // mutateSessionMessages alone only touches setMessages and the in-memory cache,
    // so the reason used to live exactly as long as the window did.
    assert.match(report, /mutateSessionMessages/);
    assert.match(report, /persistNote/);
    assert.match(report, /shouldReportTerminal/);
    const persist = bodyOf(MAIN, "ipcMain.handle('acp:persist-note'");
    assert.match(persist, /store\.appendMessage/);
    assert.match(persist, /role: 'assistant'/);
  });

  test('the terminal is written before the run is unregistered', () => {
    const body = bodyOf(HOOK, 'const endLoop = useCallback(');
    const wrote = body.indexOf('endWith(handle.run, terminal)');
    const deleted = body.indexOf('loopsRef.current.delete(sid)');
    assert.ok(wrote !== -1 && deleted !== -1 && wrote < deleted,
      'the reason must be recorded on the run before it leaves the map');
  });
});
