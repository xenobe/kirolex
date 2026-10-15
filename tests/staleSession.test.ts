import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { staleVerdict, isBareInternalError, staleRecoveryNote, POISONED_AFTER, RECREATE_COOLDOWN_MS } from '../src/main/staleSession.ts';

const base = { error: 'Internal error', contextPid: 54799, clientPid: 18444, alreadyRetried: false };

/**
 * 「`Internal error — Kiro failed to generate a response` 发生了什么？」
 *
 * ## 先排除模型
 *
 * 我拿 `kiro-cli chat --model X` 一个个试过：`claude-opus-5` / `claude-opus-4.8` / `claude-sonnet-5` /
 * `gpt-5.6-sol` **四个全都正常应答**（opus-5 用了 5 秒、0.35 credits）。所以日志里那句
 * `'claude-opus-X' unavailable at prompt time` 说的不是模型退役 —— 我据此改过默认模型，那是个错误。
 *
 * ## 真正的形状
 *
 * 那条会话带的 `cliSessionId` 是 8 小时前建的，记录里 `contextEstablishedPid = 54799`，
 * 而当时服务它的是新起的 pid 18444。kiro-cli **不持久化 ACP 会话**：`session/load(旧 id)` 会答 OK，
 * 真发一轮却服务不了，回的是笼统的 `-32603 Internal error`，一个字都不提"这个会话我不认识"。
 */
describe('会话 id 对当前进程过期了要能自愈', () => {
  test('pid 不一致 + Internal error → 换新会话', () => {
    assert.equal(staleVerdict(base), 'recreate');
  });

  test('**pid 一致就不重建** —— 那时后端里真有这份历史，重建等于把它丢掉', () => {
    /* `Internal error` 是 kiro-cli 的万能错误（并发 prompt、锁、真异常都用它），不能只看文本 */
    assert.equal(staleVerdict({ ...base, contextPid: 18444 }), 'report');
  });

  test('只重建一次 —— 否则一个真的后端异常会变成循环', () => {
    assert.equal(staleVerdict({ ...base, alreadyRetried: true }), 'report');
  });

  test('别的错误一概不动 —— 判据要窄', () => {
    for (const e of ['rate limit exceeded', 'model unavailable', 'timed out', '']) {
      assert.equal(staleVerdict({ ...base, error: e }), 'report', e);
    }
  });

  test('"上一回合仍在运行"不算 —— 那是活的，不是坏的', () => {
    /* 这一条要是判成重建，就会把一轮正在跑的对话连根拔掉 */
    assert.equal(isBareInternalError('Internal error — prompt already in progress'), false);
    assert.equal(staleVerdict({ ...base, error: 'Internal error: prompt already in progress' }), 'report');
  });

  test('pid 缺一个就不下结论 —— 没依据的判断比不判断糟', () => {
    /* `contextPid` 缺 = 上下文从来没建立过（那是"欠着重建"那条路的事）；`clientPid` 缺 = 连不上进程 */
    assert.equal(staleVerdict({ ...base, contextPid: undefined }), 'report');
    assert.equal(staleVerdict({ ...base, clientPid: undefined }), 'report');
  });

  test('那句说明要讲清换了什么、为什么、有没有丢东西', () => {
    const note = staleRecoveryNote('2281ac87-c452-445a', 'aaaabbbb-cccc-dddd', 54799, 18444);
    assert.match(note, /2281ac87/);
    assert.match(note, /54799/);
    assert.match(note, /18444/);
    assert.match(note, /不持久化/, '要说清为什么会这样');
    assert.match(note, /一条都没动/, '不说清有没有丢数据，人只会以为对话没了');
  });
});

