import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractJson } from '../src/renderer/jsonFromReply.ts';

/**
 * PULLING THE JSON OUT OF A MODEL'S REPLY — the step that silently lost a whole turn twice.
 *
 * The old extraction was `text.match(/```(?:json)?\s*([\s\S]*?)```/)` then `JSON.parse`. Both real failures
 * came from that one line:
 *
 *   · A reply with TWO fenced blocks (an explanation, then the structure) matched the FIRST one — the
 *     non-greedy `*?` stops at the first closing fence — and parsing a fragment threw
 *     「Unexpected end of JSON input」, which reads exactly like a truncated reply. I spent a while
 *     chasing an output-length problem that did not exist.
 *   · A reply whose fence was never closed matched nothing, so the whole text went to JSON.parse.
 *
 * So: find the first `{`, then walk with a depth counter that understands strings and escapes, and return
 * the balanced object. Fences become irrelevant, prose around the JSON becomes irrelevant, and a genuinely
 * truncated reply is reported as truncated rather than as a mystery.
 */
describe('finding the object in a reply', () => {
  test('plain JSON', () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  });

  test('a fenced block', () => {
    assert.deepEqual(extractJson('这是结果：\n```json\n{"a":1}\n```\n完毕'), { a: 1 });
  });

  test('TWO fenced blocks: the object is the one that parses, not the first one', () => {
    const reply = '先看例子：\n```json\n{"skill":\n```\n真正的结构：\n```json\n{"skill":"x","nodes":[{"id":"S1"}]}\n```';
    assert.deepEqual(extractJson(reply), { skill: 'x', nodes: [{ id: 'S1' }] });
  });

  test('an unclosed fence is not a problem', () => {
    assert.deepEqual(extractJson('```json\n{"a":[1,2],"b":{"c":"d"}}'), { a: [1, 2], b: { c: 'd' } });
  });

  test('braces inside strings do not confuse the counter', () => {
    assert.deepEqual(extractJson('{"prompt":"用 {占位符} 和 }} 这种","n":1}'), { prompt: '用 {占位符} 和 }} 这种', n: 1 });
  });

  test('an escaped quote inside a string does not end it', () => {
    assert.deepEqual(extractJson('{"a":"他说\\"好\\"，然后 }","b":2}'), { a: '他说"好"，然后 }', b: 2 });
  });

  test('prose before and after', () => {
    assert.deepEqual(extractJson('我的结论是 {"ok":true} —— 就这样'), { ok: true });
  });

  test('a genuinely truncated object returns null rather than a guess', () => {
    // Reported as truncated by the caller; completing it here would invent structure.
    assert.equal(extractJson('{"nodes":[{"id":"S1","prompt":"没写完'), null);
  });

  test('no object at all', () => {
    assert.equal(extractJson('我看了一遍，没什么问题。'), null);
  });

  test('the first complete object wins when several are complete', () => {
    // The structure is what the prompt asked for FIRST; a trailing example must not override it.
    assert.deepEqual(extractJson('{"nodes":[1]}\n\n{"other":2}'), { nodes: [1] });
  });
});
