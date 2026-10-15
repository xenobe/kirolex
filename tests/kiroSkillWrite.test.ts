import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { kiroSkillTarget, backupsToPrune } from '../src/main/skillDoc.ts';

/**
 * EDITING KIRO'S OWN SKILL FILE — the one write in this app that lands outside its own data directory.
 *
 * The browser now owns both kinds of skill (「kiro内部skill浏览和编辑的功能和导入的skill浏览器合成一个」),
 * and editing means writing `~/.kiro/skills/<名字>/SKILL.md` — a directory that belongs to kiro-cli, not
 * to KiroLex. So the renderer does not get to name a path: it names one, and this decides whether that
 * path is a kiro skill file at all. Anything else is refused, including the paths a path string can smuggle.
 */
const HOME = '/Users/x';

describe('only a kiro SKILL.md may be written', () => {
  test('the ordinary case is accepted, and reports the skill name', () => {
    const t = kiroSkillTarget(`${HOME}/.kiro/skills/sfdc-activity/SKILL.md`, HOME);
    assert.equal(t.ok, true);
    assert.equal(t.ok && t.name, 'sfdc-activity');
  });

  test('a path outside ~/.kiro/skills is refused', () => {
    for (const p of [`${HOME}/.zshrc`, `${HOME}/.kiro/config.json`, '/etc/passwd', `${HOME}/.kirolex/skills/x.json`]) {
      assert.equal(kiroSkillTarget(p, HOME).ok, false, `${p} 不该被允许写`);
    }
  });

  test('a traversal that resolves back out is refused, not normalised into obedience', () => {
    assert.equal(kiroSkillTarget(`${HOME}/.kiro/skills/../../.ssh/authorized_keys`, HOME).ok, false);
    assert.equal(kiroSkillTarget(`${HOME}/.kiro/skills/a/../../../x/SKILL.md`, HOME).ok, false);
  });

  test('only SKILL.md, and only one level down', () => {
    assert.equal(kiroSkillTarget(`${HOME}/.kiro/skills/a/notes.md`, HOME).ok, false);
    assert.equal(kiroSkillTarget(`${HOME}/.kiro/skills/SKILL.md`, HOME).ok, false, '技能必须在自己的目录里');
    assert.equal(kiroSkillTarget(`${HOME}/.kiro/skills/a/b/SKILL.md`, HOME).ok, false);
  });

  test('nothing throws on rubbish input', () => {
    for (const p of ['', '   ', undefined as any, null as any]) assert.equal(kiroSkillTarget(p, HOME).ok, false);
  });
});

describe('backups of one skill do not accumulate', () => {
  const name = 'weekly-report';
  const files = (n: number) => Array.from({ length: n }, (_, i) => `${name}__2026-08-1${i}T00-00-00-000Z.md`);

  test('the newest three are kept, the rest deleted oldest-first', () => {
    const all = files(6);
    assert.deepEqual(backupsToPrune(all, name, 3), all.slice(0, 3));
  });

  test('under the limit nothing is deleted', () => {
    assert.deepEqual(backupsToPrune(files(2), name, 3), []);
  });

  test("another skill's backups are never touched", () => {
    const mixed = [...files(5), 'sfdc-activity__2026-08-01T00-00-00-000Z.md'];
    assert.ok(!backupsToPrune(mixed, name, 3).some((f) => f.startsWith('sfdc-activity')));
  });
});
