import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { concreteModels, shouldReplaceModelCache } from '../src/renderer/modelList.ts';
/* 这两个在下面几个 describe 里读源码用 —— 上一次裁测试时把 import 一起裁掉了（`fsSync is not defined`） */
import fsSync from 'node:fs';
import pathSync from 'node:path';

/** 实测抓到的两份 payload：一份是断网期间的退化结果，一份是正常结果。 */
const DEGRADED = [{ model_name: 'auto', model_id: 'auto', context_window_tokens: 200_000 }];
const GOOD = [
  { model_name: 'auto', model_id: 'auto', context_window_tokens: 1_000_000 },
  { model_name: 'claude-opus-5', model_id: 'claude-opus-5', context_window_tokens: 1_000_000 },
  { model_name: 'claude-sonnet-5', model_id: 'claude-sonnet-5', context_window_tokens: 1_000_000 },
];

describe('哪些是"具体模型"', () => {
  test('auto 不算 —— 它是路由器而不是一个可选的模型', () => {
    assert.deepEqual(concreteModels(DEGRADED), []);
    assert.deepEqual(concreteModels(GOOD).map((m) => m.model_id), ['claude-opus-5', 'claude-sonnet-5']);
  });

  test('缺字段或空列表不会炸', () => {
    assert.deepEqual(concreteModels([]), []);
    assert.deepEqual(concreteModels([{}, { model_id: '' }] as any), []);
  });
});

describe('好缓存不许被更差的结果覆盖', () => {
  test('退化结果（只剩 auto）遇上有具体模型的缓存 —— 拒绝覆盖', () => {
    // 这就是那次真实故障：缓存被写成只有 auto，之后网恢复也回不来，因为缓存是唯一回退来源。
    assert.equal(shouldReplaceModelCache(DEGRADED, GOOD), false);
  });

  test('空列表永远不许覆盖 —— 宁可显示旧的，也不要显示"没有模型"', () => {
    assert.equal(shouldReplaceModelCache([], GOOD), false);
    assert.equal(shouldReplaceModelCache([], DEGRADED), false);
    assert.equal(shouldReplaceModelCache([], []), false);
  });

  test('正常结果覆盖退化缓存 —— 这是自愈的那一步', () => {
    assert.equal(shouldReplaceModelCache(GOOD, DEGRADED), true);
  });

  test('缓存本来是空的，任何非空结果都收下 —— 首次启动不能因为这条规则而没有模型', () => {
    assert.equal(shouldReplaceModelCache(DEGRADED, []), true);
    assert.equal(shouldReplaceModelCache(GOOD, []), true);
  });

  test('两份都有具体模型时收下新的 —— 模型上下线是常事，不能永远钉住旧列表', () => {
    const fewer = [{ model_id: 'claude-opus-5', model_name: 'claude-opus-5' }];
    assert.equal(shouldReplaceModelCache(fewer, GOOD), true);
  });
});

/*
 * 「为什么现在新会话只能选 default agent 了」。
 *
 * 查下来是个不对称：模型列表拿不到时退回落盘缓存（`kirolex-models`），而 agent 列表只有一句
 * "保留上一次的（内存里那份）"—— 可**新挂载时没有"上一次"**（启动、窗口重载、开发时一次 HMR 都算）。
 * 于是那一次 `agent list` 超时（日志里 `timed out after 30000ms (killed)`；同一条命令在空闲 shell 里
 * 1.6 秒）就把下拉**永久**留在"只有 kiro_default"上 —— 永久，因为除了启动那次 warmup 没有东西会再拉。
 */
describe('agent 列表也要落盘，而且拉不到会重试', () => {
  const read = (p: string) => fsSync.readFileSync(pathSync.join(process.cwd(), p), 'utf8');
  const APP2 = read('src/renderer/App.tsx');
  const ML = read('src/renderer/modelList.ts');

  test('键和模型那份对称，摆在一起', () => {
    assert.match(ML, /export const AGENTS_CACHE_KEY = 'kirolex-agents';/);
    assert.match(APP2, /AGENTS_CACHE_KEY/);
  });

  test('**初值从缓存来** —— 那正是"新挂载没有上一次"这个洞', () => {
    assert.match(APP2, /const cached = JSON\.parse\(uiGet\(AGENTS_CACHE_KEY\) \|\| '\[\]'\);/);
    assert.match(APP2, /return Array\.isArray\(cached\) \? cached : \[\];/);
  });

  test('拿到就落盘；空列表一律不收（那是"拿不到"，不是"没有"）', () => {
    const fn = APP2.slice(APP2.indexOf('const refreshAgents = useCallback'));
    const body = fn.slice(0, fn.indexOf('}, []);'));
    assert.match(body, /if \(!data\?\.agents\?\.length\) return;/);
    assert.match(body, /uiSet\(AGENTS_CACHE_KEY, JSON\.stringify\(data\.agents\)\)/);
  });

  test('**空了才重试** —— 不无条件跟着 focus 拉（每次都要 spawn 一个 kiro-cli）', () => {
    const at = APP2.indexOf('if (kiroAgents.length) return;');
    assert.ok(at > 0, '有这道早退才叫"只在空的时候拉"');
    const body = APP2.slice(at, at + 500);
    assert.match(body, /window\.addEventListener\('focus', again\)/);
    assert.match(body, /void refreshAgents\(\)/);
  });

  test('warmup 那一处也走同一条路 —— 不再各写一遍', () => {
    assert.match(APP2, /void refreshAgents\(\);/);
    assert.doesNotMatch(APP2, /listKiroAgents\(\)\.then/);
  });
});
