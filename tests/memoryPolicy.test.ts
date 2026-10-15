import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  MEMORY_WARN_BYTES,
  memoryWarnings,
  formatMemoryBytes,
  compactMemoryPrompt,
} from '../src/main/memoryPolicy.ts';

const none = { global: 0, project: 0, session: 0 };

describe('三层各有自己的阈值，因为每字节的代价不同', () => {
  test('全局层的阈值最低 —— 它注入进每一个会话，同样一个字节被付的次数最多', () => {
    assert.ok(MEMORY_WARN_BYTES.global < MEMORY_WARN_BYTES.project);
  });

  test('会话层的阈值最低于全局 —— 它本来就有 MAX_CHARS=1200 的设计上限，超出即异常', () => {
    assert.ok(MEMORY_WARN_BYTES.session < MEMORY_WARN_BYTES.global);
  });

  test('正好等于阈值不报警，超出一个字节才报警', () => {
    assert.equal(memoryWarnings({ bytes: { ...none, global: MEMORY_WARN_BYTES.global } }).length, 0);
    assert.equal(memoryWarnings({ bytes: { ...none, global: MEMORY_WARN_BYTES.global + 1 } }).length, 1);
  });
});

describe('哪些层会报警', () => {
  test('没有 projectId，项目层多大都不报 —— 这条会话根本没有那一层', () => {
    const w = memoryWarnings({ bytes: { ...none, project: 999_999 } });
    assert.equal(w.length, 0);
  });

  test('没有 sessionId，会话层不报', () => {
    const w = memoryWarnings({ bytes: { ...none, session: 999_999 } });
    assert.equal(w.length, 0);
  });

  test('全局层不需要任何 id —— 它总是存在', () => {
    const w = memoryWarnings({ bytes: { ...none, global: 999_999 } });
    assert.deepEqual(w.map((x) => x.scope), ['global']);
  });

  test('三层同时超标时，顺序是 global → project → session，和注入的级联同序', () => {
    const w = memoryWarnings({
      projectId: 'Dev',
      sessionId: 's_1',
      bytes: { global: 999_999, project: 999_999, session: 999_999 },
    });
    assert.deepEqual(w.map((x) => x.scope), ['global', 'project', 'session']);
  });

  test('项目层的标签用项目名，另外两层用固定文案', () => {
    const w = memoryWarnings({
      projectId: 'Dev',
      sessionId: 's_1',
      bytes: { global: 999_999, project: 999_999, session: 999_999 },
    });
    assert.ok(w[1].label.includes('Dev'));
    assert.ok(w[0].label.length > 0 && !w[0].label.includes('Dev'));
  });

  test('清理到阈值以下，那一层就从列表里消失 —— 横幅会自己不见的依据', () => {
    const before = memoryWarnings({ projectId: 'Dev', bytes: { ...none, project: 82_234 } });
    const after = memoryWarnings({ projectId: 'Dev', bytes: { ...none, project: 3_000 } });
    assert.equal(before.length, 1);
    assert.equal(after.length, 0);
  });
});

describe('体积的显示', () => {
  test('用 KB，不给小数 —— 横幅只需要量级', () => {
    assert.equal(formatMemoryBytes(19_612), '19 KB');
    assert.equal(formatMemoryBytes(16 * 1024), '16 KB');
  });

  test('不足 1 KB 显示字节，不显示 0 KB', () => {
    assert.equal(formatMemoryBytes(814), '814 B');
    assert.equal(formatMemoryBytes(0), '0 B');
  });
});

describe('压缩用的固定提示词', () => {
  const p = compactMemoryPrompt({
    scope: 'project',
    filePath: '/Users/x/.kirolex/memory/projects/Dev/memory.md',
    bytes: 19_612,
  });

  test('带上要改的绝对路径 —— 否则模型得先猜文件在哪', () => {
    assert.ok(p.includes('/Users/x/.kirolex/memory/projects/Dev/memory.md'));
  });

  test('说清是合并去重而不是删减 —— 压缩记忆最大的风险是丢事实', () => {
    assert.ok(p.includes('不要删除任何仍然成立的事实'));
  });

  test('点名要保留原文的东西：路径、ID、命令、数字', () => {
    for (const kw of ['路径', 'ID', '命令', '数字']) assert.ok(p.includes(kw), kw);
  });

  test('三层的提示词都能生成，且各自说明自己是哪一层', () => {
    for (const scope of ['global', 'project', 'session'] as const) {
      const text = compactMemoryPrompt({ scope, filePath: '/tmp/memory.md', bytes: 9000 });
      assert.ok(text.includes('/tmp/memory.md'), scope);
      assert.ok(text.includes('不要删除任何仍然成立的事实'), scope);
    }
  });

  test('全局层的提示词要说明它影响所有会话 —— 压它的风险比压一个项目大', () => {
    const text = compactMemoryPrompt({ scope: 'global', filePath: '/tmp/g.md', bytes: 9000 });
    assert.ok(text.includes('所有会话'));
  });

  test('没有未填的占位符', () => {
    assert.ok(!/<[a-z_]+>|\{\{|TBD|TODO/i.test(p), p);
  });
});
