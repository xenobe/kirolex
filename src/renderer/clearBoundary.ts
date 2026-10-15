/**
 * 一条会话里**最后一次清空上下文**在哪 —— PURE。
 *
 * 「技术问题 这个会话 clear 了之后再打开还有历史会话呢」。
 *
 * ## 那件事本身是设计好的，坏的是它不可见
 *
 * `/clear` 是后端的斜杠命令：它重置**模型的活动上下文**，而 KiroLex 的 transcript 是自己的持久记录
 * （审计链，也是重启后重建上下文的唯一依据），所以刻意不动。侧栏里那条「清除历史」正是因此被删掉的 ——
 * 它同时删 transcript 又发一个隐藏的 `/clear`，从右键菜单里做这件事不可逆，而且重置后端上下文
 * 本来就是「用户自己那条 `/clear` 消息」在做的事。
 *
 * 但留下的状态是坏的：实测那条会话 transcript 里 185 条，第 183 条是 `/clear`、184 条是后端回的
 * `Conversation cleared` —— 于是重新打开时，界面上摆着 183 条**模型已经不记得**的消息，
 * 而界面上一个字都没说。你看到的和模型知道的不是同一份东西，这比两个极端都糟。
 *
 * ## 判据：用户自己那条 `/clear`
 *
 * 认**用户消息**而不是后端那句 `Conversation cleared`：后者是英文的、由后端措辞决定，
 * 哪天它换成别的说法这条判据就静默失效；而 `/clear` 是用户敲的，也是这套机制唯一的入口
 * （侧栏那条菜单已经没了）。
 *
 * 只认**整条消息就是 `/clear`** 的：一句「我刚才 /clear 了一下」不是在清空。
 */

export interface ClearCandidate {
  role?: string;
  content?: unknown;
}

/** 这条消息是不是一次清空。整条就是那个命令才算 —— 提到它不等于做了它。 */
export function isClearCommand(message: ClearCandidate | undefined): boolean {
  if (String(message?.role || '') !== 'user') return false;
  const text = typeof message?.content === 'string' ? message.content : '';
  return text.trim() === '/clear';
}

/**
 * 最后一次清空之后**还剩几条消息** —— 界面默认只显示这些。
 *
 * 返回的是"从末尾数"的条数，而不是下标：调用方拿它去切数组尾部（现有的分页也是按尾部切的），
 * 下标在消息被合并成组之后就不成立了。
 *
 * 没清空过返回 `undefined`（**不是** 0 也不是全长）：那种情况下不该干预默认视图，
 * 而 0 会被误读成"一条都不显示"。
 *
 * 清空那条**自己也算在里面**：它是那条分界线，界面要在原位画出来。
 */
export function sinceLastClear(messages: ClearCandidate[] | undefined): number | undefined {
  const list = messages || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (isClearCommand(list[i])) return list.length - i;
  }
  return undefined;
}

/**
 * 那条分界线上写什么。
 *
 * 必须把**两件事**都说出来：上面的模型不记得了（否则你会以为它记得），
 * 以及那些记录还在、没被删（否则你会以为清空把历史弄丢了）。
 */
export function clearNoteText(hiddenCount: number): string {
  const above = hiddenCount > 0 ? `上面 ${hiddenCount} 条` : '上面的内容';
  return `上下文已清空 —— ${above}模型不再记得（记录仍然保留在这条会话里）`;
}
