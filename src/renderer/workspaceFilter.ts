/**
 * 文件浏览界面那个搜索的判据 —— 纯逻辑,PURE。「浏览文件的界面也要单独有搜索功能」。
 *
 * 这里搜的是**当前这个目录里的条目名**,不是递归全盘搜 —— 面板本身就是「我在哪个目录」这件事的界面,
 * 递归搜会让「路径那一行」和「列表」说的不是同一件事(列表里的东西不在当前目录下)。
 * 要找远处的文件,先切目录。
 */

export interface FilterableEntry {
  name: string;
  isDir: boolean;
}

/** 空查询不算搜索 —— 那时候列表就是完整目录,不是「0 个命中」。 */
export function shouldFilter(query: string): boolean {
  return query.trim().length > 0;
}

/**
 * 名字里**包含**这个词就算命中,大小写不敏感。
 *
 * 用包含而不是前缀:文件名的辨识度经常在中段（`useAcp.test.ts` 你会去搜 `acp`,
 * `2026-08-27-report.md` 你会去搜 `report`),前缀匹配对这两种都无效。
 *
 * 目录不特殊对待、也不置顶:命中就列出来。目录排在文件前面这件事由**目录本身的顺序**决定
 * （`workspaceList` 给的就是那个顺序),过滤只是把不命中的抽掉,不重排 —— 搜索时列表顺序
 * 突然和平时不一样,会让人以为搜到的是别的目录。
 */
export function filterEntries<T extends FilterableEntry>(entries: T[], query: string): T[] {
  if (!shouldFilter(query)) return entries;
  const term = query.trim().toLowerCase();
  return entries.filter((entry) => entry.name.toLowerCase().includes(term));
}

/**
 * 搜索结果那行说明。**查了没命中要明说** —— 否则一个空列表和「这个目录本来就是空的」
 * 长得一模一样,而那两件事你要做的动作完全不同(换词 / 换目录)。
 */
export function filterNote(arg: { query: string; shown: number; total: number }): string {
  if (!shouldFilter(arg.query)) return '';
  if (arg.shown === 0) return `没有匹配「${arg.query.trim()}」的条目（共 ${arg.total} 个）`;
  return `${arg.shown} / ${arg.total}`;
}
