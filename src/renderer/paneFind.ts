/**
 * 每一格自己的会话内搜索（Cmd+F）—— 纯逻辑,PURE。
 *
 * ## 为什么不再用 `findInPage`
 *
 * 原来这件事交给 Electron 的 `webContents.findInPage`：它给真高亮、真滚动、真命中计数,省掉自己
 * 走 DOM 的麻烦。但它有一条改不掉的性质 —— **作用于整个 window**。分屏之后这条性质变成了缺陷:
 *
 *   计数会说谎  两格都开着,`3/17` 里的 17 是两格加起来的,而你问的是「这一格里有几个」。
 *   会跳到别格  按 ↓ 找下一个,视口跳进旁边那一格 —— 你根本没在搜那一格。
 *   条子点不到  实测(CDP,`elementsFromPoint` 打在搜索条正中)栈是
 *              chat-messages → … → chat-grid(z=1001) → find-bar(z=60):
 *              分屏那层网格盖在搜索条上面,点它落到 `.chat-messages` 上,输入框拿不到焦点。
 *
 * 「哪个分屏的搜索应该显示在那个分屏中」。一格一个搜索条、各算各的计数,那就不能再用它。
 *
 * ## 换成什么
 *
 * 匹配自己算(这个文件),高亮交给 **CSS Custom Highlight API**（`findHighlight.ts`）。
 * 关键是它**不动 DOM**:用 `Range` + `CSS.highlights` 画,不往 markdown 渲染出来的节点里插 `<mark>`。
 * 插标签那条路是明确不能走的 —— 那些节点是 React 渲染的,手改它们下一次 render 就被覆盖或对不上,
 * 而且会切断代码块和链接（`findBar.ts` 当年就是因为这个才选了原生 API）。
 */

/** 空查询不算搜索 —— 它既没有命中也不该清掉别人的高亮,一律当「还没开始」。 */
export function shouldSearch(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * `needle` 在 `haystack` 里所有的起始下标,大小写不敏感、**不重叠**。
 *
 * 不重叠是刻意的:搜 `aa` 在 `aaa` 里应当是 1 个而不是 2 个 —— 编辑器和浏览器都这么算,
 * 而「2」会让你按 ↓ 时在同一段字上原地打转。
 */
export function matchOffsets(haystack: string, needle: string): number[] {
  if (!shouldSearch(needle)) return [];
  const text = haystack.toLowerCase();
  const term = needle.toLowerCase();
  const out: number[] = [];
  let at = text.indexOf(term);
  while (at >= 0) {
    out.push(at);
    at = text.indexOf(term, at + term.length);   // +term.length,不是 +1：不重叠
  }
  return out;
}

/**
 * 按 ↑/↓ 之后当前是第几个（**1 起**,和标签上显示的一致）。
 *
 * 到头**绕回去**,不是停住:停在最后一个会被当成「坏了」（按了没反应),而绕回第一个是
 * 所有编辑器的既有行为,不需要解释。
 */
export function stepIndex(active: number, total: number, direction: 'next' | 'prev'): number {
  if (total <= 0) return 0;
  // active 可能是 0（还没定位过）：往下就是第 1 个,往上就是最后一个
  if (active <= 0) return direction === 'next' ? 1 : total;
  if (direction === 'next') return active >= total ? 1 : active + 1;
  return active <= 1 ? total : active - 1;
}

/** 计数标签。没查询就不显示;查了没结果要**明说**,否则和「还没开始查」分不清。 */
export function findLabel(arg: { query: string; active: number; total: number }): string {
  if (!shouldSearch(arg.query)) return '';
  if (arg.total <= 0) return '无结果';
  return `${arg.active}/${arg.total}`;
}
