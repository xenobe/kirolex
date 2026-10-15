import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  writeFailureBundle, prunable, bundleRoot, KEEP_PER_SESSION, COOLDOWN_MS, _resetCooldown,
} from '../src/main/failureBundle.ts';

/*
 * 「这个问题很严重必须修好」+「是我后来换成 kiro-cli 才好了」。
 *
 * 同一时间、同一模型，kiro-cli 里好的、KiroLex 里不好 —— 那两边的请求就有差别，而 KiroLex 手里
 * 只有一句 `Internal error`（请求体是 kiro-cli 拼的）。故障又不能按需复现：那 25 分钟过去之后，
 * 同样的 ACP 路径 + opus-5 + 16KB 注入一次就过。所以失败当场把现场落盘，下次对着差异看。
 */
function fixture(): { home: string; cliLog: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-home-'));
  const cliLog = path.join(home, 'kiro-chat.log');
  fs.writeFileSync(cliLog, 'ERROR agent::agent: response stream encountered an error err=EmptyResponse\n');
  return { home, cliLog };
}

describe('失败现场存档', () => {
  test('四样东西都在：发出去的原文、kiro-cli 自己的会话、它的日志、元信息', () => {
    _resetCooldown();
    const { home, cliLog } = fixture();
    /* kiro-cli 存的那份会话（这次才发现它是存盘的） */
    const cliDir = path.join(home, '.kiro', 'sessions', 'cli');
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, 'abc.json'), '{"session_state":{"rts_model_state":{"context_usage_percentage":3.82}}}');
    fs.writeFileSync(path.join(cliDir, 'abc.jsonl'), '{"kind":"Prompt"}\n{"kind":"AssistantMessage"}\n');

    const dir = writeFailureBundle({
      sessionId: 's_1', cliSessionId: 'abc', promptText: '快照 + memory + 我的问题',
      error: 'Internal error — Kiro failed to generate a response',
      model: 'claude-opus-5', pid: 31257, toolsThisTurn: 13, maxToolOutput: 42000,
      cliLogPath: cliLog, home,
    });
    assert.ok(dir, '应该落盘');
    const got = fs.readdirSync(dir!).sort();
    assert.deepEqual(got, ['cli-session.json', 'cli-session.jsonl', 'kiro-log.txt', 'meta.json', 'prompt.txt']);
    assert.equal(fs.readFileSync(path.join(dir!, 'prompt.txt'), 'utf8'), '快照 + memory + 我的问题');
    const meta = JSON.parse(fs.readFileSync(path.join(dir!, 'meta.json'), 'utf8'));
    assert.equal(meta.model, 'claude-opus-5');
    assert.equal(meta.toolsThisTurn, 13);
    assert.equal(meta.promptChars, '快照 + memory + 我的问题'.length);
    assert.match(fs.readFileSync(path.join(dir!, 'kiro-log.txt'), 'utf8'), /EmptyResponse/);
    /* 上下文占用是这次定案的关键证据（3.82% 的新会话照样失败），所以那份状态必须原样带上 */
    assert.match(fs.readFileSync(path.join(dir!, 'cli-session.json'), 'utf8'), /context_usage_percentage/);
  });

  test('缺文件不报错 —— 诊断永远不能让发送失败', () => {
    _resetCooldown();
    const { home } = fixture();
    const dir = writeFailureBundle({
      sessionId: 's_2', cliSessionId: 'nope', promptText: 'x', error: 'e',
      cliLogPath: '/nope/kiro.log', home,
    });
    assert.ok(dir);
    assert.deepEqual(fs.readdirSync(dir!).sort(), ['meta.json', 'prompt.txt']);
  });

  test('同一条会话冷却期内不重复落盘 —— 连着失败 6 次不该写 6 份一样的', () => {
    _resetCooldown();
    const { home, cliLog } = fixture();
    const a = writeFailureBundle({ sessionId: 's_3', promptText: 'x', error: 'e', cliLogPath: cliLog, home, now: 1_000_000 });
    const b = writeFailureBundle({ sessionId: 's_3', promptText: 'x', error: 'e', cliLogPath: cliLog, home, now: 1_000_000 + COOLDOWN_MS - 1 });
    const c = writeFailureBundle({ sessionId: 's_3', promptText: 'x', error: 'e', cliLogPath: cliLog, home, now: 1_000_000 + COOLDOWN_MS + 1 });
    assert.ok(a); assert.equal(b, null); assert.ok(c);
  });

  test('每条会话只留最近几包', () => {
    const dirs = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07'];
    assert.deepEqual(prunable(dirs, 5), ['2026-01-01', '2026-01-02']);
    assert.deepEqual(prunable(dirs.slice(0, 3), 5), []);
    assert.equal(KEEP_PER_SESSION, 5);
  });

  test('落在 ~/.kirolex/failures 下，按会话分目录', () => {
    assert.equal(bundleRoot('/h'), path.join('/h', '.kirolex', 'failures'));
  });
});

describe('接线（src/main/index.ts）', () => {
  const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');

  test('发送失败时落一包，并把路径写进日志', () => {
    assert.match(M, /const bundle = writeFailureBundle\(\{/);
    assert.match(M, /失败现场已存档/);
  });

  test('存的是**这一轮实际发出去的**文本（含随行快照 + memory）', () => {
    const at = M.indexOf('const bundle = writeFailureBundle({');
    assert.match(M.slice(at, at + 600), /promptText: \(prompt \|\| \[\]\)\.map/);
  });
});

/*
 * 「这个问题很严重必须修好」—— 唯一还没拿到的证据是 HTTP 层的（请求 id、状态、响应头）。
 * 实测 `KIRO_LOG_LEVEL=trace` 之后 kiro-cli 会把整条 GenerateAssistantResponse 的往返记下来，
 * 所以留一个默认关的开关；开着的时候日志涨得极快，存档要多抄一段。
 */
describe('kiro-cli trace 开关（默认关）', () => {
  test('环境变量或 ~/.kirolex/kiro-trace 文件都能开，默认是关的', async () => {
    const { kiroTraceEnabled } = await import('../src/main/acp-client.ts');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-'));
    assert.equal(kiroTraceEnabled({} as any, home), false);
    assert.equal(kiroTraceEnabled({ KIROLEX_KIRO_TRACE: '1' } as any, home), true);
    fs.mkdirSync(path.join(home, '.kirolex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kirolex', 'kiro-trace'), '');
    assert.equal(kiroTraceEnabled({} as any, home), true);
  });

  test('起执行器时才把 KIRO_LOG_LEVEL 塞进去，不污染 KiroLex 自己的环境', async () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/main/acp-client.ts'), 'utf8');
    assert.match(src, /const env = \{ \.\.\.this\.env \};\s*\n\s*if \(kiroTraceEnabled\(\)\) env\.KIRO_LOG_LEVEL = 'trace';/);
  });

  test('开着 trace 时存档多抄日志 —— 512KB 可能只盖住一秒', () => {
    const M = fs.readFileSync(path.join(process.cwd(), 'src/main/index.ts'), 'utf8');
    assert.match(M, /cliLogTailBytes: kiroTraceEnabled\(\) \? 8 \* 1024 \* 1024 : undefined,/);
  });
});
