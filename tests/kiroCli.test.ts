import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { kiroCliCandidates, resolveKiroCli } from '../src/main/acp-client.ts';

/**
 * These cover the lookup that decides whether the model list, agent list, session list
 * and usage panel work at all. They used to shell out to the bare name `kiro-cli` and
 * rely on PATH, which fails on Windows (PATH is deliberately not augmented there) and
 * on any install reachable only through KIRO_CLI_PATH.
 */

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['KIRO_CLI_PATH', 'LOCALAPPDATA', 'APPDATA', 'HOME']) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('kiroCliCandidates', () => {
  test('KIRO_CLI_PATH is tried FIRST, so an explicit override always wins', () => {
    process.env.KIRO_CLI_PATH = '/custom/kiro-cli';
    assert.equal(kiroCliCandidates()[0], '/custom/kiro-cli');
  });

  test('covers the Windows install layouts', () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local';
    process.env.APPDATA = 'C:\\Users\\me\\AppData\\Roaming';
    const c = kiroCliCandidates();
    assert.ok(c.includes('C:\\Users\\me\\AppData\\Local\\Kiro-Cli\\kiro-cli.exe'));
    assert.ok(c.includes('C:\\Users\\me\\AppData\\Local\\Programs\\kiro-cli\\kiro-cli.exe'));
    assert.ok(c.includes('C:\\Users\\me\\AppData\\Roaming\\kiro-cli\\kiro-cli.exe'));
  });

  test('covers the macOS/Linux install layouts', () => {
    process.env.HOME = '/Users/me';
    const c = kiroCliCandidates();
    assert.ok(c.includes('/Users/me/.local/bin/kiro-cli'));
    assert.ok(c.includes('/usr/local/bin/kiro-cli'));
    assert.ok(c.includes('/opt/homebrew/bin/kiro-cli'));
  });

  test('an unset KIRO_CLI_PATH is dropped rather than becoming "undefined"', () => {
    delete process.env.KIRO_CLI_PATH;
    for (const c of kiroCliCandidates()) assert.ok(!c.includes('undefined/'), c);
  });
});

describe('resolveKiroCli', () => {
  test('returns the override when it exists on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kirocli-'));
    const bin = path.join(dir, 'kiro-cli');
    fs.writeFileSync(bin, '#!/bin/sh\n');
    process.env.KIRO_CLI_PATH = bin;
    try {
      assert.equal(resolveKiroCli(), bin);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skips an override that does not exist and keeps searching', () => {
    process.env.KIRO_CLI_PATH = '/definitely/not/here/kiro-cli';
    const got = resolveKiroCli();
    assert.notEqual(got, '/definitely/not/here/kiro-cli');
    // Either a real install on this machine, or null. Never the bogus override.
    if (got !== null) assert.ok(fs.existsSync(got));
  });

  test('null when nothing resolves, so the caller can fall back to PATH', () => {
    process.env.KIRO_CLI_PATH = '/nope/kiro-cli';
    process.env.LOCALAPPDATA = '/nope';
    process.env.APPDATA = '/nope';
    process.env.HOME = '/nope';
    // /usr/local/bin and /opt/homebrew/bin are absolute and may genuinely hold one.
    const got = resolveKiroCli();
    if (got === null) return;
    assert.ok(got === '/usr/local/bin/kiro-cli' || got === '/opt/homebrew/bin/kiro-cli', got);
  });
});
