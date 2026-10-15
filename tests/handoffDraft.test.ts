/**
 * 往输入框交接文本必须**取走一次就完** —— 「技术问题 这个会话反复把之前的提示词填入输入框」。
 *
 * ## 那是个一次性事件，被实现成了永不清空的状态
 *
 * 两处会把文本推回输入框：上一轮被打断（按停 / executor 中途死 / 看守狗打断哑掉的轮），
 * 以及你取消了一条排队中的消息。两处都是 `setState({ id: Date.now(), text, sessionId })`，
 * 而**全代码库没有一处清空它们**。于是那个 effect 每次输入框**挂载**都重放一遍：
 * 切回这条会话、进出分屏、布局变化。
 *
 * 实测那条会话只被打断过**一次**（日志里 `WEDGED … produced=true` 就一条），
 * 所以"反复"不是反复打断，是同一份状态被反复消费。
 *
 * 而且它比"烦"更严重：输入框本来有按会话保留的草稿（`composerDrafts`），挂载时那个 effect 会**盖掉**它。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { shouldApplyHandoff, consumeHandoff } from '../src/renderer/handoffDraft.ts';

const draft = (id: number, sessionId?: string) => ({ id, text: 't', ...(sessionId ? { sessionId } : null) });

describe('归属：一份交接只属于一条会话', () => {
  test('同一条会话才接', () => {
    assert.equal(shouldApplyHandoff(draft(1, 's_a'), 's_a'), true);
    assert.equal(shouldApplyHandoff(draft(1, 's_a'), 's_b'), false);
  });

  test('没有 sessionId 的任何框都接 —— 那是老调用点的行为，收紧会让它们静默失效', () => {
    assert.equal(shouldApplyHandoff(draft(1), 's_a'), true);
    assert.equal(shouldApplyHandoff(draft(1), null), true);
  });

  test('没有交接就不接', () => {
    assert.equal(shouldApplyHandoff(null, 's_a'), false);
    assert.equal(shouldApplyHandoff(undefined, 's_a'), false);
  });
});

describe('取走：按 id 认', () => {
  test('接走的那一份被清掉 —— 不清就会每次挂载重放', () => {
    assert.equal(consumeHandoff(draft(7, 's_a'), 7), null);
  });

  test('**迟到的清空不能抹掉更新的那份**', () => {
    /*
      分屏里同一条会话两个框都接了 id=7 并各自要求清掉；期间又来了一份新的 id=8。
      第二次清掉带的是 7，而当前是 8 —— 那份新的必须留下。
    */
    const newer = draft(8, 's_a');
    assert.equal(consumeHandoff(newer, 7), newer);
  });

  test('本来就空的清了还是空', () => {
    assert.equal(consumeHandoff(null, 7), null);
    assert.equal(consumeHandoff(undefined, 7), null);
  });
});

describe('接线：两处交接都接完就清', () => {
  const CHAT = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8',
  );
  const APP = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'App.tsx'), 'utf8',
  );
  const ACP = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'hooks', 'useAcp.ts'), 'utf8',
  );

  test('输入框接完就调 onConsume', () => {
    assert.match(CHAT, /onConsumeRestoredDraft\?\.\(restoredDraft!\.id\)/);
    assert.match(CHAT, /onConsumeRestoredInputDraft\?\.\(restoredInputDraft!\.id\)/);
  });

  test('归属判断只有一份实现 —— 原来两处各写一遍，其中一处的依赖里还漏了 sessionId', () => {
    assert.match(CHAT, /if \(!shouldApplyHandoff\(restoredDraft, sessionId\)\) return;/);
    assert.match(CHAT, /if \(!shouldApplyHandoff\(restoredInputDraft, sessionId\)\) return;/);
    assert.match(CHAT, /\}, \[restoredInputDraft, sessionId, onConsumeRestoredInputDraft\]\);/);
  });

  test('两个拥有者都真的清 —— 一处漏了就是那一处会反复回填', () => {
    assert.match(ACP, /setRestoredInputDraft\(\(cur\) => consumeHandoff\(cur, id\)\)/);
    assert.match(APP, /setRestoredQueueDraft\(\(cur\) => consumeHandoff\(cur, id\)\)/);
  });

  test('提示条上那句话仍然成立 —— 它明说了原文已填回输入框', () => {
    // 填回是设计好的，坏的只是"反复"。所以这条不能被改成"不填"
    // 文案走 i18n 了；中文在 i18n.ts 的字典里（由 tests/i18n.test.ts 钉住），
    // 这里钉住的是**那句话还在说这件事**。
    assert.match(CHAT, /The original text is back in the composer/);
  });
});
