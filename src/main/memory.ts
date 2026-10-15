import fs from 'fs';
import os from 'os';
import path from 'path';

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
    if (!projectId) {
      lines.push('(Not assigned to a project — assign it in KiroLex for a project layer.)');
    }
    return `<hidden>\n${lines.join('\n')}\n</hidden>`;
  } catch {
    return null;
  }
}
