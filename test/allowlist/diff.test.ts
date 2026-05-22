import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeAllowlistDelta, diffEntries } from '../../src/allowlist/diff';
import {
  ALLOWLIST_DIR,
  ALLOWLIST_FILENAME,
  ALLOWLIST_SCHEMA_VERSION,
  saveAllowlist,
  type AllowlistEntry,
  type AllowlistFile,
} from '../../src/allowlist/file';

function makeTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-allowlist-diff-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeEntry(partial: Partial<AllowlistEntry> & { fingerprint: string }): AllowlistEntry {
  return {
    kind: 'dep-vuln',
    category: 'accepted-risk',
    reason: 'r',
    addedBy: 'a@b.c',
    addedAt: '2026-05-22',
    expiresAt: '2026-08-22',
    ...partial,
  };
}

describe('diffEntries (pure)', () => {
  it('empty inputs → empty delta', () => {
    expect(diffEntries([], [])).toEqual({
      added: [],
      removed: [],
      baselineAccessible: true,
    });
  });

  it('added: entry in current only', () => {
    const e = makeEntry({ fingerprint: 'aaaa111111111111' });
    const d = diffEntries([], [e]);
    expect(d.added).toEqual([e]);
    expect(d.removed).toEqual([]);
  });

  it('removed: entry in prior only', () => {
    const e = makeEntry({ fingerprint: 'aaaa111111111111' });
    const d = diffEntries([e], []);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([e]);
  });

  it('persisted: matching fingerprints excluded from both sides', () => {
    const e = makeEntry({ fingerprint: 'aaaa111111111111' });
    const d = diffEntries([e], [e]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('hydrates the CURRENT side for added entries', () => {
    // Same fingerprint, different reason — current side should
    // appear in `added` only if fingerprint is new.
    const prior = makeEntry({ fingerprint: 'aaaa111111111111', reason: 'old' });
    const current = makeEntry({ fingerprint: 'aaaa111111111111', reason: 'new' });
    const d = diffEntries([prior], [current]);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('mixed prior + current', () => {
    const persistedPrior = makeEntry({ fingerprint: 'aaaa111111111111' });
    const persistedCurrent = makeEntry({ fingerprint: 'aaaa111111111111' });
    const onlyPrior = makeEntry({ fingerprint: 'bbbb111111111111' });
    const onlyCurrent = makeEntry({ fingerprint: 'cccc111111111111' });
    const d = diffEntries([persistedPrior, onlyPrior], [persistedCurrent, onlyCurrent]);
    expect(d.added.map((e) => e.fingerprint)).toEqual(['cccc111111111111']);
    expect(d.removed.map((e) => e.fingerprint)).toEqual(['bbbb111111111111']);
  });
});

describe('computeAllowlistDelta (git-aware)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
    // Initialize a tiny git repo so `git show <sha>:path` resolves.
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: tmp });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmp });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: tmp });
  });
  afterEach(() => {
    rmrf(tmp);
  });

  function commit(message: string): string {
    execFileSync('git', ['add', '-A'], { cwd: tmp });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: tmp });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: tmp, encoding: 'utf8' }).trim();
  }

  function writeAllowlist(entries: AllowlistEntry[]): void {
    const file: AllowlistFile = {
      schemaVersion: ALLOWLIST_SCHEMA_VERSION,
      mode: 'full',
      entries,
    };
    saveAllowlist(tmp, file);
  }

  function clearAllowlist(): void {
    const p = path.join(tmp, ALLOWLIST_DIR, ALLOWLIST_FILENAME);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  it('returns baselineAccessible: false when SHA is empty string', () => {
    const d = computeAllowlistDelta(tmp, '');
    expect(d).toEqual({ added: [], removed: [], baselineAccessible: false });
  });

  it('returns baselineAccessible: false when SHA is unreachable', () => {
    const d = computeAllowlistDelta(tmp, '0000000000000000000000000000000000000000');
    expect(d.baselineAccessible).toBe(false);
  });

  it('treats current entries as added when baseline SHA has no allowlist file', () => {
    // Initial commit, no allowlist file
    fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n');
    const baselineSha = commit('init');

    // Add allowlist on a later commit
    const newEntry = makeEntry({ fingerprint: 'aaaa111111111111' });
    writeAllowlist([newEntry]);
    commit('add allowlist');

    const d = computeAllowlistDelta(tmp, baselineSha);
    expect(d.baselineAccessible).toBe(true);
    expect(d.added.map((e) => e.fingerprint)).toEqual(['aaaa111111111111']);
    expect(d.removed).toEqual([]);
  });

  it('diffs allowlist between baseline SHA and current working tree', () => {
    const old = makeEntry({ fingerprint: 'aaaa111111111111', reason: 'old' });
    writeAllowlist([old]);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n');
    const baselineSha = commit('baseline');

    const persisted = makeEntry({ fingerprint: 'aaaa111111111111', reason: 'old' });
    const fresh = makeEntry({ fingerprint: 'bbbb111111111111', reason: 'new' });
    writeAllowlist([persisted, fresh]);
    // Don't even need to commit — working tree IS the "current."

    const d = computeAllowlistDelta(tmp, baselineSha);
    expect(d.baselineAccessible).toBe(true);
    expect(d.added.map((e) => e.fingerprint)).toEqual(['bbbb111111111111']);
    expect(d.removed).toEqual([]);
  });

  it('detects removed entries on the current branch', () => {
    const a = makeEntry({ fingerprint: 'aaaa111111111111' });
    const b = makeEntry({ fingerprint: 'bbbb111111111111' });
    writeAllowlist([a, b]);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n');
    const baselineSha = commit('baseline with two entries');

    // Current state: only b remains
    writeAllowlist([b]);

    const d = computeAllowlistDelta(tmp, baselineSha);
    expect(d.added).toEqual([]);
    expect(d.removed.map((e) => e.fingerprint)).toEqual(['aaaa111111111111']);
  });

  it('returns empty delta when current allowlist matches baseline', () => {
    const e = makeEntry({ fingerprint: 'aaaa111111111111' });
    writeAllowlist([e]);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n');
    const baselineSha = commit('baseline');

    // Working tree unchanged from baseline
    const d = computeAllowlistDelta(tmp, baselineSha);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
    expect(d.baselineAccessible).toBe(true);
  });

  it('handles "allowlist file deleted on current branch" via removed entries', () => {
    const e = makeEntry({ fingerprint: 'aaaa111111111111' });
    writeAllowlist([e]);
    fs.writeFileSync(path.join(tmp, 'README.md'), 'init\n');
    const baselineSha = commit('with allowlist');

    clearAllowlist();
    const d = computeAllowlistDelta(tmp, baselineSha);
    expect(d.added).toEqual([]);
    expect(d.removed.map((x) => x.fingerprint)).toEqual(['aaaa111111111111']);
  });
});
