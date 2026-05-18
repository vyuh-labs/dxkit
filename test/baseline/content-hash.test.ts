import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CONTENT_HASH_CONTEXT_LINES,
  computeContentHash,
  computeContentHashFromCommit,
  readFileFromCommit,
} from '../../src/baseline/content-hash';

function lines(...ls: string[]): string {
  return ls.join('\n') + '\n';
}

describe('computeContentHash — pure function', () => {
  const sample = lines(
    'function refund(orderId) {',
    '  const order = db.find(orderId);',
    '  if (!order) throw new Error("not found");',
    '  return processor.refund(order);',
    '}',
  );

  it('produces a 16-char lowercase hex string', () => {
    const hash = computeContentHash(sample, 3);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical inputs', () => {
    expect(computeContentHash(sample, 3)).toBe(computeContentHash(sample, 3));
  });

  it('returns the same hash for the same context regardless of where it sits in the file', () => {
    // Build two files where the ±3-line window around the target
    // line is byte-identical, but the target sits at different line
    // numbers in each file. The hash must agree.
    const fileA = lines(
      '// pre1',
      '// pre2',
      '// pre3',
      'a();',
      'TARGET();', // line 5 in fileA
      'b();',
      '// post1',
      '// post2',
      '// post3',
    );
    const fileB = lines(
      '// extra-1',
      '// extra-2',
      '// extra-3',
      '// extra-4',
      '// pre1',
      '// pre2',
      '// pre3',
      'a();',
      'TARGET();', // line 9 in fileB
      'b();',
      '// post1',
      '// post2',
      '// post3',
    );
    expect(computeContentHash(fileA, 5)).toBe(computeContentHash(fileB, 9));
  });

  it('changes when a context line is edited', () => {
    const edited = lines(
      'function refund(orderId) {',
      '  const order = db.findById(orderId);', // changed
      '  if (!order) throw new Error("not found");',
      '  return processor.refund(order);',
      '}',
    );
    expect(computeContentHash(sample, 3)).not.toBe(computeContentHash(edited, 3));
  });

  it('is insensitive to whitespace-only differences', () => {
    const reformatted = lines(
      'function refund(orderId) {',
      '   const order  =  db.find(orderId);', // extra spaces, tabs vs spaces would also normalize
      '   if (!order) throw new Error("not found");',
      '   return processor.refund(order);',
      '}',
    );
    expect(computeContentHash(sample, 3)).toBe(computeContentHash(reformatted, 3));
  });

  it('respects the contextLines parameter', () => {
    // Smaller window → less surrounding context → different hash.
    const narrow = computeContentHash(sample, 3, 1);
    const wide = computeContentHash(sample, 3, 3);
    expect(narrow).not.toBe(wide);
  });

  it('handles lines near the file edges by clamping the window', () => {
    const short = lines('only one line');
    // Line 1 with default 3-line context — window clamps to the single line.
    const hash = computeContentHash(short, 1);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('exposes the default context-line count as a constant', () => {
    expect(CONTENT_HASH_CONTEXT_LINES).toBeGreaterThan(0);
    expect(CONTENT_HASH_CONTEXT_LINES).toBeLessThan(20); // sanity bound
  });
});

describe('readFileFromCommit + computeContentHashFromCommit — git I/O', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-content-hash-'));
    execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function commit(msg: string): string {
    execFileSync('git', ['add', '-A'], { cwd: dir });
    execFileSync('git', ['commit', '--quiet', '-m', msg], { cwd: dir });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  }

  it('reads file content from a past commit', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one', 'two', 'three'));
    const sha = commit('initial');
    const content = readFileFromCommit(dir, sha, 'a.ts');
    expect(content).toBe(lines('one', 'two', 'three'));
  });

  it('returns null when the file did not exist at the commit', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one'));
    const sha = commit('initial');
    expect(readFileFromCommit(dir, sha, 'b.ts')).toBeNull();
  });

  it('returns null when the commit SHA is unreachable', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one'));
    commit('initial');
    expect(readFileFromCommit(dir, '0000000000000000000000000000000000000000', 'a.ts')).toBeNull();
  });

  it('computes a content hash directly from a commit-and-line pair', () => {
    writeFileSync(join(dir, 'a.ts'), lines('alpha', 'beta', 'gamma', 'delta', 'epsilon'));
    const sha = commit('initial');
    const hash = computeContentHashFromCommit(dir, sha, 'a.ts', 3);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    // Should match the pure-function output on the same content.
    const expected = computeContentHash(lines('alpha', 'beta', 'gamma', 'delta', 'epsilon'), 3);
    expect(hash).toBe(expected);
  });

  it('returns null from computeContentHashFromCommit when the file is missing', () => {
    writeFileSync(join(dir, 'a.ts'), lines('one'));
    const sha = commit('initial');
    expect(computeContentHashFromCommit(dir, sha, 'missing.ts', 1)).toBeNull();
  });
});
