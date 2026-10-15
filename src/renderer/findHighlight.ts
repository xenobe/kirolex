/**
 * 搜索高亮 —— DOM 那一侧。`paneFind.ts` 算命中在哪,这里把它画出来。
 *
 * ## 为什么用 CSS Custom Highlight API
 *
 * 它用 `Range` 描述「哪一段要高亮」,再交给 `CSS.highlights` 去画 —— **一个节点都不动**。
 * 这正是这件事唯一安全的做法:聊天记录那棵树是 React 从 markdown 渲染出来的,往里插 `<mark>`
 * 会被下一次 render 覆盖(或者更糟,让 React 的 diff 对不上而抹掉真内容),而且会切断代码块和链接。
 *
 * 实测这个 Electron 是 Chromium 126,`CSS.highlights` 和 `Highlight` 都在。老一点的内核上
 * `supportsHighlight()` 会返回 false —— 那时搜索仍然可用（计数和滚动照旧),只是不上色,
 * 而不是整个功能崩掉。
 *
 * ## 为什么要一个注册表
 *
 * `::highlight(name)` 的名字必须是 CSS 里写死的,不能按格子动态生成。而分屏时**几格可以各自有命中**,
 * 每格还要能单独清掉自己的。所以用两个固定名字（全部命中 / 当前那一个),按格子存 `Range`,
 * 每次变动重算这两个 Highlight 的并集。格子的 key 由调用方给（会话 id),清掉某一格不碰别格。
 */

/** 全部命中那一层的名字。CSS 里 `::highlight(kirolex-find)`。 */
const ALL = 'kirolex-find';
/** 当前那一个 —— 单独一层,颜色更重。CSS 里 `::highlight(kirolex-find-active)`。 */
const ACTIVE = 'kirolex-find-active';

/** 按格子存的命中区间。key 一般是会话 id。 */
const byPane = new Map<string, Range[]>();
/** 当前那一个属于哪一格、是第几个 —— 只有一个,因为你同时只在一格里按 ↑↓。 */
let activeRange: Range | null = null;

/** 这个内核支持自绘高亮吗。不支持也不该让搜索整体失效,所以到处都要先问一句。 */
export function supportsHighlight(): boolean {
  return typeof CSS !== 'undefined'
    && !!(CSS as any).highlights
    && typeof (globalThis as any).Highlight === 'function';
}

/** 把注册表里的东西真正交给浏览器。每次变动都整体重算 —— 状态只有一份,不会漂。 */
function flush(): void {
  if (!supportsHighlight()) return;
  const highlights = (CSS as any).highlights as Map<string, unknown>;
  const all: Range[] = [];
  for (const ranges of byPane.values()) all.push(...ranges);
  // 当前那一个从「全部」里**排掉**：两层叠在同一段字上时颜色会混,读起来像第三种状态
  const rest = activeRange ? all.filter((r) => r !== activeRange) : all;
  const Ctor = (globalThis as any).Highlight;
  if (rest.length) highlights.set(ALL, new Ctor(...rest)); else highlights.delete(ALL);
  if (activeRange) highlights.set(ACTIVE, new Ctor(activeRange)); else highlights.delete(ACTIVE);
}

/**
 * 走 `root` 底下所有文本节点,拼成一整条字符串,同时记住每个节点在这条字符串里的起点。
 *
 * 拼起来搜而不是逐节点搜:一个词经常被 markdown 切在两个节点里（`**flow**` 前后各一段),
 * 逐节点搜的话跨边界的那些命中全丢 —— 而那正是最容易被当成「搜索坏了」的情况。
 *
 * `<script>`/`<style>` 跳过（它们的文本不在屏幕上),隐藏元素也跳过 —— 折起来的东西搜出来
 * 会滚到一个看不见的位置,表现成「按了 ↓ 什么都没发生」。
 */
