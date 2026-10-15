#!/usr/bin/env node
/**
 * KiroLex self-hosting dev supervisor.
 *
 * Purpose: edit KiroLex's own source FROM WITHIN KiroLex and have the change take
 * effect without a manual restart.
 *
 *   src/renderer/**  ->  Vite HMR, live in milliseconds, no restart at all.
 *   src/main/**      ->  tsc --watch recompiles, this supervisor relaunches
 *                        Electron. The chat survives it: sessions/transcripts are
 *                        on disk, context is restored automatically on the next
 *                        message, and an interrupted turn is auto-resent.
 *
 * Why a supervisor at all: only a process OUTSIDE Electron can bring Electron back
 * after it exits. Nothing here needs an extra dependency.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** A dependency's executable in node_modules/.bin.
 *
 *  `.cmd` on Windows: npm writes THREE shims there (`vite`, `vite.cmd`, `vite.ps1`)
 *  and the extensionless one is a POSIX shell script that Windows cannot execute, so
 *  spawning the bare name fails with EACCES/ENOENT and `npm run dev:hot` never
 *  starts. */
const bin = (name) => path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const MAIN_OUT = path.join(root, 'dist', 'main');
/** Matches the main process's exit code for "another instance owns the lock". */
const EXIT_ALREADY_RUNNING = 42;
const DEV_PORT = Number(process.env.KIROLEX_DEV_PORT || 5173);
/** Supervisor log, alongside the app's own log. See `log()`. */
const SUPERVISOR_LOG = path.join(os.homedir(), '.kirolex', 'logs', 'dev-hot.log');
try { fs.mkdirSync(path.dirname(SUPERVISOR_LOG), { recursive: true }); } catch {}

