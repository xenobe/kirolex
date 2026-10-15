import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Minimal persistent logger for the Electron main process.
 *
 * ONE FILE PER LAUNCH — `~/.kirolex/logs/main-<YYYYMMDD-HHMMSS>.log` — and mirrored to stdout/stderr.
 * The whole point is that when something goes wrong (SSH failure, a crash, a dead session), there is a
 * durable record we can read back later instead of having to reproduce the problem live. Exposed to the
 * renderer via app:get-logs / app:open-logs.
 *
 * It used to be one endless `main.log`, rotated only past 2 MB, so reading it began with finding where
 * the last start was — and "this run versus the previous one" is the boundary that matters most, since a
 * restart was the fix for three separate problems in one week. The cost of a file per launch is files, so
 * the oldest are pruned on startup: this project has enough disk creep already.
 */

const LOG_DIR = path.join(os.homedir(), '.kirolex', 'logs');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB before rotation, WITHIN one launch

/** How many launches' logs are kept. Ten covers "it broke, I restarted, it broke again" several times over. */
export const LAUNCH_LOGS_KEPT = 10;

const two = (n: number) => String(n).padStart(2, '0');

/**
 * The log file for a launch. Local time, because that is the clock whoever reads it is on, and sortable
 * as a plain string so pruning never has to stat anything.
 *
 * `seq` disambiguates two launches inside the same second — rare, but two files silently sharing a name
 * would interleave two runs, which is the exact thing this change exists to stop.
 */
export function launchLogName(startedAt: number, seq = 0): string {
  const d = new Date(startedAt);
  const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
  return `main-${stamp}${seq ? `-${seq}` : ''}.log`;
}

const LAUNCH_LOG = /^main-\d{8}-\d{6}(-\d+)?\.log$/;

/**
 * **旧命名方案的遗留** —— 「你看下 kirolex 是不是堆积了很多陈旧日志」。
 *
 * 这套一次启动一份文件之前，日志是一个不断长的 `main.log`，满 2MB 轮转成 `main.log.1`。
 * 换方案时没人管那两个文件 —— 而 `LAUNCH_LOG` 那条正则匹配不上它们，于是它们**永远不会被清**。
 * 实测：`main.log` 912K（8月27日）+ `main.log.1` 2.0MB（8月12日）= 日志总量的 **85%**，
 * 而它们记的是一个多月前那些早就不成立的代码路径。
 *
 * 它们不可能是"这次启动"的文件（这次的名字一定带时间戳），所以看到就删，不用留一份。
 */
const LEGACY_LOG = /^main\.log(\.\d+)?$/;

/**
 * Which files to delete, oldest first.
 *
 * 两类：**这套命名的**留最近 `keep` 份；**旧命名的遗留**（见 `LEGACY_LOG`）一律删。
 * `dev-hot.log` 不动 —— 那是 `scripts/dev-hot.mjs` 写的，不是这个 logger 的东西，
 * 由别人的生命周期管着（而它只有 92K）。
 */
export function logsToPrune(files: string[], keep: number = LAUNCH_LOGS_KEPT): string[] {
  const mine = files.filter((f) => LAUNCH_LOG.test(f)).sort();
  const stale = mine.length <= keep ? [] : mine.slice(0, mine.length - keep);
  return [...stale, ...files.filter((f) => LEGACY_LOG.test(f))];
}

/** This launch's file. Chosen once, at load: the launch has exactly one start time. */
const LOG_PATH = (() => {
  const at = Date.now();
  for (let seq = 0; seq < 50; seq++) {
    const candidate = path.join(LOG_DIR, launchLogName(at, seq));
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(LOG_DIR, launchLogName(at, 99));
})();

/** Delete the oldest launches' logs. Called once, from the first write of this launch. */
let pruned = false;
function pruneOnce() {
  if (pruned) return;
  pruned = true;
  try {
    for (const name of logsToPrune(fs.readdirSync(LOG_DIR))) {
      try { fs.unlinkSync(path.join(LOG_DIR, name)); } catch {}
    }
  } catch {}
}

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > MAX_BYTES) {
      fs.renameSync(LOG_PATH, `${LOG_PATH}.1`);
    }
  } catch {
    /* file may not exist yet -- fine */
  }
}

type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, scope: string, message: string, extra?: unknown) {
  ensureDir();
  pruneOnce();
  rotateIfNeeded();
  const ts = new Date().toISOString();
  let line = `${ts} [${level}] [${scope}] ${message}`;
  if (extra !== undefined) {
    let extraStr: string;
    if (extra instanceof Error) {
      extraStr = `${extra.message}\n${extra.stack || ''}`;
    } else if (typeof extra === 'string') {
      extraStr = extra;
    } else {
      try { extraStr = JSON.stringify(extra); } catch { extraStr = String(extra); }
    }
    line += ` :: ${extraStr}`;
  }
  line += '\n';
  try { fs.appendFileSync(LOG_PATH, line); } catch {}
  const consoleFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  consoleFn(line.trimEnd());
}

export const logger = {
  info: (scope: string, message: string, extra?: unknown) => write('INFO', scope, message, extra),
  warn: (scope: string, message: string, extra?: unknown) => write('WARN', scope, message, extra),
  error: (scope: string, message: string, extra?: unknown) => write('ERROR', scope, message, extra),
  logPath: LOG_PATH,
  logDir: LOG_DIR,
  /** Return the tail of the log file (default last ~500 lines) for the UI. */
  tail: (maxLines = 500): string => {
    try {
      const content = fs.readFileSync(LOG_PATH, 'utf-8');
      const lines = content.split('\n');
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '(no logs yet)';
    }
  },
};
