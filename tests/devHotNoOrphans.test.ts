import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 热重启不许漏下孤儿窗口。
 *
 * 实测过一次：连改几个 main 侧文件后桌面上同时躺着三个 KiroLex，其中两个 `ppid=1`（被 init 收养）
 * 跑着旧代码，调试端口还被最早那个占着 —— 于是「验证改动是否生效」验的是错的窗口。
 *
 * 成因：`electron` 这个 child 是 `node .bin/electron` **启动器**，真正的 Electron 是它的子进程。
 * SIGKILL 不可能被转发，所以只杀启动器 = 把 Electron 交给 init。dev-hot 日志里每一条
 * 「did not exit in 6s, forcing」就对应漏一个。
 */
const DEV_HOT = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'scripts', 'dev-hot.mjs'),
  'utf8',
);

describe('强杀走进程组', () => {
  test('electron 以 detached 启动 —— 不这样它就不是组长，负号 pid 无从下手', () => {
    assert.match(DEV_HOT, /bin\('electron'\), \['\.', '--dev'\], \{ detached: true \}/);
  });

  test('升级路径杀的是组，不是单个 child', () => {
    // 锚在**代码**上，不是散文上：注释里也提到了这句日志，`indexOf` 会先命中那里。
    const at = DEV_HOT.indexOf("log('electron', 'did not exit in 6s, forcing');");
    assert.ok(at > 0, '升级路径的日志行必须存在');
    const block = DEV_HOT.slice(at, at + 1200);
    assert.match(block, /process\.kill\(-pid, 'SIGKILL'\)/,
      '必须用负号 pid 覆盖启动器和它的后代');
    // 组杀失败要退回单杀，至少不比原来差
    assert.match(block, /if \(!groupKilled\)/);
  });

  test('优雅路径仍然是 SIGTERM，且理由还在', () => {
    // SIGKILL 会跳过 app.quit()，kiro-cli 的会话锁就留在那儿了 —— 这条不能被这次改动破坏。
    assert.match(DEV_HOT, /electron\.kill\('SIGTERM'\)/);
    assert.match(DEV_HOT, /RELEASES its session/);
  });
});

describe('退出路径也不许留下窗口', () => {
  test('shutdown 兜一层组杀 —— detached 的进程不会因为 dev-hot 退出而自己死', () => {
    const at = DEV_HOT.indexOf('function shutdown(');
    assert.ok(at > 0);
    const body = DEV_HOT.slice(at, DEV_HOT.indexOf('process.on(\'SIGINT\'', at));
    assert.match(body, /process\.kill\(-stray, 'SIGKILL'\)/);
    // 先 SIGTERM 让 main 正常收尾，只有还活着才升级
    assert.match(body, /child\.kill\('SIGTERM'\)/);
    assert.match(body, /process\.kill\(stray, 0\)/);
  });
});
