import path from 'node:path';
/**
 * READING A REAL `SKILL.md` — the file kiro-cli itself loads. PURE, no fs, no IPC.
 *
 * WHY THIS EXISTS, and what it replaces. I first built a `flow.yaml` format and a diagram
 * of it, and presented that as "the SFDC skill visualised". It was not: the user's actual
 * skill is 18 prose rules with alias tables, conditional branches and per-event
 * interaction, and a five-step declarative pipeline cannot express any of that. Asking
 * them to restate the workflow in YAML just to see it drawn is the wrong trade. So this
 * reads the file that already exists.
 *
 * WHAT A KIRO SKILL IS, precisely — this shapes every decision below. There is no
 * `kiro-cli skill` command (checked `--help-all`). A skill is `~/.kiro/skills/<name>/
 * SKILL.md`, whose frontmatter carries only `name` and `description`, and that
 * description is written as a TRIGGER ("Use when the user wants to log activities…"). The
 * model reads it, decides the skill applies, pulls the prose into context, and then keeps
 * control of the flow itself.
 *
 * Therefore this module powers an OBSERVATION surface, not an engine:
 *   - it never claims a rule is enforced. Nothing here can enforce prose; the model may
 *     skip a rule, and a panel implying otherwise would be asserting a guarantee that
 *     does not exist.
 *   - it never renumbers or tidies. The panel has to agree with the document the model
 *     actually reads, or a discrepancy between them can never be noticed. The real file
 *     has two rules numbered 5 and no 4 — that is shown as-is.
 *
 * The one genuinely tricky part is fenced code blocks. This file documents its own output
 * formats with `## YYYY-MM-DD (DayOfWeek)` INSIDE ``` fences, so a naive `/^## /` scan
 * invents sections and misfiles every rule that follows.
 */

export interface SkillRule {
  /** As written in the file, duplicates and gaps included. */
  number: number;
  /** The bolded lead-in, e.g. `**Fetching calendar**:` -> `Fetching calendar`. */
  label: string;
  text: string;
  /** The rule pauses for a person (present/prompt/confirm/one at a time). These are the
   *  moments that decide whether a skill runs by itself or asks twenty questions. */
  interactive: boolean;
  /** The rule changes something outside this machine. A WARNING, never a guarantee:
   *  nothing here gates it. */
  writes: boolean;
}

export interface SkillTable {
  section: string;
  headers: string[];
  rows: string[][];
}

export interface SkillSection {
  title: string;
  level: number;
  body: string;
  children: SkillSection[];
  tables: SkillTable[];
}

export interface SkillDoc {
  name: string | null;
  description: string;
  /** The description, when it reads like a trigger. Surfaced separately because it is
   *  the entire interface between a skill and the model. */
  triggerText: string | null;
  /** The `# ` heading, i.e. the human title. */
  title: string;
  sections: SkillSection[];
  rules: SkillRule[];
  tables: SkillTable[];
}

/** Phrases that mean "a human is involved in this step". Matched on the rule text, in
 *  both languages, because the panel's value is showing WHERE the pauses are. */
const INTERACTIVE_RE = /present (?:this |two |these )?(?:table|tables|options|suggestions|them)|prompt (?:the )?user|ask (?:the )?user|confirm before|user confirmation|get user confirmation|ONE (?:EVENT|ITEM) AT A TIME|one at a time|one question at a time|review|等用户|询问用户|人工确认/i;

/**
 * Phrases that mean "this rule ITSELF performs an irreversible external write".
 *
 * Deliberately narrow. A first version matched `\bcreation\b` and `append`, which flagged
 * four rules in the real file — but three of them only MENTION creation: a review gate
 * ("prompt user to review … confirm before proceeding"), a local bookkeeping line
 * ("Append ✅ Created" to an md file on disk), and a post-hoc scan ("After creation,
 * scan …"). Over-flagging is not the safe direction here: if four rules all claim to write
 * to SFDC, the badge stops carrying information and the one rule that genuinely does no
 * longer stands out.
 *
 * So this matches a named external tool call, or an imperative verb acting on an external
 * system — never a subordinate clause about creation happening elsewhere.
 */
