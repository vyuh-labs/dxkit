import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { identityFor } from '../../src/baseline/finding-identity';
import { gitAwareMatch, mapLineThroughDiff } from '../../src/baseline/git-aware-match';
import type { LocatedIdentity } from '../../src/baseline/git-aware-match';

/**
 * Spin up an isolated git repo in the OS temp dir. Every test gets
 * a fresh directory, deterministic config (user identity, no GPG
 * signing), and a clean working tree.
 */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-baseline-'));
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

function commit(dir: string, message: string): string {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

function lines(...ls: string[]): string {
  return ls.join('\n') + '\n';
}

describe('mapLineThroughDiff', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the same line when revisions are identical', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three'));
    const sha = commit(dir, 'initial');
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: sha, headSha: sha, file: 'a.ts', baseLine: 2 }),
    ).toBe(2);
  });

  it('shifts a line down by an insertion above it', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three'));
    const base = commit(dir, 'initial');
    writeFileSync(join(dir, 'a.ts'), lines('new-a', 'new-b', 'new-c', 'one', 'two', 'three'));
    const head = commit(dir, 'prepend three lines');
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: base, headSha: head, file: 'a.ts', baseLine: 2 }),
    ).toBe(5);
  });

  it('shifts a line up by a deletion above it', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three', 'four', 'five'));
    const base = commit(dir, 'initial');
    writeFileSync(join(dir, 'a.ts'), lines('four', 'five'));
    const head = commit(dir, 'drop first three');
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: base, headSha: head, file: 'a.ts', baseLine: 4 }),
    ).toBe(1);
  });

  it('returns null when the line itself was deleted', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three'));
    const base = commit(dir, 'initial');
    writeFileSync(join(dir, 'a.ts'), lines('one', 'three'));
    const head = commit(dir, 'drop the middle');
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: base, headSha: head, file: 'a.ts', baseLine: 2 }),
    ).toBeNull();
  });

  it('handles multiple hunks with cumulative shift', () => {
    writeFileSync(
      join(dir, 'a.ts'),
      lines('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'),
    );
    const base = commit(dir, 'initial');
    writeFileSync(
      join(dir, 'a.ts'),
      // Insert one line before line 2; delete line 6; nothing else changes.
      lines('one', 'INSERTED', 'two', 'three', 'four', 'five', 'seven', 'eight', 'nine'),
    );
    const head = commit(dir, 'mixed edits');
    // base line 5 ('five') survives, ends up at head line 6 (one inserted above it).
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: base, headSha: head, file: 'a.ts', baseLine: 5 }),
    ).toBe(6);
    // base line 8 ('eight') survives the deletion above: shift is +1 - 1 = 0.
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: base, headSha: head, file: 'a.ts', baseLine: 8 }),
    ).toBe(8);
  });

  it('returns null when the file no longer exists at head', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three'));
    const base = commit(dir, 'initial');
    rmSync(join(dir, 'a.ts'));
    const head = commit(dir, 'remove a.ts');
    expect(
      mapLineThroughDiff({ cwd: dir, baseSha: base, headSha: head, file: 'a.ts', baseLine: 2 }),
    ).toBeNull();
  });
});

