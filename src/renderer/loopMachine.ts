/**
 * Loop specification and state machine — PURE. No React, no IPC, no DOM.
 *
 * Why this file exists at all: the loop used to be one type,
 *
 *     { text, intervalSec, stopped, timer }
 *
 * which mixed the user's DECLARED intent (what to run, how often) with per-round
 * RUNTIME state (stopped, the pending timer handle). That had three consequences,
 * and this module exists to remove all three:
 *
 *   1. The spec could not be serialized, reused or stored, because it was welded to
 *      a `setTimeout` handle. A loop specification that cannot be written down is
 *      not a specification.
 *   2. There was nowhere to record WHY a loop stopped. The only cleanup path deleted
 *      the map entry, so "the user pressed Stop", "the send failed" and "it finished"
 *      were indistinguishable afterwards — the most direct form of an error being
 *      read as a success.
 *   3. Every round sent the SAME text, so the previous round's outcome could not
 *      change the next round's action. That is a timer firing a one-shot task N
 *      times, not a loop.
 *
 * `nextPromptText` is the fix for (3) and is the single most important function
 * here: without feeding the verifier's output back in, adding verification only
 * buys a stop condition, and the loop still repeats one sentence forever.
 *
 * Everything below is a pure function of its arguments so it can be tested without
 * an Electron window, a backend, or a clock. The only mutable state lives in the
 * hook that drives it (`useAcp`), which keeps `stopped` and the timer handle in a
 * separate handle object so `LoopRun` itself stays JSON-serializable.
 */

/** Verification strength, following the usual ladder. Only 0 and 1–3 are
 *  implemented; 4 (model-as-judge) and 5 (human checkpoint) are named so the level
 *  a loop claims cannot silently mean something else later. */
export type VerificationLevel = 0 | 1 | 2 | 3 | 4 | 5;

export type LoopVerifier =
  /** No verification, stated explicitly. Equivalent to the historical behavior —
   *  and deliberately not the same thing as an unset field, because "nobody
   *  checked" is a fact about the run that belongs in its record. */
  | { level: 0; kind: 'none' }
  /** L1 deterministic / L2 rule-based / L3 delayed ground truth are all the same
   *  mechanism: run one command OUT OF BAND and trust only its exit code. The
   *  levels differ in what the command means, not in how it is executed.
   *
   *  Out of band is not a stylistic choice. Handing `npm test` to the agent and
   *  asking it to report the result yields the model's account of its own work —
   *  an L4 judgement wearing an L1 label, with the added problem that producer and
   *  grader are the same model. */
  | { level: 1 | 2 | 3; kind: 'command'; command: string; timeoutSec: number };

export type LoopStopRule = {
  /** Hard cap on rounds. REQUIRED (> 0), including at level 0: an unbounded loop
   *  nobody is watching is the failure mode these rules exist to prevent, and at
   *  level 0 the round count is the only stop condition there is. */
  maxIterations: number;
  /** Stop after this many consecutive rounds with no detectable change. 0 disables
   *  the check. Never applies at level 0 — see `advance`. */
  maxNoProgressRounds: number;
  /** Passes needed IN A ROW before declaring success. 1 means the first pass wins.
   *  Meaningless at level 0, where nothing can pass. */
  successStreak: number;
  /** How many CONSECUTIVE rounds the verifier may fail to RUN before the loop gives
   *  up. Required, so a spec always states its own tolerance.
   *
   *  It exists because one flake used to kill everything: `ran: false` became
   *  `unrunnable`, and `unrunnable` terminated the run on the spot. Three real paths
   *  produce it without anything being wrong with the work -- an SSH blip or
   *  ConnectTimeout on a remote session, and main's own "the previous check has not
   *  finished" guard. A twenty-round loop ending because the network hiccupped once is
   *  the same misjudgement as reading a connect timeout as a permanent failure: a
   *  transient absence of evidence is not evidence of being stuck. */
  maxUnrunnableRounds: number;
  /** Wall-clock budget for the whole run, in seconds. 0/undefined disables it. */
  maxWallClockSec?: number;
};

