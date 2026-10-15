/**
 * "THE PREVIOUS TURN IS STILL WRAPPING UP" — WHAT TO DO ABOUT IT. PURE.
 *
 * A reload or an app restart does not stop a turn. Main owns the ACP connection: it keeps
 * accumulating the reply in `assistantBuf` and flushes the complete text to the transcript when
 * the turn ends (`flushAssistant`). What breaks is only the renderer's belief -- it comes back
 * knowing nothing about streams in progress, sees a user message with no answer under it, and
 * concluded the turn was interrupted.
 *
 * The old conclusion was to WAIT for the backend to go idle and then RESEND the question. That
 * pays for the same answer twice and can produce two replies to one question: the first turn was
 * never lost, it was merely unobserved.
 *
 * So: ask main whether a turn is live, and if it is, ADOPT it -- take ownership of the stream
 * that is already running. Resending stays the answer for the case it was actually written for:
 * a turn that really did die (killed process, crashed executor) and left a question unanswered.
 *
 * This module is the decision and the painting, kept out of the hook because every wrong branch
 * costs either a duplicate billable turn or a question that is never answered.
 */

/** What main can tell us about a session's in-flight turn. */
export interface TurnPeek {
  /** Is a turn running right now for this session? */
  live: boolean;
  /** The id main will use when it flushes, so an adopted bubble can be patched by
   *  `acp:assistant-final` rather than guessed at by position. */
  messageId: string | null;
  /** What the turn has produced SO FAR. May be empty for a turn seconds old. */
  text: string;
  startedAt: number | null;
}

export type RecoveryAction =
  /** Take over the running stream: paint what it has produced and mark the chat streaming. */
  | { action: 'adopt'; messageId: string | null; text: string }
  /** The turn is gone and the question is unanswered: send it again. */
  | { action: 'resend' }
  /** Busy with something that is not a turn (attach, history rebuild, compaction). Prompting
   *  into it is rejected by the backend, so hold. */
  | { action: 'wait' }
  | { action: 'stand-down'; reason: string };

export interface RecoveryInput {
  /** Null when main cannot be asked (IPC absent) -- then never adopt. */
  peek: TurnPeek | null;
  busyReason: string | null;
  /** Does the RENDERER already think it is streaming this chat? */
  streaming: boolean;
  /** The user called the recovery off. */
  cancelled: boolean;
  /** The user switched OFF "重启后自动重发未完成的提问". Gates the resend only: that setting is
   *  about spending turns, and adoption spends none -- it shows an answer already paid for. */
  resendDisabled?: boolean;
  attempts: number;
  maxAttempts: number;
}

/** Busy reasons that are not a conversation turn and cannot be adopted or prompted into. */
const NON_TURN_BUSY = new Set(['attaching', 'priming', 'prime-pending', 'reconfiguring', 'compacting']);

export function decideTurnRecovery(input: RecoveryInput): RecoveryAction {
  const { peek, busyReason, streaming, cancelled, resendDisabled, attempts, maxAttempts } = input;

  if (cancelled) return { action: 'stand-down', reason: 'cancelled' };
  // Already on screen as a live stream: there is nothing to recover, and adopting would
  // re-seed a bubble the chunk handler is actively appending to.
  if (streaming) return { action: 'stand-down', reason: 'already streaming' };

  // ADOPTION COMES FIRST, and is checked before the attempt budget on purpose: that budget
  // bounds RESENDS (each one costs a turn). Adoption costs nothing -- it observes work already
  // paid for -- so a chat reloaded many times mid-turn must not run out of recoveries.
  if (peek?.live) return { action: 'adopt', messageId: peek.messageId, text: peek.text };

  if (resendDisabled) return { action: 'stand-down', reason: 'auto-resend switched off' };
  if (attempts >= maxAttempts) return { action: 'stand-down', reason: 'attempt budget spent' };
  if (busyReason && NON_TURN_BUSY.has(busyReason)) return { action: 'wait' };
  return { action: 'resend' };
}

/** The renderer's message shape, narrowed to what painting needs. NO index signature: the
 *  renderer's own `Message` has none, and requiring one here made this module unusable from the
 *  very hook it exists for. */
interface Msg {
  id: string;
  role: string;
  content: string;
  timestamp: number;
}

/**
 * Paint an adopted turn's partial output into the transcript.
 *
 * Idempotent, because it runs on adoption AND can run again on a later peek: the same turn must
 * extend one bubble rather than accumulate several.
 */
export function adoptedMessages<T extends Msg>(msgs: T[], peek: TurnPeek): T[] {
  if (!peek.live || !peek.text) return msgs;      // nothing to show yet
  const last = msgs[msgs.length - 1];

  // Same turn, already painted: extend it. NEVER shrink -- chunks that land between a peek and
  // the state update are dropped by the chunk handler (it gates on `streamingIds`), so the
  // buffer can legitimately be behind what is on screen.
  if (last && peek.messageId && last.id === peek.messageId) {
    if (peek.text.length <= last.content.length) return msgs;
    return [...msgs.slice(0, -1), { ...last, content: peek.text }];
  }

  // A completed reply is already there: leave it alone. The caller checks this too; a second
  // bubble under a finished turn would be the hardest failure here to explain.
  if (last && last.role === 'assistant' && !last.content.startsWith('💭 ')) return msgs;

  // Under the question, or after a live-only 💭 thinking segment (reply text starts a fresh
  // message -- same rule the chunk handler follows).
  // Built from nothing, NOT spread from `last`: spreading copied the user message's own fields
  // into the reply -- `steer` among them, which is what the recovery walk-back reads to find a
  // turn's base message, and `attachments`, which would re-render the user's files under the
  // answer.
  const seeded = {
    id: peek.messageId || `a_adopted_${peek.startedAt ?? 0}`,
    role: 'assistant',
    content: peek.text,
    timestamp: peek.startedAt ?? (last?.timestamp ?? 0),
  } as unknown as T;
  return [...msgs, seeded];
}
