import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const css = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/styles/global.css'), 'utf8');

/**
 * EVERY CUSTOM PROPERTY USED IS DEFINED — 「文字有的紫色有的灰的，你也没修好」.
 *
 * `color: var(--text-tertiary)` is an INVALID declaration when the property does not exist, so the element
 * falls back to inheriting its parent's colour: white inside a card, purple inside an accent-coloured
 * container. Third-level text therefore had no colour of its own — it tracked whatever sat above it, which is
 * exactly 「有的紫有的灰」. Measured on the user's canvas: one `.fg-dep` capsule computed to `rgb(232,232,232)`
 * (= `--text-primary`), not the grey its own rule asks for. `--text-tertiary` was used 65 times and defined
 * zero times, and three more properties were in the same state.
 *
 * A missing variable is silent in the browser and invisible in review, which is why this is a test rather
 * than a convention.
 */
describe('no CSS variable is used without being defined', () => {
  const defined = new Set([...css.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
  /** Used WITHOUT a fallback — with one, a missing definition degrades instead of breaking. */
  const usedBare = new Map<string, number>();
  for (const m of css.matchAll(/var\((--[a-zA-Z0-9-]+)\s*(,)?/g)) {
    if (m[2]) continue;
    usedBare.set(m[1], (usedBare.get(m[1]) || 0) + 1);
  }

  test('every bare var() resolves', () => {
    const missing = [...usedBare.entries()].filter(([name]) => !defined.has(name));
    assert.deepEqual(
      missing.map(([name, n]) => `${name}（${n} 次）`),
      [],
      '未定义的变量让声明整条失效，文字会退回继承父元素的颜色',
    );
  });

  test('the four that were missing are defined now, at the right level', () => {
    // 第三级灰和 --text-muted 同一档：它们语义相同，只是历史上有两个名字。
    assert.match(css, /--text-tertiary:\s*#666/);
    assert.match(css, /--accent-soft:\s*rgba\(124, 111, 224/);
    assert.match(css, /--border-strong:\s*#4a4a4a/);
    assert.match(css, /--text:\s*#e8e8e8/);
  });

  test('the three text levels stay distinct — otherwise there is no hierarchy to see', () => {
    const value = (name: string): string => {
      const m = css.match(new RegExp(`${name}:\\s*([^;]+);`));
      assert.ok(m, `${name} 没有定义`);
      return m![1].trim();
    };
    const levels = ['--text-primary', '--text-secondary', '--text-tertiary'].map(value);
    assert.equal(new Set(levels).size, 3, `三级文字色不能重复：${levels.join(' / ')}`);
  });
});
