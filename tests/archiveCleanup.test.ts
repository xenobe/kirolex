import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 归档必须真的把一条会话停下来。三条规则，都来自同一次实测报告：
 * 「firehose 这个会话 archive 之后内容显示到 Run flow validation button visibility issue 里了，
 *   而且原先的 firehose 会话在 archive 中还显示为绿色」+「不知道为什么它又回到分屏了」。
 *
 * 都是 hook/组件里的接线，这个 runner 没有 DOM 也没有 React，所以钉的是源码结构而不是像素。
 */
const APP = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8');
const HOOK = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8');

describe('归档的会话不占分屏格子', () => {
  test('notForSplit 把 archived 算进去', () => {
    // `panes` 只过滤「这条会话还存在吗」，而归档只是写了 archived: true —— 所以归档过的那一格
    // 会继续渲染。判据必须在 notForSplit 里，因为清理 effect 是按它摘人的。
    const fn = APP.slice(APP.indexOf('const notForSplit = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, ['));
    assert.match(body, /session\?\.archived/,
      'notForSplit 必须把已归档的会话判为不进分屏');
  });

  test('清理 effect 仍然按 notForSplit 摘人', () => {
    assert.match(APP, /const keep = splitSessionIds\.filter\(\(id\) => !notForSplit\(id\)\);/);
  });
});

describe('归档当前会话时必须走 switchSession', () => {
  const fn = HOOK.slice(HOOK.indexOf('const archiveSession = useCallback'));
  const body = fn.slice(0, fn.indexOf('\n  }, ['));

  test('用 switchSession 切走，而不是直接设 id', () => {
    // 直接 setCurrentSessionId 会跳过 switchSession 开头那一步（把旧会话正在渲染的消息存进它自己的
    // paneView），于是 currentSessionId 已经换人、messages 还是旧的 —— renderPane 就把旧消息画在
    // 新会话标题下面。这就是那次串台。
    assert.match(body, /await switchSession\(next\.id\)/);
    assert.doesNotMatch(body, /setCurrentSessionId\(next\.id\)/,
      '直接设 id 会绕过 paneView 寄存这一步，串台就是这么来的');
  });

  test('找的是未归档的下一条会话', () => {
    assert.match(body, /sessions\.find\(\(s\) => s\.id !== sessionId && !s\.archived\)/);
  });
});

describe('归档的会话不许被自动恢复救回来', () => {
  test('auto-recovery 有 archived 守卫', () => {
    // 没有它：removeAttached 刚摘掉，disconnected 事件到达，这里又 loadSession + addAttached，
    // 于是侧栏那条还是绿的（只有 attached 才会绿），kiro-cli 进程也被重新拉起。
    const recover = HOOK.slice(HOOK.indexOf('AUTO-RECOVERY'));
    const body = recover.slice(0, recover.indexOf('addAttached(sid);'));
    assert.match(body, /if \(sessionsRef\.current\.find\(\(s\) => s\.id === sid\)\?\.archived\) return;/);
  });
});