/** The user's declaration: fixed for the life of the run, serializable, reusable.
 *
 *  Deliberately SMALLER than the obvious design. Left out for now: cron and
 *  file-event triggers (the loop is driven from the renderer, so it cannot fire
 *  while the window is closed), a memory path, an approval list for irreversible
 *  actions, and a token budget (the renderer has no reliable per-turn token count —
 *  the usage map is a display approximation). Declaring those fields before they
 *  can be honored would only produce half-implemented branches. */
export type LoopSpec = {
  /** What to send. Was `LoopState.text`. */
  prompt: string;
  /** Human-readable definition of "done", shown to the model alongside the
   *  verifier output. Optional in effect (empty string is allowed) but asked for in
   *  the UI, because a verifier command without a stated goal is an exit code
   *  nobody can interpret later. */
  goal: string;
  verifier: LoopVerifier;
  /** Delay between rounds. 0 means "start the next round as soon as this one ends". */
  everySec: number;
  stop: LoopStopRule;
};

/**
 * Why a run ended. Written to the run BEFORE it is removed from the live map, and
 * (except where noted) reported into the chat, so the reason survives the process.
 *
 * The first six are outcomes of the loop itself. The last three describe something
 * happening TO the loop, and exist because the alternative — folding them into
 * `aborted` — records two kinds of genuine failure as "the user stopped it", which
 * is the same class of bug as having no reason at all.
 */
export type LoopTerminal =
  /** The verifier passed, `successStreak` times in a row. Unreachable at level 0. */
  | 'success'
  /** It passed on the very first round: there was nothing to do. Kept distinct from
   *  `success` because "already satisfied" and "fixed by the loop" are different
   *  facts about the world. Unreachable at level 0. */
  | 'no-op'
  /** Cannot continue: the send failed, the verifier could not be executed, or the
   *  executor died. NOT the same as the verifier returning non-zero, which is an
   *  ordinary failing round. */
  | 'blocked'
  /** `maxNoProgressRounds` consecutive rounds changed nothing. Unreachable at
   *  level 0, where there is no evidence either way. */
  | 'stalled'
  /** A budget ran out: rounds or wall clock. */
  | 'exhausted'
  /** The user stopped it (Stop, /stop, force-stop). */
  | 'aborted'
  /** A NEW loop was started on the same chat, replacing this one. */
  | 'superseded'
  /** The connection or the app was torn down under it. Not a verdict on the loop. */
  | 'torn-down'
  /** The chat itself was deleted. The only terminal that is not reported anywhere,
   *  because there is no longer a transcript to report it into. */
  | 'discarded';

/** Terminals that describe the loop's own outcome, as opposed to something that
 *  happened to it. Used by the UI to decide whether to frame the end as a result. */
export const OUTCOME_TERMINALS: readonly LoopTerminal[] = [
  'success', 'no-op', 'blocked', 'stalled', 'exhausted',
];

/** Terminals reachable without any verifier. `success`, `no-op` and `stalled` are
 *  absent on purpose: with nothing checking anything, claiming the goal was met (or
 *  that progress has stopped) would be an assertion with no evidence behind it. */
export const LEVEL0_TERMINALS: readonly LoopTerminal[] = [
  'blocked', 'exhausted', 'aborted', 'superseded', 'torn-down', 'discarded',
];

export type LoopVerdict = {
  level: VerificationLevel;
  pass: boolean;
  /** Exit code, when a command actually ran. */
  exitCode?: number;
  /** Truncated verifier output. Shown in the UI and fed into the next prompt. */
  output: string;
  at: number;
  /** The verifier could not be RUN (missing binary, timeout, SSH failure). This is
   *  `blocked`, not a failing round: treating "the checker is broken" as "the work
   *  is not done yet" would let a loop grind forever against a check that never had
   *  a chance to pass. */
  unrunnable?: boolean;
  /** No evidence was collected at all — level 0. Distinct from a failing verdict:
   *  it suppresses progress tracking rather than counting as no progress. */
  noEvidence?: boolean;
};

