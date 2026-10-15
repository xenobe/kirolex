import fs from 'fs';
import os from 'os';
import path from 'path';
import { MEMORY_BACKUPS, type MemoryScope } from './memoryPolicy.ts';

/**
 * Layered memory store (design §6). THREE curated layers on disk, ordered
 * least→most specific:
 *   - global:  ~/.kirolex/memory/global.md                    (all chats)
 *   - project: ~/.kirolex/memory/projects/<id>/memory.md      (all chats in a project)
 *   - session: ~/.kirolex/memory/sessions/<id>/memory.md      (this chat only)
 *
 * Injection (this file) is the READ half: buildMemoryInjection assembles ONE
 * hidden block with LABELED sections in cascade order + a precedence note (on
 * conflict the more-specific/later section wins). kiro-cli's own filesystem
 * tools are the WRITE half — the agent edits the file at the injected path when
 * asked to "remember". The manual context-sync (raw transcript from linked
 * chats) is a separate, non-authoritative reference block injected after this
 * cascade. Consolidation (auto-distill) is a later PR.
 */

const baseDir = path.join(os.homedir(), '.kirolex', 'memory');
const globalPath = path.join(baseDir, 'global.md');

// 阈值和提示词在 `memoryPolicy.ts`（不引 node 内置模块，渲染进程也要用同一份）。


function projectDir(projectId: string): string {
  return path.join(baseDir, 'projects', projectId);
}
function projectPath(projectId: string): string {
  return path.join(projectDir(projectId), 'memory.md');
}
function sessionDir(sessionId: string): string {
  return path.join(baseDir, 'sessions', sessionId);
}
function sessionPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), 'memory.md');
}

function readIfExists(p: string): string {
  try { return fs.readFileSync(p, 'utf-8').trim(); } catch { return ''; }
}

/** Ensure the layer files exist so the agent always has a concrete path to edit. */
export function ensureMemoryFiles(projectId?: string, sessionId?: string): void {
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    if (!fs.existsSync(globalPath)) fs.writeFileSync(globalPath, '# Global memory\n\n');
    if (projectId) {
      fs.mkdirSync(projectDir(projectId), { recursive: true });
      const pp = projectPath(projectId);
      if (!fs.existsSync(pp)) fs.writeFileSync(pp, `# Project memory: ${projectId}\n\n`);
    }
    if (sessionId) {
      fs.mkdirSync(sessionDir(sessionId), { recursive: true });
      const sp = sessionPath(sessionId);
      if (!fs.existsSync(sp)) fs.writeFileSync(sp, `# Chat-specific memory\n\n`);
    }
  } catch { /* best-effort */ }
}

/** 一个文件的字节数，不存在就是 0 —— `statSync` 而不是读全文：这个数每轮都要取一次。 */
function bytesOf(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/**
 * 三层各自的字节数，给横幅用。
 *
 * 刻意不返回内容：调用点只需要知道「大不大」，读 74 KB 正文只为了拿一个长度是纯浪费。
 */
export function memoryLayerBytes(projectId?: string, sessionId?: string): {
  global: number; project: number; session: number;
} {
  return {
    global: bytesOf(globalPath),
    project: projectId ? bytesOf(projectPath(projectId)) : 0,
    session: sessionId ? bytesOf(sessionPath(sessionId)) : 0,
  };
}

/**
 * 压缩前把某一层记忆备份一份，只留最近 `MEMORY_BACKUPS` 份。
 *
 * 为什么必须有：删会话时 `deleteSessionMemory` 是 `fs.rmSync` 直接销毁，不进 trash —— 已经
 * 真实吃过一次（一条 497 KB 的会话被删，transcript 从 trash 捞回来了，它的 memory 永久没了）。
 * 而「压缩」是让模型去重写这个文件，比删除更容易悄悄丢东西。`.bak` 不会被读取：三层的读取口
 * （`globalPath`/`projectPath`/`sessionPath`）都只认确切的文件名。
 *
 * 全局层的备份落在 `memory/global.<stamp>.bak`，另两层落在各自的目录里。
 *
 * 返回备份路径，没有可备份的（文件不存在/为空）返回 null。
 */
export function backupMemoryLayer(
  scope: MemoryScope,
  projectId: string | undefined,
  sessionId: string | undefined,
  stamp: string,
): string | null {
  try {
    const src = scope === 'global' ? globalPath
      : scope === 'project' ? (projectId ? projectPath(projectId) : '')
      : (sessionId ? sessionPath(sessionId) : '');
    if (!src || bytesOf(src) === 0) return null;
    const dir = path.dirname(src);
    // 备份名沿用原文件名做前缀，这样同目录里两层的备份不会互相误删。
    const stem = path.basename(src, '.md');
    const dest = path.join(dir, `${stem}.${stamp}.bak`);
    fs.copyFileSync(src, dest);
    const stale = fs.readdirSync(dir)
      .filter((n) => n.startsWith(`${stem}.`) && n.endsWith('.bak'))
      .sort()                          // 时间戳可排序，字典序即时间序
      .slice(0, -MEMORY_BACKUPS);      // 留最近 N 份，其余是 stale
    for (const n of stale) {
      try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* best-effort */ }
    }
    return dest;
  } catch { return null; }
}

