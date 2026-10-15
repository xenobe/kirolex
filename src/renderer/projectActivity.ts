/**
 * WHAT IS STILL LIVE, AND WHAT COSTS NOTHING UNTIL OPENED — PURE, with `now` as a parameter.
 *
 * 「如果7天project没有活动就自动折叠，不用每次启动都预热了，等用户点开project再创建连接」.
 *
 * Every launch attached an executor for up to `cap - 1` sessions — a kiro-cli process of roughly 0.4 GB
 * apiece — ordered only so the last-used chat stayed inside the cut. Twenty sessions across projects
 * abandoned months ago therefore spent most of a RAM budget on conversations nobody was going to open,
 * and the sidebar showed all of them expanded as if they were current work.
 *
 * Two decisions live here:
 *   IDLE      a project whose newest session has not moved in a week. Activity belongs to the PROJECT,
 *             not the session: an old chat inside live work is still context worth having warm.
 *             Drives the sidebar's auto-collapse, and still gates warming.
 *   WARM SET  which sessions get an executor at startup: ONE project — the last active one, and only if it
 *             is not itself idle — plus Unassigned, plus the chat being landed on.
 *             「默认只预热上一个活跃的project和unassigned中的会话」.
 *
 * The warm set used to be 「every project that is not idle」, which fixed 「几个月前的项目还在吃内存」 but not
 * the case of several LIVE projects: three of them is three 0.4 GB kiro-cli processes while you read one.
 * 「等用户点开project再创建连接」 — the sentence this module was written for — applies just as well to a
 * project that is live but not on screen. So idleness became a gate rather than the whole answer.
 *
 * `now` is passed in, like `scheduleStore`'s `dueAt`. That rule was learned the hard way: `dueAt` read
 * `Date.now()` itself, a daily 09:00 job created at 09:38 fired immediately, and the test that would have
 * caught it could not be written.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** A week. Long enough that a project you worked on last Friday is still warm on Monday. */
export const IDLE_DAYS = 7;

export interface WarmCandidate {
  id: string;
  /**
   * The app's own field names, deliberately, and `timestamp` is REQUIRED.
   *
   * Both of these were wrong once and neither failed to compile. Written as `project` this module read
   * `undefined` for every session and still returned a plausible answer — every chat looked ungrouped, so
   * idleness quietly became per-session. Written as an OPTIONAL `updatedAt` (the store's name, not the
   * renderer's) every session read 0, i.e. older than any cutoff: every project idle, everything collapsed,
   * nothing warmed. A missing activity time cannot have a safe default, so it is not allowed to be missing.
   */
  projectId?: string;
  /** Last activity. `Session.timestamp` in the renderer — the field the sidebar already sorts by. */
  timestamp: number;
  archived?: boolean;
}

const named = (s: WarmCandidate): string => (typeof s.projectId === 'string' ? s.projectId.trim() : '');
const usable = (s: WarmCandidate): boolean =>
  !!s?.id && !String(s.id).startsWith('pending_') && !s.archived;

/** Newest activity per project. Unnamed (ungrouped) sessions belong to no project and are excluded. */
function lastActiveByProject(sessions: WarmCandidate[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    const project = named(s);
    if (!project) continue;
    const at = Number(s.timestamp) || 0;
    if (at > (out.get(project) ?? -1)) out.set(project, at);
  }
  return out;
}

/**
 * 启动时唯一**热**的那个 project —— 「默认只预热上一个活跃的 project 和 unassigned 中的会话」。
 *
 * 判据分两层，`keepId` 优先：
 *   ① 你落在哪条会话上（`keepId`）—— 它的 project 就是你上一次在做的事。这比时间戳直接：
 *      时间戳最新的可能是某个后台 flow 刚写完一步，而你人在另一个 project 里。
 *   ② 没有 `keepId`（首次启动、上次那条被删了），才退回"活动时间最新的那个 project"。
 *
 * `keepId` 本身是 ungrouped 时返回空串 —— 那种情况下没有哪个 project 是"上一个"，
 * 而 ungrouped 反正一律预热。
 */
export function warmProject(sessions: WarmCandidate[], keepId?: string | null): string {
  const kept = keepId ? sessions.find((s) => s.id === keepId) : undefined;
  if (kept) return named(kept);                 // ungrouped 时是空串，那就是答案
  let best = '';
  let at = -1;
  for (const [project, when] of lastActiveByProject(sessions)) {
    if (when > at) { at = when; best = project; }
  }
  return best;
}

/** Projects with no activity for `days` — collapsed in the sidebar, and not warmed. */
export function idleProjects(sessions: WarmCandidate[], now: number, days: number = IDLE_DAYS): string[] {
  const cutoff = now - days * DAY_MS;
  return [...lastActiveByProject(sessions).entries()]
    .filter(([, at]) => at < cutoff)
    .map(([project]) => project)
    .sort();
}

