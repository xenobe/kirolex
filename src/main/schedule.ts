/**
 * TIME-TRIGGERED TASKS — PURE. No timers, no IPC, no clock of its own.
 *
 * WHAT THIS REPLACES, and why. "Loop mode" re-sent one message on an interval and judged
 * each round with a verifier command (L1/L2/L3), stopping when the check passed. That is a
 * coding shape. Against the four real target scenarios — weekly report, SFDC activity
 * logging, oncall, research — none of them is a loop by the only test that matters: does
 * the previous round's RESULT change the next round's ACTION? A weekly report does not
 * depend on last week's; an oncall check reads the current queue. They are time-triggered
 * tasks, so this models time, and nothing else.
 *
 * DELIBERATELY ABSENT: goal, verifier, and the `success` / `no-op` / `stalled` terminals.
 * All three require a judgeable completion condition, which these tasks do not have —
 * claiming a schedule "succeeded" would assert something nothing measured. The stop
 * conditions are the two that survive without a goal: A PERSON (pause / cancel) and A
 * BUDGET (`maxRuns`).
 *
 * EACH RUN IS INDEPENDENT, and that is load-bearing rather than a simplification.
 * KiroCrew's cron carries the previous result forward by default and its own source calls
 * that "the other half of the bug" (`cron.py:204`), shipping a stateless mode to switch it
 * off; Warp's scheduled agents open a fresh session per run for the same reason. Feeding
 * the last result back is exactly what makes a scheduled job report the same thing every
 * morning. So this state records THAT a run happened and when — never its output.
 *
 * Wall-clock kinds (`daily` / `weekly`) are not sugar over an interval: an every-86400s
 * job drifts by however long each run took, so a 9am report slides later every day.
 */

export type ScheduleKind = 'interval' | 'daily' | 'weekly' | 'once';

export interface ScheduleSpec {
  /** What to send. One prompt, sent verbatim, every time. */
  prompt: string;
  kind: ScheduleKind;
  /** `interval` only: seconds between runs. */
  everySec: number;
  /** `daily` / `weekly`: local wall-clock time, `HH:MM`, 24-hour. */
  atTime?: string;
  /** `weekly`: 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  weekday?: number;
  /** `once`: the moment to fire, epoch ms. */
  atEpoch?: number;
  /** Hard cap on runs. REQUIRED: every run costs a model turn, and an unattended job
   *  with no ceiling is the failure these rules exist to prevent. */
  maxRuns: number;
}

/** Why a schedule stopped. Three, and none of them is a verdict on the WORK — only on
 *  whether the schedule itself is still live. */
export type ScheduleTerminal =
  /** A `once` job fired, or the run budget was spent exactly. */
  | 'completed'
  /** The run budget ran out. */
  | 'exhausted'
  /** The user removed it. */
  | 'cancelled';

export interface ScheduleState {
  spec: ScheduleSpec;
  /** The chat this job sends into. */
  sessionId: string;
  runs: number;
  createdAt: number;
  lastRunAt: number | null;
  /** The last run's failure, kept so a job failing every time is visible instead of
   *  looking healthy. Never the last run's OUTPUT — see the header. */
  lastError: string | null;
  paused: boolean;
  terminal: ScheduleTerminal | null;
}

/** Floor on the interval, matching KiroCrew's cron. Every run costs a model turn, so a
 *  5-second schedule is a way to spend money quickly rather than a useful setting. */
export const MIN_INTERVAL_SEC = 60;

/** Prefill for the dialog. A VISIBLE number the user can change — never a silent
 *  fallback for an empty field, which is how a program ends up choosing how many
 *  billable turns to spend. */
export const DEFAULT_MAX_RUNS = 20;

const WEEKDAY_TEXT = ['日', '一', '二', '三', '四', '五', '六'];

/** `HH:MM` → parts, or null when it is not a real time of day. */
export function parseClockTime(text: string): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

export function validateSchedule(spec: ScheduleSpec): string[] {
  const errors: string[] = [];
  if (!spec.prompt.trim()) errors.push('要发送的内容为空');
  if (spec.kind === 'interval') {
    if (!Number.isFinite(spec.everySec) || spec.everySec < MIN_INTERVAL_SEC) {
      errors.push(`间隔不能小于 ${MIN_INTERVAL_SEC} 秒`);
    }
  }
  if (spec.kind === 'daily' || spec.kind === 'weekly') {
    if (!parseClockTime(spec.atTime || '')) errors.push('时间格式应为 HH:MM（24 小时制）');
  }
  if (spec.kind === 'weekly' && (spec.weekday === undefined || spec.weekday < 0 || spec.weekday > 6)) {
    errors.push('请选择星期几');
  }
  if (spec.kind === 'once' && !Number.isFinite(spec.atEpoch)) errors.push('请选择触发时间');
  if (!Number.isFinite(spec.maxRuns) || spec.maxRuns < 1) errors.push('运行次数上限必须 ≥ 1');
  return errors;
}