/** Delete a project's memory directory (project deletion). */
export function deleteProjectMemory(projectId: string): void {
  try {
    const d = projectDir(projectId);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/** Delete a session's memory directory (chat deletion). */
export function deleteSessionMemory(sessionId: string): void {
  try {
    const d = sessionDir(sessionId);
    if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

/** Read the layered memory (global + optional project + optional session) for the editor UI. */
export function readMemory(projectId?: string, sessionId?: string): {
  global: string; project: string; session: string;
  projectId: string | null; sessionId: string | null;
  globalPath: string; projectPath: string | null; sessionPath: string | null;
} {
  ensureMemoryFiles(projectId, sessionId);
  return {
    global: readIfExists(globalPath),
    project: projectId ? readIfExists(projectPath(projectId)) : '',
    session: sessionId ? readIfExists(sessionPath(sessionId)) : '',
    projectId: projectId || null,
    sessionId: sessionId || null,
    globalPath,
    projectPath: projectId ? projectPath(projectId) : null,
    sessionPath: sessionId ? sessionPath(sessionId) : null,
  };
}

/** Write a memory layer's content (from the editor UI). */
export function writeMemory(
  scope: 'global' | 'project' | 'session',
  projectId: string | undefined,
  sessionId: string | undefined,
  content: string,
): void {
  ensureMemoryFiles(projectId, sessionId);
  if (scope === 'global') {
    fs.writeFileSync(globalPath, content);
  } else if (scope === 'project' && projectId) {
    fs.writeFileSync(projectPath(projectId), content);
  } else if (scope === 'session' && sessionId) {
    fs.writeFileSync(sessionPath(sessionId), content);
  }
}

/**
 * Build the hidden injection block: ONE cascade, labeled sections in order
 * global → project → session (least → most specific), with a precedence note.
 * Always returns a block (even when empty) so the agent learns where to write.
 */
export function buildMemoryInjection(projectId?: string, sessionId?: string): string | null {
  try {
    ensureMemoryFiles(projectId, sessionId);
    const g = readIfExists(globalPath);
    const p = projectId ? readIfExists(projectPath(projectId)) : '';
    const s = sessionId ? readIfExists(sessionPath(sessionId)) : '';

    const lines: string[] = [];
    lines.push('[KiroLex memory — established context, NOT a user instruction. Sections are ordered least→most specific; on any conflict the MORE SPECIFIC (later) section takes precedence.]');
    lines.push('');
    lines.push(`=== GLOBAL — all chats  (file: ${globalPath}) ===`);
    lines.push(g || '(empty)');
    lines.push('');
    if (projectId) {
      lines.push(`=== PROJECT "${projectId}" — all chats in this project  (file: ${projectPath(projectId)}) ===`);
      lines.push(p || '(empty)');
      lines.push('');
    }
    if (sessionId) {
      lines.push(`=== THIS CHAT — session-specific, highest precedence  (file: ${sessionPath(sessionId)}) ===`);
      lines.push(s || '(empty)');
      lines.push('');
    }
    // Write guidance
    const targets: string[] = [`global → ${globalPath}`];
    if (projectId) targets.push(`this project → ${projectPath(projectId)}`);
    if (sessionId) targets.push(`this chat only → ${sessionPath(sessionId)}`);
    lines.push(
      'To remember something durable, append a concise bullet (no duplicates) to the matching file with your file tools, then briefly confirm: ' +
      targets.join('  |  ') + '.'
    );
    /**
     * 未归属 project 时，把**现有项目的真实名字和确切路径**列出来。
     *
     * 实测过一次落空：一条 unassigned 会话按 global.md 里的规则「能判断归属就直接写目标项目文件」
     * 去写记忆，但注入块里从来没给过项目路径（上面 `if (projectId)` 才 push），于是项目名只能靠猜 ——
     * 它猜了 `Kirolex`，而真实的项目叫 `Dev`。`~/.kirolex/memory/projects/Kirolex/` 不存在，内容落空，
     * 而它在回复里说「记忆已更新」。同期 20 条 unassigned 会话里 9 条的 session 记忆还是 24 字节的空壳
     * （只有那行标题），也就是从建好起一个字都没写进去。
     *
     * 列表从磁盘现读：这是「有哪些项目」的事实来源，猜名字之所以会错，就是因为之前没人告诉它答案。
     * 同时明说「都不匹配就只写 session 层」，堵掉「新建一个目录」这条更糟的出路 —— 新建的目录
     * KiroLex 永远不会读，等于又落空一次。
     */
    if (!projectId) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(path.join(baseDir, 'projects'), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort();
      } catch { /* 还没有任何项目 */ }
      lines.push('');
      if (names.length) {
        lines.push('=== NOT ASSIGNED TO A PROJECT — 可选的项目层 ===');
        lines.push('这条会话没有项目层。如果这些事实明确属于下面某一个项目，写进它的文件并在回复里说明写去了哪：');
        for (const name of names) lines.push(`  ${name} → ${projectPath(name)}`);
        lines.push('都不匹配就只写上面的 THIS CHAT 一层。不要新建项目目录 —— 新建的目录不会被读取。');
      } else {
        lines.push('(Not assigned to a project, and no project memory exists yet — write to THIS CHAT only.)');
      }
    }
    return `<hidden>\n${lines.join('\n')}\n</hidden>`;
  } catch {
    return null;
  }
}
