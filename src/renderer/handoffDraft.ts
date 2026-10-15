/**
 * 往输入框**交接一次**文本的语义 —— PURE。
 *
 * 「技术问题 这个会话反复把之前的提示词填入输入框」。
 *
 * ## 那是个一次性事件，被实现成了永不清空的状态
 *
 * 有两处会把文本推回输入框：
 *   `restoredInputDraft`  上一轮被打断（你按了停、executor 中途死了、看守狗打断了一个哑掉的轮）→
 *                         把那一轮的原文交回来，好让你改完重发。提示条上写着「原文已填回输入框」。
 *   `restoredQueueDraft`  你取消了一条排队中的消息 → 把它的正文交回来。
 *
 * 两处都是 `setState({ id: Date.now(), text, sessionId })`，而**全代码库没有一处把它们清空**。
 * 于是那个 `useEffect` 每次**输入框挂载**都会重放一遍：切回这条会话、进出分屏、布局变化 ——
 * 早已处理完的中断还会一直回来。实测那条会话只被打断过**一次**（日志里 `WEDGED … produced=true`
 * 只有一条），所以"反复"不是反复打断，是同一份状态被反复消费。
 *
 * 而且它比"烦"更严重一点：输入框本来有**按会话保留的草稿**（`composerDrafts`），
 * 挂载时那个 effect 会**盖掉**它 —— 你刚打的字会被一条旧提示词覆盖。
 *
 * ## 所以交接必须是"取走"，不是"读到"
 *
 * 拿走之后要通知拥有它的一方清掉。清的时候**按 id 认**：分屏里同一条会话可能有两个输入框，
 * 而"清掉"这个动作到得晚一点就可能把**新的**一份交接抹掉 —— 按 id 认就不会。
 */

export interface HandoffDraft {
  /** 每次交接一个新的（`Date.now()`）—— 它同时是"这是不是同一份"的判据。 */
  id: number;
  text: string;
  /**
   * 这份交接属于**哪条会话**。
   *
   * 必须有：没有它的时候，每个可见的输入框都会把它吃掉 —— 实测过，A 会话的文本出现在了 B 会话的框里。
   */
  sessionId?: string;
}

/**
 * 这个输入框该不该接这份交接。
 *
 * 没有 `sessionId` 的交接（老的调用点）**任何框都接** —— 那是它原来的行为，收紧它会让那些调用点静默失效。
 */
export function shouldApplyHandoff(
  draft: HandoffDraft | null | undefined,
  sessionId: string | null | undefined,
): boolean {
  if (!draft) return false;
  if (!draft.sessionId) return true;
  return draft.sessionId === String(sessionId || '');
}

/**
 * 取走之后的新状态 —— **按 id 认**，所以一次迟到的"清掉"不会抹掉一份更新的交接。
 *
 * 例：分屏里两个框都指向同一条会话，两个都接了同一份（id=7）并各自要求清掉；
 * 期间又来了一份新的（id=8）。第二次清掉带的是 7，而当前是 8 → 什么都不做。
 */
export function consumeHandoff(
  current: HandoffDraft | null | undefined,
  id: number,
): HandoffDraft | null {
  if (!current) return null;
  return current.id === id ? null : current;
}