/** Local midnight of the day containing `at`. */
function startOfDay(at: number): Date {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * The moment this schedule is next due, given when it last ran.
 *
 * `0` means "immediately": a never-run job fires now rather than one interval from now,
 * because a job that appears to do nothing for an hour after you create it reads as
 * broken.
 */
export function dueAt(spec: ScheduleSpec, lastRunAt: number | null, createdAt: number): number {
  if (spec.kind === 'once') return Number(spec.atEpoch ?? 0);
  if (spec.kind === 'interval') {
    // Only an interval job starts right away: "every hour" from now means the first one is now.
    if (lastRunAt === null) return 0;
    return lastRunAt + Math.max(MIN_INTERVAL_SEC, spec.everySec) * 1000;
  }

  const clock = parseClockTime(spec.atTime || '') || { hour: 0, minute: 0 };
  /**
   * THE ANCHOR: the last run, or -- for a job that has never run -- the moment it was CREATED.
   *
   * It used to be `Date.now()` for a never-run job, which had two effects. The function stopped
   * being a function (same arguments, different answers on different days), and creating
   * 「每天 09:00」 in the evening put its first slot at TODAY 09:00, already past, so the job was
   * immediately due and fired the moment it was created. Creating an unattended job must never
   * also mean running it now.
   *
   * A slot at or before the anchor is spent -- either it is the run that already happened there,
   * or the job was created after it passed.
   */
  const anchor = lastRunAt ?? createdAt;
  const candidate = startOfDay(anchor);
  candidate.setHours(clock.hour, clock.minute, 0, 0);

  if (spec.kind === 'daily') {
    if (anchor >= candidate.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  // Weekly: walk to the declared weekday, never returning a slot already spent.
  const target = spec.weekday ?? 0;
  while (candidate.getDay() !== target) candidate.setDate(candidate.getDate() + 1);
  if (anchor >= candidate.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate.getTime();
}

export function isDue(state: ScheduleState, now: number): boolean {
  if (state.terminal || state.paused) return false;
  if (state.runs >= state.spec.maxRuns) return false;
  return now >= dueAt(state.spec, state.lastRunAt, state.createdAt);
}

/** When this will next fire, or null when it never will again. */
export function nextRunAt(state: ScheduleState): number | null {
  if (state.terminal || state.runs >= state.spec.maxRuns) return null;
  return dueAt(state.spec, state.lastRunAt, state.createdAt);
}

/**
 * Fold one completed run in. A FAILED run still counts — otherwise a broken job retries
 * without limit, and the budget stops bounding anything.
 */
export function recordRun(state: ScheduleState, now: number, error?: string): ScheduleState {
  return { ...state, runs: state.runs + 1, lastRunAt: now, lastError: error ?? null };
}

/** Whether the schedule is over, and why. Not a verdict on the work. */
export function scheduleTerminal(state: ScheduleState): ScheduleTerminal | null {
  if (state.terminal) return state.terminal;
  if (state.spec.kind === 'once' && state.runs >= 1) return 'completed';
  if (state.runs >= state.spec.maxRuns) return 'exhausted';
  return null;
}

export function createSchedule(sessionId: string, spec: ScheduleSpec, now: number): ScheduleState {
  return { spec, sessionId, runs: 0, createdAt: now, lastRunAt: null, lastError: null, paused: false, terminal: null };
}

/** Plain-language rendering, so a job in a list is never a black box. The lesson from
 *  n8n's bare "stopped due to max iterations": a limit that does not explain itself gets
 *  treated as an obstacle to route around. */
export function describeSchedule(spec: ScheduleSpec): string {
  switch (spec.kind) {
    case 'interval': {
      const secs = Math.max(MIN_INTERVAL_SEC, spec.everySec);
      return secs % 3600 === 0 ? `每 ${secs / 3600} 小时`
        : secs % 60 === 0 ? `每 ${secs / 60} 分钟`
        : `每 ${secs} 秒`;
    }
    case 'daily':
      return `每天 ${spec.atTime}`;
    case 'weekly':
      return `每周${WEEKDAY_TEXT[spec.weekday ?? 0]} ${spec.atTime}`;
    case 'once':
      return `一次性 · ${new Date(spec.atEpoch ?? 0).toLocaleString()}`;
  }
}

const TERMINAL_TEXT: Record<ScheduleTerminal, string> = {
  'completed': '已完成',
  'exhausted': '运行次数已用尽',
  'cancelled': '已取消',
};

export function scheduleTerminalLabel(terminal: ScheduleTerminal): string {
  return TERMINAL_TEXT[terminal];
}
