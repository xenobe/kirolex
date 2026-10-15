import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * LOOP MODE IS GONE FROM THE UI, and scheduling took its place.
 *
 * The loop declared a goal plus a verifier command and iterated until the check passed.
 * Against the four real scenarios -- weekly report, SFDC activity logging, oncall,
 * research -- none of them is a loop by the only test that matters: does the previous
 * round's RESULT change the next round's ACTION? So the entry point was removed rather
 * than relabelled, and what replaced it models time only.
 *
 * These are source-structure assertions: the behaviour needs an Electron window, so they
 * pin the wiring instead of the pixels.
 */
const SRC = path.join(import.meta.dirname, '..', 'src');
const read = (...parts: string[]) => fs.readFileSync(path.join(SRC, ...parts), 'utf8');
/** Comments stripped: these are claims about CODE, and a sentence in a comment (there are
 *  many, explaining why the loop was replaced) must not satisfy them. */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const CHAT = strip(read('renderer', 'components', 'ChatArea.tsx'));
const HOOK = strip(read('renderer', 'hooks', 'useAcp.ts'));
const APP = strip(read('renderer', 'App.tsx'));
const MAIN = strip(read('main', 'index.ts'));
const SIDEBAR = strip(read('renderer', 'components', 'Sidebar.tsx'));
const CSS = read('renderer', 'styles', 'global.css');

describe('the loop entry point is removed from the main UI', () => {
  test('the 🔁 button and its handler are gone', () => {
    assert.doesNotMatch(CHAT, /loop-message-action/);
    assert.doesNotMatch(CHAT, /循环重发此消息/);
    assert.doesNotMatch(CHAT, /onLoopSetup|openLoopSetup/);
  });

  test('the loop setup dialog is gone, verifier fields included', () => {
    // The goal/verifier/level fields are the part that did not fit: they all presuppose a
    // judgeable completion condition.
    for (const gone of ['loopGoal', 'loopCommand', 'loopLevel', 'loopStreak', 'loopTolerance', 'draftLoopSpec']) {
      assert.doesNotMatch(CHAT, new RegExp(gone), `${gone} still present`);
    }
    assert.doesNotMatch(CHAT, /开始循环/);
  });

  test('nothing still calls startLoop', () => {
    assert.doesNotMatch(HOOK, /const startLoop/);
    assert.doesNotMatch(APP, /startLoop/);
    assert.doesNotMatch(CHAT, /onStartLoop/);
  });
});

describe('scheduling replaced it, with time as the only trigger', () => {
  test('the message action creates a scheduled task', () => {
    assert.match(CHAT, /schedule-message-action/);
    assert.match(CHAT, /onScheduleSetup\(combinedText\)/);
    assert.match(CHAT, /onStartSchedule\(draftSchedule\)/);
  });

  test('all four trigger kinds are reachable from the dialog', () => {
    for (const kind of ['daily', 'weekly', 'interval', 'once']) {
      assert.match(CHAT, new RegExp(`value="${kind}"`), `${kind} not offered`);
    }
  });

  test('NO goal or verifier field exists in the new dialog', () => {
    // The instruction was explicit: no goal judgement. A field that exists but is unused
    // would re-introduce the concept the removal was for.
    assert.doesNotMatch(CHAT, /校验命令|连续通过轮数|停滞阈值|校验超时/);
    assert.doesNotMatch(CHAT, /validateSpec|levelLabel/);
  });

  test('the run budget is a visible prefill, not a silent default', () => {
    // Every run costs a model turn. A hidden fallback would mean the program chose how
    // many unattended billable turns to spend -- and an empty box that LOOKS filled is
    // exactly the trap the old dialog had (placeholder "10" over an empty required field,
    // which left 「开始循环」 permanently disabled).
    assert.match(CHAT, /useState\(String\(DEFAULT_MAX_RUNS\)\)/);
    assert.match(CHAT, /value=\{schedMaxRuns\}/);
    assert.doesNotMatch(CHAT, /placeholder="10"/);
  });
});

