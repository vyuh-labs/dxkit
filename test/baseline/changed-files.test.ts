import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { computeChangedFiles, createChangedLineIndex } from '../../src/baseline/changed-files';

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

describe('createChangedLineIndex (line-granularity sibling — same working-tree basis)', () => {
  let repo: string;
  let base: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-changed-lines-'));
    git(repo, ['init', '-q', '-b', 'main']);
    git(repo, ['config', 'user.email', 't@t.co']);
    git(repo, ['config', 'user.name', 't']);
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.ts'), 'line one\nline two\nline three\n');
    base = commitAll(repo, 'base');
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('attributes an UNCOMMITTED (unstaged) edit — the T1.1 hole', () => {
    // At Stop time an agent's edits are dirty. Attribution that diffed
    // committed HEAD saw an empty diff here and demoted the finding.
    writeFileSync(join(repo, 'src', 'a.ts'), 'line one\nEDITED two\nline three\n');
    const idx = createChangedLineIndex(repo, base);
    expect(idx).not.toBeNull();
    const lines = idx!.linesFor('src/a.ts');
    expect(lines).not.toBe('all');
    expect(lines).not.toBeNull();
    expect([...(lines as ReadonlySet<number>)]).toEqual([2]);
  });

  it('attributes a staged-but-uncommitted edit', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'line one\nline two\nline three\nline four\n');
    git(repo, ['add', 'src/a.ts']);
    const idx = createChangedLineIndex(repo, base)!;
    expect([...(idx.linesFor('src/a.ts') as ReadonlySet<number>)]).toEqual([4]);
  });

  it('attributes a committed edit (HEAD ahead of base)', () => {
    writeFileSync(join(repo, 'src', 'a.ts'), 'CHANGED one\nline two\nline three\n');
    commitAll(repo, 'later');
    const idx = createChangedLineIndex(repo, base)!;
    expect([...(idx.linesFor('src/a.ts') as ReadonlySet<number>)]).toEqual([1]);
  });

  it("reports 'all' for an untracked file — every line is this change's work", () => {
    writeFileSync(join(repo, 'src', 'new.ts'), 'brand\nnew\nfile\n');
    const idx = createChangedLineIndex(repo, base)!;
    expect(idx.linesFor('src/new.ts')).toBe('all');
  });

  it('reports an empty set for an unchanged file', () => {
    const idx = createChangedLineIndex(repo, base)!;
    const lines = idx.linesFor('src/a.ts');
    expect(lines).not.toBe('all');
    expect((lines as ReadonlySet<number>).size).toBe(0);
  });

  it('returns null (unknown-everywhere) for an empty base', () => {
    expect(createChangedLineIndex(repo, '')).toBeNull();
  });

  it('reports null (unknown) for a file when the base SHA is unreachable — never an empty set', () => {
    // An unreadable diff must read as CANNOT-ATTRIBUTE (no demotion), not as
    // "nothing changed" (silent demotion of a real finding).
    const idx = createChangedLineIndex(repo, '0000000000000000000000000000000000000000')!;
    expect(idx.linesFor('src/a.ts')).toBeNull();
  });

  it('PARITY: every file computeChangedFiles reports has non-empty line attribution', () => {
    // The Rule 2.30 net: file-level and line-level discovery are two
    // projections of one concept and must agree. A file the file-level
    // sibling calls "changed" whose line attribution comes back empty
    // means the two paths diverged on diff basis again.
    writeFileSync(join(repo, 'src', 'a.ts'), 'line one\nEDITED two\nline three\n'); // unstaged
    writeFileSync(join(repo, 'src', 'b.ts'), 'staged\n'); // staged new content
    git(repo, ['add', 'src/b.ts']);
    writeFileSync(join(repo, 'src', 'c.ts'), 'untracked\n'); // untracked
    const files = computeChangedFiles(repo, base)!;
    expect(files.length).toBeGreaterThanOrEqual(3);
    const idx = createChangedLineIndex(repo, base)!;
    for (const file of files) {
      const lines = idx.linesFor(file);
      const attributed = lines === 'all' || (lines !== null && lines.size > 0);
      expect(attributed, `no line attribution for changed file ${file}`).toBe(true);
    }
  });
});