const log = (tag, msg) => {
  const line = `[dev-hot:${tag}] ${msg}`;
  console.log(line);
  // Mirror to a file. Everything the supervisor knows -- how long Vite took, why a
  // restart was deferred, whether a rebuild was a no-op -- used to exist ONLY in
  // whatever terminal happened to be running it. So "startup is slow, it keeps
  // waiting for :5173" was undiagnosable after the fact: main.log has zero
  // `[vite]` lines. Now the timings are on disk next to the app's own log.
  try {
    fs.appendFileSync(SUPERVISOR_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {}
};

/** Child processes we own, so Ctrl-C tears everything down. */
const owned = new Set();
function run(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
  owned.add(child);
  child.on('exit', () => owned.delete(child));
  child.on('error', (err) => log(name, `failed to start: ${err.message}`));
  return child;
}

// ---------------------------------------------------------------- renderer (HMR)
log('vite', 'starting renderer dev server (HMR) on :5173');
run('vite', bin('vite'), []);

// ------------------------------------------------------------ main (tsc --watch)
log('tsc', 'watching src/main for changes');
run('tsc', bin('tsc'), ['-p', 'tsconfig.main.json', '--watch', '--preserveWatchOutput']);

// ---------------------------------------------------------------------- electron
let electron = null;
let restarting = false;
let shuttingDown = false;
let crashStreak = 0;

function startElectron() {
  // `--dev` (not NODE_ENV) so the renderer is loaded from Vite: the env-var form
  // this project used before was Windows-only syntax and silently no-op'd here.
  electron = run('electron', bin('electron'), ['.', '--dev']);
  const started = Date.now();
  electron.on('exit', (code, signal) => {
    electron = null;
    if (shuttingDown) return;
    if (restarting) { restarting = false; startElectron(); return; }
    // 42 = another instance owns the single-instance lock. Retrying can never
    // succeed, and doing so silently is how a stale instance turned into "the app
    // will not start". Name it and stop.
    if (code === EXIT_ALREADY_RUNNING) {
      log('electron', 'another KiroLex instance is already running, so this one exited.');
      log('electron', 'Quit it first (Cmd-Q), or: pkill -f "kirolex/node_modules/electron"');
      shutdown(1);
      return;
    }
    // A quick exit right after launch means the new main code is broken. Back off
    // instead of spin-looping, and keep watching: the next save can fix it.
    if (Date.now() - started < 4000 && code !== 0) {
      crashStreak += 1;
      const wait = Math.min(15000, 1000 * crashStreak);
      log('electron', `exited fast (code=${code} signal=${signal}) -- main code likely broken. Waiting ${wait}ms; save a fix to retry.`);
      setTimeout(() => { if (!shuttingDown) startElectron(); }, wait);
      return;
    }
    crashStreak = 0;
    // A clean exit is the user closing the app: stop the whole supervisor rather
    // than resurrecting a window they just closed.
    log('electron', `exited (code=${code} signal=${signal}) -- shutting down supervisor`);
    shutdown(0);
  });
}

function restartElectron(reason) {
  if (shuttingDown || restarting) return;
  if (!electron) { startElectron(); return; }
  restarting = true;
  log('electron', `restarting: ${reason}`);
  // SIGTERM, not SIGKILL: main turns it into app.quit(), which closes each
  // kiro-cli's stdin so it exits 0 and RELEASES its session. A hard kill leaves a
  // stale session lock behind and the next session/load fails with
  // "Session is active in another process (PID n)".
  //
  // KNOWN LIMITATION on Windows: there are no POSIX signals, so Node implements
  // kill() as an immediate TerminateProcess -- main never runs app.quit() and the
  // kiro-cli children are orphaned with their session locks still held. A hot
  // restart there therefore costs the session locks until those processes are
  // reaped. Fixing it needs an explicit "please quit" IPC/window message instead of
  // a signal; not done, and it only affects `dev:hot`, not a normal launch.
  electron.kill('SIGTERM');
  const child = electron;
  const pid = child.pid;
  // Escalation must test whether the process is STILL ALIVE, not `child.killed`:
  // Node sets `killed` as soon as a signal was delivered successfully, regardless
  // of whether the process died. So the old `!child.killed` test was always false
  // and the SIGKILL fallback could never fire. When main then failed to quit (it
  // closes each kiro-cli's stdin first, which can hang), `restarting` stayed true
  // forever -- and `if (shuttingDown || restarting) return` silently swallowed
  // EVERY later restart. Observed live: a main-process fix compiled at 12:56 was
  // still not loaded at 13:50, with the app running from 12:48.
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  setTimeout(() => {
    if (!alive()) return;
    log('electron', 'did not exit in 6s, forcing');
    try { child.kill('SIGKILL'); } catch {}
    setTimeout(() => {
      if (!alive()) return;
      // Unkillable (stuck in a syscall, or not ours any more). Clear the flag so
      // the next rebuild is still allowed to try instead of being dropped silently.
      log('electron', `pid ${pid} survived SIGKILL -- clearing restart lock; quit it manually (Cmd-Q) if the app is stuck`);
      restarting = false;
    }, 4000);
  }, 6000);
}

// -------------------------------------------------------- watch compiled main JS
let debounce = null;
/** Content hash of dist/main, so an IDENTICAL recompile never restarts anything.
 *
 *  `tsc` rewrites its output whenever it runs, even when the emitted bytes are the
 *  same -- so a renderer-only change verified with `npm run build` (which runs tsc
 *  first) looked exactly like a main-process change and killed the running app,
 *  mid-turn, for nothing. */
function mainOutputHash() {
  try {
    const h = crypto.createHash('sha1');
    for (const name of fs.readdirSync(MAIN_OUT).sort()) {
      if (!name.endsWith('.js')) continue;
      h.update(name);
      h.update(fs.readFileSync(path.join(MAIN_OUT, name)));
    }
    return h.digest('hex');
  } catch { return null; }
}
let lastMainHash = null;

/** Is a turn in flight? Read from the app's own log: the supervisor must never
 *  interrupt a running answer. A restart mid-turn loses that turn -- it already
 *  happened, and the reply never came back. */
function turnInFlight() {
  try {
    // A turn ends with done, failed, OR error -- main logs a rejected turn as
    // `[prompt] error`, which this used to ignore. Those sessions then counted as
    // "running" forever (396 received vs 219 done in a real log), so EVERY
    // main-process rebuild was deferred the full 10 minutes for turns that had
    // already failed minutes or hours earlier.
    const log = path.join(os.homedir(), '.kirolex', 'logs', 'main.log');
    const size = fs.statSync(log).size;
    const start = Math.max(0, size - 200_000);
    const fd = fs.openSync(log, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const open = new Set();
    for (const line of buf.toString('utf-8').split('\n')) {
      const recv = line.match(/\[prompt\] received sessionId=(\S+)/);
      if (recv) { open.add(recv[1]); continue; }
      const done = line.match(/\[prompt\] (?:done|failed|error) sessionId=(\S+)/);
      if (done) open.delete(done[1]);
      if (/\[app\] main process starting/.test(line)) open.clear();
    }
    return open.size > 0 ? [...open] : null;
  } catch { return null; }
}

async function restartWhenIdle(reason) {
  for (let waited = 0; waited <= 600; waited += 5) {
    const busy = turnInFlight();
    if (!busy) { restartElectron(reason); return; }
    if (waited === 0) log('electron', `main changed but a turn is running (${busy.join(', ')}) -- deferring restart until it finishes`);
    if (waited && waited % 60 === 0) log('electron', `still waiting for ${busy.join(', ')} (${waited}s)`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  log('electron', 'turn still running after 10 min -- restarting anyway');
  restartElectron(reason);
}

function watchMainOutput() {
  fs.mkdirSync(MAIN_OUT, { recursive: true });
  lastMainHash = mainOutputHash();
  fs.watch(MAIN_OUT, (_event, filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    clearTimeout(debounce);
    // tsc writes several files per compile; wait for the burst to settle.
    debounce = setTimeout(() => {
      const hash = mainOutputHash();
      if (hash && hash === lastMainHash) {
        log('watch', 'dist/main recompiled with identical output -- not restarting');
        return;
      }
      lastMainHash = hash;
      void restartWhenIdle(`dist/main/${filename} changed`);
    }, 400);
  });
  log('watch', `watching ${MAIN_OUT} -> relaunch Electron on change (skips no-op rebuilds, waits for idle)`);
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of owned) { try { child.kill('SIGTERM'); } catch {} }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** Wait until Vite is actually serving before launching Electron.
 *
 *  Without this the window opens against a dead port and just sits blank -- which
 *  is exactly what happened once already: the log filled with
 *  "dev server not up yet, retry n/30" and the user saw an app that looked broken.
 *  Reporting the wait is the point; a blank window explains nothing. */
async function waitForVite(timeoutMs = 30000) {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      // `localhost`, NOT 127.0.0.1: Vite binds the IPv6 loopback (`[::1]:5173`,
      // confirmed with lsof), so an IPv4 probe can never succeed and this loop burned
      // the full 30s on EVERY start, then printed a bogus "Is the port taken?". The
      // port was never taken -- Electron loads `http://localhost:5173`, which resolves
      // to ::1, and connected on the first try while this said "not reachable".
      const res = await fetch(`http://localhost:${DEV_PORT}/@vite/client`, { method: 'GET' });
      if (res.ok) {
        log('vite', `ready on :${DEV_PORT} after ${Date.now() - started}ms`);
        return true;
      }
    } catch {}
    if (Date.now() - started > timeoutMs) {
      log('vite', `NOT reachable on :${DEV_PORT} after ${Math.round(timeoutMs / 1000)}s -- starting Electron anyway (it will retry the load).`);
      log('vite', `Is the port taken? Check with: lsof -nP -iTCP:${DEV_PORT}`);
      return false;
    }
    if (!announced && Date.now() - started > 3000) { announced = true; log('vite', `waiting for :${DEV_PORT}…`); }
    await new Promise((r) => setTimeout(r, 300));
  }
}

// Electron and Vite boot IN PARALLEL, gated only on tsc having produced dist/main.
//
// Waiting for Vite first put it squarely on the startup critical path: 1.5s fixed
// sleep + however long Vite took to bind + only THEN ~3s of Electron boot, all
// serial, which is what "startup is slow, it just keeps waiting for :5173" was.
// Nothing required that order -- main retries loadURL up to 30 times (500ms apart)
// precisely because the supervisor may win the race, and the window is not revealed
// until the renderer says so, so there is no blank-window risk either. Vite's boot
// now overlaps Electron's instead of preceding it.
void (async () => {
  await waitForMainOutput();
  watchMainOutput();
  startElectron();
  const ready = await waitForVite();
  if (!ready) log('vite', 'Electron is up and retrying the load; fix the port and it will connect.');
})();

/** Electron must never start against a half-written (or absent) dist/main. Polls
 *  instead of sleeping a fixed 1.5s, so a warm tsc cache costs milliseconds. */
async function waitForMainOutput(timeoutMs = 30000) {
  const started = Date.now();
  const entry = path.join(MAIN_OUT, 'index.js');
  for (;;) {
    try { if (fs.statSync(entry).size > 0) { log('tsc', `dist/main ready after ${Date.now() - started}ms`); return true; } } catch {}
    if (Date.now() - started > timeoutMs) { log('tsc', `dist/main still missing after ${Math.round(timeoutMs / 1000)}s -- starting anyway`); return false; }
    await new Promise((r) => setTimeout(r, 100));
  }
}
