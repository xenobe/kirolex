import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Minimal persistent logger for the Electron main process.
 *
 * Writes timestamped lines to ~/.kirolex/logs/main.log (rotated when it grows
 * past ~2 MB) AND mirrors to stdout/stderr. The whole point is that when
 * something goes wrong (SSH failure, a crash, a dead session), there is a
 * durable record we can read back later instead of having to reproduce the
 * problem live. Exposed to the renderer via app:get-logs / app:open-logs.
 */

const LOG_DIR = path.join(os.homedir(), '.kirolex', 'logs');
const LOG_PATH = path.join(LOG_DIR, 'main.log');
const MAX_BYTES = 2 * 1024 * 1024; // 2 MB before rotation

function ensureDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch {}
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size > MAX_BYTES) {
      fs.renameSync(LOG_PATH, path.join(LOG_DIR, 'main.log.1'));
    }
  } catch {
    /* file may not exist yet -- fine */
  }
}

type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, scope: string, message: string, extra?: unknown) {
  ensureDir();
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
