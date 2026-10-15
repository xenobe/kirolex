import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decidePaste } from '../src/renderer/pasteDecision.ts';

/**
 * WHAT A PASTE MEANS — the decision only, extracted from the handler so it can be tested.
 *
 * THE BUG THIS EXISTS FOR. The handler read `if (hasImage && !plain)`, i.e. it took the image
 * ONLY when the clipboard carried no text. That is exactly the shape of a paste from a browser,
 * Word, Excel or a chat app: they put an image AND its alt text / URL / cell content on the
 * clipboard together. So those images were dropped in silence and only the text arrived —
 * reproduced live: image-only paste → 1 attachment, image+text paste → 0 attachments.
 *
 * The old condition was not careless: its comment says a failed image save must not silently eat
 * the text. That protection is kept here by NOT preventing the default when text is present —
 * the text lands the ordinary way, and the image is attached on top of it. Neither can lose now.
 */

const base = { hasImage: false, plain: '', filesWithPaths: 0 };

describe('a real file on the clipboard wins', () => {
  test('files with paths are attached by path, whatever else is there', () => {
    // Copying a PDF in Finder used to do NOTHING: its MIME is not image/*, so it fell through to
    // the text branch where `text/plain` is empty for a file copy.
    const d = decidePaste({ ...base, filesWithPaths: 2, hasImage: true, plain: 'x' });
    assert.equal(d.kind, 'files');
    assert.equal(d.preventDefault, true);
  });
});

describe('an image is taken whether or not text came with it', () => {
  test('image only: the image is saved and the default is prevented', () => {
    const d = decidePaste({ ...base, hasImage: true });
    assert.equal(d.kind, 'image');
    assert.equal(d.attachImage, true);
    assert.equal(d.preventDefault, true, '没有文本时应当阻止默认粘贴');
  });

  test('image AND text: BOTH — the image is attached and the text still lands', () => {
    // The case that was broken. A browser/Word/Excel paste hits this every time.
    const d = decidePaste({ ...base, hasImage: true, plain: '某段说明文字' });
    assert.equal(d.kind, 'image');
    assert.equal(d.attachImage, true, '图被丢了');
    assert.equal(d.preventDefault, false,
      '有文本时不能阻止默认粘贴：文本要照常进输入框，这样存图失败也吞不掉它');
  });

  test('whitespace-only text does not count as text', () => {
    // A trailing newline beside a screenshot must not turn this into the mixed case and leave a
    // blank line in the composer.
    const d = decidePaste({ ...base, hasImage: true, plain: '  \n ' });
    assert.equal(d.preventDefault, true);
  });
});

describe('no image', () => {
  test('text alone is an ordinary paste', () => {
    const d = decidePaste({ ...base, plain: 'hello' });
    assert.equal(d.kind, 'text');
    assert.equal(d.attachImage, false);
    assert.equal(d.preventDefault, false);
  });

  test('an empty clipboard is an ordinary paste, not an error', () => {
    const d = decidePaste(base);
    assert.equal(d.kind, 'text');
    assert.equal(d.preventDefault, false);
  });
});
