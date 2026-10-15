/**
 * 清空上下文之后，界面不该还摆着一堆模型已经不记得的消息 ——
 * 「技术问题 这个会话 clear 了之后再打开还有历史会话呢」。
 *
 * ## 那件事本身是设计好的，坏的是它不可见
 *
 * `/clear` 是后端斜杠命令：它重置**模型的活动上下文**，而 transcript 是 KiroLex 自己的持久记录
 * （审计链，也是重启后重建上下文的唯一依据），所以刻意不动。侧栏那条「清除历史」正因此被删掉 ——
 * 它同时删 transcript 又发一个隐藏的 `/clear`，从右键菜单做这件事不可逆，而重置后端上下文
 * 本来就是用户自己那条 `/clear` 在做的事。
 *
 * 实测那条会话：transcript 185 条，#183 是 `/clear`、#184 是后端回的 `Conversation cleared`。
 * 重新打开时界面上摆着 183 条模型已经不记得的消息，而界面上一个字都没说 ——
 * **你看到的和模型知道的不是同一份东西**，这比两个极端都糟。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isClearCommand, sinceLastClear, clearNoteText } from '../src/renderer/clearBoundary.ts';

const u = (content: string) => ({ role: 'user', content });
const a = (content: string) => ({ role: 'assistant', content });

describe('判据：用户自己那条 /clear', () => {
  test('整条就是那个命令才算', () => {
    assert.equal(isClearCommand(u('/clear')), true);
    assert.equal(isClearCommand(u('  /clear  ')), true, '前后空白不该让它失效');
  });

  test('提到它不等于做了它', () => {
    assert.equal(isClearCommand(u('我刚才 /clear 了一下')), false);
    assert.equal(isClearCommand(u('/clearhistory')), false);
  });

  test('**不认后端那句 `Conversation cleared`** —— 那是英文的、由后端措辞决定', () => {
    // 哪天后端换个说法，按它判就会静默失效；而 `/clear` 是用户敲的，也是这套机制唯一的入口
    assert.equal(isClearCommand(a('Conversation cleared\n')), false);
  });

  test('脏输入不炸', () => {
    assert.equal(isClearCommand(undefined), false);
    assert.equal(isClearCommand({ role: 'user' }), false);
    assert.equal(isClearCommand({ role: 'user', content: 123 as any }), false);
  });
});

describe('最后一次清空之后还剩几条', () => {
  test('从末尾数，而且**清空那条自己算在里面** —— 它是要在原位画出来的那条线', () => {
    const msgs = [u('a'), a('b'), u('/clear'), a('Conversation cleared'), u('c')];
    assert.equal(sinceLastClear(msgs), 3);
  });

  test('只认**最后**那一次 —— 清空过两回，早先那次不该再当边界', () => {
    const msgs = [u('/clear'), a('x'), u('one'), a('y'), u('/clear'), a('z')];
    assert.equal(sinceLastClear(msgs), 2);
  });

  test('没清空过返回 undefined —— 不是 0（那会被读成"一条都不显示"）也不是全长', () => {
    assert.equal(sinceLastClear([u('a'), a('b')]), undefined);
    assert.equal(sinceLastClear([]), undefined);
    assert.equal(sinceLastClear(undefined), undefined);
  });
});

describe('那条线上写什么', () => {
  test('两件事都要说：上面的不记得了、记录还在', () => {
    const text = clearNoteText(64);
    assert.match(text, /上下文已清空/);
    assert.match(text, /上面 64 条模型不再记得/, '不说这句，你会以为它还记得');
    assert.match(text, /记录仍然保留/, '不说这句，你会以为清空把历史弄丢了');
  });

  test('一条都没被折叠时也能读', () => {
    assert.match(clearNoteText(0), /上面的内容模型不再记得/);
  });
});

describe('接进了聊天区', () => {
  const CHAT = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8',
  );
  const CSS = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'renderer', 'styles', 'global.css'), 'utf8',
  );

  test('默认窗口收到清空那条之后', () => {
    assert.match(CHAT, /const afterClear = sinceLastClear\(orderedMessages as any\)/);
    /*
      窗口现在还多一层：**这一格的搜索条开着就整开**（搜索只搜已渲染的 DOM，窗口挡住的就是搜不到的）。
      清空边界那条收窄也一起让开 —— 否则清空过的会话搜不到清空之前的内容，实测搜 `Cognito` 得到「无结果」。

      判据是 `expandForFind`（= 这一格自己的 `findOpen`），不再是窗口级那个 `searchOpen`：
      搜索条搬进每一格之后，只有真的在搜的那一格需要付「挂完整棵树」的代价。
    */
    assert.match(CHAT, /const expandForFind = findOpen \|\| !!searchOpen;/);
    assert.match(CHAT, /expandForFind\s*\n?\s*\? renderGroups\.length/);
    assert.match(CHAT, /groupsSinceClear > 0 \? Math\.min\(renderLimit, groupsSinceClear\) : renderLimit/);
  });

  test('更早的用**现成的**分页按钮取回 —— 记录一条没少', () => {
    const at = CHAT.indexOf('const visibleGroups = renderGroups.length > windowSize');
    assert.ok(at > 0, '窗口没有按 windowSize 切');
    assert.match(CHAT, /加载更早的消息（还有 \{hiddenGroupCount\} 组）/);
  });

  test('清空那条画成分界线，不画成用户气泡', () => {
    // 一个写着 `/clear` 的气泡说不出「上面的模型不记得了」，而那是这条消息在这一页上唯一的意义
    assert.match(CHAT, /group\.kind === 'user' && isClearCommand\(\(group as any\)\.base\) \?/);
    assert.match(CHAT, /className="chat-clear-line"/);
    assert.match(CHAT, /clearNoteText\(hiddenGroupCount\)/);
  });

  test('找不到那一组就退回不干预 —— 它可能被合并进了别人', () => {
    assert.match(CHAT, /clearedGroupIndex >= 0 \? renderGroups\.length - clearedGroupIndex : 0/);
  });

  test('有样式', () => {
    assert.match(CSS, /\.chat-clear-line \{/);
  });
});
