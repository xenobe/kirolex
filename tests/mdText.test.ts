import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mdText } from '../src/renderer/mdText.ts';

/**
 * 「[object Object] 这是什么鬼」——代码块的「复制」按钮吐出来的就是这个。
 *
 * `rehypeHighlight` 把代码块切成一堆 `<span class="hljs-…">` 的 React 元素，而取文本用的是
 * `children.join('')`：数组里是对象，join 出来每个都变成 `[object Object]`，而空白/换行是普通字符串
 * 所以留了下来 —— 于是缩进和分组看着像真代码，内容全是占位符。
 */
const el = (children: unknown) => ({ type: 'span', props: { className: 'hljs-string', children } });

describe('mdText pulls real text out of highlighted children', () => {
  test('a joined array of token elements used to become [object Object]', () => {
    const kids = ['{\n', '  ', el('"a"'), ': ', el('1'), ',\n', '  ', el('"b"'), ': ', el('2'), '\n}'];
    assert.equal(kids.join('').includes('[object Object]'), true, 'this is the bug being fixed');
    assert.equal(mdText(kids), '{\n  "a": 1,\n  "b": 2\n}');
  });

  test('nested elements, numbers, null and booleans are all handled', () => {
    assert.equal(mdText(el([el('a'), 'b', el([1, 'c'])])), 'ab1c');
    assert.equal(mdText([null, undefined, false, true, 'x']), 'x');
    assert.equal(mdText(42), '42');
  });

  test('a hast node (value / children) also yields its text', () => {
    assert.equal(mdText({ type: 'text', value: 'hi' }), 'hi');
    assert.equal(mdText({ type: 'element', children: [{ type: 'text', value: 'a' }, { type: 'text', value: 'b' }] }), 'ab');
  });

  test('an unknown object yields empty string — never String(obj)', () => {
    assert.equal(mdText({ weird: true }), '');
    assert.equal(mdText(Symbol('x') as unknown), '');
  });
});

describe('the chat renderer uses it for both code paths', () => {
  const CHAT = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
  test('the copy button and the file-path check both go through mdText', () => {
    assert.match(CHAT, /import \{ mdText \} from '\.\.\/mdText'/);
    assert.match(CHAT, /const text = mdText\(codeEl\?\.props\?\.children\)/);
    assert.match(CHAT, /const raw = mdText\(children\)/);
    assert.doesNotMatch(CHAT, /children\.join\(''\)/, "join('') over React children is exactly what produced [object Object]");
    assert.doesNotMatch(CHAT, /String\(kids \?\? ''\)/);
  });
});