/** Per-round state. Serializable on purpose: no timer handle, no `stopped` flag —
 *  those belong to the driver, which owns the actual timers (see `LoopHandle` in
 *  useAcp). `terminal` is written here first and only then is the run unregistered. */
export type LoopRun = {
  spec: LoopSpec;
  sessionId: string;
  /** Rounds STARTED, 1-based once the first one begins. */
  iteration: number;
  consecutivePasses: number;
  noProgressRounds: number;
  lastVerdict: LoopVerdict | null;
  /** The last verdict that actually MEASURED something, i.e. the last one that was
   *  neither `unrunnable` nor `noEvidence`.
   *
   *  Separate from `lastVerdict` because the two answer different questions:
   *  `lastVerdict` is what happened on the most recent attempt (and must stay
   *  truthful, including "the checker could not run"), while this is what the checker
   *  last actually SAID. Feeding back the former throws away the very progress that
   *  tolerating a flake exists to preserve — a round that reported "3 failing: a,b,c",
   *  followed by an SSH blip, would tell the next round only "无法执行".
   *
   *  Same trap as Conductor resolving `${think.output.draft}` to the most recent task
   *  instance rather than the last committed one: when accumulated state has to cross
   *  a mid-run failure, the reference has to name the last COMMITTED output. */
  lastMeasuredVerdict: LoopVerdict | null;
  /** Fingerprint of the last verdict, i.e. the basis for stall detection. */
  lastFingerprint: string | null;
  /** Consecutive rounds in which the verifier could not be RUN. Reset by any round
   *  that produced a real verdict, pass or fail. */
  unrunnableRounds: number;
  startedAt: number;
  terminal: LoopTerminal | null;
};

/** Default tolerance for a verifier that cannot run. Three consecutive failures to
 *  even start the check is a broken verifier; one or two is a flake. */
export const DEFAULT_MAX_UNRUNNABLE_ROUNDS = 3;

/** Floor for the delay before RETRYING after a tolerated unrunnable round.
 *
 *  A round costs a model turn, so retrying at `everySec: 0` would spend real turns as
 *  fast as an outage can reject checks. Tolerating a flake must not become a way to
 *  spend money quickly. */
export const TOLERATED_RETRY_FLOOR_SEC = 15;

/** Verifier output kept per round. Enough to see a failing test list; short enough
 *  that feeding it back into the next prompt does not dominate the context. */
export const MAX_VERDICT_OUTPUT = 4000;

export function truncateVerdictOutput(text: string, limit = MAX_VERDICT_OUTPUT): string {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  // Keep the TAIL: runners print the summary and the failure list last, while the
  // head is usually a banner and a list of passing cases.
  return `…（前 ${value.length - limit} 字符已省略）\n${value.slice(value.length - limit)}`;
}

/**
 * Strip the parts of verifier output that change on every run without meaning
 * anything changed. Without this, stall detection never fires against any test
 * runner that prints a duration or a timestamp — every round looks like progress.
 *
 * This is a PROXY for progress and should be read as one. The real definition —
 * "the set of failures got smaller" — requires parsing a specific runner's output,
 * so it is deliberately not attempted here; a round that only reformatted a comment
 * still registers as progress, and a round that cut failures from 12 to 3 registers
 * as progress only because the printed counts differ.
 */