const WRITES_RE = new RegExp([
  // A named tool that writes: `create_tech_activity`, `create_task`, `send_email`, …
  '\\b(?:create|update|delete|send|post|put)_[a-z_]+\\b',
  // `create via …`, `create the activity`, `create now` — imperative, this rule acting.
  '\\bcreate (?:via|the |a |an |now\\b)',
  // Explicit external targets.
  'send (?:an? )?(?:email|message|notification)',
  'write to (?:SFDC|Salesforce|the API)',
  '提交(?:工单|记录)|写入 ?(?:SFDC|Salesforce)',
].join('|'), 'i');

/** Split the document into lines, marking which are inside a fenced code block.
 *
 *  This is the load-bearing detail of the whole parser: the real SKILL.md documents its
 *  own file formats with `##` headings inside fences. */
function scan(text: string): { line: string; fenced: boolean }[] {
  const out: { line: string; fenced: boolean }[] = [];
  let fenced = false;
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      // The fence marker itself belongs to neither side; mark it fenced so it is never
      // read as content.
      out.push({ line, fenced: true });
      fenced = !fenced;
      continue;
    }
    out.push({ line, fenced });
  }
  return out;
}

function parseFrontmatter(text: string): { name: string | null; description: string; rest: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { name: null, description: '', rest: text };
  const head = match[1];
  const field = (key: string) => {
    const hit = new RegExp(`^${key}:\\s*(.*)$`, 'mi').exec(head);
    return hit ? hit[1].trim() : '';
  };
  return { name: field('name') || null, description: field('description'), rest: text.slice(match[0].length) };
}

/** A markdown table starting at `from`, or null. */
function readTable(lines: { line: string; fenced: boolean }[], from: number): { table: Omit<SkillTable, 'section'>; next: number } | null {
  const isRow = (i: number) => i < lines.length && !lines[i].fenced && /^\s*\|.*\|\s*$/.test(lines[i].line);
  if (!isRow(from) || !isRow(from + 1)) return null;
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const headers = cells(lines[from].line);
  // The second line must be the separator, or this is not a table.
  if (!cells(lines[from + 1].line).every((c) => /^:?-{1,}:?$/.test(c))) return null;
  const rows: string[][] = [];
  let i = from + 2;
  for (; isRow(i); i++) {
    const row = cells(lines[i].line);
    if (row.every((c) => /^:?-*:?$/.test(c))) continue;   // stray separator
    rows.push(row);
  }
  return { table: { headers, rows }, next: i };
}

export function parseSkillDoc(text: string): SkillDoc {
  const { name, description, rest } = parseFrontmatter(String(text ?? ''));
  const lines = scan(rest);

  let title = '';
  const sections: SkillSection[] = [];
  const tables: SkillTable[] = [];
  const rules: SkillRule[] = [];
  /** Stack of open sections, so `###` nests under the `##` above it. */
  const stack: SkillSection[] = [];
  let currentSectionTitle = '';

  for (let i = 0; i < lines.length; i++) {
    const { line, fenced } = lines[i];
    if (fenced) {
      // Still part of the current section's body -- a format example is content.
      if (stack.length) stack[stack.length - 1].body += `${line}\n`;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].trim();
      if (level === 1 && !title) { title = text; continue; }
      const section: SkillSection = { title: text, level, body: '', children: [], tables: [] };
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(section);
      else sections.push(section);
      stack.push(section);
      currentSectionTitle = text;
      continue;
    }

    const table = readTable(lines, i);
    if (table) {
      const withSection: SkillTable = { section: currentSectionTitle, ...table.table };
      tables.push(withSection);
      if (stack.length) stack[stack.length - 1].tables.push(withSection);
      i = table.next - 1;
      continue;
    }

    // `1. **Label**: text` — numbered as the file numbers it.
    const rule = /^\s*(\d+)\.\s+(?:\*\*(.+?)\*\*\s*:?\s*)?(.*)$/.exec(line);
    if (rule) {
      const body = rule[3] || '';
      const full = `${rule[2] ? `${rule[2]}: ` : ''}${body}`;
      rules.push({
        number: Number(rule[1]),
        label: rule[2] || body.slice(0, 40),
        text: body,
        interactive: INTERACTIVE_RE.test(full),
        writes: WRITES_RE.test(full),
      });
    }

    if (stack.length) stack[stack.length - 1].body += `${line}\n`;
  }

  return {
    name,
    description,
    // Only call it a trigger when it actually reads like one; inventing a trigger for a
    // description that does not state a condition would misrepresent the file.
    triggerText: /use (?:this )?when|适用于|当用户/i.test(description) ? description : null,
    title,
    sections,
    rules,
    tables,
  };
}

