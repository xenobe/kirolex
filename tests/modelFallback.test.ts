import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The automatic fallback chain is exactly three models, and none of them is a Claude.
 *
 * The chain used to lead with `claude-sonnet-5` then `claude-sonnet-4.6`. During a
 * Claude-wide outage (2026-08-10 23:42-23:47: kiro-cli listed no claude model at all)
 * that walked a chat created on `claude-opus-5` onto `claude-sonnet-4.6` -- a model the
 * user had never chosen, reached only after a wasted failed hop on another Claude model.
 * A fallback whose first stops share the failure mode of what just failed is not a
 * fallback, and the selector shows the EFFECTIVE model, so the substitution was silent.
 */
const ROOT = path.join(import.meta.dirname, '..');
const config = fs.readFileSync(path.join(ROOT, 'src', 'main', 'config.ts'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.tsx'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');

/** The chain exactly as declared, in order. */
function fallbackChain(): string[] {
  const block = config.match(/MODEL_FALLBACK_ORDER = \[([^\]]*)\]/);
  assert.ok(block, 'MODEL_FALLBACK_ORDER must stay a literal array so it can be checked here');
  return [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** main's declared default, i.e. the model a new chat is created on. */
function mainDefaultModel(): string {
  const m = config.match(/export const DEFAULT_MODEL = '([^']+)'/);
  assert.ok(m, 'DEFAULT_MODEL must stay a literal');
  return m![1];
}

describe('the automatic fallback chain is exactly the three chosen models', () => {
  test('the chain is pinned, in order', () => {
    // Pinned rather than pattern-matched: the chain IS the policy, and a silent
    // addition is how a chat ended up on a model nobody picked. Changing it should
    // be a deliberate edit here too.
    assert.deepEqual(fallbackChain(), ['gpt-5.6-sol', 'gpt-5.6-terra', 'deepseek-3.2']);
  });

  test('no Claude model may ever be a fallback target', () => {
    // The invariant behind the pin: an outage of one vendor must not fall back onto
    // that same vendor. Claude is the preferred family, so its outage is exactly
    // when this chain runs.
    for (const model of fallbackChain()) {
      assert.equal(
        model.startsWith('claude-'),
        false,
        `'${model}' is in the fallback chain: a Claude outage must not fall back to Claude`,
      );
    }
  });

  test('the two models a chat was silently seated on are gone from it', () => {
    const chain = fallbackChain().join(',');
    for (const banned of ['claude-sonnet-5', 'claude-sonnet-4.6', 'claude-haiku-4.5']) {
      assert.equal(chain.includes(banned), false, `${banned} is back in the fallback chain`);
    }
  });

  test('the preferred model is never overwritten by an automatic fallback', () => {
    // The whole reason the substitution is acceptable: it is temporary. Only an
    // explicit user switch writes `preferredModel`, so the next attach retries it.
    assert.match(main, /preferredModel: existing\?\.profile\.preferredModel \|\| DEFAULT_MODEL/);
    // acp:switch-model is the one place that does set it.
    assert.match(main, /model: normalizedModel, preferredModel: normalizedModel/);
  });
});

/** Source with comments stripped. The literals matter; prose about the OLD value
 *  (including the note explaining this very drift) must not trip the check. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('main and the renderer agree on the default model', () => {
  test('no renderer literal disagrees with main DEFAULT_MODEL', () => {
    const expected = mainDefaultModel();
    // They cannot share a module: main's tsconfig pins rootDir to ./src/main, so a
    // src/shared/ import would move the entire emit layout. Hence this test --
    // the two HAD drifted (renderer 'claude-opus-4.6' vs main 'claude-opus-5'),
    // which is how the selector could name a model no executor was running.
    for (const [name, src] of [['App.tsx', app], ['useAcp.ts', hook]] as const) {
      const literals = [...code(src).matchAll(/'(claude-[a-z0-9.-]+)'/g)].map((m) => m[1]);
      assert.ok(literals.length > 0, `${name}: expected at least one default-model literal to pin`);
      for (const literal of literals) {
        assert.equal(
          literal,
          expected,
          `${name} hardcodes '${literal}' while main's DEFAULT_MODEL is '${expected}'`,
        );
      }
    }
  });
});
