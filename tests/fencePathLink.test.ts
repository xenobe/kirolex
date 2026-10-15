/**
 * 围栏里单独一条路径要能点开 —— 「我在技术问题这个会话中发现 …md 无法直接超链接打开，为什么」。
 *
 * ## 当时的形状
 *
 * 模型很爱这么写：
 *
 *     已写到：
 *     ```text
 *     /Users/keyinan/Downloads/devops-agent-rds-诊断配置指南.md
 *     ```
 *
 * 而链接化原来只发生在两处 —— **行内代码**（`code` 渲染器 + `FILE_TOKEN_RE`）和**散文里的裸路径**
 * （`remarkLinkifyPaths`）。围栏两处都不走，而且大部分时候这是对的：围栏里常常是一整段脚本，
 * 把里面每个路径都染蓝会把代码变成一片链接。
 *
 * 排查时先验掉了两个更可疑的嫌疑人（含中文的路径、`~/Downloads` 的 TCC 权限），两个都是好的：
 * `FILE_TOKEN_RE` 匹配那条含中文的路径，主进程 `pathExists` 也看得见那个文件（21433 字节）。
 * 所以问题只在"它待在围栏里"。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
/*
  import **真货**，不是在测试里手抄一份正则：手抄的那份和代码分岔了不会有任何人发现。
  为此把两条正则从 `ChatArea.tsx` 挪进了 `filePaths.ts` —— `.tsx` 跑不了 node:test，
  而"待在组件里的判据只能靠手抄来测"本身就是个该修的东西。
*/
import { FILE_TOKEN_RE } from '../src/renderer/filePaths.ts';

const CHAT = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'ChatArea.tsx'), 'utf8',
);



describe('判据：整行就是一条路径', () => {
  test('那条含中文、在 ~/Downloads 下的路径是匹配的 —— 中文和目录都不是原因', () => {
    assert.equal(FILE_TOKEN_RE.test('/Users/keyinan/Downloads/devops-agent-rds-诊断配置指南.md'), true);
  });

  test('一行命令不算 —— `cd /x && ls` 不是"整体就是一条路径"', () => {
    assert.equal(FILE_TOKEN_RE.test('cd /Users/keyinan/work && ls'), false);
    assert.equal(FILE_TOKEN_RE.test('cat /tmp/a.md | head'), false);
  });

  test('没有扩展名的不算 —— 那更像一句话里的斜杠', () => {
    assert.equal(FILE_TOKEN_RE.test('/update/delete'), false);
  });
});

describe('围栏里怎么处理', () => {
  const block = CHAT.slice(CHAT.indexOf('const MdCodeBlock'), CHAT.indexOf('// Linkify absolute file/dir paths'));

  test('**逐行**判，只换掉整行是路径的那些 —— 尺寸说明那种行不该变成链接', () => {
    assert.match(block, /lines\.map\(\(line\) => \(FILE_TOKEN_RE\.test\(line\.trim\(\)\) \? line\.trim\(\) : null\)\)/);
    assert.match(block, /pathLines\[i\]\s*\n?\s*\? <FileRef/);
  });

  test('有行数上限 —— 否则一个 500 行的 find 输出就是 500 次存在性探测', () => {
    assert.match(block, /lines\.length <= 3/);
  });

  test('存在性仍然由 FileRef 说话 —— 文件不在盘上就是普通文本，绝不给点了没反应的链接', () => {
    assert.match(block, /<FileRef path=\{pathLines\[i\] as string\} as="code"/);
    // FileRef 自己那条判据（`exists !== 'yes'` → 纯文本）不能被绕过
    assert.match(CHAT, /if \(exists !== 'yes'\) \{/);
  });

  test('「复制」按钮照旧留着 —— 它本来就是为这种情形存在的（长路径在围栏里横向溢出，拖选会滚走）', () => {
    assert.match(block, /className="md-code-copy"/);
    assert.match(block, /navigator\.clipboard\.writeText\(text\)/);
  });

  test('复制拿的还是**源文本**，不是渲染出来的 DOM —— 那是 `[object Object]` 那次的教训', () => {
    assert.match(CHAT, /const text = mdText\(codeEl\?\.props\?\.children\)/);
  });
});
