import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseSkillDoc, ruleCount, tablesOf, sectionsOf } from '../src/main/skillDoc.ts';

/**
 * READING A REAL `SKILL.md`, the file kiro-cli itself loads.
 *
 * This replaces an earlier mistake of mine. I had built a `flow.yaml` format and shown a
 * five-step diagram of it, calling that "the SFDC skill" -- but the user's actual skill is
 * 18 prose rules with alias tables and per-event interaction, which a five-step straight
 * line cannot express. Visualising it therefore means reading the file that EXISTS, not
 * asking for a second declaration of the same work.
 *
 * WHAT THIS IS NOT. It is not an execution engine. A kiro skill is loaded by the model on
 * its own judgement (the frontmatter `description` is the trigger: "Use when the user
 * wants to log activities..."), and the model keeps control of the flow. So this parser
 * powers an OBSERVATION surface: what skills exist, when each fires, what rules each
 * declares. Claiming to drive one would be claiming control KiroLex does not have.
 *
 * The fixture is the shape of the real file, including the trap that broke my first
 * attempt: `## YYYY-MM-DD (DayOfWeek)` and `## Account - Opp Name` appear INSIDE fenced
 * code blocks as format examples. A naive `/^## /` scan reports them as sections.
 */
const DOC = `---
name: sfdc-activity-logging
description: SFDC SA activity logging workflow. Use when the user wants to log activities, fetch calendar events for activity tracking, map events to opportunities, or create tech activities in Salesforce.
---

# SFDC Activity Logging Workflow

You are a specialized assistant that only helps with logging SA activities in SFDC.

## User Info
- Role: SA (Solutions Architect)

## Account Alias Mappings
| Alias (CN/EN) | SFDC Account Name | Account ID |
|---|---|---|
| 高盛、GS | GOLDMAN SACHS GROUP | 0015000000poxNUAAY |
| 易宝支付、Kun | Yeepay Co., Ltd. | 0015000000uykG0AAI |

## BD Reps
| Name | Alias | User ID |
|---|---|---|
| Yun Huang | huanyun | 0054z000009qQFEAA2 |

## Regular Activity File Format
\`\`\`
## YYYY-MM-DD (DayOfWeek)
- **HH:MM - HH:MM** | Event Title
  - Account: SFDC Account Name (AccountID)
\`\`\`

## Activity Type Options

### Regular Activities
- Architecture Review [Architecture]
- Demo [Architecture]

### G1 Activities (prompt user to choose)
- Demo [Architecture]

## Workflow Rules

1. **G1 gap scan (all accounts)**: At the very start, fetch ALL open opps.
2. **Fetching calendar**: Use Outlook calendar_view for the previous month AND current month.
3. **Account mapping**: Match event titles against alias mappings above.
5. **Opportunity mapping**: Present options to user ONE EVENT AT A TIME (do not batch).
5. **G1 opp dedup check**: Before mapping a G1 activity, check if that opp already has one.
8. **Pre-creation review**: prompt user to review the md files and confirm before proceeding.
9. **Creation**: create via create_tech_activity using parentRecord = opp ID.
`;

describe('the frontmatter is the trigger, and is read as such', () => {
  test('name and description come from the YAML header', () => {
    const doc = parseSkillDoc(DOC);
    assert.equal(doc.name, 'sfdc-activity-logging');
    assert.match(doc.description, /^SFDC SA activity logging workflow/);
  });

  test('the description is surfaced as WHEN this skill fires', () => {
    // This is the whole interface between a skill and the model: there is no command to
    // invoke one, so "Use when ..." IS the trigger condition. A panel that hides it hides
    // the only thing that decides whether the skill ever runs.
    const doc = parseSkillDoc(DOC);
    assert.match(doc.triggerText!, /Use when the user wants to log activities/);
  });

  test('a file with no frontmatter still parses, named after nothing invented', () => {
    const doc = parseSkillDoc('# Just a heading\n\nsome prose\n');
    assert.equal(doc.name, null);
    assert.equal(doc.description, '');
    assert.equal(doc.title, 'Just a heading');
  });
});

describe('sections come from real headings, not from code samples', () => {
  test('a "## heading" inside a fenced block is NOT a section', () => {
    // The real file uses `## YYYY-MM-DD (DayOfWeek)` and `## Account - Opp Name` inside
    // ``` fences as format examples. Counting them produces phantom sections and, worse,
    // swallows the rules that follow into the wrong one.
    const names = sectionsOf(parseSkillDoc(DOC)).map((s) => s.title);
    assert.ok(!names.includes('YYYY-MM-DD (DayOfWeek)'), `phantom section: ${names.join(' | ')}`);
    assert.deepEqual(names, [
      'User Info',
      'Account Alias Mappings',
      'BD Reps',
      'Regular Activity File Format',
      'Activity Type Options',
      'Workflow Rules',
    ]);
  });

  test('a subsection is nested under its parent, not promoted', () => {
    const types = sectionsOf(parseSkillDoc(DOC)).find((s) => s.title === 'Activity Type Options')!;
    assert.deepEqual(types.children.map((c) => c.title), ['Regular Activities', 'G1 Activities (prompt user to choose)']);
  });
});