describe('接线', () => {
  const MAIN = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('判据接在 prompt 的 catch 里，用的是记录里的 pid 和当前 client 的 pid', () => {
    assert.match(MAIN, /const verdict = staleVerdict\(\{/);
    assert.match(MAIN, /contextPid: store\.readRecord\(sessionId\)\?\.contextEstablishedPid/);
    assert.match(MAIN, /clientPid: entry\.client\.pid/);
  });

  test('重建之后**清掉"已建立"并欠上一次重建** —— 新会话里什么都没有', () => {
    /* 不清的话下一轮会以为后端还记得之前的对话，然后自信地答错 */
    const at = MAIN.indexOf("if (verdict === 'recreate')");
    assert.ok(at > 0);
    const body = MAIN.slice(at, at + 1500);
    assert.match(body, /clearContextEstablished\(sessionId\)/);
    assert.match(body, /markContextOwedIfUnverified\(sessionId, 'stale-session-recreate'\)/);
    assert.match(body, /rec2\.cliSessionId = made\.sessionId/, '新 id 要落盘，否则重启又回到旧的');
  });

  test('重试次数用参数传下去（计数），而不是靠外面的循环', () => {
    assert.match(MAIN, /sendPromptOnce\(sessionId, prompt, projectId, display, _model, attempt \+ 1\)/);
    assert.match(MAIN, /_model\?: string, attempt = 0\)/);
  });

  test('重建自己失败了也要说出来，不能把原始错误吞掉', () => {
    assert.match(MAIN, /stale recreate FAILED/);
    const at = MAIN.indexOf('stale recreate FAILED');
    /* 重建失败时 `made` 留成 null —— 下面那两条"重发"都要求 `made`，所以它落到最后照旧抛原始错误 */
    assert.match(MAIN.slice(at, at + 200), /made = null;/);
    assert.match(MAIN.slice(at), /throw err;/, '原来那个错误照旧抛出去');
  });
});

/*
 * 「⚠️ …'acp:prompt': Error: Internal error — Encountered an error in the response stream:
 * An unknown error occurred: dispatch failure」。
 *
 * `dispatch failure` 是 AWS SDK 在**连不上**时给的（DNS / TLS / 连接被掐）—— 不是模型问题，也不是
 * 会话坏了。实测一条会话上 9 次、其中 6 次挤在 20 秒内：网络抖了一下，而每次都把原话甩给你、
 * 也不自己重试。
 */
describe('传输层瞬时错误：自己重发', () => {
  const T = fs.readFileSync(path.join(process.cwd(), 'src/main/transientError.ts'), 'utf8');
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('判据只认明确的传输层特征 —— `Internal error` 是万能错误，不能当可重试', () => {
    assert.match(T, /export function isTransientTransportError\(text: string\): boolean/);
    assert.match(T, /dispatch failure/i);
    assert.match(T, /ECONNRESET\|ETIMEDOUT\|ENOTFOUND\|EAI_AGAIN\|EPIPE/);
  });

  test('判据是**纯**模块，不在 index.ts 里 —— 重试判据要 import 它，而 index 里有 electron', () => {
    assert.match(M, /import \{ isTransientTransportError as isTransientTransportErrorImpl \} from '\.\/transientError\.ts';/);
  });

  test('重试预算用光时说清是网络问题，而不是再甩一遍原话', () => {
    const at = M.indexOf("if (plan.reason === 'budget')");
    assert.ok(at > 0);
    const body = M.slice(at, at + 700);
    assert.match(body, /连不上后端/);
    assert.match(body, /检查网络\/VPN 后再发一次/);
  });
});

/*
 * 「无法继续执行，总是断」。
 *
 * 实测那条会话：一次 `write` 工具失败之后，每一次发送都回
 * `Internal error — Kiro failed to generate a response`，8 秒一次、连着 6 次，而 **pid 从头到尾没变**。
 * 也就是说这段对话在**后端侧**坏了（历史里有它咽不下去的东西），而每次请求都会把同一段历史重放，
 * 所以换模型、重连、重发全都没用。
 *
 * 而原来的重建判据只认"pid 不一致"—— 这种"进程没换但对话已经毒了"的情况**永远不触发**，
 * 那条会话就此彻底卡死，只能靠人手动复制会话。
 */
describe('同一段后端对话连着坏两次 = 毒了，要重建', () => {
  const base = { error: 'Internal error — Kiro failed to generate a response', alreadyRetried: false };

  test('pid 一致 + 连着两次 → 重建（原来这里一定是 report）', () => {
    assert.equal(staleVerdict({ ...base, contextPid: 100, clientPid: 100, consecutiveFailures: 2 }), 'recreate');
  });

  test('**只坏一次不算** —— 单次 Internal error 太常见（并发、锁、一时抖动）', () => {
    /* 为一次抖动重建会把后端里真实存在的那段历史换掉 */
    assert.equal(staleVerdict({ ...base, contextPid: 100, clientPid: 100, consecutiveFailures: 1 }), 'report');
  });

  test('阈值是个常量，不是散在调用点的魔法数字', () => {
    assert.equal(POISONED_AFTER, 2);
  });

  test('不是 Internal error 的照旧不重建 —— 判据没被放宽', () => {
    assert.equal(staleVerdict({
      error: 'prompt already in progress', contextPid: 1, clientPid: 2,
      alreadyRetried: false, consecutiveFailures: 5,
    }), 'report');
  });

  test('重试预算用光就不再重建 —— 否则一个真异常会变成循环', () => {
    assert.equal(staleVerdict({ ...base, alreadyRetried: true, consecutiveFailures: 9 }), 'report');
  });

  /* 「你难道不能让它自动重试吗，挂了你他妈也不管啊」—— 实测要换三个后端会话才通，
     所以这个上限不能是"一次"，而是自动重试的预算。 */
  test('接线上给的是**预算**而不是"重建过没有"', () => {
    const M2 = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M2, /alreadyRetried: attempt >= MAX_AUTO_RETRIES,/);
  });
});