export function normalizeVerifierOutput(text: string): string {
  return String(text ?? '')
    // ISO timestamps, then clock times
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>')
    // durations: 12ms / 1.23s / 2 m / 0.5 sec
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins)\b/gi, '<dur>')
    // pids and ports
    .replace(/\b(pid|PID|port)[=: ]\s*\d+/g, '$1=<n>')
    // absolute home paths differ between the local Mac and a remote host
    .replace(/(?:\/Users|\/home)\/[^/\s:]+/g, '<home>')
    // long hex blobs (hashes, ids)
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hex>')
    .split('\n').map((line) => line.replace(/\s+$/, '')).join('\n')
    .trim();
}

/** FNV-1a. Not cryptographic and does not need to be — this only has to detect
 *  "the same output as last round" without pulling in a dependency or touching
 *  node:crypto, which is unavailable in the renderer. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The value stall detection compares round over round: exit code plus normalized
 *  output. Both matter — an unchanged exit code with different failures is progress,
 *  and identical output with a different exit code is a state change. */
export function fingerprintVerdict(verdict: LoopVerdict): string | null {
  if (verdict.noEvidence) return null;      // level 0: nothing was measured
  // An unrunnable round measured nothing either -- its "output" is an SSH error, and
  // hashing that would let a repeated connection failure register as either progress
  // or a stall. A tolerated flake has to be transparent to both.
  if (verdict.unrunnable) return null;
  return `${verdict.exitCode ?? 'n/a'}:${hashText(normalizeVerifierOutput(verdict.output))}`;
}

/** A round at level 0. Named so the caller cannot accidentally pass `pass: false`
 *  and have "nobody checked" counted as "the check failed". */
export function noEvidenceVerdict(at: number): LoopVerdict {
  return { level: 0, pass: false, output: '', at, noEvidence: true };
}

/** Build a verdict from an out-of-band command result. `ran === false` means the
 *  command never executed, which is `blocked`, not a failure. */
export function verdictFromCommand(
  level: 1 | 2 | 3,
  result: { ran: boolean; exitCode: number | null; output: string; error?: string },
  at: number,
): LoopVerdict {
  if (!result.ran) {
    return {
      level, pass: false, at, unrunnable: true,
      output: truncateVerdictOutput(result.error || result.output || '校验命令无法执行'),
    };
  }
  return {
    level,
    pass: result.exitCode === 0,
    exitCode: result.exitCode ?? undefined,
    output: truncateVerdictOutput(result.output),
    at,
  };
}

export function canReachSuccess(spec: LoopSpec): boolean {
  return spec.verifier.level > 0;
}

/** Complaints about a spec, in the user's language, empty when it is usable.
 *  Enforced at the UI boundary so an unusable loop cannot be started at all. */
export function validateSpec(spec: LoopSpec): string[] {
  const errors: string[] = [];
  if (!spec.prompt.trim()) errors.push('循环内容为空');
  if (!Number.isFinite(spec.stop.maxIterations) || spec.stop.maxIterations < 1) {
    // No default is supplied on purpose. A default round cap at level 0 would be a
    // number of unattended billable turns chosen by the program rather than by the
    // person paying for them.
    errors.push('必须填写轮数上限（≥ 1）');
  }
  if (spec.verifier.level > 0 && spec.verifier.kind === 'command') {
    if (!spec.verifier.command.trim()) errors.push('校验命令为空');
    if (!Number.isFinite(spec.verifier.timeoutSec) || spec.verifier.timeoutSec < 1) {
      errors.push('校验超时必须 ≥ 1 秒');
    }
  }
  if (spec.stop.successStreak < 1) errors.push('连续通过轮数必须 ≥ 1');
  // Only worth saying once the cap itself is usable, or a missing cap reports twice.
  if (spec.stop.maxIterations >= 1 && spec.stop.successStreak > spec.stop.maxIterations) {
    // Otherwise the loop cannot succeed by construction and only its round cap can
    // end it -- an unreachable goal presented as a verified one.
    errors.push('连续通过轮数不能大于轮数上限');
  }
  if (spec.verifier.level === 0 && spec.stop.successStreak > 1) {
    errors.push('L0 没有校验，连续通过轮数只能是 1');
  }
  if (spec.stop.maxNoProgressRounds < 0) errors.push('停滞阈值不能为负');
  if (spec.stop.maxUnrunnableRounds < 1) errors.push('校验器容错轮数必须 ≥ 1');
  return errors;
}

