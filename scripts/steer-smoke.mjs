#!/usr/bin/env node
/**
 * Real kiro-cli ACP mid-turn steer smoke test.
 *
 * No unit-test framework is wired into KiroLex, so this is a minimal, repeatable
 * end-to-end check that exercises the exact protocol KiroLex uses for steering:
 *
 *   1. initialize -> session/new -> session/prompt (a prompt with tool boundaries)
 *   2. at the first streamed chunk, send `_session/steer` FIRE-AND-FORGET on the
 *      SAME connection (a request id is consumed but NO pending handler is
 *      registered and NO second stdout reader is started), mirroring
 *      AcpClient.steer().
 *   3. assert: (a) a steering lifecycle notification is observed on the same
 *      session (steering_queued / steering_consumed, incl. the old
 *      AgentExecution* names), and (b) the ORIGINAL session/prompt resolves with
 *      stopReason !== 'cancelled' — i.e. steering did NOT cancel the turn.
 *
 * Usage:  node scripts/steer-smoke.mjs
 * Exit 0 = PASS. Exit 1 = incomplete/failed (details printed).
 *
 * This talks to the real kiro-cli and consumes a small amount of model credits.
 * If kiro-cli is missing or unauthenticated the script prints the boundary and
 * exits non-zero without hanging.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

function resolveKiro() {
  const cands = [
    process.env.KIRO_CLI_PATH,
    path.join(os.homedir(), '.local/bin/kiro-cli'),
    path.join(os.homedir(), '.toolbox/bin/kiro-cli'),
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
  ].filter(Boolean);
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch {} }
  return 'kiro-cli';
}

const KIRO = resolveKiro();
const cwd = process.cwd();
const proc = spawn(KIRO, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });

let buf = '';
let nextId = 1;
let sessionId = null;
const pending = new Map();
const state = {
  steerSent: false,
  sawQueued: false,
  sawConsumed: false,
  promptDone: false,
  promptStop: null,
  perms: 0,
};

const log = (...a) => console.log(...a);
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + '\n');
const request = (method, params) => {
  const id = nextId++;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); send({ jsonrpc: '2.0', id, method, params }); });
};
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const respondErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

// SINGLE stdout line reader — the one and only consumer of the process stdout,
// exactly like AcpClient. The steer ack rides through here too.
proc.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
proc.stderr.on('data', () => { /* ignore adapter chatter */ });
proc.on('error', (e) => { log('spawn error:', e?.message || e); finish(); });

function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  // Response to one of our requests (has id, no method).
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.rej(msg.error) : p.res(msg.result); }
    // else: the fire-and-forget steer ack ({queued:true}) — no pending handler,
    // safely ignored. This is the proof that steer needs no second reader.
    return;
  }

  // Server->client request (has id AND method).
  if (msg.method && msg.id !== undefined) {
    if (msg.method === 'session/request_permission') {
      const opts = msg.params?.options || [];
      const allow = opts.find((o) => o.kind === 'allow_once')
        || opts.find((o) => o.kind === 'allow_always')
        || opts.find((o) => o.kind?.startsWith('allow'))
        || opts[0];
      state.perms++;
      respond(msg.id, allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } });
    } else {
      respondErr(msg.id, -32601, 'Method not found: ' + msg.method);
    }
    return;
  }

  // Notification (has method, no id).
  if (msg.method && msg.id === undefined) {
    const u = msg.params?.update;
    const disc = u?.sessionUpdate;
    if (disc === 'steering_queued' || disc === 'AgentExecutionUserMessageQueued') {
      state.sawQueued = true;
      log('  ↳ steer QUEUED notification observed (' + disc + ')');
    } else if (disc === 'steering_consumed' || disc === 'AgentExecutionSteeringInjected') {
      state.sawConsumed = true;
      log('  ↳ steer CONSUMED notification observed (' + disc + ')');
    } else if (disc === 'agent_message_chunk' && !state.steerSent && sessionId) {
      // Turn is live and streaming — inject exactly one steer, fire-and-forget.
      state.steerSent = true;
      log('  → sending _session/steer (fire-and-forget; id consumed, no pending handler)');
      const id = nextId++; // consume an id but DO NOT register a pending entry
      send({
        jsonrpc: '2.0',
        id,
        method: '_session/steer',
        params: { sessionId, message: '<user_message>\nAlso: end your final reply with the exact token STEER_OK.\n</user_message>' },
      });
    }
    return;
  }
}

async function main() {
  await request('initialize', { protocolVersion: 1, clientInfo: { name: 'kirolex-steer-smoke', version: '0.0.1' }, capabilities: {} });
  const s = await request('session/new', { cwd, mcpServers: [] });
  sessionId = s.sessionId;
  log('session:', sessionId);
  const promptText =
    'Run this single shell command: `echo FIRST`. Then write one short sentence and stop.';
  const t0 = Date.now();
  const result = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text: promptText }] });
  state.promptDone = true;
  state.promptStop = result?.stopReason ?? '(none)';
  log('prompt resolved in ' + ((Date.now() - t0) / 1000).toFixed(1) + 's, stopReason=' + state.promptStop);
}

const timeout = setTimeout(() => { log('TIMEOUT (180s)'); finish(); }, 180000);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  try { proc.kill(); } catch {}
  const notCancelled = state.promptDone && state.promptStop !== 'cancelled';
  const steerObserved = state.sawQueued || state.sawConsumed;
  log('\n=== STEER SMOKE RESULT ===');
  log('steer sent:               ' + state.steerSent);
  log('steer queued observed:    ' + state.sawQueued);
  log('steer consumed observed:  ' + state.sawConsumed);
  log('prompt completed:         ' + state.promptDone + ' (stopReason=' + state.promptStop + ')');
  log('turn NOT cancelled:       ' + notCancelled);
  log('permission requests ackd: ' + state.perms);
  const pass = state.steerSent && steerObserved && notCancelled;
  log(pass
    ? '\nPASS ✅  _session/steer injected into the SAME running turn; the turn completed without being cancelled.'
    : '\nINCOMPLETE ⚠️  see fields above (may be auth/model/tool-boundary related).');
  process.exit(pass ? 0 : 1);
}

main().then(() => finish()).catch((e) => { log('ERROR:', e?.message || JSON.stringify(e)); finish(); });
