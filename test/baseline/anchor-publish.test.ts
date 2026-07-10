import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { publishFilesToAnchorRef, readFromAnchorRef } from '../../src/baseline/anchor-publish';

/**
 * Real-git tests for the shared anchor writer/reader. A local bare repo stands
 * in for `origin` (the same transport a real remote takes); the "checkout" repo
 * has it wired as `origin`. We assert the plumbing publish lands a commit on the
 * side ref, accumulates unchanged files, prunes, and is idempotent — all WITHOUT
 * touching the checkout's working tree or index (verified via `git status`).
 */
const ANCHOR = 'dxkit-reports';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

describe('publishFilesToAnchorRef', () => {
  let bare: string;
  let repo: string;
  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'dxkit-anchor-bare-'));
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    repo = mkdtempSync(join(tmpdir(), 'dxkit-anchor-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@e.com');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'initial');
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', '-q', 'origin', 'main');
  });
  afterEach(() => {
    rmSync(bare, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it('publishes files to a fresh side ref and leaves the working tree untouched', () => {
    const before = git(repo, 'status', '--porcelain');
    const res = publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [
        { path: 'report-history.jsonl', content: '{"sha":"a"}\n' },
        { path: 'latest/dashboard.html', content: '<html>1</html>' },
      ],
      message: 'chore(reports): snapshot a',
    });
    expect(res.pushed).toBe(true);
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    // Working tree + index unchanged (plumbing, no checkout).
    expect(git(repo, 'status', '--porcelain')).toBe(before);
    // The side ref now has the files.
    expect(readFromAnchorRef(repo, ANCHOR, 'report-history.jsonl')).toBe('{"sha":"a"}\n');
    expect(readFromAnchorRef(repo, ANCHOR, 'latest/dashboard.html')).toBe('<html>1</html>');
  });

  it('accumulates: a second publish keeps unchanged files and updates changed ones', () => {
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [
        { path: 'report-history.jsonl', content: '{"sha":"a"}\n' },
        { path: 'keep.txt', content: 'unchanged' },
      ],
      message: 'a',
    });
    const res = publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [{ path: 'report-history.jsonl', content: '{"sha":"a"}\n{"sha":"b"}\n' }],
      message: 'b',
    });
    expect(res.pushed).toBe(true);
    // Appended file updated; the untouched file persists (accumulate).
    expect(readFromAnchorRef(repo, ANCHOR, 'report-history.jsonl')).toBe(
      '{"sha":"a"}\n{"sha":"b"}\n',
    );
    expect(readFromAnchorRef(repo, ANCHOR, 'keep.txt')).toBe('unchanged');
    // Two commits of history on the ref (read from the bare remote — the local
    // tracking ref is shallow after readFromAnchorRef's --depth=1 fetch).
    const log = git(bare, 'log', '--oneline', ANCHOR);
    expect(log.trim().split('\n')).toHaveLength(2);
  });

  it('prunes paths via removePaths', () => {
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [
        { path: 'snapshots/old/x.html', content: 'old' },
        { path: 'report-history.jsonl', content: '{"sha":"a"}\n' },
      ],
      message: 'a',
    });
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [{ path: 'report-history.jsonl', content: '{"sha":"a"}\n{"sha":"b"}\n' }],
      removePaths: ['snapshots/old/x.html'],
      message: 'b + prune',
    });
    expect(readFromAnchorRef(repo, ANCHOR, 'snapshots/old/x.html')).toBeNull();
    expect(readFromAnchorRef(repo, ANCHOR, 'report-history.jsonl')).toBe(
      '{"sha":"a"}\n{"sha":"b"}\n',
    );
  });

  it('is idempotent: re-publishing identical content pushes nothing', () => {
    const files = [{ path: 'report-history.jsonl', content: '{"sha":"a"}\n' }];
    publishFilesToAnchorRef({ cwd: repo, anchorRef: ANCHOR, files, message: 'a' });
    const res = publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files,
      message: 'a again',
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe('no change');
  });

  it('replace-all (baseParent:false) writes a parentless orphan commit', () => {
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [{ path: 'a.txt', content: '1' }],
      message: 'first',
    });
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [{ path: 'b.txt', content: '2' }],
      baseParent: false,
      message: 'orphan replace',
    });
    // Old file gone (replace-all), new file present, single commit (no parent).
    expect(readFromAnchorRef(repo, ANCHOR, 'a.txt')).toBeNull();
    expect(readFromAnchorRef(repo, ANCHOR, 'b.txt')).toBe('2');
    expect(git(bare, 'log', '--oneline', ANCHOR).trim().split('\n')).toHaveLength(1);
  });

  it('replace-all is idempotent too: identical content pushes nothing', () => {
    const files = [{ path: 'a.txt', content: '1' }];
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files,
      baseParent: false,
      message: 'a',
    });
    const res = publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files,
      baseParent: false,
      message: 'a again',
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBe('no change');
    // Still exactly one commit on the ref — the periodic refresh didn't churn it.
    expect(git(bare, 'log', '--oneline', ANCHOR).trim().split('\n')).toHaveLength(1);
  });

  it('replace-all self-heals: a deleted ref is recreated even when content is byte-identical', () => {
    const files = [{ path: 'a.txt', content: '1' }];
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files,
      baseParent: false,
      message: 'a',
    });
    // The side branch gets deleted on the remote (the failure class doctor's
    // deleted-anchor warning detects). The
    // local remote-tracking ref still remembers the old tip — the hard case:
    // resolveTip falls back to it (the fetch of a deleted ref fails), the tree
    // compares equal, and a naive no-change skip would leave the branch gone
    // until the content next changes. The writer must confirm the ref still
    // exists on the REMOTE before skipping.
    git(bare, 'update-ref', '-d', `refs/heads/${ANCHOR}`);
    const res = publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files,
      baseParent: false,
      message: 'recreate',
    });
    expect(res.pushed).toBe(true);
    expect(readFromAnchorRef(repo, ANCHOR, 'a.txt')).toBe('1');
  });

  it('returns pushed:false with a reason when there is no origin remote', () => {
    const noRemote = mkdtempSync(join(tmpdir(), 'dxkit-anchor-noremote-'));
    try {
      git(noRemote, 'init', '-q', '-b', 'main');
      const res = publishFilesToAnchorRef({
        cwd: noRemote,
        anchorRef: ANCHOR,
        files: [{ path: 'x', content: 'y' }],
        message: 'm',
      });
      expect(res.pushed).toBe(false);
      expect(res.reason).toBe('no origin remote');
    } finally {
      rmSync(noRemote, { recursive: true, force: true });
    }
  });

  it('readFromAnchorRef returns null for an unreachable ref', () => {
    expect(readFromAnchorRef(repo, 'never-created', 'x')).toBeNull();
  });
});
