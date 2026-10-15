#!/usr/bin/env node
/**
 * Validate a skill flow, and optionally print exactly what one step would inject.
 *
 *   npm run skill:validate -- <path/to/flow.yaml>
 *   npm run skill:validate -- <path/to/flow.yaml> --inject <stepId>
 *
 * Exits non-zero when the flow is invalid, so this can gate a commit or a run. That
 * is the point of the schema: an unenforced rule is a suggestion, and a red badge in
 * a graph is something you click past.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const injectIndex = args.indexOf('--inject');
const injectStep = injectIndex >= 0 ? args[injectIndex + 1] : null;

if (!file) {
  console.error('用法: npm run skill:validate -- <flow.yaml> [--inject <stepId>]');
  process.exit(2);
}

// The compiled main bundle is preferred (it is what the app actually runs); fall back
// to the TypeScript source so this works before a build.
const compiled = path.resolve('dist/main/skillFlow.js');
const source = path.resolve('src/main/skillFlow.ts');
const modulePath = fs.existsSync(compiled) ? compiled : source;
const flowModule = await import(pathToFileURL(modulePath).href);
const { loadFlow, describeFlow, flowSteps, buildStepPrompt, VERIFY_LEVEL_LABEL } = flowModule;

const text = fs.readFileSync(path.resolve(file), 'utf-8');
const { flow, errors } = loadFlow(text);

if (errors.length) {
  console.error(`✖ ${file} 不是一个合法的技能流程，共 ${errors.length} 处问题：\n`);
  for (const e of errors) console.error(`  ${e.path || '(顶层)'}\n    ${e.message}`);
  console.error('\n（模块: ' + path.relative(process.cwd(), modulePath) + '）');
  process.exit(1);
}

console.log(`✔ ${describeFlow(flow)}`);
console.log(`  ${path.relative(process.cwd(), path.resolve(file))}\n`);

for (const { step, path: at, insideForEach } of flowSteps(flow)) {
  const kind = step.kind || (step.forEach ? 'forEach' : step.approval ? 'approval' : 'prompt');
  const marks = [
    kind === 'approval' ? '◆ 人工闸门' : kind === 'forEach' ? `⬔ 扇出 over ${step.forEach.items} (并发 ${step.forEach.maxConcurrent ?? 1})` : '● 步骤',
    step.write ? `▣ 写 ${step.write.target} 键=${step.write.idempotencyKey}` : '',
    step.verify ? `✓ ${VERIFY_LEVEL_LABEL[step.verify.level]}` : (kind === 'prompt' ? '⚠ 无带外校验' : ''),
    step.produces ? `→ ${step.produces}` : '',
  ].filter(Boolean);
  console.log(`${insideForEach ? '    ' : '  '}${step.id.padEnd(18)} ${marks.join('  ')}`);
  console.log(`${insideForEach ? '    ' : '  '}${' '.repeat(18)} ${at}`);
}

if (injectStep) {
  const found = flowSteps(flow).find((s) => s.step.id === injectStep);
  if (!found) {
    console.error(`\n✖ 没有叫 ${injectStep} 的步骤`);
    process.exit(1);
  }
  // Placeholder values, clearly marked: the point is to show the SHAPE of the
  // injected text, not to pretend a run happened.
  const values = {};
  for (const input of flow.inputs || []) values[input.id] = `<${input.id} 的值>`;
  for (const { step } of flowSteps(flow)) {
    if (step.produces) values[step.produces] = { note: `<${step.produces} 的内容>` };
  }
  const item = found.insideForEach
    ? { as: flow.steps.find((s) => s.id === found.insideForEach).forEach.as, value: { note: '<当前条目>' } }
    : undefined;
  const injected = buildStepPrompt(flow, found.step, { runId: 'run-DEMO', values, item, iteration: 1 });
  console.log(`\n${'─'.repeat(72)}\n注入给 ${injectStep} 的完整文本（${injected.text.length} 字符）`);
  if (injected.missing.length) {
    console.log(`未解析的引用: ${injected.missing.join(', ')}`
      + '\n（演示模式下这是预期的：占位值只有形状没有字段。真实运行时这些引用解析不了就是一个步骤失败，'
      + '不会把 {{…}} 原样发给模型。）');
  }
  console.log(`${'─'.repeat(72)}\n${injected.text}\n${'─'.repeat(72)}`);
  if (found.step.verify) {
    console.log(`注意：校验命令 \`${found.step.verify.command}\` 不在上面这段文字里——`
      + '带外执行，不给模型看，否则就是让被检查者看到考题。');
  }
}
