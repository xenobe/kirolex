import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { placeMenu } from '../src/renderer/menuPlacement.ts';

const V = { viewportWidth: 1000, viewportHeight: 800 };
const SIZE = { width: 200, height: 300 };

describe('a context menu stays on screen', () => {
  test('in the middle it opens exactly at the pointer', () => {
    assert.deepEqual(placeMenu({ x: 400, y: 300, ...SIZE, ...V }), { left: 400, top: 300 });
  });

  test('near the bottom it flips UP, staying next to the row you clicked', () => {
    // Clamping instead of flipping would slide the menu away from the row — you would lose which chat it is for.
    assert.deepEqual(placeMenu({ x: 100, y: 700, ...SIZE, ...V }), { left: 100, top: 400 });
  });

  test('near the right edge it flips to the left of the pointer', () => {
    assert.deepEqual(placeMenu({ x: 950, y: 100, ...SIZE, ...V }), { left: 750, top: 100 });
  });

  test('the bottom-right corner flips both ways at once', () => {
    assert.deepEqual(placeMenu({ x: 980, y: 780, ...SIZE, ...V }), { left: 780, top: 480 });
  });

  test('a menu taller than the window is clamped, not pushed off the top', () => {
    // 「Assign to project」 grows with the project list, so this is reachable in real use.
    const p = placeMenu({ x: 100, y: 700, width: 200, height: 900, ...V });
    assert.equal(p.top, 6, '顶部留边，而不是负坐标（负的那一半永远点不到）');
  });

  test('it never lands at a negative coordinate', () => {
    const p = placeMenu({ x: 2, y: 2, width: 400, height: 400, viewportWidth: 300, viewportHeight: 300 });
    assert.ok(p.left >= 0 && p.top >= 0, JSON.stringify(p));
  });
});
