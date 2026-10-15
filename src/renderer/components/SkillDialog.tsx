import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * THE SKILLS KIRO ACTUALLY HAS — read from `~/.kiro/skills/<name>/SKILL.md`.
 *
 * This panel replaces an earlier version of mine that visualised a `flow.yaml` format I
 * had invented. That was the wrong thing to show: the user's real skill is 20 prose rules
 * with alias tables, conditional branches and per-event interaction, and a five-step
 * declarative pipeline cannot express any of it. Asking someone to restate their workflow
 * in YAML just so it can be drawn is a worse deal than not drawing it.
 *
 * WHAT A KIRO SKILL IS, and therefore what this panel may claim. There is no
 * `kiro-cli skill` command. A skill is markdown whose frontmatter `description` is a
 * TRIGGER ("Use when the user wants to log activities…"); the model reads it, decides the
 * skill applies, pulls the prose into context, and keeps control of the flow. So this is
 * an OBSERVATION surface:
 *
 *   - it shows WHEN each skill fires, because that description is the entire interface
 *     between a skill and the model, and it is otherwise invisible;
 *   - it shows the rules AS NUMBERED IN THE FILE, duplicates and gaps included, so the
 *     panel can never quietly disagree with the document the model reads;
 *   - it marks which rules pause for a human and which write to an external system, as
 *     WARNINGS. Nothing here enforces a word of it -- the model may skip any rule -- and
 *     the footer says so, because a panel that looks like a control surface would be
 *     claiming a guarantee KiroLex does not have.
 */

interface SkillRule {
  number: number;
  label: string;
  text: string;
  interactive: boolean;
  writes: boolean;
}

interface SkillTable {
  section: string;
  headers: string[];
  rows: string[][];
}

interface SkillSection {
  title: string;
  level: number;
  body: string;
  children: SkillSection[];
  tables: SkillTable[];
}

interface SkillDoc {
  name: string | null;
  description: string;
  triggerText: string | null;
  title: string;
  sections: SkillSection[];
  rules: SkillRule[];
  tables: SkillTable[];
}

interface SkillEntry {
  folder: string;
  path: string;
  ok: boolean;
  doc?: SkillDoc;
  summary?: string;
  error?: string;
}

type Tab = 'rules' | 'tables' | 'source';

