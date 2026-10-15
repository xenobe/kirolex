/**
 * WHAT KIRO-CLI ACTUALLY PUTS ON THE WIRE — a probe, because reading our own code cannot say.
 *
 * Speaks the same ACP handshake KiroLex speaks (`src/main/acp-client.ts`): NDJSON over stdio,
 * `initialize` -> `session/new` -> `session/prompt`, auto-approving permission requests. Every
 * frame is logged VERBATIM, which is the point: three facts found on its first two runs were
 * each invisible in the source, and one of them was a silent hole in the tool gate.
 *
 *   1. `session/request_permission` carries NO tool name — only `{ toolCall: { toolCallId,
 *      title }, options, _meta }`. The `tool_call` notification has `kind` + `rawInput` and
 *      arrives ~1ms EARLIER with the same `toolCallId`. `toolGate.permissionVerdict` judges the
 *      join of the two; before that the gate read a field that is never present and skipped.
 *   2. Native subagents each get their OWN ACP session id, and their tool calls and permission
 *      requests arrive under it (68% of one turn's notifications came from child sessions).
 *      `_kiro.dev/subagent/list_update` carries sessionName / agentName / status / group /
 *      dependsOn per subagent. `main/index.ts` overwrites that sessionId with the KiroLex one.
 *   3. The delegation tool call is titled `Spawning agent crew` — matching on the word
 *      "subagent" or "delegate" does not find it.
 *
 * Usage (nothing is hardcoded to one experiment):
 *   PROBE_AGENT=probe-parent PROBE_MODEL=claude-sonnet-5 PROBE_LOG=/tmp/acp-probe.log \
 *   PROBE_PROMPT='…' node scripts/acp-probe.mjs
 *
 * It prints a summary (discriminants seen, tool titles, permission requests + their sessionIds)
 * and writes the full transcript to PROBE_LOG. Native subagents need `chat.enableDelegate true`
 * in kiro settings and an agent whose `toolsSettings.subagent.availableAgents` lists a worker.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENT = process.env.PROBE_AGENT || 'probe-parent';
const MODEL = process.env.PROBE_MODEL || 'claude-sonnet-5';
const LOG = process.env.PROBE_LOG || '/tmp/acp-probe.log';
fs.writeFileSync(LOG, '');
const t0 = Date.now();
const rec = (dir, obj) => {
  const line = `[${String(Date.now() - t0).padStart(6)}ms] ${dir} ${JSON.stringify(obj)}`;
  fs.appendFileSync(LOG, line + '\n');
};

/* 和 steer-smoke.mjs 同一个找法 —— 原来写死了某台 Mac 的绝对路径，换一台机器就跑不起来 */
function kiroCli() {
  const candidates = [
    process.env.KIRO_CLI_PATH,
    path.join(os.homedir(), '.local/bin/kiro-cli'),
    path.join(os.homedir(), '.toolbox/bin/kiro-cli'),
    '/usr/local/bin/kiro-cli',
    '/opt/homebrew/bin/kiro-cli',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch { /* 下一个 */ } }
  return 'kiro-cli';   // 交给 PATH
}

const proc = spawn(kiroCli(), ['acp', '--agent', AGENT, '--model', MODEL], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, PATH: `${process.env.PATH}${path.delimiter}${path.join(os.homedir(), '.local/bin')}` },
});

let nextId = 1;
const pending = new Map();
const send = (obj) => { rec('-->', obj); proc.stdin.write(JSON.stringify(obj) + '\n'); };
const request = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ jsonrpc: '2.0', id, method, params });
});

/** Optional hooks used by PROBE_GATE mode (see bottom of file). */
const gateHooks = { onToolCall: null, onPermission: null };

/** Counters that answer the question without reading 3000 log lines. */
const seen = { updates: new Map(), toolTitles: new Set(), perms: [], subagentText: 0 };

