import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteImagePaths, mayContainPath } from '../src/main/imagePaths.ts';

/** Stand-in for safeImageRef: only "oversized" paths are rewritten. */
const cap = (p: string) => (p.includes('oversized') ? p.replace(/\.png$/, '_1500px.png') : p);
/** Collect what the pattern matched, without changing anything. */
const found = (text: string): string[] => {
  const hits: string[] = [];
  rewriteImagePaths(text, (p) => { hits.push(p); return p; });
  return hits;
};

describe('mayContainPath', () => {
  test('accepts both separators, so the Windows branch can fire', () => {
    assert.equal(mayContainPath('C:\\Users\\me\\a.png'), true);
    assert.equal(mayContainPath('/Users/me/a.png'), true);
  });
  test('rejects text with no path at all', () => {
    assert.equal(mayContainPath('just some prose'), false);
    assert.equal(mayContainPath(''), false);
  });
});

describe('rewriteImagePaths', () => {
  test('a POSIX path in a replayed tool-call record', () => {
    // This exact shape is what kept re-poisoning a backend: the snapshot handed the
    // model the ORIGINAL path and it read the oversized file again every turn.
    const line = '- [read] Reading image /Users/me/.kirolex/pasted/oversized.png';
    assert.equal(
      rewriteImagePaths(line, cap),
      '- [read] Reading image /Users/me/.kirolex/pasted/oversized_1500px.png',
    );
  });

  test('a Windows drive path is matched too', () => {
    assert.deepEqual(
      found('Reading image C:\\Users\\me\\AppData\\Local\\pasted\\shot.png'),
      ['C:\\Users\\me\\AppData\\Local\\pasted\\shot.png'],
    );
  });

  test('spaces and CJK in a path are part of the path', () => {
    const p = '/tmp/deck/支付行业 GenAI 落地方案（AWS风格重构版）_contact.png';
    assert.deepEqual(found(`file:${p}`), [p]);
  });

  test('spaces and CJK also work on Windows', () => {
    const p = 'C:\\Users\\me\\My Pictures\\架构图.jpeg';
    assert.deepEqual(found(`${p} 后面还有字`), [p]);
  });

  test('every supported extension, and nothing else', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']) {
      assert.deepEqual(found(`/a/b.${ext}`), [`/a/b.${ext}`], ext);
    }
    assert.deepEqual(found('/a/b.svg'), [], 'svg is not a raster image Bedrock rejects');
    assert.deepEqual(found('/a/b.txt'), []);
  });

  test('several paths in one text are all rewritten', () => {
    const text = 'see /a/oversized.png and /b/fine.png and /c/oversized.png';
    assert.equal(
      rewriteImagePaths(text, cap),
      'see /a/oversized_1500px.png and /b/fine.png and /c/oversized_1500px.png',
    );
  });

  test('a mapper that returns its input is a no-op, which is what makes liberal matching safe', () => {
    const text = 'weird but harmless: /not/really/a/file.png';
    assert.equal(rewriteImagePaths(text, (p) => p), text);
  });

  test('text with no path is returned as-is and never touches the regex', () => {
    const text = 'no image here at all';
    assert.equal(rewriteImagePaths(text, () => { throw new Error('must not be called'); }), text);
  });

  test('trailing punctuation is not swallowed into the path', () => {
    assert.deepEqual(found('(/a/b.png)'), ['/a/b.png']);
    assert.deepEqual(found('/a/b.png, next'), ['/a/b.png']);
    assert.deepEqual(found('"/a/b.png"'), ['/a/b.png']);
  });

  test('the global regex has no sticky-state leak between calls', () => {
    // A /g regex reused across .replace calls must not skip matches; replace resets
    // lastIndex, but this pins the behaviour in case the pattern is ever reused raw.
    for (let i = 0; i < 3; i++) assert.deepEqual(found('/a/b.png'), ['/a/b.png'], `call ${i}`);
  });
});