/** The historical `startLoop(sessionId, text, intervalSec)` mapped onto a spec:
 *  level 0, interval trigger, and a round cap the caller must supply. Kept so the
 *  old entry point stays expressible, NOT so it stays unbounded. */
export function legacySpec(prompt: string, everySec: number, maxIterations: number): LoopSpec {
  return {
    prompt: prompt.trim(),
    goal: '',
    verifier: { level: 0, kind: 'none' },
    everySec: Math.max(0, Number.isFinite(everySec) ? everySec : 0),
    stop: {
      maxIterations,
      maxNoProgressRounds: 0,
      successStreak: 1,
      maxUnrunnableRounds: DEFAULT_MAX_UNRUNNABLE_ROUNDS,
    },
  };
}

export function createRun(sessionId: string, spec: LoopSpec, now: number): LoopRun {
  return {
    spec,
    sessionId,
    iteration: 0,
    consecutivePasses: 0,
    noProgressRounds: 0,
    lastVerdict: null,
    lastMeasuredVerdict: null,
    lastFingerprint: null,
    unrunnableRounds: 0,
    startedAt: now,
    terminal: null,
  };
}

/**
 * Start of a round: charge the budget BEFORE anything is sent.
 *
 * Checking budgets after the send is what an unbounded loop looks like from the
 * inside — the last round is always paid for before anyone notices the limit.
 */
export function beginIteration(run: LoopRun, now: number): { run: LoopRun; terminal: LoopTerminal | null } {
  if (run.terminal) return { run, terminal: run.terminal };
  if (run.iteration >= run.spec.stop.maxIterations) {
    return { run: { ...run, terminal: 'exhausted' }, terminal: 'exhausted' };
  }
  const budget = run.spec.stop.maxWallClockSec;
  if (budget && now - run.startedAt >= budget * 1000) {
    return { run: { ...run, terminal: 'exhausted' }, terminal: 'exhausted' };
  }
  return { run: { ...run, iteration: run.iteration + 1 }, terminal: null };
}

/** Separator that keeps the restored/verifier material from being read as the
 *  thing to answer. Same shape as the ride-along hand-off, for the same reason. */
const FEEDBACK_HANDOFF = '请据此决定这一轮要做什么；如果目标已经达成，明确说明并停止改动。';

/**
 * The text to send for the current round.
 *
 * THE point of this module. Round 1 sends the prompt as written; every later round
 * sends the prompt plus the goal plus the previous round's verifier verdict, so the
 * outcome of round N changes the action in round N+1. Without this, a verified loop
 * is still one sentence repeated on a timer — it merely knows when to give up.
 *
 * At level 0 there is nothing to feed back, so the text is the prompt, unchanged.
 * That is the honest rendering of "no verification": identical rounds.
 */
export function nextPromptText(run: LoopRun): string {
  const { spec } = run;
  // The LAST MEASURED verdict, not the last attempt: a tolerated flake must not erase
  // the failure list the previous real round produced. See `lastMeasuredVerdict`.
  const lastVerdict = run.lastMeasuredVerdict;
  if (!lastVerdict || lastVerdict.noEvidence) return spec.prompt;
  const status = lastVerdict.pass
    ? `通过（exit=${lastVerdict.exitCode ?? 0}）`
    : `未通过（exit=${lastVerdict.exitCode ?? '?'}）`;
  const parts = [
    spec.prompt,
    '',
    '---',
    `以上是本循环的任务（第 ${run.iteration} 轮，共 ${spec.stop.maxIterations} 轮上限）。`,
  ];
  if (spec.goal.trim()) parts.push(`目标（达成即结束）：${spec.goal.trim()}`);
  parts.push(
    '',
    `上一轮校验结果：${status}`,
    '```',
    lastVerdict.output.trim() || '（校验命令没有输出）',
    '```',
    '',
    FEEDBACK_HANDOFF,
  );
  return parts.join('\n');
}

