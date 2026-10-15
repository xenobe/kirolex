import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The file viewer must track the file, not a snapshot of it.
 *
 * It used to read once on open and never again -- and re-opening an already-open path
 * only focused its tab -- so a file the agent rewrote kept showing the old text with
 * nothing to say it was out of date.
 *
 * Verified live before these were written (CDP, dev port): in-place write, atomic
 * rename, a SECOND atomic rename, and deletion all reflected; scroll held at 3000px
 * across a refresh; a background tab stayed untouched and was re-read on activation.
 */
const ROOT = path.join(import.meta.dirname, '..');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'App.tsx'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'src', 'main', 'preload.ts'), 'utf8');

describe('the viewer watches the files it has open', () => {
  const handler = main.slice(main.indexOf("ipcMain.handle('workspace:watch-files'"));
  const body = handler.slice(0, handler.indexOf('\n  ipcMain.handle', 10));

  test('the DIRECTORY is watched, not the file path', () => {
    // A save is usually write-temp + rename, which replaces the inode. `fs.watch` on the
    // file follows the OLD inode and goes silent after exactly one such save -- a viewer
    // that refreshes once and then never again. The live test does two renames in a row
    // precisely to catch that.
    assert.match(body, /fs\.watch\(dir, \(_type, changed\) =>/);
    assert.match(body, /viewerFiles\.get\(dir\)\?\.has\(name\)/, 'filter by basename');
    assert.doesNotMatch(body, /fs\.watch\(full/, 'per-file watchers do not survive a rename');
  });

  test('events are debounced and the set is replaced, not appended to', () => {
    // One save emits several events (rename + change), and a build can rewrite a file
    // many times a second.
    assert.match(body, /viewerDebounce\.set\(full2, setTimeout\(/);
    assert.match(body, /stopViewerWatch\(\);/, 'each call must replace the previous set');
    assert.match(main, /function stopViewerWatch\(\): void \{[\s\S]*?viewerWatchers\.clear\(\)/);
  });

  test('a deleted file is reported as such rather than dropped', () => {
    assert.match(body, /let exists = true;[\s\S]*?catch \{ exists = false; \}/);
    assert.match(body, /send\('workspace:file-changed', \{ path: full2, exists, mtimeMs \}\)/);
  });

  test('the bridge is exposed both ways', () => {
    assert.match(preload, /workspaceWatchFiles: \(sessionId/);
    assert.match(preload, /onWorkspaceFileChanged: \(callback/);
  });
});

describe('a refresh keeps what the user chose', () => {
  const fn = app.slice(app.indexOf('const refreshFileTab = useCallback'));
  const body = fn.slice(0, fn.indexOf('}, [currentSessionId]);') + 24);

  test('the rendered/source choice survives', () => {
    // `...result` would otherwise reset `raw` to undefined on every save.
    assert.match(body, /\{ \.\.\.t, \.\.\.result, raw: t\.raw, stale: false, gone: false \}/);
  });

  test('a failed re-read does not wipe the content', () => {
    // Mid-write or a permissions change is a reason to flag the tab, not to lose what
    // the user was reading.
    assert.match(body, /catch \(err: any\) \{[\s\S]*?gone: true/);
    assert.doesNotMatch(body, /content: ''/);
  });

  test('only the visible tab is re-read; the others are marked', () => {
    assert.match(app, /if \(hit\.id === activeFileTabIdRef\.current\) void refreshFileTab\(hit\.id, hit\.path\);/);
    assert.match(app, /else setFileTabs\(\(prev\) => prev\.map\(\(t\) => \(t\.id === hit\.id \? \{ \.\.\.t, stale: true \} : t\)\)\);/);
    // ...and picked up the moment it becomes visible.
    assert.match(app, /if \(tab\?\.stale\) void refreshFileTab\(tab\.id, tab\.path\);/);
  });

  test('a manual refresh exists too', () => {
    // fs.watch does not fire for every writer on every filesystem (network mounts,
    // some container bind mounts), and the button costs nothing when it does.
    assert.match(app, /⟳ 刷新/);
    assert.match(app, /onClick=\{\(\) => void refreshFileTab\(fileViewer\.id, fileViewer\.path\)\}/);
  });
});
