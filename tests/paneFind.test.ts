/**
 * 每格一条搜索条（Cmd+F）。
 *
 * 上一版是窗口级的一条 + Electron `findInPage`,分屏时有三个毛病,全是实测出来的:
 *   ① 计数说谎  `findInPage` 作用于整个 window,`3/17` 里的 17 是所有可见格子加起来的
 *   ② 跳到别格  按 ↓ 会把视口带进旁边那一格
 *   ③ 点不到    `elementsFromPoint` 打在搜索条正中,栈自上而下是
 *               chat-messages → chat-main → chat-pane → chat-row → chat-grid(z=1001) → find-bar(z=60)
 *               —— 画出来了、可见,但整个网格盖在它上面,输入框拿不到焦点
 * 「哪个分屏的搜索应该显示在那个分屏中」→ 一格一条,自己算命中、自己画高亮。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findLabel, matchOffsets, shouldSearch, stepIndex } from '../src/renderer/paneFind.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');
const CHAT = read('src', 'renderer', 'components', 'ChatArea.tsx');
const APP = read('src', 'renderer', 'App.tsx');
const CSS = read('src', 'renderer', 'styles', 'global.css');
const HL = read('src', 'renderer', 'findHighlight.ts');

describe('命中在哪', () => {
  test('大小写不敏感', () => {
    assert.deepEqual(matchOffsets('Flow flow FLOW', 'flow'), [0, 5, 10]);
  });

  test('空串和纯空白不算搜索 —— 否则每个位置都是命中', () => {
    assert.deepEqual(matchOffsets('abc', ''), []);
    assert.deepEqual(matchOffsets('abc', '   '), []);
  });

  test('**不重叠**：`aa` 在 `aaa` 里是 1 个,不是 2 个', () => {
    // 2 个的话按 ↓ 会在同一段字上原地打转,而浏览器和编辑器都算 1 个
    assert.deepEqual(matchOffsets('aaa', 'aa'), [0]);
    assert.deepEqual(matchOffsets('aaaa', 'aa'), [0, 2]);
  });

  test('一个都没有就是空数组,不是 -1 那种哨兵值', () => {
    assert.deepEqual(matchOffsets('abc', 'zzz'), []);
  });

  test('中文照样算 —— 界面里大半内容是中文', () => {
    assert.deepEqual(matchOffsets('主会话 · 主会话', '主会话'), [0, 6]);
  });
});

describe('↑↓ 的下标算术', () => {
  test('到头绕回去,不是停住 —— 停住会被当成「按了没反应」', () => {
    assert.equal(stepIndex(17, 17, 'next'), 1);
    assert.equal(stepIndex(1, 17, 'prev'), 17);
  });

  test('正常前后各一步', () => {
    assert.equal(stepIndex(3, 17, 'next'), 4);
    assert.equal(stepIndex(3, 17, 'prev'), 2);
  });

  test('还没定位过（0）：往下是第 1 个,往上是最后一个', () => {
    assert.equal(stepIndex(0, 9, 'next'), 1);
    assert.equal(stepIndex(0, 9, 'prev'), 9);
  });

  test('没有命中时哪个方向都是 0,不能变成 1（那会去取 ranges[0]）', () => {
    assert.equal(stepIndex(0, 0, 'next'), 0);
    assert.equal(stepIndex(5, 0, 'prev'), 0);
  });
});

describe('计数标签', () => {
  test('没查询时什么都不显示', () => {
    assert.equal(findLabel({ query: '', active: 0, total: 0 }), '');
    assert.equal(findLabel({ query: '  ', active: 3, total: 9 }), '');
  });

  test('查了没结果要明说 —— 否则和「还没开始查」分不清', () => {
    assert.equal(findLabel({ query: 'zzz', active: 0, total: 0 }), '无结果');
  });

  test('有结果显示 当前/总数', () => {
    assert.equal(findLabel({ query: 'a', active: 3, total: 17 }), '3/17');
  });

  test('shouldSearch 和标签用同一条判据 —— 两份会漂', () => {
    assert.equal(shouldSearch('  '), false);
    assert.equal(findLabel({ query: '  ', active: 1, total: 1 }), '');
  });
});

describe('搜索条属于**这一格**,不属于窗口', () => {
  test('状态在 ChatArea 里,App 不再持有全局搜索状态', () => {
    assert.match(CHAT, /const \[findOpen, setFindOpen\] = useState\(false\)/);
    assert.doesNotMatch(APP, /const \[find, setFind\]/, 'App 不该再有窗口级搜索状态');
  });

  test('高亮注册表的 key 是**这一格的会话**,不是全局焦点', () => {
    assert.match(CHAT, /const findKey = currentSessionId \|\| 'no-session'/);
    // App 给每格传的是它自己那条会话，不是全局 currentSessionId
    assert.match(APP, /currentSessionId=\{sid\}/);
  });

  test('条子是格子内的 absolute,不是窗口级 fixed —— fixed 那版被 chat-grid 盖住点不到', () => {
    const rule = CSS.slice(CSS.indexOf('\n.pane-find {'), CSS.indexOf('\n.pane-find-input'));
    assert.match(rule, /position:\s*absolute/);
    assert.doesNotMatch(rule, /position:\s*fixed/);
    assert.doesNotMatch(CSS, /\n\.find-bar \{/, '窗口级那条搜索条的样式应该已经删掉');
  });

  test('只有聚焦的那一格响应 Cmd+F —— 否则一次按键把每格都打开', () => {
    const at = CHAT.indexOf('Cmd/Ctrl+F 打开**这一格**的搜索条');
    assert.ok(at > 0, '没有那段 Cmd+F 的 effect');
    const block = CHAT.slice(at, at + 1200);
    assert.match(block, /if \(!paneFocused\) return;/);
    // capture 阶段：composer 的 textarea 会先吃掉冒泡阶段的 keydown
    assert.match(block, /addEventListener\('keydown', onKey, true\)/);
  });

  test('findInPage 那一整套已经拆干净 —— 留着就是两套搜索同时在跑', () => {
    for (const file of ['src/main/index.ts', 'src/main/preload.ts', 'src/renderer/App.tsx']) {
      const code = read(...file.split('/'));
      assert.doesNotMatch(code, /webContents\.findInPage|ipcMain\.handle\('chat:find'|kiroApi\.findInPage\?/,
        `${file} 里还有 findInPage 的残留`);
    }
  });
});

describe('搜索**只能搜挂上来的 DOM**,所以搜索时要整开', () => {
  test('判据是这一格自己的 findOpen,不是一个全局开关', () => {
    assert.match(CHAT, /const expandForFind = findOpen \|\| !!searchOpen;/);
    assert.match(CHAT, /const windowSize = expandForFind\s*\n?\s*\? renderGroups\.length/);
  });

  test('等两帧再算 —— 同一帧里 DOM 还是旧的那 120 组', () => {
    const at = CHAT.indexOf('重新算这一格的命中');
    assert.ok(at > 0);
    const block = CHAT.slice(at, at + 2000);
    const first = block.indexOf('requestAnimationFrame');
    assert.ok(first > 0 && block.indexOf('requestAnimationFrame', first + 1) > 0, '要两层 rAF');
  });
});

describe('高亮不许动 DOM,也不许滚别的格子', () => {
  test('用 Range + CSS.highlights,不插 <mark>', () => {
    assert.match(HL, /CSS as any\)\.highlights/);
    assert.doesNotMatch(HL, /createElement\('mark'\)|innerHTML/,
      '插标签会被 React 下一次 render 覆盖,还会切断代码块和链接');
  });

  test('**不用 scrollIntoView** —— 它会把分屏那层共享的网格一起滚走', () => {
    // 这条禁令由 tests/scrollIsolation.test.ts 全局把守；这里钉住这个模块自己的做法。
    // 只看代码,不看注释 —— 注释里正当地提到了这个被禁的 API 来解释为什么不用它。
    const code = HL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /scrollIntoView/);
    assert.match(code, /container\.scrollTop \+= offset/);
    assert.match(code, /closest\('\.chat-messages'\)/);
  });

  test('两层高亮的名字在 CSS 里写死 —— ::highlight() 不接受变量', () => {
    assert.match(CSS, /::highlight\(kirolex-find\)/);
    assert.match(CSS, /::highlight\(kirolex-find-active\)/);
  });

  test('当前那一个从「全部」里排掉,否则两层颜色叠成第三种状态', () => {
    assert.match(HL, /activeRange \? all\.filter\(\(r\) => r !== activeRange\) : all/);
  });

  test('内核不支持时搜索仍然可用,只是不上色', () => {
    assert.match(HL, /export function supportsHighlight/);
    const flush = HL.slice(HL.indexOf('function flush'), HL.indexOf('function textMap'));
    assert.match(flush, /if \(!supportsHighlight\(\)\) return;/);
  });

  test('清掉某一格不碰别格 —— 每格自己一份 Range', () => {
    assert.match(HL, /const byPane = new Map<string, Range\[\]>\(\)/);
    assert.match(HL, /export function clearPane/);
  });
});
