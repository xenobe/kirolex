import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The wedge watchdog has exactly TWO inputs, both deterministic and both user-tunable.
 *
 * A third one existed: a CPU probe that postponed the interrupt while the executor's
 * process tree was burning CPU. It was removed because it cannot tell computing from
 * spinning (and a turn waiting on remote inference burns nothing at all), so it was
 * uninformative in both directions -- while costing a 5s sample plus a full process sweep
 * per decision and making the timeout non-deterministic.
 */
const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
const hook = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');
const chat = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.ts'), 'utf8');

describe('the wedge watchdog does not consult the CPU', () => {
  test('no probe, no veto, anywhere in main', () => {
    for (const gone of ['sampleTreeCpu', 'treeIsWorking', 'CPU_PROBE', 'CPU_VETO', 'cpuBusy', 'vetoExhausted']) {
      assert.equal(main.includes(gone), false, `${gone} is back: the interrupt must stay deterministic`);
    }
    // The `ps -Ao` / CIM sweep that fed it is gone with it.
    assert.equal(main.includes("'ps', ['-Ao'"), false);
    assert.equal(main.includes('Get-CimInstance Win32_Process'), false);
  });

  test('the removal is explained where the code used to be', () => {
    // So the next person does not re-add it for the same reason it was added the first
    // time. The claim is specific: CPU proves "not blocked", not "progressing".
    assert.match(main, /The CPU-progress probe that used to live here is GONE, deliberately\./);
  });

  test('the quiet payload and the UI no longer carry CPU fields', () => {
    for (const src of [hook, chat, preload]) {
      assert.equal(/cpuBusy|cpuVetoLeftSeconds/.test(src), false);
    }
    assert.match(hook, /export interface TurnStall/);
  });

  test('two bounds decide it, and both are user-visible settings', () => {
    const tick = main.slice(main.indexOf('const watchdog = setInterval'));
    const body = tick.slice(0, tick.indexOf('}, WATCHDOG_TICK_MS)'));
    assert.match(body, /if \(toolIdleFor >= 0 && toolIdleFor < TOOL_STALL_MS\) return;/);
    assert.match(body, /if \(quietFor <= WEDGE_CONFIRM_MS\) return;/);
    // Nothing may await between the decision and the note: an await here is what let a
    // probe from a previous tick cancel a turn that had already moved on.
    assert.doesNotMatch(body.slice(body.indexOf('wedgeHandled = true')), /await [^)]*treeIsWorking/);
  });

  test('an interrupted turn is MARKED interrupted, whichever way it was cut', () => {
    // The wedge path used to return early whenever the turn had produced something, so a
    // turn KiroLex had just killed looked completed: no banner, an empty composer, and
    // per-message Rerun still offered. All three cut paths now share one implementation.
    assert.match(hook, /const markTurnInterrupted = \(sid: string, opts\?: \{ prefill\?: boolean \}\) => \{/);
    assert.ok((hook.match(/markTurnInterrupted\(/g) || []).length >= 3,
      'Stop, executor death and the watchdog must all mark the turn');
    const wedge = hook.slice(hook.indexOf('window.kiroApi.onTurnWedged'));
    const branch = wedge.slice(0, 1600);
    assert.match(branch, /if \(produced\) \{/, 'the produced branch must do more than return');
    assert.match(branch, /markTurnInterrupted\(sid\)/);
    // The anchor walk existed in three copies; a fourth would drift.
    assert.equal((hook.match(/role === 'user' && !msgs\[i\]\.steer/g) || []).length, 1);
  });

  test('the interrupt threshold defaults to 10 minutes, after the 5-minute notice', () => {
    // At the old 180s the turn was cut BEFORE the advisory notice (300s) could appear, so
    // the interrupt always arrived unannounced.
    assert.match(main, /const WEDGE_CONFIRM_SECONDS_DEFAULT = 600;/);
    assert.match(main, /const QUIET_NOTICE_MS = 300000;/);
    const notice = Number(/const QUIET_NOTICE_MS = (\d+);/.exec(main)![1]);
    const cut = Number(/const WEDGE_CONFIRM_SECONDS_DEFAULT = (\d+);/.exec(main)![1]) * 1000;
    assert.ok(notice < cut, 'the notice must be able to appear before the interrupt');
  });

  test('the countdown says WHICH of the two thresholds it comes from', () => {
    // The two bounds are ANDed, so with a tool call open the countdown follows the tool
    // no-progress limit (30 min), not the silence threshold Settings shows first (10 min).
    // Reporting only the remaining time made the notice look like it disagreed with the
    // number on the Settings page.
    assert.match(main, /boundBy: toolLeftMs > quietLeftMs \? 'tool' : 'quiet'/);
    assert.match(main, /boundSeconds: Math\.round\(\s*\(toolLeftMs > quietLeftMs \? TOOL_STALL_MS : WEDGE_CONFIRM_MS\) \/ 1000,?\s*\)/);
    // Carried all the way to the notice, not dropped in the hook or the props.
    assert.match(preload, /boundBy\?: 'tool' \| 'quiet'; boundSeconds\?: number/);
    assert.match(hook, /boundBy: data\.boundBy === 'tool' \? 'tool' : 'quiet'/);
    assert.match(chat, /工具无进度多久判定卡死 \$\{dur\(stall\.boundSeconds\)\}/);
    assert.match(chat, /按「\$\{bound\}」/);
  });

  test('the two settings are named as one rule, and nothing still uses the old names', () => {
    const settings = fs.readFileSync(
      path.join(ROOT, 'src', 'renderer', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert.ok(settings.includes('静默多久判定卡死'), 'the silence bound must say what it decides');
    assert.ok(settings.includes('工具无进度多久判定卡死'));
    // Each tooltip states BOTH bounds: read alone, either one reads as "the" timeout.
    const wedgeTip = settings.slice(settings.indexOf('静默多久判定卡死'), settings.indexOf('工具无进度多久判定卡死'));
    assert.match(wedgeTip, /两个条件同时成立/);
    // 「无响应中断阈值」/「工具无进度上限」 were the old labels; a leftover reference would
    // point at a setting that no longer exists by that name.
    for (const src of [settings, main, chat]) {
      assert.equal(src.includes('无响应中断阈值'), false);
      assert.equal(src.includes('工具无进度上限'), false);
    }
  });
});
