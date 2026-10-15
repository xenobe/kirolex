import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STORE = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'main', 'sessionStore.ts'), 'utf8');

describe('会话 id 得校验形状', () => {
  test('落盘的唯一入口上校验 —— 裸 path.join 能写出 sessions 目录', () => {
    /*
      实测撞出来一个：一次调用把 cwd 传成了 id（参数顺序错了一位），磁盘上多了
      `sessions/Users/keyinan/work/record.json` —— 一条 app 永远看不见、清扫也永远碰不到的会话。
      参数错一位这种事一定会再发生，而它的代价不该是"往任意路径写文件"。
    */
    assert.match(STORE, /const ID_SHAPE = \/\^\[A-Za-z0-9_-\]\{1,120\}\$\//);
    assert.match(STORE, /function dirFor\(id: string\): string \{\s*\n\s*return path\.join\(baseDir, safeId\(id\)\);/);
    assert.doesNotMatch(STORE, /return path\.join\(baseDir, id\);/);
  });

  test('形状本身：斜杠、点点、空串都不通过', () => {
    const shape = /^[A-Za-z0-9_-]{1,120}$/;
    for (const bad of ['/Users/keyinan/work', '../escape', 'a/b', '', ' ', 'a b', 'x/../y', 'a.json']) {
      assert.equal(shape.test(bad), false, `应该拒绝：${JSON.stringify(bad)}`);
    }
    for (const good of ['s_1787305534532_s2axt7', 's_probe_1', 'abc-DEF_123']) {
      assert.equal(shape.test(good), true, `应该接受：${good}`);
    }
  });

  test('报错要带上那个 id —— 参数错位时你得看得出传进去的是什么', () => {
    assert.match(STORE, /会话 id 不合法：/);
    assert.match(STORE, /JSON\.stringify\(s\.slice\(0, 80\)\)/);
  });
});