export interface WarmOptions {
  /**
   * 时钟还是要的 —— 「上一个**活跃的** project」里那个"活跃"是有时限的：一周没动过的那个，
   * 即便它确实是你上一次待的地方，也不该在启动时花掉 0.4 GB。回来一次的开销落在点击上。
   */
  now: number;
  /** How many executors may be started; the backend cap, minus the slot reserved for a new chat. */
  limit: number;
  /** The chat being landed on. Warmed regardless, since it is the one session certain to be read. */
  keepId?: string | null;
  days?: number;
}

/**
 * 启动时给哪些会话起 executor。
 *
 * ## 判据从"不是 idle 的 project"收紧到"**上一个活跃的** project"
 *
 * 「默认只预热上一个活跃的 project 和 unassigned 中的会话」。
 *
 * 原来的判据是"7 天内动过的 project 全预热"。它解决的是"几个月前的项目还在吃内存"，但没解决**同时在做
 * 几件事**的情形：三个都活跃的 project 就是三份 0.4 GB 的 kiro-cli，而你一次只看一个。而这个模块从第一行
 * 起就写着 `等用户点开project再创建连接` —— 那句话对"活跃但没在看"的 project 同样成立。
 *
 * 所以现在启动只热三样东西：
 *   `keepId`   你落在的那条会话，必热（它是唯一确定会被读到的）
 *   ungrouped  一律热 —— 它不是一个能"点开"的 project，没有哪一次点击能承接它的开销
 *   `warmProject` 那一个 project 的会话
 *
 * 别的 project 是**冷的但看得见**：点它的任一会话就地预热（`warmSession`），点开一个折叠的 project
 * 预热它整组（Sidebar 的 `onWarmProject`）。所以没有任何东西变得到不了 —— 只是开销落在点击上。
 *
 * 那条 7 天规则没被取代，只是从"答案"退成"闸"：候选先由"你上一次在哪"选出来，再问它自己凉没凉。
 */
/**
 * 这次启动**唯一热**的那个 project —— 预热和侧栏折叠共用这一份答案。
 *
 * 两道闸串起来：先挑出"上一个活跃的 project"（`warmProject`），再问它自己是不是已经凉了。
 * 一周没动过的那个一个都不热 —— 那是这个模块最早那次测量的结论，没有被这次收紧取代。
 *
 * 抽成一个函数是因为它有**两个**消费者，而两处各算一遍必然分岔：那样就会出现"折起来的却是热的"
 * 或者"展开着的却是冷的"—— 后者实测出现过（「为什么不预热的project不折叠啊」）。
 * 返回空串 = 一个 project 都不热（只剩 unassigned 和落屏那条会话）。
 */
export function warmedProject(
  sessions: WarmCandidate[],
  opts: { now: number; keepId?: string | null; days?: number },
): string {
  const candidate = warmProject(sessions, opts.keepId);
  if (!candidate) return '';
  return idleProjects(sessions, opts.now, opts.days ?? IDLE_DAYS).includes(candidate) ? '' : candidate;
}

/**
 * 侧栏该把哪些 project 折起来 —— **热的那个之外，全折**。
 *
 * 「为什么不预热的project不折叠啊」。原来折叠按"7 天没动过"判，而预热已经收紧到"只热上一个活跃的"，
 * 于是中间多出一类：**展开着但是冷的**（没到 7 天所以不折，但也不预热了），点上去一片灰点。
 * 这个模块开头那条不变量本来就是 `折起来 = 冷的，展开 = 热的` —— 两个判据分开的那一刻它就破了。
 * 所以折叠不再自己判时间，直接跟着 `warmedProject`。
 *
 * unassigned 不在这里：它没有可折叠的组头，而且一律预热。
 */
export function projectsToCollapse(
  sessions: WarmCandidate[],
  opts: { now: number; keepId?: string | null; days?: number },
): string[] {
  const warm = warmedProject(sessions, opts);
  return [...lastActiveByProject(sessions).keys()].filter((p) => p !== warm).sort();
}

export function sessionsToWarm(sessions: WarmCandidate[], opts: WarmOptions): string[] {
  const { now, limit, keepId, days = IDLE_DAYS } = opts;
  const warm = warmedProject(sessions, { now, keepId, days });
  const live = sessions.filter((s) => {
    if (!usable(s)) return false;
    if (s.id === keepId) return true;
    const project = named(s);
    /**
     * UNGROUPED CHATS ARE ALWAYS WARMED. 「为什么unassigned不预热了」 — because I first judged them by their own
     * age, and most of Unassigned is older than a week while being exactly where the day's work happens.
     * The rule this whole module implements is 「等用户点开project再创建连接」, and Unassigned is not a project
     * you can open: there is no click at which its cost could land instead. So it has no idle state.
     */
    if (!project) return true;
    return project === warm;
  });
  // The kept chat first, so a cap can never cut the one session that is about to be shown.
  live.sort((a, b) => (a.id === keepId ? -1 : b.id === keepId ? 1 : 0));
  return live.slice(0, Math.max(0, limit)).map((s) => s.id);
}