export function sectionsOf(doc: SkillDoc): SkillSection[] {
  return doc.sections;
}

export function tablesOf(doc: SkillDoc): SkillTable[] {
  return doc.tables;
}

export function ruleCount(doc: SkillDoc): number {
  return doc.rules.length;
}

/** One-line summary for the panel header. States what the FILE contains — never what is
 *  guaranteed, because nothing here enforces a word of it. */
export function describeSkill(doc: SkillDoc): string {
  const pauses = doc.rules.filter((r) => r.interactive).length;
  const writes = doc.rules.filter((r) => r.writes).length;
  const rows = doc.tables.reduce((sum, t) => sum + t.rows.length, 0);
  return [
    doc.name || doc.title || '(未命名)',
    `${doc.rules.length} 条规则`,
    pauses ? `${pauses} 处要人参与` : '',
    writes ? `${writes} 处写外部系统` : '',
    doc.tables.length ? `${doc.tables.length} 张表 / ${rows} 行` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * IS THIS PATH A KIRO SKILL FILE — the guard on the one write that leaves KiroLex's own directory.
 *
 * The skill browser can now edit `~/.kiro/skills/<名字>/SKILL.md`, which belongs to kiro-cli. A renderer
 * that hands main a path is a renderer that can hand main ANY path, so the shape is checked here rather
 * than trusted: resolved (so `..` cannot climb out), directly under `~/.kiro/skills`, exactly one folder
 * deep, and named SKILL.md. Everything else is refused rather than corrected — silently rewriting a path
 * into an allowed one would write to a file nobody asked for.
 */
export function kiroSkillTarget(
  filePath: string,
  home: string,
): { ok: true; name: string; path: string } | { ok: false; why: string } {
  if (typeof filePath !== 'string' || !filePath.trim()) return { ok: false, why: '没有给路径' };
  const root = path.resolve(home, '.kiro', 'skills');
  const full = path.resolve(filePath);
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, why: `不在 ${root} 下面` };
  const parts = rel.split(path.sep);
  if (parts.length !== 2) return { ok: false, why: 'skill 必须是 <名字>/SKILL.md 这一层' };
  if (parts[1] !== 'SKILL.md') return { ok: false, why: '只能写 SKILL.md' };
  return { ok: true, name: parts[0], path: full };
}

/** How many previous versions of one kiro SKILL.md are kept. Three covers "I broke it, put it back". */
export const SKILL_BACKUPS_KEPT = 3;

/**
 * WHICH BACKUPS OF ONE SKILL TO DELETE — because a file per save is how a directory becomes a problem.
 *
 * Names are `<名字>__<ISO stamp>.md`, which sorts chronologically, so this is a sort rather than a stat
 * call. Only this skill's own backups are candidates: a sweep that also matched its neighbours would
 * silently thin someone else's history.
 */
export function backupsToPrune(files: string[], name: string, keep: number = SKILL_BACKUPS_KEPT): string[] {
  const prefix = `${name}__`;
  const mine = files.filter((f) => f.startsWith(prefix) && f.endsWith('.md')).sort();
  return mine.length <= keep ? [] : mine.slice(0, mine.length - keep);
}
