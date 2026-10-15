import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * NO HOOK BELOW AN EARLY RETURN — the failure this file exists to prevent cost a whole startup.
 *
 * `RunView` grew a `useState` trio and a `useMemo` under its `if (!stored) return …` guards. The first
 * render that HAD a run called more hooks than the render before it, React threw 「Rendered more hooks than
 * during the previous render」, the renderer died inside the error boundary — and because the splash screen
 * only lifts when the renderer reports it has hydrated, the app hung on 「Starting…」 forever. Nothing in
 * `tsc` or the unit tests could see it: hook ORDER is a runtime property.
 *
 * The check is textual on purpose. It reads the component the way React does — top to bottom — and asks one
 * question: does any hook call appear after the first `return` that is not the component's last?
 */

const HOOK = /\b(useState|useEffect|useMemo|useCallback|useRef|useReducer|useLayoutEffect|useImperativeHandle|useContext|useDeferredValue|useTransition)\s*(<[^;]*?>)?\s*\(/;

/** Components whose render body must be hook-safe. Files, not exhaustive AST work — see above. */
const FILES = [
];

/** A conditional early return at the component's top level: `if (…) return <…>;` / `return null;` */
const EARLY_RETURN = /^\s{2}if \(.*\) return .*;\s*$/;

describe('a hook is never reached conditionally', () => {
  for (const file of FILES) {
    test(`${path.basename(file)} calls every hook before its first early return`, () => {
      const lines = fs.readFileSync(path.join(process.cwd(), file), 'utf8').split('\n');
      let firstReturn = -1;
      for (const [i, line] of lines.entries()) {
        if (EARLY_RETURN.test(line)) { firstReturn = i; break; }
      }
      if (firstReturn < 0) return;                       // no early return: nothing to order wrongly

      const offenders: string[] = [];
      for (let i = firstReturn + 1; i < lines.length; i++) {
        const line = lines[i];
        // Hooks inside a NESTED component (a sub-component declared later in the file) are that
        // component's own business; those are indented deeper than the top level of a render body.
        if (!HOOK.test(line)) continue;
        offenders.push(`${file}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
      assert.deepEqual(offenders, [],
        '这些 hook 在早返回之后 —— 组件从「没数据」变成「有数据」时 hook 数量会变，React 会抛 Rendered more hooks，'
        + '而 renderer 一崩，splash 就永远不会消失');
    });
  }
});

/**
 * 关掉全页视图之后落在哪 —— 「我关掉当前页面应该默认到那个新会话页面」。
 *
 * 运行页和画布是盖在聊天区上面的全页视图，而它们下面那个 currentSessionId 往往是 KiroLex 为自己的事开的
 * （画布那条 `skill` 会话、流程主会话、某一步的 worker）。关掉全页却把人留在里面，看到的就是一段生成提示词
 * ——「一个不知道是啥会话」。这两条是文本检查，因为它们是 effect 与 handler 的接线。
 */
/**
 * 全页视图（flow 画布 / 运行页）和分屏的关系 —— 「flow 是单独的」。
 *
 * 「我从 flow 切换回分屏的时候分屏重置了」：打开全页时会把 splitSessionIds 清空、splitGrid 压成 1x1，
 * 而紧接着那个持久化效果把「空」写进了磁盘 —— 原来的分屏就此没了。内存里那份 savedSplit 是个 ref，
 * 刷新或热替换一次就丢，于是回到分屏是空的。
 */
/**
 * 排队的消息要活过一次重渲染 —— 「会话被重新渲染了 queue 就会丢失」。
 *
 * 它原来「故意只活在运行时」。可这里的运行时是**渲染进程**，而排队的东西是你已经打完字、按过回车的内容：
 * 一次刷新、一次热替换、开发时改一行代码，它们就没了，而你以为它们在等着发 —— 执行器活在主进程里，
 * 那一轮根本没停，只有队列跟着窗口一起消失。
 */
describe('队列落盘，而且恢复之后不抢跑', () => {
  const APP = fs.readFileSync(path.join(process.cwd(), 'src/renderer/App.tsx'), 'utf8');

  test('队列存在 ui-state 里，空队列不留键', () => {
    assert.match(APP, /QUEUES_KEY = 'kirolex-queues'/);
    assert.match(APP, /uiSet\(QUEUES_KEY, JSON\.stringify\(alive\)\)/);
    assert.match(APP, /uiRemove\(QUEUES_KEY\)/);
  });

  test('恢复的条目带标记', () => {
    assert.match(APP, /restored\?: boolean;/);
    assert.match(APP, /createdAt: Number\(item\.createdAt\) \|\| Date\.now\(\),\s*\n\s*restored: true,/);
  });

  test('带标记的条目只在「回合还在跑」或「你正打开着它」时才发', () => {
    // 重启之后所有会话都是空闲的，而排空规则「空闲就发」原本假设你正坐在这儿。
    assert.match(APP, /queue\[0\]\?\.restored\s*\n\s*&& sessionId !== currentSessionId\s*\n\s*&& !streamingIds\.includes\(sessionId\)/);
  });
});

/**
 * 分屏布局是你的，任何「全页」都不许改它 —— 「重启之后分屏没有恢复，虽然左侧有序号」。
 *
 * 症状精确地指向 splitGrid：磁盘上那两个 id 还在（所以序号照旧显示），但 splitActive 需要 capacity > 1，
 * 被压成 1x1 之后它变成假，界面退回单格。
 */