describe('接线：失败计数按后端 session 记，成功就清零', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('键是 `cliSessionId` —— 重建会换掉它，计数自然从零开始', () => {
    assert.match(M, /const cliFailStreak = new Map<string, number>\(\);/);
    assert.match(M, /const failKey = entry\.cliSessionId \|\| '';/);
  });

  test('成功一轮清零 —— 连续性是这个判据的全部内容', () => {
    assert.match(M, /if \(entry\.cliSessionId\) cliFailStreak\.delete\(entry\.cliSessionId\);/);
  });

  test('毒了那条路要**在会话里说一句** —— 否则"前几条都失败、这一条突然成了"没人解释得了', () => {
    assert.match(M, /if \(poisoned\) \{\s*\n\s*noteInSession\(sessionId, `♻️ \$\{note\}`\);/);
    /* pid 不一致那条是常规现象，不播报 —— 每次都说只会变成噪音 */
    assert.match(M, /只在"毒了"这条路上说/);
  });
});

/*
 * 「我他妈说的是最近那几次 workshop 的」。
 *
 * 查到底：那几次不是这条对话的问题。证据在 kiro-cli 自己存的会话状态
 * （~/.kiro/sessions/cli/<id>.json{,l}）里 ——
 *   旧会话（连失败 4 次）386 条 / 上下文 29.17%
 *   新建 #1（又失败 2 次）34 条 /  3.85%   ← 几乎空的，照样失败
 *   新建 #2（又失败 2 次）14 条 /  3.82%   ← 更空，照样失败
 *   新建 #3（07:56 起成功）82 条 /  9.11%  ← 最满的那个反而好了
 * 失败按时间聚堆：07:30–07:54 十三失败一成功，07:55 之后九成功一失败；
 * kiro-cli 日志里全是 `err=EmptyResponse`。换会话对这种故障没用。
 */
describe('刚换过后端会话又是同一个错 → 别再换', () => {
  const poisoned = {
    error: 'Internal error — Kiro failed to generate a response',
    contextPid: 100, clientPid: 100, alreadyRetried: false, consecutiveFailures: 5,
  };

  test('冷却期内不再重建 —— 换出来的新会话几乎是空的，再换也一样', () => {
    assert.equal(staleVerdict({ ...poisoned, lastRecreateAgoMs: 1000 }), 'report');
  });

  test('冷却期过了照旧可以重建 —— 这条闸只挡"刚刚才换过"', () => {
    assert.equal(staleVerdict({ ...poisoned, lastRecreateAgoMs: RECREATE_COOLDOWN_MS + 1 }), 'recreate');
  });

  test('从来没换过（undefined）不受影响', () => {
    assert.equal(staleVerdict(poisoned), 'recreate');
  });

  test('冷却时长是常量，不是散在调用点的魔法数字', () => {
    assert.equal(RECREATE_COOLDOWN_MS, 300_000);
  });

  test('接线：换会话时记时间，判据里换算成"多久以前"', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /cliRecreatedAt\.set\(sessionId, Date\.now\(\)\);/);
    assert.match(M, /lastRecreateAgoMs: cliRecreatedAt\.has\(sessionId\)/);
  });
});