function textMap(root: Element): { text: string; nodes: Text[]; starts: number[] } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') return NodeFilter.FILTER_REJECT;
      if (!(node as Text).data) return NodeFilter.FILTER_REJECT;
      // offsetParent 为 null = 没被布局出来（display:none 或祖先如此）
      if (!(parent as HTMLElement).offsetParent && parent.tagName !== 'BODY') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node = walker.nextNode() as Text | null;
  while (node) {
    starts.push(text.length);
    nodes.push(node);
    text += node.data;
    node = walker.nextNode() as Text | null;
  }
  return { text, nodes, starts };
}

/** 拼接串里的 `[from, to)` 换回一个真的 `Range`。跨节点的命中在这里被接起来。 */
function rangeFor(map: { nodes: Text[]; starts: number[] }, from: number, to: number): Range | null {
  const locate = (offset: number, isEnd: boolean): { node: Text; offset: number } | null => {
    for (let i = map.nodes.length - 1; i >= 0; i--) {
      const start = map.starts[i];
      const len = map.nodes[i].data.length;
      // 终点落在节点边界上时归给**前一个**节点的末尾,否则会指到下一个节点的 0 而漏掉最后一个字
      if (isEnd ? (offset > start && offset <= start + len) : (offset >= start && offset < start + len)) {
        return { node: map.nodes[i], offset: offset - start };
      }
    }
    return null;
  };
  const a = locate(from, false);
  const b = locate(to, true);
  if (!a || !b) return null;
  const range = document.createRange();
  try {
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
  } catch {
    return null;   // 节点在这一帧里被换掉了 —— 丢掉这一个命中,不要连累整次搜索
  }
  return range;
}

/**
 * 在 `root` 里找 `query` 的所有命中,按文档顺序返回。
 *
 * `offsets` 由 `paneFind.matchOffsets` 给（那是可测的纯函数),这里只负责把下标换成 `Range`。
 */
export function rangesIn(root: Element, query: string, offsets: number[]): Range[] {
  if (!offsets.length) return [];
  const map = textMap(root);
  const out: Range[] = [];
  for (const at of offsets) {
    const range = rangeFor(map, at, at + query.length);
    if (range) out.push(range);
  }
  return out;
}

/** 这一格的文本,给 `matchOffsets` 用。和 `rangesIn` 走同一套跳过规则,所以计数和高亮不会错位。 */
export function textOf(root: Element): string {
  return textMap(root).text;
}

/** 换掉某一格的命中集合。`ranges` 空就等于清掉这一格。 */
export function setPaneRanges(key: string, ranges: Range[]): void {
  if (ranges.length) byPane.set(key, ranges); else byPane.delete(key);
  flush();
}

/** 这一格彻底不搜了（关掉条子、格子被关掉、会话被换掉)。 */
export function clearPane(key: string): void {
  const mine = byPane.get(key);
  if (mine && activeRange && mine.includes(activeRange)) activeRange = null;
  byPane.delete(key);
  flush();
}

/**
 * 指定「当前那一个」并滚到它上面。传 null 就是取消当前项(命中清零时)。
 *
 * **不用 `scrollIntoView`** —— 那是仓库里明令禁止的（`tests/scrollIsolation.test.ts`）:
 * 它会把祖先一起滚,包括分屏那层共享的 `overflow:hidden` 网格,于是搜 A 格会把 B 格也拽走。
 * 分屏搜索恰恰是这条禁令存在的理由,所以这里只动**这一格自己**的 `.chat-messages`。
 */
export function setActive(range: Range | null): void {
  activeRange = range;
  flush();
  if (!range) return;
  const anchor = range.startContainer.parentElement;
  const container = anchor?.closest('.chat-messages') as HTMLElement | null;
  if (!anchor || !container) return;
  const box = anchor.getBoundingClientRect();
  const view = container.getBoundingClientRect();
  // 居中而不是「刚好露出来」：搜索时你要看的是命中周围的上下文,贴边的那一行读不出来
  const offset = (box.top + box.height / 2) - (view.top + view.height / 2);
  if (Math.abs(offset) > 4) container.scrollTop += offset;
}