describe('gitAwareMatch', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function findingAt(file: string, line: number, rule = 'demo-rule'): LocatedIdentity {
    return {
      id: identityFor({ kind: 'code', tool: 'semgrep', rule, file, line }),
      file,
      line,
      rule,
    };
  }

  it('persists exact identity matches without consulting git', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two'));
    const sha = commit(dir, 'initial');
    const prior = [findingAt('a.ts', 2)];
    const current = [findingAt('a.ts', 2)];
    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: sha, headSha: sha });
    expect(result.persisted.length).toBe(1);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('pairs prior+current across a vertical insertion that crosses the line-bucket boundary', () => {
    // Twelve-line insertion at top: a finding at line 42 in base ends up at
    // line 54 in head. Line-bucket fingerprints (3-line buckets at 42 vs 54)
    // differ — exact-id match alone reports "removed + added." Git-aware
    // match should re-pair them.
    const baseContent = Array.from({ length: 50 }, (_, i) => `base-${i + 1}`);
    writeFileSync(join(dir, 'a.ts'), baseContent.join('\n') + '\n');
    const base = commit(dir, 'initial');
    const headContent = [...Array.from({ length: 12 }, (_, i) => `top-${i + 1}`), ...baseContent];
    writeFileSync(join(dir, 'a.ts'), headContent.join('\n') + '\n');
    const head = commit(dir, 'prepend 12 lines');

    const prior = [findingAt('a.ts', 42)];
    const current = [findingAt('a.ts', 54)];
    expect(prior[0].id).not.toBe(current[0].id); // confirm bucket-different

    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: base, headSha: head });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.persisted.length).toBe(2); // both ids reported as persisted
    expect(new Set(result.persisted)).toEqual(new Set([prior[0].id, current[0].id]));
  });

  it('marks a deleted-line finding as removed and a fresh finding as added', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three', 'four', 'five'));
    const base = commit(dir, 'initial');
    writeFileSync(join(dir, 'a.ts'), lines('one', 'three', 'four', 'NEW-FIVE'));
    const head = commit(dir, 'delete line2, replace last line');

    const prior = [findingAt('a.ts', 2), findingAt('a.ts', 5)];
    const current = [findingAt('a.ts', 4)]; // 'NEW-FIVE' at line 4 in head

    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: base, headSha: head });
    // prior:2 was deleted → removed. prior:5 maps to head:4 (after -1 shift),
    // but current[0] is at head:4 — pair matches → persisted.
    expect(new Set(result.removed)).toEqual(new Set([prior[0].id]));
    expect(result.added).toEqual([]);
    expect(new Set(result.persisted)).toEqual(new Set([prior[1].id, current[0].id]));
  });

  it('falls back to set-diff when the base SHA is unreachable', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three', 'four', 'five'));
    commit(dir, 'initial');
    // Lines 1 and 4 fall into different line-window buckets (bucket 0
    // vs bucket 3) so their identities differ — confirms the matcher
    // actually attempted (and failed) the git-aware fallback rather
    // than the test trivially passing on bucket collision.
    const prior = [findingAt('a.ts', 1)];
    const current = [findingAt('a.ts', 4)];
    expect(prior[0].id).not.toBe(current[0].id);
    const result = gitAwareMatch(prior, current, {
      cwd: dir,
      baseSha: '0000000000000000000000000000000000000000', // not in repo
    });
    // No git fallback → reports as removed+added without pairing.
    expect(new Set(result.removed)).toEqual(new Set([prior[0].id]));
    expect(new Set(result.added)).toEqual(new Set([current[0].id]));
    expect(result.persisted).toEqual([]);
  });

  it('treats non-line-anchored findings via exact identity only', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one'));
    const sha = commit(dir, 'initial');
    // A dep-vuln identity has no file/line — must be matched by exact id alone.
    const depId = identityFor({
      kind: 'dep-vuln',
      package: 'fixture-pkg',
      installedVersion: '1.0.0',
      id: 'GHSA-aaaa-bbbb-cccc',
    });
    const prior: LocatedIdentity[] = [{ id: depId }];
    const current: LocatedIdentity[] = [{ id: depId }];
    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: sha });
    expect(result.persisted).toEqual([depId]);
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  it('does not pair findings with different rules even on the same line', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two'));
    const base = commit(dir, 'initial');
    writeFileSync(join(dir, 'a.ts'), lines('zero', 'one', 'two'));
    const head = commit(dir, 'prepend');

    const prior = [findingAt('a.ts', 1, 'rule-A')];
    const current = [findingAt('a.ts', 2, 'rule-B')];
    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: base, headSha: head });
    expect(new Set(result.removed)).toEqual(new Set([prior[0].id]));
    expect(new Set(result.added)).toEqual(new Set([current[0].id]));
    expect(result.persisted).toEqual([]);
  });

  it('pairs across a file rename — status is "relocated", not "persisted"', () => {
    writeFileSync(join(dir, 'old-path.ts'), lines('one', 'two', 'three'));
    const base = commit(dir, 'initial');
    execFileSync('git', ['mv', 'old-path.ts', 'new-path.ts'], { cwd: dir });
    const head = commit(dir, 'rename old-path → new-path');

    const prior = [findingAt('old-path.ts', 2)];
    const current = [findingAt('new-path.ts', 2)];
    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: base, headSha: head });

    expect(result.removed).toEqual([]);
    expect(result.added).toEqual([]);
    expect(result.pairs).toHaveLength(1);
    const [pair] = result.pairs;
    expect(pair.status).toBe('relocated');
    expect(pair.priorId).toBe(prior[0].id);
    expect(pair.currentId).toBe(current[0].id);
    expect(pair.reasons.some((r) => r.code === 'git-rename')).toBe(true);
  });

  it('pairs via line-fuzz when the scanner reports a slightly different line', () => {
    writeFileSync(join(dir, 'a.ts'), lines('alpha', 'beta', 'gamma'));
    const base = commit(dir, 'initial');
    writeFileSync(
      join(dir, 'a.ts'),
      lines('TOP-1', 'TOP-2', 'TOP-3', 'TOP-4', 'TOP-5', 'alpha', 'beta', 'gamma'),
    );
    const head = commit(dir, 'prepend 5 lines');

    // Prior finding at line 2 → git diff maps to line 7. Pretend the
    // scanner reported the current finding at line 8 instead — within
    // the ±2 fuzz window. Different identity (different buckets).
    const prior = [findingAt('a.ts', 2)];
    const current = [findingAt('a.ts', 8)];
    expect(prior[0].id).not.toBe(current[0].id);

    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: base, headSha: head });
    expect(result.pairs).toHaveLength(1);
    const [pair] = result.pairs;
    expect(pair.status).toBe('persisted');
    expect(pair.confidence).toBeLessThan(1.0);
    expect(pair.reasons[0].code).toBe('git-line-fuzz');
  });

  it('reports degraded mode with a reason when the base SHA is unreachable', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one'));
    commit(dir, 'initial');
    const result = gitAwareMatch([], [], {
      cwd: dir,
      baseSha: '0000000000000000000000000000000000000000',
    });
    expect(result.gitAware).toBe(false);
    expect(result.degradedReason).toBeDefined();
    expect(result.degradedReason).toMatch(/not reachable/);
  });

  it('exposes git-aware match reasons + confidence on pair entries', () => {
    writeFileSync(join(dir, 'a.ts'), lines('alpha', 'beta', 'gamma'));
    const base = commit(dir, 'initial');
    writeFileSync(join(dir, 'a.ts'), lines('top-1', 'top-2', 'top-3', 'alpha', 'beta', 'gamma'));
    const head = commit(dir, 'prepend 3 lines');

    const prior = [findingAt('a.ts', 1)];
    const current = [findingAt('a.ts', 4)];
    const result = gitAwareMatch(prior, current, { cwd: dir, baseSha: base, headSha: head });
    expect(result.gitAware).toBe(true);
    const [pair] = result.pairs;
    expect(pair.confidence).toBe(0.95);
    expect(pair.reasons[0].code).toBe('git-line-exact');
    expect(pair.reasons[0].detail).toContain('a.ts:1');
    expect(pair.reasons[0].detail).toContain('a.ts:4');
  });
});
