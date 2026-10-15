/**
 * 界面语言（中 / 英）。
 *
 * 这个界面原来是两种语言各写了一半：`+ New Session` / `Type a message...` / `Archived` /
 * `connected` 是英文，而 tooltip、设置、各种对话框全是中文 —— 同一屏上两种语言。
 * 加开关之前先要有一处**唯一的**文案来源，这些测试钉住的就是那一处的性质。
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LANG_OPTIONS, missingZh, normalizeLang, t, zhKeyCount } from '../src/renderer/i18n.ts';

const read = (...p: string[]) => fs.readFileSync(path.join(import.meta.dirname, '..', ...p), 'utf8');

describe('取文案', () => {
  test('en 直接返回 key —— key 就是英文原文，所以英文不需要第二张表', () => {
    assert.equal(t('en', 'New Session'), 'New Session');
    assert.equal(t('en', 'Settings'), 'Settings');
  });

  test('zh 查表', () => {
    assert.equal(t('zh', 'New Session'), '新建会话');
    assert.equal(t('zh', 'Settings'), '设置');
  });

  test('**漏翻退化成英文原文，不是裸 key**', () => {
    // 这是选「key 用英文原文」而不是 `sidebar.newSession` 的全部理由：
    // 漏的那一处显示英文，难看但可读；裸 key 用户看得见而且没法猜。
    assert.equal(t('zh', 'Some String Nobody Translated Yet'), 'Some String Nobody Translated Yet');
  });
});

describe('占位符', () => {
  test('按名字替换，不按位置 —— 两种语言的语序不同', () => {
    assert.equal(
      t('zh', 'Split pane {n} · right-click, or the pane ✕, to remove', { n: 3 }),
      '分屏第 3 格 · 右键或该格的 ✕ 可移除',
    );
    assert.match(t('en', '{n} more can go here', { n: 2 }), /^2 more/);
  });

  test('没给值的占位符原样留着 —— 不许悄悄变成 undefined', () => {
    assert.equal(t('en', '{n} more can go here', {}), '{n} more can go here');
  });

  test('不传 vars 时原样返回，不做任何替换', () => {
    assert.equal(t('en', 'Now at: {dir}'), 'Now at: {dir}');
  });
});

describe('语言值本身', () => {
  test('只认 en，别的一律退回中文（现状以中文为主）', () => {
    assert.equal(normalizeLang('en'), 'en');
    assert.equal(normalizeLang('zh'), 'zh');
    assert.equal(normalizeLang(undefined), 'zh');   // 存量 settings 里没有这个字段
    assert.equal(normalizeLang('fr'), 'zh');
    assert.equal(normalizeLang(42), 'zh');
  });

  test('下拉里语言名用它自己的语言写', () => {
    assert.deepEqual(LANG_OPTIONS.map((o) => o.label), ['中文', 'English']);
  });
});

describe('接进了界面', () => {
  const APP = read('src', 'renderer', 'App.tsx');
  const SETTINGS = read('src', 'renderer', 'components', 'SettingsDialog.tsx');
  const HOOK = read('src', 'renderer', 'hooks', 'useLang.tsx');

  test('语言存在 Settings 里 —— 持久化和「改了立刻生效」都是现成的', () => {
    assert.match(APP, /language: Lang;/);
    assert.match(APP, /language: 'zh' \};/);           // 默认值
    assert.match(APP, /merged\.language = normalizeLang\(merged\.language\)/);  // 存量迁移
  });

  test('走 context，不走模块级全局变量', () => {
    // 全局变量不是 React 的依赖：改了语言只有恰好因别的原因重渲染的组件会变，
    // 表现成「切了语言，一半界面没动」。
    assert.match(HOOK, /createContext<Lang>/);
    assert.match(APP, /<LangProvider lang=\{settings\.language\}>/);
  });

  test('设置里有那个下拉，而且改的是 settings.language', () => {
    assert.match(SETTINGS, /t\('Interface language'\)/);
    assert.match(SETTINGS, /language: normalizeLang\(e\.target\.value\)/);
  });

  test('`t` 的身份随语言变 —— 否则被 useMemo 缓存住的 JSX 会留着旧语言', () => {
    assert.match(HOOK, /\[lang\]\)/);
  });
});

describe('字典不许越翻越少', () => {
  test('调用点用到的 key 都在中文表里', () => {
    // 从渲染层真实的 `t('…')` 调用里收 key，逐个对表 —— 防止「加了调用点忘了加文案」
    // 悄悄退化成英文（那种退化不报错，只是那一处变成英文）。
    const files = ['App.tsx', 'components/Sidebar.tsx', 'components/WorkspacePanel.tsx',
      'components/SettingsDialog.tsx'];
    const keys = new Set<string>();
    for (const f of files) {
      const src = read('src', 'renderer', ...f.split('/'));
      for (const m of src.matchAll(/\bt\((?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
        const k = (m[1] ?? m[2] ?? '').replace(/\\'/g, "'").replace(/\\"/g, '"');
        if (k) keys.add(k);
      }
    }
    assert.ok(keys.size > 60, `应该收到几十个 key，实际 ${keys.size}`);
    assert.deepEqual(missingZh([...keys]), [], '这些 key 没有中文文案，界面上会显示英文');
  });

  test('表里条数有下限 —— 有人整段删掉时测试要响', () => {
    assert.ok(zhKeyCount() >= 150, `字典只剩 ${zhKeyCount()} 条`);
  });
});