describe('the ticker lives in main, so a job fires with no window open', () => {
  test('main owns the interval and the IPC surface', () => {
    // The old loop's setTimeout was in useAcp, so closing the window stopped it. That is
    // the single reason scheduling could not be built on top of it.
    assert.match(MAIN, /setInterval\(\(\) => \{[\s\S]{0,300}isDue\(job\.state, now\)/);
    for (const channel of ['schedule:create', 'schedule:list', 'schedule:pause', 'schedule:remove']) {
      assert.ok(MAIN.includes(`'${channel}'`), `main does not handle ${channel}`);
    }
  });

  test('the renderer only asks main; it drives nothing', () => {
    assert.match(HOOK, /scheduleCreate\?\.\(sessionId, spec\)/);
    assert.doesNotMatch(HOOK, /setTimeout\(\(\) => \{ void (iterate|recheck)\(\)/);
  });

  test('a run is charged and flushed BEFORE the send', () => {
    // A run recorded only on completion is one a killed process forgets it paid for --
    // the shape of a job that bills a turn per restart.
    assert.match(MAIN, /const charged = recordRun\(state, Date\.now\(\)\);[\s\S]{0,200}writeSchedule\(id, charged/);
  });

  test('a slow run is not re-entered by the next tick', () => {
    assert.match(MAIN, /schedulesInFlight/);
  });

  test('the previous run result is NEVER injected into the next run', () => {
    // KiroCrew calls accumulated context "the other half of the bug" (cron.py:204). The
    // send must carry the bare prompt.
    assert.match(MAIN, /text: state\.spec\.prompt/);
    assert.doesNotMatch(MAIN, /lastResult|last_result/);
  });
});

/**
 * A SCHEDULE YOU CANNOT SEE IS INDISTINGUISHABLE FROM ONE THAT SILENTLY STOPPED.
 *
 * Creating a job posted one note into the transcript and then nothing: scroll up, reload the
 * window, or come back tomorrow and the chat looked ordinary. So the fact is stated in the two
 * places a person actually looks -- above the transcript of the chat itself, and on that chat's
 * sidebar row while you are looking at a different one.
 *
 * Both read from the SAME computed summary (`sessionScheduleSummary`), so the banner and the row
 * can never disagree about when the next run is.
 */
describe('a chat with a scheduled task says so, in both places you look', () => {
  test('the banner sits ABOVE the transcript, not down in the composer', () => {
    // The archived notice lives inside `chat-input-area`, which is the wrong precedent to copy
    // here: a schedule is a property of the chat, and it must be visible while you read history
    // rather than only when the composer happens to be expanded.
    const banner = CHAT.indexOf('schedule-banner');
    const messages = CHAT.indexOf('className="chat-messages"');
    assert.ok(banner > 0, 'no schedule banner in ChatArea');
    assert.ok(messages > 0, 'the transcript container moved — this guard needs updating');
    assert.ok(banner < messages, 'the banner must be rendered before the transcript, not after');
  });

  test('both surfaces render the SAME computed summary', () => {
    // Not "each formats its own": two call sites formatting a countdown separately is how the
    // row and the banner end up naming different times for one job.
    assert.match(CHAT, /schedule(Summary|Info)/i, 'ChatArea does not take a schedule summary');
    assert.match(SIDEBAR, /schedule(Summary|Info)/i, 'the sidebar row does not take one');
    assert.match(APP, /sessionScheduleSummary|scheduleSummaryFor/,
      'App does not compute the summary from the pure helper');
  });

  test('the sidebar row states the next run', () => {
    assert.match(SIDEBAR, /session-schedule/, 'no next-run badge on the row');
    // `.short` is the sidebar's field -- the sentence form does not fit a row and was the
    // reason the row previously showed nothing at all.
    assert.match(SIDEBAR, /\.short/, 'the row must use the short form, not the full sentence');
  });

  test('no schedule means NO banner and NO badge, never an empty chip', () => {
    // `sessionScheduleSummary` returns null for a chat with no live jobs, so both sites must be
    // guarded. An always-rendered empty element is worse than nothing: it reads as "scheduled".
    assert.match(CHAT, /schedule(Summary|Info)\s*&&/, 'the banner is not guarded on having one');
    assert.match(SIDEBAR, /schedule(Summary|Info)\s*&&/, 'the badge is not guarded');
  });

  test('a finished or paused job is not shown as pending', () => {
    // The distinction is made once, in the helper, and both surfaces inherit it -- so this pins
    // that the surfaces do NOT filter jobs themselves.
    assert.doesNotMatch(CHAT, /\.filter\(\s*\(?\s*j(ob)?\s*\)?\s*=>[\s\S]{0,60}terminal/,
      'ChatArea re-implements liveness filtering that belongs in scheduleView');
    assert.doesNotMatch(SIDEBAR, /\.filter\(\s*\(?\s*j(ob)?\s*\)?\s*=>[\s\S]{0,60}terminal/,
      'Sidebar re-implements liveness filtering');
  });

  test('the list is refreshed from MAIN on change; the renderer still drives nothing', () => {
    assert.match(HOOK, /scheduleList\?\.\(\)/, 'nobody ever asks main for the jobs');
    assert.match(HOOK, /onScheduleChanged/,
      'main announces created/run/finished jobs and the renderer ignores it');
  });

  test('the display clock ticks COARSELY, so a pending job does not re-render the sidebar every second', () => {
    // The countdown is minute-grained past 60s (scheduleView.ts), so a 1s tick would re-render
    // every row to produce identical text -- those rows are memoised precisely to avoid churn.
    const tick = HOOK.match(/setInterval\(\s*\(\)\s*=>\s*setScheduleNow\(Date\.now\(\)\)\s*,\s*(\d+)\s*\)/);
    assert.ok(tick, 'no display-clock tick for the countdown');
    assert.ok(Number(tick[1]) >= 15000, `tick is ${tick[1]}ms — too fine for a minute-grained countdown`);
  });

  test('both surfaces are actually styled', () => {
    assert.match(CSS, /\.schedule-banner/, 'the banner has no style');
    assert.match(CSS, /\.session-schedule/, 'the row badge has no style');
  });
});

/**
 * A JOB YOU CANNOT CALL OFF IS A LEAK, and a stale banner is a lie.
 *
 * Both were found by driving the real window rather than by reading the code: `schedule:remove`
 * emptied the store and the banner stayed on screen (main announced nothing, so the renderer's
 * mirror was never re-read), and there was no way to reach `schedule:pause`/`schedule:remove`
 * from the UI at all -- the only exits were the run budget and editing the store by hand.
 */
describe('a scheduled task can be called off, and the UI keeps up', () => {
  test('EVERY mutation is announced, not just the end of a run', () => {
    // A run's completion was the only broadcast. So a job created in this window showed no
    // banner until a reload, and one removed here kept its banner until a reload.
    const bodyOf = (channel: string) => {
      const start = MAIN.indexOf(`ipcMain.handle('${channel}'`);
      assert.ok(start > 0, `main does not handle ${channel}`);
      const next = MAIN.indexOf('ipcMain.handle(', start + 20);
      return MAIN.slice(start, next > 0 ? next : undefined);
    };
    for (const channel of ['schedule:create', 'schedule:pause', 'schedule:remove']) {
      assert.match(bodyOf(channel), /schedule:changed/, `${channel} changes state silently`);
    }
  });

  test('the banner carries the pause and the cancel', () => {
    // The banner is the only place that already names the job, so it is where its controls
    // belong -- a separate manager screen for one line of state would be worse.
    assert.match(CHAT, /schedule-banner-pause/, 'no pause control');
    assert.match(CHAT, /schedule-banner-cancel/, 'no cancel control');
    assert.match(CHAT, /onPauseSchedule/, 'the pause is not wired out of the component');
    assert.match(CHAT, /onCancelSchedule/, 'the cancel is not wired out');
  });

  test('cancel takes two clicks; pause takes one', () => {
    // Pause is reversible, so a stray click costs nothing. Cancel is not: the spec (prompt,
    // trigger, remaining budget) is gone and has to be retyped, so it asks first.
    assert.match(CHAT, /confirmCancelSchedule|cancelArmed/, 'cancel fires on the first click');
  });

  test('both controls reach MAIN, which owns the record', () => {
    assert.match(HOOK, /schedulePause\?\.\(/, 'nothing calls schedule:pause');
    assert.match(HOOK, /scheduleRemove\?\.\(/, 'nothing calls schedule:remove');
  });
});

/**
 * SCHEDULE STATE BELONGS IN THE BANNER, NOT IN THE CONVERSATION.
 *
 * Creating a job used to push a bubble into the message list ("⏰ 定时任务已创建…"), and
 * cancelling one did the same. Both were written with `mutateSessionMessages`, which updates the
 * screen and the in-memory cache but NOT the transcript on disk -- so they read as conversation
 * while behaving like UI state, and vanished on the next reload. The banner states the same fact
 * permanently and truthfully, so the bubbles are gone.
 *
 * The ONE note that stays is main's terminal line ("⏰ 定时任务结束…"), and it is written to disk:
 * a finished job has no banner left to carry it, so without that line nothing explains why the
 * runs stopped.
 */
describe('creating and cancelling a job say nothing in the transcript', () => {
  test('no fake bubbles are pushed for create or cancel', () => {
    for (const gone of ['sched_note_', 'sched_cancel_', '定时任务已创建', '定时任务已取消']) {
      assert.doesNotMatch(HOOK, new RegExp(gone), `${gone} still enters the message list`);
    }
  });

  test('createSchedule touches the message list at all', () => {
    const start = HOOK.indexOf('const createSchedule');
    const body = HOOK.slice(start, HOOK.indexOf('const pauseSchedule', start));
    assert.ok(start > 0 && body.length > 0, 'createSchedule moved — update this guard');
    assert.doesNotMatch(body, /mutateSessionMessages/, 'the create still writes a bubble');
    // A FAILED create is different: nothing appears anywhere else, so it still speaks up.
    assert.match(body, /noteError\(/, 'a rejected schedule would now fail silently');
  });

  test('the terminal note is still durable, and still main\'s job', () => {
    // `store.appendMessage`, not the renderer's screen-only mutation: it must survive a reload,
    // because it is the only record that a job ended and why.
    assert.match(MAIN, /定时任务结束[\s\S]{0,200}|store\.appendMessage[\s\S]{0,300}定时任务结束/);
    assert.doesNotMatch(HOOK, /定时任务结束/, 'the renderer must not duplicate main\'s note');
  });
});

describe('setting a schedule does not wait for the current turn', () => {
  test('the ⏰ is NOT disabled while a turn is streaming', () => {
    // Creating a job writes one record in main and sends nothing now — main owns the ticker, so
    // a job created mid-turn simply fires later. The guard was inherited from the 🔁 loop button,
    // where starting a loop during a turn really did conflict (the renderer drove those sends).
    // Carried over to scheduling it meant "you may not schedule anything until the reply lands",
    // a rule with no reason behind it.
    const at = CHAT.indexOf('schedule-message-action');
    assert.ok(at > 0, 'the ⏰ action is gone');
    const button = CHAT.slice(at, at + 400);
    assert.doesNotMatch(button, /disabled=\{[^}]*isStreaming/, 'a live turn still blocks scheduling');
  });

  test('an empty message still cannot be scheduled', () => {
    // The one guard that IS about the schedule itself: there is no prompt to send.
    const at = CHAT.indexOf('schedule-message-action');
    assert.match(CHAT.slice(at, at + 400), /!combinedText\.trim\(\)/);
  });
});
