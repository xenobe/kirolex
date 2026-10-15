import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * 归档会话的右键菜单里只能有**一个**恢复动作。
 *
 * 来自实测：「现在恢复会话还是有两个一样的按钮」。当时菜单里同时存在
 * `♻️ 恢复到 Unassigned`（解档 + 移到 Unassigned）和 `♻️ Unarchive`（只解档），图标相同、
 * 措辞相近，唯一的区别写在括号里的补充说明中 —— 那个说明还是假的：`archiveSession` 归档时会把
 * projectId 清成 undefined，所以不存在「留在原 project」这回事。
 */
const SIDEBAR = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'renderer', 'components', 'Sidebar.tsx'),
  'utf8',
);

describe('右键菜单里的归档/恢复', () => {
  /**
   * **这条判据原来是空转的。**
   *
   * 它只匹配字面量 `false`（`/onArchiveSession\([^)]*,\s*false\s*\)/`），而活下来的那个按钮写的是
   * `onArchiveSession(ctxSession.id, !ctxSession.archived)` —— 一个**切换**，在归档态下同样是解档。
   * 正则匹配不到它，于是按钮一直在、测试一直绿，而它本该在写这条测试的时候就被删掉。
   *
   * 所以现在正面反面都钉：解档只有一个字面入口，**并且**这个菜单里不许再出现切换写法。
   */
  test('只有一处会调用解档（archived=false）', () => {
    const unarchiveCalls = SIDEBAR.match(/onArchiveSession\([^)]*,\s*false\s*\)/g) || [];
    assert.equal(unarchiveCalls.length, 1,
      `解档动作只应有一个入口，实际有 ${unarchiveCalls.length} 个：${unarchiveCalls.join(' | ')}`);
  });

  test('**不许用 `!ctxSession.archived` 这种切换写法** —— 上面那条正则抓不到它，按钮就是这么活下来的', () => {
    assert.doesNotMatch(
      SIDEBAR,
      /onArchiveSession\([^)]*,\s*![A-Za-z]/,
      '切换写法在归档态下也是解档，等于绕过「只有一个恢复入口」这条判据',
    );
  });

  test('菜单里不许出现第二个 ♻️ —— 图标相同、措辞相近的两个恢复动作就是当初的原始投诉', () => {
    const at = SIDEBAR.indexOf('{contextMenu && ctxSession && (');
    assert.ok(at > 0, '找不到右键菜单那段');
    // 先剥注释：记录「为什么删了那一条」的注释里也会提到 ♻️，那不是菜单项
    const menu = SIDEBAR.slice(at, SIDEBAR.indexOf('</Menu>', at))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const icons = menu.match(/♻️/g) || [];
    assert.equal(icons.length, 1, `菜单里有 ${icons.length} 个 ♻️`);
  });

  test('「留在原 project」这句话不许再出现 —— archiveSession 归档时会清掉 projectId，那句是假的', () => {
    // 注释里可以提它（记录为什么删了），代码里不行 —— 所以只查 JSX 文本节点那种形态
    assert.doesNotMatch(SIDEBAR, /'♻️ Unarchive（留在原 project）'/);
    assert.doesNotMatch(SIDEBAR, /> *♻️ Unarchive/);
  });

  test('那个入口是「恢复到 Unassigned」，并且真的顺带移出项目', () => {
    const at = SIDEBAR.indexOf('onArchiveSession(ctxSession.id, false)');
    assert.ok(at > 0);
    const around = SIDEBAR.slice(at, at + 220);
    assert.match(around, /onMoveSession\(ctxSession\.id, null\)/,
      '恢复必须同时把会话移到 Unassigned —— 原项目可能已不存在或已被流程托管');
    // 文案现在走 i18n（`t('Restore to Unassigned')`），所以断言的是那个 key 而不是中文原文 ——
    // 中文在 `i18n.ts` 的字典里，由 tests/i18n.test.ts 钉住。
    assert.match(around, /t\('Restore to Unassigned'\)/);
  });
});
