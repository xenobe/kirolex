import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldConsolidate, buildConsolidationPrompt, mergeSessionMemory, CONSOLIDATE_EVERY, MAX_CHARS,
} from '../src/main/sessionMemory.ts';

/**
 * 会话记忆的自动维护 —— 「你在 memory 里加一个 session memory」。
 *
 * 存储、分层注入（全局 ⊕ project ⊕ 会话）和那个编辑 tab 早就有了；缺的是**没人写这一层**——
 * 它是个手填文本框，而没人会在聊天中途停下来写笔记。这个模块管的就是「什么时候压、压出来怎么并」。
 */
describe('什么时候值得压一次', () => {
  test('攒够新消息才压 —— 一句「好」不值得一次模型调用', () => {
    assert.equal(shouldConsolidate({ messages: CONSOLIDATE_EVERY - 1 }), false);
    assert.equal(shouldConsolidate({ messages: CONSOLIDATE_EVERY }), true);
  });

  test('按「上次压到哪」算增量，不是按总数反复压', () => {
    assert.equal(shouldConsolidate({ messages: 20, consolidatedAt: 14 }), false);
    assert.equal(shouldConsolidate({ messages: 26, consolidatedAt: 14 }), true);
  });

  test('正在压的不重入 —— 两次并发写同一个文件只会写坏它', () => {
    assert.equal(shouldConsolidate({ messages: 99, consolidatedAt: 0, inFlight: true }), false);
  });

  test('脏数据不炸', () => {
    assert.equal(shouldConsolidate({ messages: NaN as any }), false);
    assert.equal(shouldConsolidate({ messages: 30, consolidatedAt: -5 }), true);
  });
});

describe('压出来的东西怎么并回去', () => {
  test('要求合并而不是重写 —— 最早定下的约束最不该被丢', () => {
    const prompt = buildConsolidationPrompt('User: 用 opus', '- 周报只统计客户侧活动');
    assert.match(prompt, /MERGE/);
    assert.match(prompt, /周报只统计客户侧活动/);
    assert.match(prompt, /at most 12 lines/);
  });

  test('没有旧笔记时明说没有，而不是塞一段空引用', () => {
    assert.match(buildConsolidationPrompt('User: x', '  '), /no note yet/);
  });

  test('模型什么都没给 → 保持原样，绝不把已有记忆清空', () => {
    assert.equal(mergeSessionMemory('- 旧的还在', ''), '- 旧的还在');
    assert.equal(mergeSessionMemory('- 旧的还在', '   \n  '), '- 旧的还在');
  });

  test('统一成一行一条，去掉模型自己加的符号', () => {
    assert.equal(mergeSessionMemory('', '* 用 opus\n- 只算客户侧\n\n• 路径是 ~/周报.md'),
      '- 用 opus\n- 只算客户侧\n- 路径是 ~/周报.md');
  });

  test('最多 12 行，而且不超过上限 —— 它每一轮都要被注入', () => {
    const many = Array.from({ length: 30 }, (_, i) => `第 ${i} 条`).join('\n');
    const out = mergeSessionMemory('', many);
    assert.equal(out.split('\n').length, 12);
    assert.ok(out.length <= MAX_CHARS);
  });

  test('超长时从后面截 —— 靠前的是更早定下的约束', () => {
    const long = Array.from({ length: 12 }, (_, i) => `${i} ${'长'.repeat(200)}`).join('\n');
    const out = mergeSessionMemory('', long, 300);
    assert.ok(out.length <= 300);
    assert.ok(out.startsWith('- 0 '), '第一条必须还在');
  });
});