export function SkillDialog({ onClose }: { onClose: () => void }) {
  const [dir, setDir] = useState('');
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [active, setActive] = useState<SkillEntry | null>(null);
  const [raw, setRaw] = useState<string>('');
  const [tab, setTab] = useState<Tab>('rules');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      const result = await window.kiroApi.skillList?.();
      setDir(result?.dir || '');
      setSkills(result?.skills || []);
      // Open the first one: with a single skill installed, making the user click once
      // more to see anything would be pure ceremony.
      if (result?.skills?.length) setActive(result.skills[0]);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!active?.ok) { setRaw(''); return; }
    void (async () => {
      const result = await window.kiroApi.skillRead?.(active.path);
      setRaw(result?.raw || '');
    })();
  }, [active]);

  const doc = active?.doc;
  const counts = useMemo(() => {
    if (!doc) return null;
    return {
      rules: doc.rules.length,
      pauses: doc.rules.filter((r) => r.interactive).length,
      writes: doc.rules.filter((r) => r.writes).length,
      tableRows: doc.tables.reduce((sum, t) => sum + t.rows.length, 0),
    };
  }, [doc]);

  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className="skill-dialog" role="dialog" aria-label="技能">
        <div className="skill-dialog-head">
          <span className="skill-dialog-title">🧩 Kiro 技能</span>
          <span className="skill-dialog-sub">
            {loading ? '读取中…' : active?.summary || (skills.length ? '选择一个技能' : '没有找到技能')}
          </span>
          <button className="skill-dialog-close" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <div className="skill-dialog-body">
          <div className="skill-side skill-side-left">
            <div className="skill-side-section">
              <div className="skill-side-head">已安装（{skills.length}）</div>
              {!loading && skills.length === 0 && (
                <div className="skill-side-empty">
                  <code>{dir || '~/.kiro/skills'}</code> 下没有技能目录。
                </div>
              )}
              {skills.map((skill) => (
                <button
                  key={skill.path}
                  className={`skill-run${active?.path === skill.path ? ' selected' : ''}${skill.ok ? '' : ' waiting'}`}
                  onClick={() => { setActive(skill); setTab('rules'); }}
                >
                  <span className="skill-run-name">{skill.ok ? (skill.doc?.name || skill.folder) : `⚠ ${skill.folder}`}</span>
                  <span className="skill-run-summary">{skill.ok ? skill.summary : skill.error}</span>
                </button>
              ))}
            </div>
            <div className="skill-side-section skill-provenance">
              <div className="skill-side-head">这些文件归 kiro 所有</div>
              <div className="skill-provenance-body">
                技能由<b>模型自己</b>按下面的触发条件加载，KiroLex 不调用、不改写这些文件。
                这里只是把它们读出来给你看。
              </div>
            </div>
          </div>

          <div className="skill-main">
            {!doc && !loading && (
              <div className="skill-graph-empty">
                技能放在 <code>~/.kiro/skills/&lt;名字&gt;/SKILL.md</code>。
                <br />frontmatter 里的 <code>description</code> 就是它的触发条件。
              </div>
            )}
            {doc && (
              <>
                <div className="skill-trigger">
                  <div className="skill-trigger-label">触发条件（模型据此决定要不要用这个技能）</div>
                  <div className="skill-trigger-text">{doc.triggerText || doc.description || '（frontmatter 没有 description —— 模型无从判断何时该用它）'}</div>
                </div>

                <div className="skill-tabs">
                  {([['rules', `规则 ${counts?.rules ?? 0}`], ['tables', `数据表 ${doc.tables.length}`], ['source', '原文']] as [Tab, string][])
                    .map(([id, label]) => (
                      <button key={id} className={`skill-tab${tab === id ? ' active' : ''}`} onClick={() => setTab(id)}>
                        {label}
                      </button>
                    ))}
                  <span className="skill-tabs-spacer" />
                  {counts!.pauses > 0 && <span className="skill-badge pause">{counts!.pauses} 处要人参与</span>}
                  {counts!.writes > 0 && <span className="skill-badge write">{counts!.writes} 处写外部系统</span>}
                </div>

                {tab === 'rules' && (
                  <div className="skill-rules">
                    {doc.rules.length === 0 && <div className="skill-side-empty">这个技能没有编号规则，只有散文说明。见「原文」。</div>}
                    {doc.rules.map((rule, index) => (
                      <div className={`skill-rule${rule.interactive ? ' interactive' : ''}${rule.writes ? ' writes' : ''}`} key={index}>
                        <span className="skill-rule-num">{rule.number}</span>
                        <div className="skill-rule-main">
                          <div className="skill-rule-label">
                            {rule.label}
                            {rule.interactive && <span className="skill-badge pause">要人参与</span>}
                            {rule.writes && <span className="skill-badge write">写外部系统</span>}
                          </div>
                          <div className="skill-rule-text">{rule.text}</div>
                        </div>
                      </div>
                    ))}
                    {/* The real file numbers two rules 5 and skips 4. Shown, not fixed --
                        and explained, so it reads as a fact about the file rather than a
                        rendering bug. */}
                    {hasNumberingOddity(doc.rules) && (
                      <div className="skill-rules-note">
                        注意：文件里的编号有重复或跳号（{doc.rules.map((r) => r.number).join(', ')}）。
                        这里按原样显示 —— 面板不替文件重排编号，否则你就看不出文件本身有这个问题。
                      </div>
                    )}
                  </div>
                )}

                {tab === 'tables' && (
                  <div className="skill-tables">
                    {doc.tables.length === 0 && <div className="skill-side-empty">这个技能没有数据表。</div>}
                    {doc.tables.map((table, index) => (
                      <div className="skill-table-block" key={index}>
                        <div className="skill-table-caption">{table.section} · {table.rows.length} 行</div>
                        <div className="skill-table-scroll">
                          <table>
                            <thead>
                              <tr>{table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
                            </thead>
                            <tbody>
                              {table.rows.map((row, r) => (
                                <tr key={r}>{row.map((cell, c) => <td key={c}>{cell}</td>)}</tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {tab === 'source' && (
                  <div className="skill-source">
                    <div className="skill-source-path"><code>{active?.path}</code></div>
                    <pre>{raw || '（读取中…）'}</pre>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div className="skill-dialog-foot">
          这些规则由模型执行，<b>KiroLex 不强制</b>：模型可能跳过某一条。「写外部系统」是提醒，不是闸门。
          {doc && <> 章节：{doc.sections.map((s) => s.title).join(' · ')}</>}
        </div>
      </div>
    </>,
    document.body,
  );
}

/** Duplicated or non-monotonic numbering in the source file. */
function hasNumberingOddity(rules: SkillRule[]): boolean {
  for (let i = 1; i < rules.length; i++) {
    if (rules[i].number <= rules[i - 1].number) return true;
  }
  return false;
}
