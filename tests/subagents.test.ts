import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isSubagentListUpdate, parseSubagentList, activeSubagents, subagentTag, mergeSubagentList,
} from '../src/main/subagents.ts';

/**
 * KIRO'S NATIVE SUBAGENTS — fixtures are the VERBATIM notifications captured by
 * `scripts/acp-probe.mjs` (two probe-workers reading two directories in parallel).
 */

/** The roster while `probe-b` was still working and `probe-a` had not been reported yet. */
const WORKING = {
  subagents: [{
    sessionId: 'd3bc9734-c3dc-46b5-bb07-cc8403859957',
    sessionName: 'probe-b',
    agentName: 'probe-worker',
    initialQuery: 'Read the directory /tmp/probe-b. Report: (1) how many .txt files it contains…',
    status: { type: 'working', message: 'Running' },
    group: 'crew-Inspect probe direct',
    role: 'probe-worker',
    dependsOn: [],
    hasLoop: false,
    loopIteration: 0,
    loopMaxIterations: 0,
    createdAtMs: 1786843349979,
  }],
  pendingStages: [],
};

/** The last roster of the turn: both children reported `terminated`. */
const FINISHED = {
  subagents: [
    { ...WORKING.subagents[0], status: { type: 'terminated' } },
    {
      sessionId: '5e930dee-1b49-4ac6-a645-e32942eeb2ea',
      sessionName: 'probe-a',
      agentName: 'probe-worker',
      initialQuery: 'Read the directory /tmp/probe-a…',
      status: { type: 'terminated' },
      group: 'crew-Inspect probe direct',
      role: 'probe-worker',
      createdAtMs: 1786843349979,
    },
  ],
  pendingStages: [],
};

describe('the roster notification is recognised by its real method name', () => {
  test('the measured method', () => assert.equal(isSubagentListUpdate('_kiro.dev/subagent/list_update'), true));
  test('an ordinary update is not it', () => assert.equal(isSubagentListUpdate('session/update'), false));
  test('missing is not it', () => assert.equal(isSubagentListUpdate(undefined), false));
});

describe('what a row carries is what kiro gave', () => {
  test('name, worker agent, task and status survive parsing', () => {
    const [row] = parseSubagentList(WORKING);
    assert.equal(row.sessionId, 'd3bc9734-c3dc-46b5-bb07-cc8403859957');
    assert.equal(row.name, 'probe-b');
    assert.equal(row.agentName, 'probe-worker');
    assert.match(row.task, /probe-b/);
    assert.equal(row.statusType, 'working');
    assert.equal(row.statusMessage, 'Running');
    assert.equal(row.group, 'crew-Inspect probe direct');
  });

  test('the first roster of a turn is empty, and that is not an error', () => {
    assert.deepEqual(parseSubagentList({ subagents: [], pendingStages: [] }), []);
    assert.deepEqual(parseSubagentList(undefined), []);
  });

  test('a row with no session id is dropped — nothing could be opened or addressed', () => {
    assert.deepEqual(parseSubagentList({ subagents: [{ sessionName: 'ghost' }] }), []);
  });

  test('a nameless row falls back to its agent, never to blank', () => {
    const [row] = parseSubagentList({ subagents: [{ sessionId: 'abc', agentName: 'probe-worker' }] });
    assert.equal(row.name, 'probe-worker');
  });
});

describe('the tag lasts until the subagents are gone — 「直到subagent被关掉」', () => {
  test('one working subagent = a tag of 1', () => {
    const tag = subagentTag(parseSubagentList(WORKING));
    assert.equal(tag?.count, 1);
    assert.match(String(tag?.title), /probe-b/);
    assert.match(String(tag?.title), /Running/);
  });

  test('all terminated = no tag', () => {
    assert.equal(subagentTag(parseSubagentList(FINISHED)), null);
    assert.deepEqual(activeSubagents(parseSubagentList(FINISHED)), []);
  });

  test('a status this code has never heard of counts as RUNNING, not as finished', () => {
    // Erring the other way would drop the tag on any status kiro adds later — the one thing
    // the tag must not do is disappear while a worker is still going.
    const rows = parseSubagentList({ subagents: [{ sessionId: 'x', sessionName: 'n', status: { type: 'queued' } }] });
    assert.equal(subagentTag(rows)?.count, 1);
  });

  test('mixed: only the running ones are counted', () => {
    const rows = parseSubagentList({
      subagents: [
        { sessionId: 'a', sessionName: 'a', status: { type: 'working' } },
        { sessionId: 'b', sessionName: 'b', status: { type: 'terminated' } },
      ],
    });
    assert.equal(subagentTag(rows)?.count, 1);
  });

  test('the roster REPLACES, so a finished turn cannot leave the tag stuck on', () => {
    const before = parseSubagentList(WORKING);
    const after = mergeSubagentList(before, parseSubagentList(FINISHED));
    assert.equal(subagentTag(after), null);
  });
});

describe('main keeps the child session id instead of relabelling it away', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('the forward carries childSessionId', () => {
    // Measured: 87 of one delegating turn's 127 notifications arrive under a CHILD ACP session id.
    // `{...data, sessionId}` has to relabel them onto the KiroLex id to route them, and that used to
    // erase the only evidence that a subagent — not this chat — did the work.
    assert.match(main, /childSessionId/, 'the child ACP session id must survive the relabel');
    assert.match(main, /originAcpSessionId !== entry\.cliSessionId/,
      'the discriminator is the parent backend session, not a guess');
  });

  test('the roster is broadcast rather than dropped into the unread _kiro_internal channel', () => {
    assert.match(main, /acp:subagents/);
    assert.match(main, /isSubagentListUpdate/);
  });
});
