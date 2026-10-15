import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readProject, writeProject, whyNotWorkspace, projectCwd } from '../src/main/projectStore.ts';

/**
 * project 的工作目录 —— 「这玩意加到 project 里面不就好了吗，为什么要加到 flow 里」。
 *
 * 目录是 project 的属性：一个 project 基本就是一个仓库，而 flow 是要在多个仓库上复用的**定义**
 * （目录一进定义，就得为每个仓库注册一份，指纹都变）。也不该是起跑输入：同一个 project 里这个答案
 * 永远一样，每次开跑都问一遍就是把常量做成必填项。
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kirolex-proj-'));

describe('读写', () => {
  test('写进去读出来是同一个', () => {
    writeProject(home, 'SFDC Activity', { workspace: '/tmp' });
    assert.equal(readProject(home, 'SFDC Activity').workspace, '/tmp');
  });

  test('没配过的 project 读出来是空 —— 行为完全不变（家目录）', () => {
    assert.deepEqual(readProject(home, '从没配过'), {});
    assert.equal(projectCwd(home, '从没配过'), home);
  });

  test('清空 = 回家目录', () => {
    writeProject(home, 'SFDC Activity', { workspace: '   ' });
    assert.equal(projectCwd(home, 'SFDC Activity'), home);
  });

  test('没有 project 名（散落会话）也回家目录', () => {
    assert.equal(projectCwd(home, ''), home);
    assert.equal(projectCwd(home, undefined), home);
  });

  test('文件落在这个 project 已有的目录里，和 runs/ 并排', () => {
    writeProject(home, 'SFDC Activity', { workspace: '/tmp' });
    assert.ok(fs.existsSync(path.join(home, '.kirolex', 'projects', 'SFDC Activity', 'project.json')));
  });
});

describe('设之前先说清为什么不能设', () => {
  test('相对路径不行 —— cwd 必须是确定的一个地方', () => {
    assert.match(String(whyNotWorkspace('src/renderer')), /绝对路径/);
  });

  test('不存在 / 不是目录都当场说', () => {
    assert.match(String(whyNotWorkspace('/definitely/not/here')), /不存在/);
    const f = path.join(home, 'afile'); fs.writeFileSync(f, 'x');
    assert.match(String(whyNotWorkspace(f)), /不是一个目录/);
  });

  test('空 = 家目录，是合法的', () => {
    assert.equal(whyNotWorkspace(''), null);
    assert.equal(whyNotWorkspace('   '), null);
  });
});
