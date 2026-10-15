import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * unassigned 会话必须被告知**有哪些项目、路径是什么**，否则它只能猜。
 *
 * 实测的落空：一条 unassigned 会话按 global.md 的规则「能判断归属就直接写目标项目文件」去写记忆，
 * 猜了 `Kirolex`，而真实项目叫 `Dev`；`memory/projects/Kirolex/` 不存在，内容落空，而它在回复里说
 * 「记忆已更新」。同期 20 条 unassigned 会话里 9 条的 session 记忆还是 24 字节空壳。
 *
 * `memory.ts` 在模块加载时就从 `os.homedir()` 算出 baseDir，所以这里在**子进程**里跑，把 HOME 指到
 * 临时目录 —— 既能测真实的磁盘行为，又不会在用户的 `~/.kirolex` 里留下探针垃圾。
 */
const here = path.dirname(new URL(import.meta.url).pathname);
let home = '';

function inject(projectId: string | undefined, sessionId: string): string {
  const script = `
    const m = await import(${JSON.stringify(path.join(here, '..', 'src', 'main', 'memory.ts'))});
    process.stdout.write(m.buildMemoryInjection(${projectId === undefined ? 'undefined' : JSON.stringify(projectId)}, ${JSON.stringify(sessionId)}) || '');
  `;
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf-8',
    env: { ...process.env, HOME: home },
  });
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-mem-'));
  for (const name of ['Dev', 'Research', 'SFDC Activity']) {
    fs.mkdirSync(path.join(home, '.kirolex', 'memory', 'projects', name), { recursive: true });
  }
});

after(() => {
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
});

describe('unassigned 会话的注入块', () => {
  test('列出现有项目的真实名字，而不是让它猜', () => {
    const out = inject(undefined, 's_probe');
    assert.match(out, /NOT ASSIGNED TO A PROJECT/);
    for (const name of ['Dev', 'Research', 'SFDC Activity']) {
      assert.ok(out.includes(name), `应该列出 ${name}`);
    }
  });

  test('给的是确切路径 —— 猜错名字就是因为之前没人给过路径', () => {
    const out = inject(undefined, 's_probe');
    assert.match(out, /projects\/Dev\/memory\.md/);
    // 带空格的项目名也要原样给出，不能被截断
    assert.match(out, /projects\/SFDC Activity\/memory\.md/);
  });

  test('明说都不匹配时只写 session 层，并禁止新建目录', () => {
    const out = inject(undefined, 's_probe');
    assert.match(out, /都不匹配就只写/);
    // 新建的目录 KiroLex 永远不会读，等于又落空一次
    assert.match(out, /不要新建项目目录/);
  });

  test('已归属项目的会话不出现这一段 —— 它有自己的项目层', () => {
    const out = inject('Dev', 's_probe');
    assert.doesNotMatch(out, /NOT ASSIGNED TO A PROJECT/);
    assert.match(out, /=== PROJECT "Dev"/);
  });

  test('一个项目都没有时说人话，不是空清单', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-mem-empty-'));
    const saved = home;
    home = empty;
    try {
      const out = inject(undefined, 's_probe');
      assert.match(out, /no project memory exists yet/);
      assert.doesNotMatch(out, /NOT ASSIGNED TO A PROJECT — 可选的项目层/);
    } finally {
      home = saved;
      try { fs.rmSync(empty, { recursive: true, force: true }); } catch {}
    }
  });
});
