import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { existsSync, chmodSync } from 'fs';
import {
  announceAnchorNotPushed,
  describePushFailure,
  publishFilesToAnchorRef,
  readFromAnchorRef,
} from '../../src/baseline/anchor-publish';
import { anchorStalenessFromContents } from '../../src/baseline/anchor';

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

  it('fails FAST with a surfaced reason when origin is unreachable — never hangs (gh #156)', () => {
    // Point origin at a path that is not a git repo. With the terminal-prompt +
    // SSH BatchMode guards, the push errors immediately instead of blocking on a
    // credential prompt, and the reason is surfaced (not a silent 60s stall).
    git(repo, 'remote', 'set-url', 'origin', join(tmpdir(), 'dxkit-nonexistent-remote-xyz'));
    const start = Date.now();
    const res = publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: ANCHOR,
      files: [{ path: 'x', content: 'y' }],
      baseParent: false,
      message: 'm',
      timeoutMs: 10_000,
    });
    expect(res.pushed).toBe(false);
    expect(res.reason).toBeTruthy();
    expect(res.reason).not.toBe('no change');
    // Fast-fail: nowhere near the timeout.
    expect(Date.now() - start).toBeLessThan(9_000);
  });

  it('publishes even when a repo pre-push hook would block the push — runs --no-verify (gh #156)', () => {
    // THE root-cause regression test. dxkit's internal side-ref push is a machine
    // push; when dxkit is installed with git hooks, `core.hooksPath` is active in
    // the checkout, so a plain `git push` fires the repo's pre-push hook (dxkit's
    // own guardrail check) — which, under the exec timeout, got SIGTERM'd mid-run
    // → ETIMEDOUT, the "hang" #156 chased as an auth failure for four builds.
    // Wire a pre-push hook that BLOCKS any ordinary push, then assert the
    // primitive still publishes (it passes --no-verify) and the hook never fired.
    const hooks = mkdtempSync(join(tmpdir(), 'dxkit-anchor-hooks-'));
    const sentinel = join(hooks, 'fired');
    const hook = join(hooks, 'pre-push');
    writeFileSync(hook, `#!/bin/sh\necho fired > "${sentinel}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(repo, 'config', 'core.hooksPath', hooks);
    try {
      // Sanity: an ordinary push MUST be blocked by the hook (else the test is moot).
      let ordinaryBlocked = false;
      try {
        git(repo, 'push', 'origin', 'HEAD:refs/heads/ordinary-probe');
      } catch {
        ordinaryBlocked = true;
      }
      expect(ordinaryBlocked).toBe(true);
      if (existsSync(sentinel)) rmSync(sentinel); // reset before the real assertion

      const res = publishFilesToAnchorRef({
        cwd: repo,
        anchorRef: ANCHOR,
        files: [{ path: 'baselines/main.json', content: '{}\n' }],
        baseParent: false,
        message: 'refresh under a blocking pre-push hook',
      });
      // Skipped the hook → the push landed ...
      expect(res.pushed).toBe(true);
      // ... and the pre-push hook never fired.
      expect(existsSync(sentinel)).toBe(false);
      expect(readFromAnchorRef(repo, ANCHOR, 'baselines/main.json')).toBe('{}\n');
    } finally {
      git(repo, 'config', '--unset', 'core.hooksPath');
      rmSync(hooks, { recursive: true, force: true });
    }
  });
});

describe('describePushFailure (gh #156 categorization)', () => {
  it('does NOT assert auth for a bare timeout — the mislabel that cost four builds', () => {
    const err = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const reason = describePushFailure(err, 30_000);
    expect(reason).toMatch(/did not complete within 30s/);
    expect(reason).toMatch(/--no-verify/);
    // The old message asserted the remote "did not authenticate" — the exact
    // mislabel that sent four debug builds chasing a non-existent auth bug.
    expect(reason).not.toMatch(/did not authenticate/i);
    expect(reason).not.toMatch(/persist-credentials/);
  });

  it('categorizes a SIGTERM-killed push (timeout kill) as a timeout too', () => {
    const err = Object.assign(new Error('Command failed'), { signal: 'SIGTERM', killed: true });
    expect(describePushFailure(err, 15_000)).toMatch(/did not complete within 15s/);
  });

  it('categorizes a permission denial distinctly', () => {
    const err = new Error('remote: Permission to org/repo denied to token. fatal: 403');
    expect(describePushFailure(err, 30_000)).toMatch(/push denied by the remote/);
  });

  it('falls through to a plain rejection for a non-fast-forward (so the retry still bites)', () => {
    const err = new Error('Updates were rejected because the remote contains work you do not have');
    const reason = describePushFailure(err, 30_000);
    expect(reason.startsWith('push rejected')).toBe(true);
  });

  it('names the remedy for a repository-ruleset rejection (GH013 — the customer incident)', () => {
    const err = new Error(
      'remote: error: GH013: Repository rule violations found for refs/heads/dxkit-baselines. ' +
        'remote: - Cannot create ref due to creations being restricted.',
    );
    const reason = describePushFailure(err, 30_000);
    // Not the raw wall, and not a generic "push rejected".
    expect(reason).toMatch(/ruleset/i);
    expect(reason).toContain('refs/heads/dxkit-**');
    // Reassures that gating still works — the fail-open promise.
    expect(reason).toMatch(/re-gather|unaffected/i);
    expect(reason.startsWith('push rejected')).toBe(false);
  });
});

describe('announceAnchorNotPushed — loud fail-open (baseline + reports share it)', () => {
  const saved = process.env.GITHUB_ACTIONS;
  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = saved;
  });

  it('emits a ::warning:: annotation carrying the reason when running in Actions', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    announceAnchorNotPushed('dxkit-reports', 'push blocked by a repository/org ruleset');
    spy.mockRestore();
    const annotation = lines.find((l) => l.startsWith('::warning::'));
    expect(annotation).toBeDefined();
    expect(annotation).toContain('dxkit-reports');
    expect(annotation).toContain('ruleset');
  });

  it('is a no-op annotation outside Actions (no ::warning:: noise on a terminal)', () => {
    delete process.env.GITHUB_ACTIONS;
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    announceAnchorNotPushed('dxkit-baselines', 'no origin remote');
    spy.mockRestore();
    expect(lines.some((l) => l.startsWith('::warning::'))).toBe(false);
  });
});

/**
 * Seam test (injected git exec, no real remote): every side-ref push carries
 * `--no-verify` so the internal machine push never fires the repo's pre-push
 * hook (gh #156). Both modes — replace-all (force) and accumulate — are covered.
 * The REAL end-to-end proof (that --no-verify actually skips a live hook) is the
 * real-git test above plus `.github/workflows/anchor-auth-smoke.yml`.
 */
describe('publishFilesToAnchorRef — the push always runs --no-verify (gh #156)', () => {
  function gitSpy(originUrl: string) {
    const calls: string[][] = [];
    const exec = (args: string[]): string => {
      calls.push(args);
      switch (args[0]) {
        case 'remote':
          return args[1] === 'get-url' ? originUrl + '\n' : '';
        case 'rev-parse':
          throw new Error('unknown revision'); // resolveTip → null (first publish)
        case 'hash-object':
        case 'write-tree':
        case 'commit-tree':
          return 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\n';
        default:
          return '';
      }
    };
    return { calls, exec, pushCall: () => calls.find((c) => c.includes('push')) ?? [] };
  }

  it('replace-all (baseParent:false) force-pushes with --no-verify', () => {
    const spy = gitSpy('https://github.com/acme/widgets.git');
    const res = publishFilesToAnchorRef({
      cwd: '/tmp/x',
      anchorRef: 'dxkit-baselines',
      files: [{ path: 'baselines/main.json', content: '{}' }],
      message: 'refresh',
      baseParent: false,
      _exec: spy.exec,
    });
    expect(res.pushed).toBe(true);
    const push = spy.pushCall();
    expect(push).toContain('--no-verify');
    expect(push).toContain('--force');
    expect(push).toContain('origin');
  });

  it('accumulate (default) pushes with --no-verify', () => {
    const spy = gitSpy('https://github.com/acme/widgets.git');
    const res = publishFilesToAnchorRef({
      cwd: '/tmp/x',
      anchorRef: 'dxkit-reports',
      files: [{ path: 'report-history.jsonl', content: '{}\n' }],
      message: 'snapshot',
      _exec: spy.exec,
    });
    expect(res.pushed).toBe(true);
    const push = spy.pushCall();
    expect(push).toContain('--no-verify');
    expect(push).toContain('origin');
  });
});

describe('anchorStalenessFromContents (VERIFY-40 F-6 — migrated local over stale anchor)', () => {
  it('scheme divergence alarms with both schemes named', () => {
    const problem = anchorStalenessFromContents(
      { identityScheme: undefined, recall: undefined },
      { identityScheme: 'v2', recall: {} },
    );
    expect(problem).toContain("'pre-v2'");
    expect(problem).toContain("'v2'");
  });

  it('anchor without recall while local carries it alarms', () => {
    const problem = anchorStalenessFromContents(
      { identityScheme: 'v2' },
      { identityScheme: 'v2', recall: { secret: { epoch: 1, inputs: {} } } },
    );
    expect(problem).toContain('predates recall attribution');
  });

  it('ordinary content lag stays quiet (same scheme, both have recall)', () => {
    expect(
      anchorStalenessFromContents(
        { identityScheme: 'v2', recall: {} },
        { identityScheme: 'v2', recall: {} },
      ),
    ).toBeNull();
  });

  it('an unreadable side never alarms (fail-open — the presence probe covers absence)', () => {
    expect(anchorStalenessFromContents(null, { identityScheme: 'v2' })).toBeNull();
    expect(anchorStalenessFromContents({ identityScheme: 'v2' }, null)).toBeNull();
  });
});
