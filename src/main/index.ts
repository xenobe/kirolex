import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, clipboard } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { AcpClient } from './acp-client';
import { AgentProfile, DEFAULT_MODEL, deriveProjectId, canAssignProjectId } from './config';
import * as store from './sessionStore';
import { buildMemoryInjection, deleteProjectMemory, deleteSessionMemory, readMemory, writeMemory } from './memory';

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;

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
  /** accumulates the in-flight assistant response; flushed to the durable
   *  store only when the turn completes (asymmetric durability, §7). */
  assistantBuf: string;
  assistantMsgId: string | null;
  /** whether layered memory has been injected on this executor's first prompt
   *  (design §6.4) — re-armed each time a fresh executor attaches. */
  memoryInjected: boolean;
  /** the projectId used in the last memory injection; re-inject if it changes. */
  injectedProjectId?: string;
  /** the exact memory block last injected; re-inject when the content changes
   *  (so same-project chats pick up each other's memory writes). */
  lastInjectedMemory?: string;
  /** LRU bookkeeping: last time this executor was created/attached/prompted.
   *  Used to pick an eviction victim when the attached-executor cap is hit. */
  lastUsedAt: number;
  /** true while a prompt turn is in flight — a busy executor is never evicted. */
  busy?: boolean;
}
const sessionClients: Map<string, SessionEntry> = new Map();
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
const MAX_CONCURRENT_SESSIONS = computeExecutorCap();

