/**
 * "WHEN DOES THIS FIRE NEXT" — PURE. No React, no clock of its own (`now` is passed in).
 *
 * A schedule the user cannot see is indistinguishable from one that silently stopped, so
 * a chat carrying scheduled jobs says so in two places: a banner above its transcript, and
 * the next-run time on its sidebar row. Both are computed here rather than inside JSX, for
 * the usual reason — the awkward cases (due right now, paused, finished, several jobs on
 * one chat) are where this goes wrong, and they are only testable if they are data.
 *
 * THE COUNTDOWN IS DELIBERATELY COARSE. Past a minute it reports minutes, and past a day
 * it reports a date rather than "37 小时后". Two reasons: a per-second tick on a
 * Monday-morning job would re-render the sidebar tens of thousands of times to convey
 * nothing (those rows are memoised precisely to avoid that churn), and a duration nobody
 * can act on is less useful than the date itself.
 */

export interface ScheduleView {
  id: string;
  sessionId: string;
  prompt: string;
  /** Human rendering of the trigger, e.g. `每周一 09:00`. Comes from main's
   *  `describeSchedule`, so the two surfaces cannot word it differently. */
  describe: string;
  runs: number;
  maxRuns: number;
  paused: boolean;
  terminal?: string | null;
  lastRunAt: number | null;
  lastError: string | null;
  nextRunAt: number | null;
}

export interface ScheduleSummary {
  /** Live (neither finished nor cancelled) jobs on this chat. */
  count: number;
  /** The one line shown in the banner and as the row's tooltip. */
  text: string;
  /** Short form for the sidebar row, where there is no space for a sentence. */
  short: string;
  paused: boolean;
  hasError: boolean;
  /** The soonest job, so a click can act on the thing being described. */
  next: ScheduleView | null;
}

/**
 * How long until `at`, in words. Null when there is no next run.
 *
 * `即将运行` rather than a negative number: the main-process ticker fires every 20s, so
 * "due" and "started" are not the same instant, and a countdown that goes negative reads
 * as a bug.
 */
export function countdownText(at: number | null, now: number): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  const ms = at - now;
  if (ms <= 0) return '即将运行';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs} 秒后`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时 ${mins % 60} 分后`;
  // Beyond a day the date is the useful fact. Locale-formatted, because this is the same
  // string a person would read off a calendar.
  return new Date(at).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Is this job still going to run again? */
function isLive(job: ScheduleView): boolean {
  if (job.terminal) return false;
  if (job.runs >= job.maxRuns) return false;
  return true;
}

/**
 * One line for a chat that has scheduled jobs, or null when it has none.
 *
 * With several jobs the SOONEST one is described, because that is the next thing that will
 * actually happen — showing whichever was created first would name a run that is not next.
 */
export function sessionScheduleSummary(jobs: ScheduleView[], now: number): ScheduleSummary | null {
  const live = jobs.filter(isLive);
  if (live.length === 0) return null;

  // A paused job has no next run, so it must not be picked as "soonest" while an active
  // one exists -- but if everything is paused, the line has to say that rather than nothing.
  const active = live.filter((job) => !job.paused && job.nextRunAt !== null);
  const pool = active.length ? active : live;
  const next = pool.reduce<ScheduleView | null>((best, job) => {
    if (best === null) return job;
    const a = job.nextRunAt ?? Number.POSITIVE_INFINITY;
    const b = best.nextRunAt ?? Number.POSITIVE_INFINITY;
    return a < b ? job : best;
  }, null);

  const allPaused = active.length === 0;
  const hasError = live.some((job) => !!job.lastError);
  const budget = next ? `${next.runs}/${next.maxRuns}` : '';
  const countdown = allPaused ? null : countdownText(next?.nextRunAt ?? null, now);

  const parts: string[] = [];
  if (next) parts.push(next.describe);
  if (allPaused) parts.push('已暂停');
  else if (countdown) parts.push(countdown);
  if (budget) parts.push(`已运行 ${budget}`);
  if (live.length > 1) parts.push(`共 ${live.length} 个任务`);
  // The error goes LAST but is never dropped: a daily job that has failed every morning
  // must not read the same as one that has been working.
  if (hasError) {
    const failing = live.find((job) => job.lastError)!;
    parts.push(`上次失败：${failing.lastError}`);
  }

  return {
    count: live.length,
    text: parts.join(' · '),
    short: allPaused ? '已暂停' : (countdown || next?.describe || ''),
    paused: allPaused,
    hasError,
    next,
  };
}

/** Group jobs by the chat they belong to, so the sidebar can look one up per row. */
export function schedulesBySession(jobs: ScheduleView[]): Map<string, ScheduleView[]> {
  const out = new Map<string, ScheduleView[]>();
  for (const job of jobs) {
    const list = out.get(job.sessionId);
    if (list) list.push(job);
    else out.set(job.sessionId, [job]);
  }
  return out;
}
