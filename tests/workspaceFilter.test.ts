/**
 * 文件浏览界面的筛选 —— 「浏览文件的界面也要单独有搜索功能哦」。
 *
 * 和聊天里那条 Cmd+F 是两件事,所以它们不共用状态也不共用控件形态:
 *   这里  过滤**列出什么**（列表会变短）→ 占一行,不浮动（浮动会遮住刚筛出来的东西）
 *   那里  在已渲染的文字里找词（列表不变）→ 浮在内容上的临时条子
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { filterEntries, filterNote, shouldFilter } from '../src/renderer/workspaceFilter.ts';

const e = (name: string, isDir = false) => ({ name, isDir });

describe('什么算命中', () => {
  test('空查询**不过滤** —— 那时列表就是完整目录,不是「0 个命中」', () => {
    const all = [e('a.ts'), e('b.ts')];
    assert.equal(filterEntries(all, ''), all, '应当原样返回同一个数组（不重建,省一次重渲染）');
    assert.equal(filterEntries(all, '   '), all);
    assert.equal(shouldFilter('  '), false);
  });

  test('大小写不敏感', () => {
    assert.deepEqual(filterEntries([e('README.md'), e('index.ts')], 'readme').map((x) => x.name), ['README.md']);
    assert.deepEqual(filterEntries([e('README.md')], 'ReAdMe').map((x) => x.name), ['README.md']);
  });

  test('**包含**就算,不是前缀 —— 文件名的辨识度经常在中段', () => {
    const files = [e('useAcp.test.ts'), e('2026-08-27-report.md'), e('other.ts')];
    assert.deepEqual(filterEntries(files, 'acp').map((x) => x.name), ['useAcp.test.ts']);
    assert.deepEqual(filterEntries(files, 'report').map((x) => x.name), ['2026-08-27-report.md']);
  });

  test('查询词首尾的空格不影响判断（打字时很容易带上）', () => {
    assert.deepEqual(filterEntries([e('src')], '  src  ').map((x) => x.name), ['src']);
  });

  test('目录和文件一样对待,而且**不重排** —— 搜索时顺序变会让人以为搜到了别的目录', () => {
    const mixed = [e('src', true), e('src.ts'), e('scripts', true)];
    assert.deepEqual(filterEntries(mixed, 's').map((x) => x.name), ['src', 'src.ts', 'scripts']);
  });

  test('一个都不命中就是空数组', () => {
    assert.deepEqual(filterEntries([e('a.ts')], 'zzz'), []);
  });
});

describe('那行说明', () => {
  test('没查询时不显示', () => {
    assert.equal(filterNote({ query: '', shown: 9, total: 9 }), '');
  });

  test('查了没命中要**明说** —— 空列表和「目录本来就是空的」长得一样,但你要做的事不同', () => {
    const note = filterNote({ query: 'zzz', shown: 0, total: 40 });
    assert.match(note, /zzz/);
    assert.match(note, /40/);
  });

  test('有命中就报 筛出几个 / 共几个', () => {
    assert.equal(filterNote({ query: 'a', shown: 3, total: 40 }), '3 / 40');
  });
});

describe('接进了面板', () => {
  const PANEL = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'WorkspacePanel.tsx'), 'utf8',
  );

  test('列表渲染的是**筛过的**那份,不是原始 entries', () => {
    assert.match(PANEL, /shown\.map\(\(entry\)/);
    assert.match(PANEL, /const shown = useMemo\(\(\) => filterEntries\(entries, query\)/);
  });

  test('进目录要清掉查询词 —— 否则新目录一开就是个残缺列表', () => {
    const at = PANEL.indexOf('if (entry.isDir)');
    assert.ok(at > 0);
    assert.match(PANEL.slice(at, at + 400), /setQuery\(''\)/);
  });

  test('「空目录」那句只在真的空时出现,不能在筛没了时出现', () => {
    assert.match(PANEL, /entries\.length === 0 && \(/);
    assert.doesNotMatch(PANEL, /shown\.length === 0 &&[\s\S]{0,80}empty directory/);
  });

  test('Esc 先清词,清完了才让它冒泡去关面板 —— 一次 Esc 不该干两件事', () => {
    const at = PANEL.indexOf("if (e.key === 'Escape')");
    assert.ok(at > 0);
    const block = PANEL.slice(at, at + 260);
    assert.match(block, /if \(query\)/);
    assert.match(block, /stopPropagation/);
  });

  test('只剩一个命中时 Enter 直接打开它', () => {
    assert.match(PANEL, /e\.key === 'Enter' && shown\.length === 1/);
  });
});
