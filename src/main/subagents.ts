/**
 * KIRO'S NATIVE SUBAGENTS, AS THEY ARRIVE — pure, so the shape can be tested against the real wire.
 *
 * kiro-cli's own delegation (`chat.enableDelegate true`, an agent whose
 * `toolsSettings.subagent.availableAgents` names a worker) is NOT a message inside the parent
 * transcript. Measured with `scripts/acp-probe.mjs`:
 *
 *   - the delegation is one tool call titled **`Spawning agent crew`** (kind `other`), which is why
 *     matching on the words "subagent" / "delegate" finds nothing;
 *   - each subagent gets its OWN ACP session id and its tool calls and permission requests arrive
 *     under that id — 87 of one turn's 127 notifications came from children;
 *   - a dedicated notification `_kiro.dev/subagent/list_update` carries the roster, repeatedly,
 *     with status moving `working` -> `terminated`.
 *
 * One captured row, verbatim:
 *
 *   { sessionId: 'd3bc9734-…', sessionName: 'probe-b', agentName: 'probe-worker',
 *     initialQuery: 'Read the directory /tmp/probe-b…', status: { type: 'working', message: 'Running' },
 *     group: 'crew-Inspect probe direct', role: 'probe-worker', dependsOn: [], hasLoop: false,
 *     loopIteration: 0, loopMaxIterations: 0, createdAtMs: 1786843349979 }
 *
 * So KiroLex does not have to invent bookkeeping for 「如果有subagent在运行左侧的会话上也应该有一个tag，
 * 直到subagent被关掉」: the name, the worker agent, the task and the liveness are all given. This module
 * only normalises them and answers "is anything still running".
 */

export interface SubagentRow {
  /** The subagent's OWN ACP session id — not a KiroLex session id, and not the parent's. */
  sessionId: string;
  /** Human name kiro assigned (`probe-b`), falling back to the worker agent when absent. */
  name: string;
  /** Which agent config is doing the work (`probe-worker`). */
  agentName: string;
  /** The task it was given, as delegated. Useful as the tag's tooltip. */
  task: string;
  /** `working` | `terminated` | whatever kiro adds later. Only `terminated` is treated as finished. */
  statusType: string;
  statusMessage?: string;
  group?: string;
  createdAtMs?: number;
}

/** Is this notification the subagent roster? Kept here so the method name lives in one place. */
export function isSubagentListUpdate(method: string | undefined | null): boolean {
  return String(method || '') === '_kiro.dev/subagent/list_update';
}

/**
 * Normalise one roster notification. Tolerant on purpose: an unknown field must not cost the tag,
 * and a row with no session id is not a worker anyone could open, so it is dropped.
 */
export function parseSubagentList(params: any): SubagentRow[] {
  const raw = Array.isArray(params?.subagents) ? params.subagents : [];
  const out: SubagentRow[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const sessionId = String(item?.sessionId || '').trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const agentName = String(item?.agentName || item?.role || '').trim();
    out.push({
      sessionId,
      name: String(item?.sessionName || '').trim() || agentName || sessionId.slice(0, 8),
      agentName,
      task: String(item?.initialQuery || '').trim(),
      statusType: String(item?.status?.type || '').trim() || 'unknown',
      ...(item?.status?.message ? { statusMessage: String(item.status.message) } : null),
      ...(item?.group ? { group: String(item.group) } : null),
      ...(Number.isFinite(item?.createdAtMs) ? { createdAtMs: Number(item.createdAtMs) } : null),
    });
  }
  return out;
}

/**
 * STILL RUNNING = not terminated.
 *
 * Deliberately not a list of "live" status names: kiro sent `working` in this measurement and may add
 * more, and a status this file has never heard of is far more likely to be another form of running than
 * to mean finished. Only the one word observed to mean "over" ends the tag.
 */
export function activeSubagents(rows: SubagentRow[] | undefined): SubagentRow[] {
  return (rows || []).filter((row) => row.statusType !== 'terminated');
}

/**
 * What the left rail shows next to the chat — 「直到subagent被关掉」 is the whole requirement, so this is
 * `null` the moment the last one terminates, and the count is of the running ones only.
 */
export function subagentTag(rows: SubagentRow[] | undefined): { count: number; title: string } | null {
  const live = activeSubagents(rows);
  if (!live.length) return null;
  return {
    count: live.length,
    title: live.map((row) => `${row.name}（${row.agentName || '未知 agent'}）${row.statusMessage ? ' · ' + row.statusMessage : ''}`).join('\n'),
  };
}

/**
 * The roster is a REPLACEMENT, not a delta: every notification carries the full list, and the last one
 * of a turn is the one that says everything terminated. Merging instead of replacing is how a tag gets
 * stuck on forever.
 */
export function mergeSubagentList(_previous: SubagentRow[] | undefined, next: SubagentRow[]): SubagentRow[] {
  return next;
}