/**
 * End of a round: fold the verdict in and decide whether the run is over.
 *
 * Order matters and is not arbitrary:
 *   - `unrunnable` wins over everything. A broken checker is not a failing round --
 *     but it is only BLOCKING once it has happened `maxUnrunnableRounds` times in a
 *     row. A single flake (SSH blip, ConnectTimeout, main's "previous check still
 *     running" guard) is tolerated as a round that measured nothing, exactly like a
 *     level-0 round: it neither counts as progress nor as a failure, and it does not
 *     break a pass streak.
 *
 *     A tolerated flake asks for the CHECK to be retried (`retryVerifierOnly`), not
 *     for a new round. The round cap is a budget for MODEL TURNS, and an SSH hiccup
 *     has nothing to do with the model's output, so charging one against that budget
 *     spends the user's turns on the network's behalf. `maxUnrunnableRounds` is the
 *     bound that actually describes an outage, and with the iteration no longer
 *     advancing it is the only thing bounding one -- hence the floor on the retry
 *     delay in the driver, so re-checking cannot spin.
 *   - success is evaluated before stalling, so a run that passes the streak on the
 *     same output it produced last round is a success, not a stall.
 *   - no-progress is only counted on FAILING rounds. Counting it on passes would
 *     let a `successStreak` of 3 be cut short by a stall threshold of 2, purely
 *     because a passing verifier prints the same thing every time.
 *   - level 0 skips progress tracking entirely: with no measurement there is no
 *     evidence of progress OR of its absence, so only budgets can end the run.
 */
export function advance(
  run: LoopRun,
  verdict: LoopVerdict,
  now: number,
): { run: LoopRun; terminal: LoopTerminal | null; retryVerifierOnly?: boolean } {
  if (run.terminal) return { run, terminal: run.terminal };

  const fingerprint = fingerprintVerdict(verdict);
  const measured = fingerprint !== null;
  const progressed = measured ? fingerprint !== run.lastFingerprint : null;
  // A round that could not run PRESERVES the streak rather than resetting it: the
  // verifier did not disagree, it never spoke. Resetting would let one network blip
  // undo two genuine passes.
  const consecutivePasses = verdict.unrunnable
    ? run.consecutivePasses
    : verdict.pass ? run.consecutivePasses + 1 : 0;
  const noProgressRounds = measured && progressed === false && !verdict.pass
    ? run.noProgressRounds + 1
    : (progressed ? 0 : run.noProgressRounds);

  const next: LoopRun = {
    ...run,
    consecutivePasses,
    noProgressRounds,
    lastVerdict: verdict,
    lastMeasuredVerdict: measured ? verdict : run.lastMeasuredVerdict,
    lastFingerprint: measured ? fingerprint : run.lastFingerprint,
    unrunnableRounds: verdict.unrunnable ? run.unrunnableRounds + 1 : 0,
  };
  void now;

  const settle = (terminal: LoopTerminal) => ({ run: { ...next, terminal }, terminal });
  const outOfRounds = () => next.iteration >= run.spec.stop.maxIterations;

  if (verdict.unrunnable) {
    if (next.unrunnableRounds >= Math.max(1, run.spec.stop.maxUnrunnableRounds)) {
      return settle('blocked');
    }
    // Retry the CHECK on this same round: no re-send, no iteration spent. The round
    // cap is deliberately NOT consulted here -- on the last round it would report
    // `exhausted` for a round that was never re-sent, and the run would end without
    // ever learning whether the work passed. The wall-clock budget still applies, and
    // is checked by the driver before it re-checks.
    return { run: next, terminal: null, retryVerifierOnly: true };
  }

  if (verdict.pass && canReachSuccess(run.spec) && consecutivePasses >= run.spec.stop.successStreak) {
    // Passing on the first round means the work was already done. Reported
    // separately so a loop that never had anything to do cannot be mistaken for a
    // loop that fixed something.
    return settle(run.iteration === 1 ? 'no-op' : 'success');
  }

  const stallLimit = run.spec.stop.maxNoProgressRounds;
  if (measured && stallLimit > 0 && noProgressRounds >= stallLimit) return settle('stalled');

  if (outOfRounds()) return settle('exhausted');

  return { run: next, terminal: null };
}

