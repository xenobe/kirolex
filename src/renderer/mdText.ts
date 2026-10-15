/**
 * 从 markdown 渲染出来的 children 里取回**纯文本**。PURE。
 *
 * 为什么需要它：`rehypeHighlight` 会把代码块切成一堆 `<span class="hljs-…">` 的**React 元素**，
 * 而原来那两处用的是 `children.join('')` / `String(children)` —— 数组里是对象，`join` 出来就是
 *
 *     [object Object]
 *       [object Object][object Object] [object Object]…
 *
 * 空白和换行是普通字符串所以留了下来，于是缩进和分组看着像真代码，内容全变成 `[object Object]`。
 * 用户点「复制」拿到的就是这个（他把它当成会话报错贴了出来）；同一个字符串还被 `code` 用来判断
 * 「这是不是一个文件路径」，所以高亮过的行内代码也一并判错。
 *
 * 这里递归下去只收字符串：字符串原样、数组逐个、React 元素取它的 `props.children`。
 * 不认识的东西（数字之外）一律当空，绝不 `String(obj)` —— 那正是这个 bug 的来源。
 */
export function mdText(node: unknown): string {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(mdText).join('');
  if (typeof node === 'object') {
    const props = (node as { props?: { children?: unknown } }).props;
    if (props && 'children' in props) return mdText(props.children);
    /* hast 节点（react-markdown 也会把它传进来）：text 有 value，element 有 children */
    const hast = node as { value?: unknown; children?: unknown };
    if (typeof hast.value === 'string') return hast.value;
    if (hast.children !== undefined) return mdText(hast.children);
  }
  return '';
}