describe('rules are counted as the file numbers them, not renumbered', () => {
  test('每条规则的编号与标题被解析出来', () => {
    const rules = parseSkillDoc(DOC).rules;
    assert.equal(rules.length, 7);
    assert.equal(rules[0].label, 'G1 gap scan (all accounts)');
    assert.equal(rules[1].label, 'Fetching calendar');
    assert.match(rules[1].text, /Outlook calendar_view/);
  });

  test('a duplicated number is preserved, not silently fixed', () => {
    // The real file has TWO rules numbered 5 and skips 4 — an authoring slip, but the
    // panel must show what the file says. Renumbering would make the panel disagree with
    // the document the model actually reads, so a discrepancy could never be spotted.
    const rules = parseSkillDoc(DOC).rules;
    const numbers = rules.map((r) => r.number);
    assert.deepEqual(numbers, [1, 2, 3, 5, 5, 8, 9]);
    assert.equal(ruleCount(parseSkillDoc(DOC)), 7);
  });

  test('a rule that pauses for the user is flagged', () => {
    // These are the moments a person is actually needed. In this skill they are the
    // difference between "runs by itself" and "asks me 20 times", so the panel has to
    // show them rather than leaving every rule looking alike.
    const rules = parseSkillDoc(DOC).rules;
    const byNumber = (n: number, label: string) => rules.find((r) => r.number === n && r.label.startsWith(label))!;
    assert.equal(byNumber(5, 'Opportunity mapping').interactive, true);   // ONE EVENT AT A TIME
    assert.equal(byNumber(8, 'Pre-creation review').interactive, true);   // confirm before proceeding
    assert.equal(byNumber(2, 'Fetching calendar').interactive, false);
  });

  test('a rule that writes to an external system is flagged', () => {
    // The irreversible ones. Nothing here enforces anything -- the model decides -- so
    // this is a warning, and the panel must not imply a guarantee it cannot give.
    const rules = parseSkillDoc(DOC).rules;
    assert.equal(rules.find((r) => r.number === 9)!.writes, true);
    assert.equal(rules.find((r) => r.number === 2)!.writes, false);
  });

  test('MENTIONING creation is not the same as doing it', () => {
    // Measured against the real file: rule 8 ("prompt user to review ... confirm before
    // proceeding"), rule 10 ("Append ✅ Created" -- to a local md file) and rule 15
    // ("After creation, scan ...") were all flagged as external writes purely because the
    // word "creation" appears. Over-flagging is not harmless: if four rules claim to
    // write to SFDC, the badge stops meaning anything and the one rule that really does
    // (9) no longer stands out.
    const rules = parseSkillDoc(`## Workflow Rules

8. **Pre-creation review**: After all events are mapped, prompt user to review the md files and confirm before proceeding.
9. **Creation**: After user confirms, create via create_tech_activity using parentRecord = opp ID.
10. **Completion marking**: Append \`✅ Created: TaskID\` line after successful creation.
15. **Unlogged opp check**: After creation, scan both activity files for entries with no marker.
`).rules;
    const at = (n: number) => rules.find((r) => r.number === n)!;
    assert.equal(at(9).writes, true, '真正调 create_tech_activity 的那条应该被标记');
    assert.equal(at(8).writes, false, '审查闸门不是写操作');
    assert.equal(at(10).writes, false, '往本地 md 追加一行不是写外部系统');
    assert.equal(at(15).writes, false, '"After creation, scan" 是事后扫描');
  });
});

describe('tables are data the skill depends on', () => {
  test('an alias table is parsed into rows, with its headers', () => {
    // The alias/BD tables are lookup data the model uses to resolve names to SFDC IDs.
    // Showing them is how you check "is 汇元通 in there" without opening the file.
    const tables = tablesOf(parseSkillDoc(DOC));
    const alias = tables.find((t) => t.section === 'Account Alias Mappings')!;
    assert.deepEqual(alias.headers, ['Alias (CN/EN)', 'SFDC Account Name', 'Account ID']);
    assert.equal(alias.rows.length, 2);
    assert.deepEqual(alias.rows[0], ['高盛、GS', 'GOLDMAN SACHS GROUP', '0015000000poxNUAAY']);
  });

  test('the separator row is not mistaken for data', () => {
    const alias = tablesOf(parseSkillDoc(DOC)).find((t) => t.section === 'Account Alias Mappings')!;
    assert.ok(!alias.rows.some((row) => row.every((cell) => /^-+$/.test(cell))));
  });

  test('every table is attributed to the section it appeared in', () => {
    const tables = tablesOf(parseSkillDoc(DOC));
    assert.deepEqual(tables.map((t) => t.section), ['Account Alias Mappings', 'BD Reps']);
  });
});