/** Set the terminal without a verdict: the loop was ended from outside (Stop,
 *  delete, teardown, a send failure). Writing it into the run is the whole point —
 *  the old code deleted the map entry and the reason with it. */
export function endWith(run: LoopRun, terminal: LoopTerminal): LoopRun {
  return run.terminal ? run : { ...run, terminal };
}

/** Names WHAT the level claims, not just its number: the badge sits next to the
 *  picker, and "L3 命令校验" would leave the badge saying less than the choice does. */
const LEVEL_TEXT: Record<VerificationLevel, string> = {
  0: 'L0 无校验',
  1: 'L1 确定性断言',
  2: 'L2 规则检查',
  3: 'L3 延迟真值',
  4: 'L4 模型评判',
  5: 'L5 人工检查点',
};

export function levelLabel(level: VerificationLevel): string {
  return LEVEL_TEXT[level] || `L${level}`;
}

const TERMINAL_TEXT: Record<LoopTerminal, string> = {
  'success': '目标达成',
  'no-op': '首轮校验即通过，本来无需改动',
  'blocked': '无法继续（发送失败或校验器无法执行）',
  'stalled': '连续多轮无进展',
  'exhausted': '预算用尽（轮数或时长上限）',
  'aborted': '用户手动停止',
  'superseded': '被新启动的循环替换',
  'torn-down': '连接或应用被拆除',
  'discarded': '会话已删除',
};

export function terminalLabel(terminal: LoopTerminal): string {
  return TERMINAL_TEXT[terminal];
}

/** True when this ending is worth writing into the chat. Only a deleted chat is
 *  excluded — there is nothing left to write into, and the files are already gone. */
export function shouldReportTerminal(terminal: LoopTerminal): boolean {
  return terminal !== 'discarded';
}

/** One-line human summary of a finished run, for the chat and the durable
 *  transcript. This is the artifact whose absence made "the loop stopped" and "the
 *  loop succeeded" look identical, so it always states the level: a run that ended
 *  with nothing checking it must not read like a result. */
export function terminalSummary(run: LoopRun, terminal: LoopTerminal, now: number): string {
  const secs = Math.max(0, Math.round((now - run.startedAt) / 1000));
  const dur = secs < 60 ? `${secs} 秒` : `${Math.floor(secs / 60)} 分 ${secs % 60} 秒`;
  const facts = [
    `第 ${run.iteration}/${run.spec.stop.maxIterations} 轮`,
    dur,
    levelLabel(run.spec.verifier.level),
  ];
  if (run.lastVerdict && !run.lastVerdict.noEvidence) {
    facts.push(run.lastVerdict.unrunnable
      ? '最后一次校验：无法执行'
      : `最后一次校验：exit=${run.lastVerdict.exitCode ?? '?'}`);
  }
  if (run.unrunnableRounds > 0) {
    facts.push(`连续 ${run.unrunnableRounds} 轮校验无法执行`);
  }
  if (run.spec.verifier.level === 0) {
    facts.push('没有任何校验运行过，因此无法判定目标是否达成');
  }
  return `🔁 循环结束：${terminalLabel(terminal)}\n${facts.join(' · ')}`;
}
