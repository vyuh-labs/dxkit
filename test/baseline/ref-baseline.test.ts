import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  RefBaselineError,
  isShallowRepo,
  mirrorSaltFile,
  resolveRefToSha,
  withRefWorktree,
} from '../../src/baseline/ref-baseline';

/**
 * Real-git fixture tests for the ref-based gather path. Each test
 * builds a small git repo with a known structure, exercises the
 * worktree mechanics, then asserts the cleanup left no orphan
 * state behind.
 */

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-refbase-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir });
  return dir;
}

describe('resolveRefToSha', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns the SHA when the ref is reachable', () => {
    const sha = resolveRefToSha(dir, 'HEAD');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns the SHA for a named branch', () => {
    const sha = resolveRefToSha(dir, 'main');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('returns null when the ref does not exist', () => {
    expect(resolveRefToSha(dir, 'origin/never-existed')).toBeNull();
  });

  it('returns null when cwd is not a git repo', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dxkit-notgit-'));
    try {
      expect(resolveRefToSha(empty, 'HEAD')).toBeNull();
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('isShallowRepo', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns false on a normal clone', () => {
    expect(isShallowRepo(dir)).toBe(false);
  });

  it('returns false on a non-git directory (defensive fallback)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'dxkit-notgit-'));
    try {
      expect(isShallowRepo(empty)).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('mirrorSaltFile', () => {
  let src: string;
  let dst: string;
  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), 'dxkit-salt-src-'));
    dst = mkdtempSync(join(tmpdir(), 'dxkit-salt-dst-'));
  });
  afterEach(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(dst, { recursive: true, force: true });
  });

  it('no-ops when no salt file is present', () => {
    mirrorSaltFile(src, dst);
    expect(existsSync(join(dst, '.dxkit', 'salt'))).toBe(false);
  });

  it('copies the salt verbatim into the destination', () => {
    mkdirSync(join(src, '.dxkit'), { recursive: true });
    writeFileSync(join(src, '.dxkit', 'salt'), 'secret-salt-bytes');
    mirrorSaltFile(src, dst);
    expect(existsSync(join(dst, '.dxkit', 'salt'))).toBe(true);
    expect(readFileSync(join(dst, '.dxkit', 'salt'), 'utf-8')).toBe('secret-salt-bytes');
  });

  it('creates the .dxkit directory if absent', () => {
    mkdirSync(join(src, '.dxkit'), { recursive: true });
    writeFileSync(join(src, '.dxkit', 'salt'), 'x');
    expect(existsSync(join(dst, '.dxkit'))).toBe(false);
    mirrorSaltFile(src, dst);
    expect(existsSync(join(dst, '.dxkit', 'salt'))).toBe(true);
  });
});

describe('withRefWorktree', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeRepo();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('calls fn with a path to a temporary worktree containing the ref', async () => {
    let capturedPath: string | null = null;
    await withRefWorktree({ cwd: dir, ref: 'HEAD' }, async (worktreePath) => {
      capturedPath = worktreePath;
      expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);
      return null;
    });
    expect(capturedPath).not.toBeNull();
    // Cleanup must have removed the worktree dir.
    expect(existsSync(capturedPath!)).toBe(false);
  });

  it('passes the fn return value back to the caller', async () => {
    const value = await withRefWorktree({ cwd: dir, ref: 'HEAD' }, async () => ({ ok: 42 }));
    expect(value).toEqual({ ok: 42 });
  });

  it('cleans up the worktree even when fn throws', async () => {
    let capturedPath: string | null = null;
    await expect(
      withRefWorktree({ cwd: dir, ref: 'HEAD' }, async (worktreePath) => {
        capturedPath = worktreePath;
        throw new Error('intentional-failure-from-fn');
      }),
    ).rejects.toThrow('intentional-failure-from-fn');
    expect(capturedPath).not.toBeNull();
    expect(existsSync(capturedPath!)).toBe(false);
  });

  it('mirrors file-mode salt into the worktree', async () => {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'salt'), 'fixture-salt-secret');
    let observed: string | null = null;
    await withRefWorktree({ cwd: dir, ref: 'HEAD' }, async (worktreePath) => {
      const saltPath = join(worktreePath, '.dxkit', 'salt');
      observed = existsSync(saltPath) ? readFileSync(saltPath, 'utf-8') : null;
      return null;
    });
    expect(observed).toBe('fixture-salt-secret');
  });

  it('throws RefBaselineError with shallow-clone hint when the ref is not reachable', async () => {
    let captured: unknown;
    try {
      await withRefWorktree({ cwd: dir, ref: 'never-existed' }, async () => null);
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(RefBaselineError);
    const err = captured as RefBaselineError;
    expect(err.message).toContain('never-existed');
    expect(err.hint).toBeTruthy();
  });
});
