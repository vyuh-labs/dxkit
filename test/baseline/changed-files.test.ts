import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeChangedFiles } from '../../src/baseline/changed-files';

/**
 * `computeChangedFiles` is the safety core of incremental scanning (opt 3):
 * if it ever UNDER-reports the changed set, the gather skips a file that
 * really changed and misses a net-new finding — a false negative in a
 * safety gate. So these tests pin the two non-negotiables: the set is
 * COMPLETE (tracked edits + untracked, no false omissions), and ANY
 * uncertainty yields `null` (→ caller does a full scan), never a partial set.
 */

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
}

function commitAll(repo: string, msg: string): string {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-qm', msg]);
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

describe('computeChangedFiles', () => {
  let repo: string;
  let base: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-changed-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.co']);
    git(repo, ['config', 'user.name', 't']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    base = commitAll(repo, 'base');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('reports nothing changed on a clean tree at the base', () => {
    expect(computeChangedFiles(repo, base)).toEqual([]);
  });

  it('detects a modified tracked file (unstaged)', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 99;\n');
    expect(computeChangedFiles(repo, base)).toEqual(['src/a.ts']);
  });

  it('detects a staged-but-uncommitted change', () => {
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 42;\n');
    git(repo, ['add', 'src/b.ts']);
    expect(computeChangedFiles(repo, base)).toEqual(['src/b.ts']);
  });

  it('detects an untracked new file', () => {
    writeFileSync(join(repo, 'src', 'c.ts'), 'export const c = 3;\n');
    const changed = computeChangedFiles(repo, base);
    expect(changed).toContain('src/c.ts');
  });

  it('detects changes committed AFTER the base (HEAD ahead of base)', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 7;\n');
    commitAll(repo, 'later');
    // base is the parent commit; the working tree differs from it.
    expect(computeChangedFiles(repo, base)).toEqual(['src/a.ts']);
  });

  it('excludes a deleted file (no current content to scan)', () => {
    unlinkSync(join(repo, 'src', 'b.ts'));
    const changed = computeChangedFiles(repo, base);
    // b.ts changed (deleted) vs base, but has no on-disk content — must not
    // appear in the scan set.
    expect(changed).not.toContain('src/b.ts');
  });

  it('returns null for an unreachable base SHA (→ caller full-scans)', () => {
    expect(computeChangedFiles(repo, '0000000000000000000000000000000000000000')).toBeNull();
  });

  it('returns null for an empty base', () => {
    expect(computeChangedFiles(repo, '')).toBeNull();
  });

  it('returns null outside a git repo (→ caller full-scans)', () => {
    const plain = mkdtempSync(join(tmpdir(), 'dxkit-nogit-'));
    try {
      expect(computeChangedFiles(plain, 'HEAD')).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
