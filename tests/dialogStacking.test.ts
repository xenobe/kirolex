import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A DIALOG MUST SIT ABOVE ITS OWN BACKDROP.
 *
 * Every dialog here renders the same two siblings into a portal:
 *
 *     <div className="overlay" onClick={close} />
 *     <div className="<name>-dialog"> … </div>
 *
 * `.overlay` is `z-index: 1999`. A dialog declaring anything lower is painted UNDER its
 * own backdrop: the screen dims, the panel is invisible behind the scrim, and every
 * click lands on the overlay -- which closes it. The feature looks like it "does not
 * open", and no error is logged anywhere, because nothing failed.
 *
 * This was real for two panels at once (`.skill-dialog` and `.activity-dialog`, both at
 * 1000) while `.loop-dialog` and `.settings-dialog` worked at 2000 -- i.e. the codebase
 * already knew the right number and two panels missed it. A number that must be greater
 * than another number, spread across a 5000-line stylesheet, is exactly the kind of
 * invariant that needs a test rather than a convention.
 *
 * Also pinned: a dialog that omits z-index ENTIRELY is fine only if it is not preceded
 * by an overlay, since the default stacking would put it under one.
 */
const CSS = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8')
  // Comments carry braces and numbers of their own.
  .replace(/\/\*[\s\S]*?\*\//g, '');

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'renderer');

/** The declared z-index of a rule, or null when it does not set one. */
function zIndexOf(selector: string): number | null {
  const index = CSS.indexOf(`${selector} {`);
  if (index === -1) return null;
  const body = CSS.slice(index, CSS.indexOf('}', index));
  const match = body.match(/z-index:\s*(-?\d+)/);
  return match ? Number(match[1]) : null;
}

/** Every `*-dialog` class that CSS defines a rule for. */
function dialogSelectors(): string[] {
  const found = new Set<string>();
  for (const match of CSS.matchAll(/^\.([a-z-]+-dialog)\s*\{/gm)) found.add(`.${match[1]}`);
  return [...found].sort();
}

/** Renderer sources, so "does this dialog ship an overlay" is answered from the JSX. */
function sources(): string {
  const parts: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) parts.push(fs.readFileSync(full, 'utf8'));
    }
  };
  walk(RENDERER);
  return parts.join('\n');
}

const OVERLAY_Z = zIndexOf('.overlay');

describe('a dialog is never painted under its own backdrop', () => {
  test('the overlay declares the z-index this rule is measured against', () => {
    assert.equal(typeof OVERLAY_Z, 'number', '.overlay must declare a z-index');
  });

  test('EVERY dialog that ships an overlay stacks above it', () => {
    const jsx = sources();
    const offenders: string[] = [];
    for (const selector of dialogSelectors()) {
      const cls = selector.slice(1);
      // Only dialogs that actually render a scrim are subject to the rule.
      if (!jsx.includes(cls)) continue;
      const z = zIndexOf(selector);
      if (z === null || z <= OVERLAY_Z!) offenders.push(`${selector} = ${z ?? '(unset)'}`);
    }
    assert.deepEqual(offenders, [],
      `these dialogs are behind .overlay (${OVERLAY_Z}), so they render invisible and every click closes them`);
  });

  test('the two panels that were broken are specifically covered', () => {
    // Named rather than left to the sweep above: these are the two that shipped wrong,
    // and a future refactor that drops them from the sweep must still fail here.
    // `.activity-dialog` was the other one, but the run timeline is no longer part of this
    // branch. Its removal is exactly what broke `.skill-dialog` — the two shared one selector
    // list, so deleting the panel deleted this one's stacking too. Hence: one selector, one rule.
    for (const selector of ['.skill-dialog']) {
      const z = zIndexOf(selector);
      assert.equal(typeof z, 'number', `${selector} has no z-index`);
      assert.ok(z! > OVERLAY_Z!, `${selector} (${z}) must be above .overlay (${OVERLAY_Z})`);
    }
  });

  test('the panels that already worked keep working', () => {
    for (const selector of ['.loop-dialog', '.settings-dialog']) {
      assert.ok(zIndexOf(selector)! > OVERLAY_Z!, `${selector} regressed below .overlay`);
    }
  });
});