/** Wire a freshly-created client's events, routing everything by sessionId. */
function wireSession(sessionId: string, entry: SessionEntry) {
  const { client } = entry;
  client.on('update', (data: any) => {
    // Accumulate assistant text so we can persist the COMPLETE message on
    // turn end (never the in-flight partial, §7). The ACP session/update
    // payload is { sessionId, update: { sessionUpdate, content: { text } } }.
    try {
      const u = data?.update;
      if (u?.sessionUpdate === 'agent_message_chunk') {
        entry.assistantBuf += u?.content?.text || '';
        if (!entry.assistantMsgId) entry.assistantMsgId = u?.messageId || `a_${Date.now()}`;
      }
    } catch {}
    mainWindow?.webContents.send('acp:update', { ...data, sessionId });
  });
  client.on('error', (error: any) => {
    mainWindow?.webContents.send('acp:error', { ...error, sessionId });
  });
  client.on('disconnected', () => {
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
  if (!entry || !entry.assistantBuf) return;
  store.appendMessage(sessionId, {
    id: entry.assistantMsgId || `a_${Date.now()}`,
    role: 'assistant',
    content: entry.assistantBuf,
    ts: Date.now(),
  });
  entry.assistantBuf = '';
  entry.assistantMsgId = null;
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
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Someone tried to launch a second instance - focus our window instead
    if (mainWindow) {
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

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
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
  // Create tray icon - write a temporary ico file with lightning bolt
  const iconPath = path.join(app.getPath('temp'), 'kirolex-tray.png');
  
  // 16x16 PNG lightning bolt icon (⚡)
  // Generate it programmatically using a canvas-like approach via nativeImage
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4); // RGBA

  // Draw a simple lightning bolt shape
  const setPixel = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    if (x < 0 || x >= size || y < 0 || y >= size) return;
    const idx = (y * size + x) * 4;
    canvas[idx] = r;
    canvas[idx + 1] = g;
    canvas[idx + 2] = b;
    canvas[idx + 3] = a;
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

  const icon = nativeImage.createFromBuffer(canvas, { width: size, height: size });

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
  }
}

app.whenReady().then(() => {
  // No executors survive a restart — reset any stale live executorState so the
  // durable records are truthful from boot.
  try { store.markAllExecutorsDetached(); } catch {}
  // Clear leftover pasted-image temp files from previous runs
  try {
    const pastedDir = path.join(os.homedir(), '.kirolex', 'pasted');
    if (fs.existsSync(pastedDir)) {
      for (const f of fs.readdirSync(pastedDir)) {
        try { fs.unlinkSync(path.join(pastedDir, f)); } catch {}
      }
    }
  } catch {}

  createTray();
  createSplashWindow();
  createWindow();

  // Fallback: if connect takes too long, show main window anyway
  const splashTimeout = setTimeout(() => {
    showMainWindow();
  }, 15000);

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

  // Reveal the main window once the renderer has established its session
  // connections behind the splash (called after eager-attach completes). The
  // splashTimeout above is the safety net if warming is slow or fails.
  ipcMain.handle('acp:reveal', async () => {
    clearTimeout(splashTimeout);
    showMainWindow();
    return { revealed: true };
  });

  ipcMain.handle('acp:disconnect', async () => {
    for (const [, entry] of sessionClients) {
      try { await entry.client.disconnect(); } catch {}
    }
    sessionClients.clear();
  });

  ipcMain.handle('acp:new-session', async (_event, kiroLexId: string, cwd: string, model: string, projectId?: string) => {
    if (!ensureExecutorCapacity()) {
      throw new Error('All live sessions are busy; cannot start another right now.');
    }
    const sessionDir = getSessionDir(kiroLexId);
    const resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    const derived = resolvedCwd === os.homedir() ? undefined : deriveProjectId(resolvedCwd);
    const profile: AgentProfile = { model: model || DEFAULT_MODEL, projectId: projectId ?? derived };
    const client = new AcpClient(profile.model, shellEnv);
    await client.connect();
    const { sessionId: cliSessionId } = await client.newSession(sessionDir);
    const entry: SessionEntry = { client, cliSessionId, profile, assistantBuf: '', assistantMsgId: null, memoryInjected: false, lastUsedAt: Date.now() };
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

  ipcMain.handle('acp:prompt', async (_event, sessionId: string, prompt: any[], _model?: string, projectId?: string) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');
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
    try {
      const text = Array.isArray(prompt)
        ? prompt.map((p: any) => (typeof p === 'string' ? p : p?.text || '')).join('')
        : String(prompt ?? '');
      store.appendMessage(sessionId, { id: `u_${Date.now()}`, role: 'user', content: text, ts: Date.now() });
    } catch {}
    // Inject layered memory (global ⊕ project) on the first prompt AND whenever
    // the memory CONTENT changes (project switch, or another chat wrote to the
    // shared file). Rebuilt from disk each prompt; only re-injected when it
    // differs from the last injection. AFTER persisting the user message so
    // memory never lands in the transcript.
    try {
      const block = buildMemoryInjection(effectiveProjectId, sessionId);
      if (block && block !== entry.lastInjectedMemory) {
        prompt = [{ type: 'text', text: block }, ...prompt];
        entry.lastInjectedMemory = block;
        entry.memoryInjected = true;
        entry.injectedProjectId = effectiveProjectId;
        const rec = store.readRecord(sessionId);
        if (rec) { rec.lastMemoryInjection = { charCount: block.length, at: Date.now() }; store.writeRecord(rec); }
      }
    } catch {}
    try {
      entry.busy = true; // in-flight turn — exempt from LRU eviction
      const result = await entry.client.sendPrompt(entry.cliSessionId, prompt);
      flushAssistant(sessionId); // turn complete -> persist the full assistant msg
      return result;
    } catch (err) {
      flushAssistant(sessionId); // persist whatever completed before the error
      throw err;
    } finally {
      const e = sessionClients.get(sessionId);
      if (e) { e.busy = false; e.lastUsedAt = Date.now(); }
    }
  });

  ipcMain.handle('acp:cancel', async (_event, sessionId: string) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) return;
    return entry.client.cancelPrompt(entry.cliSessionId);
  });

  ipcMain.handle('acp:delete-session', async (_event, sessionId: string) => {
    // Kill this chat's executor first (frees a slot, stops the kiro-cli process)
    // so deleting a chat never leaves an orphaned process running.
    detachExecutor(sessionId);
    // Delete session directory from disk
    const sessionDir = path.join(sessionsBaseDir, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    // Also delete this chat's session-specific memory.
    deleteSessionMemory(sessionId);
    // Also check if any directory in sessionsBaseDir contains this sessionId
    if (fs.existsSync(sessionsBaseDir)) {
      const dirs = fs.readdirSync(sessionsBaseDir);
      for (const dir of dirs) {
        if (dir === sessionId || dir.includes(sessionId)) {
          const fullPath = path.join(sessionsBaseDir, dir);
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      }
    }
  });

  ipcMain.handle('app:get-home-dir', () => {
    return os.homedir();
  });

  // Save the current clipboard image to a temp file so it can be attached and
  // read by the agent (attachments are referenced by file path). Returns the
  // path, filename, and a small thumbnail data URL for preview.
  ipcMain.handle('app:save-clipboard-image', () => {
    try {
      const img = clipboard.readImage();
      if (img.isEmpty()) return null;
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
    const { execSync } = require('child_process');
    const result = execSync('kiro-cli chat --list-models --format json', { encoding: 'utf-8', env: shellEnv, shell: true });
    return JSON.parse(result);
  });

  ipcMain.handle('acp:get-usage', async () => {
    const { execSync } = require('child_process');
    try {
      const result = execSync('kiro-cli chat --no-interactive "/usage" 2>&1', {
        encoding: 'utf-8',
        timeout: 20000,
        shell: true,
        env: shellEnv,
      });
      const clean = result.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean };
    } catch (err: any) {
      const output = (err.stdout || '') + (err.stderr || '');
      const clean = output.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\[\?[0-9;]*[a-zA-Z]/g, '').trim();
      return { text: clean || 'Failed to get usage' };
    }
  });

  ipcMain.handle('acp:list-sessions', async () => {
    const { execSync } = require('child_process');
    try {
      const result = execSync('kiro-cli chat --list-sessions --format json', { encoding: 'utf-8', env: shellEnv, shell: true });
      return JSON.parse(result);
    } catch {
      return { sessions: [] };
    }
  });

  ipcMain.handle('acp:load-session', async (_event, sessionId: string, cwd: string, model: string) => {
    const resolvedCwd = cwd === '~' ? os.homedir() : cwd;
    let entry = sessionClients.get(sessionId);
    if (!entry) {
      if (!ensureExecutorCapacity(sessionId)) {
        throw new Error('All live sessions are busy; cannot attach another right now.');
      }
      const existing = store.readRecord(sessionId);
      const derived = resolvedCwd === os.homedir() ? undefined : deriveProjectId(resolvedCwd);
      const projectId = existing?.profile.projectId ?? derived;
      const profile: AgentProfile = { model: model || DEFAULT_MODEL, projectId };
      const client = new AcpClient(profile.model, shellEnv);
      await client.connect();
      // Resume the mapped kiro-cli session; fall back to id (legacy records where
      // KiroLex id WAS the cli id), and to a fresh session if resume fails.
      let cliSessionId = existing?.cliSessionId || sessionId;
      try {
        await client.loadSession(cliSessionId, resolvedCwd);
      } catch {
        const created = await client.newSession(resolvedCwd);
        cliSessionId = created.sessionId;
      }
      entry = { client, cliSessionId, profile, assistantBuf: '', assistantMsgId: null, memoryInjected: false, lastUsedAt: Date.now() };
      sessionClients.set(sessionId, entry);
      wireSession(sessionId, entry);
      const rec = store.readRecord(sessionId) || store.createSession(sessionId, profile);
      rec.cliSessionId = cliSessionId;
      rec.executorState = 'attached';
      store.writeRecord(rec);
      mainWindow?.webContents.send('session:ready-for-first-prompt', { sessionId, projectId: profile.projectId });
    }
    return { ok: true };
  });

  ipcMain.handle('acp:request-permission-response', async (_event, requestId: number, granted: boolean, sessionId: string) => {
    const entry = sessionClients.get(sessionId);
    if (!entry) throw new Error('Session not connected');
    return entry.client.respondToPermission(requestId, granted);
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
  ipcMain.handle('acp:read-transcript', async (_event, sessionId: string) => {
    return store.readTranscript(sessionId);
  });

  ipcMain.handle('acp:read-memory', async (_event, projectId?: string, sessionId?: string) => {
    return readMemory(projectId, sessionId);
  });
  ipcMain.handle('acp:write-memory', async (_event, scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => {
    writeMemory(scope, projectId, sessionId, content);
    return { ok: true };
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  // Kill all per-session kiro-cli child processes so none are orphaned
  for (const [, entry] of sessionClients) {
    try { entry.client.disconnect(); } catch {}
  }
  sessionClients.clear();
});

app.on('window-all-closed', () => {
  // Don't quit on Windows/Linux when window is hidden to tray
  if (process.platform === 'darwin') {
    // macOS: keep app running
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
  }
});