let buffer = '';
proc.stdout.on('data', (d) => {
  buffer += d.toString('utf-8');
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { rec('<--RAW', { line }); continue; }
    rec('<--', msg);

    // Response to one of our requests
    if ('id' in msg && !('method' in msg)) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result); }
      continue;
    }

    // Notification
    if ('method' in msg && !('id' in msg)) {
      const u = msg.params?.update;
      const disc = u?.sessionUpdate || `(no-disc:${msg.method})`;
      seen.updates.set(disc, (seen.updates.get(disc) || 0) + 1);
      if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
        gateHooks.onToolCall?.(u);
        if (u.title) seen.toolTitles.add(`${u.title} [${u.kind || '-'}] ${u.status || ''}`);
      }
      const text = typeof u?.content === 'string' ? u.content : u?.content?.text;
      if (text && /🤖|subagent|子代理/i.test(text)) seen.subagentText++;
      continue;
    }

    // Request FROM the agent (permission etc.) -- auto-approve, but record who asked
    if ('method' in msg && 'id' in msg) {
      if (msg.method === 'session/request_permission') {
        const opts = msg.params?.options || [];
        const allow = opts.find((o) => /allow|approve|yes|once/i.test(`${o.optionId} ${o.name} ${o.kind}`)) || opts[0];
        seen.perms.push({
          sessionId: msg.params?.sessionId,
          tool: msg.params?.toolCall?.title || msg.params?.toolCall?.rawInput?.command || JSON.stringify(msg.params?.toolCall || {}).slice(0, 120),
          options: opts.map((o) => o.optionId),
        });
        gateHooks.onPermission?.(msg.params);
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId } } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    }
  }
});
proc.stderr.on('data', (d) => rec('ERR', { text: d.toString('utf-8').slice(0, 400) }));

const PROMPT = process.env.PROBE_PROMPT || `(no prompt)`;

const done = (code) => {
  const summary = {
    sessionUpdates: Object.fromEntries(seen.updates),
    toolTitles: [...seen.toolTitles],
    permissionRequests: seen.perms,
    textsMentioningSubagent: seen.subagentText,
  };
  fs.appendFileSync(LOG, '\n=== SUMMARY ===\n' + JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  try { proc.kill('SIGTERM'); } catch {}
  process.exit(code);
};

setTimeout(() => { console.log('TIMEOUT after 300s'); done(2); }, 300000);

setTimeout(async () => {
  try {
    const init = await request('initialize', { protocolVersion: 1, clientInfo: { name: 'acp-probe', version: '0.1' }, capabilities: {} });
    console.log('initialize ok');
    fs.appendFileSync(LOG, '\n=== initialize result ===\n' + JSON.stringify(init, null, 2) + '\n');
    const s = await request('session/new', { cwd: '/tmp', mcpServers: [] });
    console.log('session', s?.sessionId);
    const res = await request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: PROMPT }] });
    fs.appendFileSync(LOG, '\n=== prompt result ===\n' + JSON.stringify(res, null, 2) + '\n');
    console.log('prompt done:', JSON.stringify(res));
    done(0);
  } catch (e) {
    console.log('FAILED:', e.message);
    done(1);
  }
}, 800);

/**
 * GATE MODE (PROBE_GATE=1) — run the REAL gate against the REAL frames.
 *
 * The unit tests feed `toolGate` payloads transcribed by hand, which is exactly the mistake this
 * file exists to prevent. With PROBE_GATE=1 the probe imports the compiled gate and, for every
 * live permission request, performs the same toolCallId join `main/index.ts` performs and prints
 * the verdict for a read-only node. If the join order is ever wrong, this prints `allow` where a
 * refusal is required.
 */
if (process.env.PROBE_GATE === '1') {
  const gate = await import('../dist/main/toolGate.js');
  const READ_ONLY_NODE = { id: 'S1', name: '只读步骤（探针）', tools: ['fs_read'], writes: [] };
  const calls = new Map();
  gateHooks.onToolCall = (u) => {
    if (u?.kind || u?.rawInput || u?.title) {
      const prior = calls.get(u.toolCallId) || {};
      calls.set(u.toolCallId, { toolCallId: u.toolCallId, title: u.title || prior.title, kind: u.kind || prior.kind, rawInput: u.rawInput ?? prior.rawInput });
    }
  };
  gateHooks.onPermission = (params) => {
    const joined = calls.get(params?.toolCall?.toolCallId) || {};
    const evidence = {
      toolCallId: params?.toolCall?.toolCallId,
      title: params?.toolCall?.title || joined.title,
      kind: joined.kind,
      rawInput: joined.rawInput,
      trustSettingKeys: (params?._meta?.trustOptions || []).map((o) => String(o?.setting_key || '')).filter(Boolean),
    };
    const v = gate.permissionVerdict(READ_ONLY_NODE, evidence);
    console.log(`GATE  joined=${joined.kind ? 'yes' : 'NO'}  name=${gate.inferToolName(evidence)}  mutates=${gate.mutatesOutside(evidence) || '-'}  =>  ${v.allow ? 'ALLOW' : 'DENY: ' + v.why}`);
  };
}
