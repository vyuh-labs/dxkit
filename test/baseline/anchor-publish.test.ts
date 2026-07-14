import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ciCredentialedUrl,
  describePushFailure,
  publishFilesToAnchorRef,
  readFromAnchorRef,
} from '../../src/baseline/anchor-publish';

/**
 * Real-git tests for the shared anchor writer/reader. A local bare repo stands
 * in for `origin` (the same transport a real remote takes); the "checkout" repo
 * has it wired as `origin`. We assert the plumbing publish lands a commit on the
 * side ref, accumulates unchanged files, prunes, and is idempotent — all WITHOUT
 * touching the checkout's working tree or index (verified via `git status`).
 */
const ANCHOR = 'dxkit-reports';

// A placeholder token spelled indirectly so dxkit's OWN secret scanner does not
// flag these fixtures as a real credential (no `x-access-token:<literal>@…` in
// source). The value is irrelevant — only that it flows through the auth logic.
const FAKE_TOKEN = ['fake', 'token'].join('-');

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
});

describe('describePushFailure (gh #156 categorization)', () => {
  it('categorizes a timeout as a stuck auth handshake with an actionable hint', () => {
    const err = Object.assign(new Error('spawnSync git ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const reason = describePushFailure(err, 30_000);
    expect(reason).toMatch(/timed out after 30s/);
    expect(reason).toMatch(/contents: write/);
    expect(reason).toMatch(/persist-credentials/);
  });

  it('categorizes a SIGTERM-killed push (timeout kill) as a timeout too', () => {
    const err = Object.assign(new Error('Command failed'), { signal: 'SIGTERM', killed: true });
    expect(describePushFailure(err, 15_000)).toMatch(/timed out after 15s/);
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
});

describe('ciCredentialedUrl (gh #156 — CI token push auth)', () => {
  const TOKEN = FAKE_TOKEN;

  it('builds a token-credentialed URL for an HTTPS origin when a token is present', () => {
    expect(ciCredentialedUrl('https://github.com/acme/widgets.git', { GITHUB_TOKEN: TOKEN })).toBe(
      `https://x-access-token:${TOKEN}@github.com/acme/widgets.git`,
    );
  });

  it('preserves the actual host (GitHub Enterprise)', () => {
    expect(
      ciCredentialedUrl('https://ghe.corp.example/acme/widgets.git', { GH_TOKEN: TOKEN }),
    ).toBe(`https://x-access-token:${TOKEN}@ghe.corp.example/acme/widgets.git`);
  });

  it('strips any credentials already in the origin URL', () => {
    expect(
      ciCredentialedUrl('https://old@github.com/acme/widgets.git', { GITHUB_TOKEN: TOKEN }),
    ).toBe(`https://x-access-token:${TOKEN}@github.com/acme/widgets.git`);
  });

  it('returns null when no token is in the env (falls back to ambient creds)', () => {
    expect(ciCredentialedUrl('https://github.com/acme/widgets.git', {})).toBeNull();
  });

  it('returns null for an SSH origin (token URL does not apply)', () => {
    expect(
      ciCredentialedUrl('git@github.com:acme/widgets.git', { GITHUB_TOKEN: TOKEN }),
    ).toBeNull();
    expect(
      ciCredentialedUrl('ssh://git@github.com/acme/widgets.git', { GH_TOKEN: TOKEN }),
    ).toBeNull();
  });
});

/**
 * End-to-end auth wiring through the primitive, via the injected exec seam — no
 * real remote needed. Proves the primitive points `origin` at the credentialed
 * URL for the operation (then restores it), and does NOT for the no-token / SSH
 * cases. The REAL auth (that the URL actually authenticates GitHub) is proven by
 * `.github/workflows/anchor-auth-smoke.yml` — a mock cannot cover that.
 */
describe('publishFilesToAnchorRef — origin gets the credentialed URL for CI auth (gh #156)', () => {
  /** A git spy that records every invocation and returns canned output so the
   *  writer completes a full replace-all publish without a real remote. `remote
   *  get-url` reports `originUrl`; `rev-parse` throws so `resolveTip` sees an
   *  absent ref (first-publish path). */
  function gitSpy(originUrl: string) {
    const calls: string[][] = [];
    const exec = (args: string[]): string => {
      calls.push(args);
      let i = 0;
      while (args[i] === '-c') i += 2; // skip a prepended `-c credential.helper=`
      switch (args[i]) {
        case 'remote':
          return args[i + 1] === 'get-url' ? originUrl + '\n' : '';
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
    return { calls, exec };
  }

  const pushCall = (calls: string[][]) => calls.find((c) => c.includes('push')) ?? [];

  let saved: { gh?: string; ghp?: string };
  beforeEach(() => {
    saved = { gh: process.env.GITHUB_TOKEN, ghp: process.env.GH_TOKEN };
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  afterEach(() => {
    if (saved.gh === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = saved.gh;
    if (saved.ghp === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = saved.ghp;
  });

  const publish = (exec: (a: string[], i?: string) => string) =>
    publishFilesToAnchorRef({
      cwd: '/tmp/x',
      anchorRef: 'dxkit-baselines',
      files: [{ path: 'baselines/main.json', content: '{}' }],
      message: 'refresh',
      baseParent: false,
      _exec: exec,
    });

  it('pushes DIRECTLY to the credentialed URL when HTTPS + GITHUB_TOKEN', () => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;
    const { calls, exec } = gitSpy('https://github.com/acme/widgets.git');
    expect(publish(exec).pushed).toBe(true);
    const push = pushCall(calls);
    // The push targets the credentialed URL itself (the proven raw form), NOT
    // the bare `origin`, and disables any ambient credential helper.
    expect(push).toContain(`https://x-access-token:${FAKE_TOKEN}@github.com/acme/widgets.git`);
    expect(push).not.toContain('origin');
    expect(push.slice(0, 2)).toEqual(['-c', 'credential.helper=']);
  });

  it('pushes to `origin` (ambient creds) when no token is present', () => {
    const { calls, exec } = gitSpy('https://github.com/acme/widgets.git');
    expect(publish(exec).pushed).toBe(true);
    const push = pushCall(calls);
    expect(push).toContain('origin');
    expect(push).not.toContain('-c');
  });

  it('pushes to `origin` for an SSH origin even with a token set (token URL n/a)', () => {
    process.env.GITHUB_TOKEN = FAKE_TOKEN;
    const { calls, exec } = gitSpy('git@github.com:acme/widgets.git');
    expect(publish(exec).pushed).toBe(true);
    const push = pushCall(calls);
    expect(push).toContain('origin');
    expect(push).not.toContain('-c');
  });
});
