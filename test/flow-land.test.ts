/**
 * Landing a flow-contract refresh (src/analyzers/flow/land.ts): the pure
 * delta/PR-text builders, push-mode against a real bare remote, and pr-mode's
 * branch push + graceful no-gh degradation via an injected exec.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  FLOW_REFRESH_BRANCH,
  landFlowRefresh,
  refreshPrText,
  servedDelta,
} from '../src/analyzers/flow/land';
import type { ServedContract } from '../src/analyzers/flow/contract';

function contract(keys: string[]): ServedContract {
  return {
    schemaVersion: 1,
    generatedAt: '2026-07-01T00:00:00.000Z',
    side: 'served',
    routes: keys.map((k) => {
      const [method, path] = k.split(' ');
      return { method, path, handler: null, via: 'spec' as const };
    }),
  };
}

describe('servedDelta + refreshPrText (pure)', () => {
  it('computes added/removed keys, tolerating absent sides', () => {
    const d = servedDelta(contract(['GET /a', 'GET /gone']), contract(['GET /a', 'POST /new']));
    expect(d).toEqual({ added: ['POST /new'], removed: ['GET /gone'] });
    expect(servedDelta(undefined, contract(['GET /a'])).added).toEqual(['GET /a']);
    expect(servedDelta(contract(['GET /a']), undefined).removed).toEqual(['GET /a']);
  });

  it('removals lead the PR body with the consumer warning; the title flags them', () => {
    const { title, body } = refreshPrText({ added: ['POST /new'], removed: ['GET /gone'] });
    expect(title).toMatch(/1 route\(s\) removed, review before merge/);
    expect(body.indexOf('routes(s) removed') === -1).toBe(true); // sanity of template
    expect(body.indexOf('route(s) removed')).toBeLessThan(body.indexOf('route(s) added'));
    expect(body).toMatch(/starts? flagging any consumer/);
    expect(body).toContain('`GET /gone`');
  });

  it('an additions-only refresh reads as safe; metadata-only says so', () => {
    const add = refreshPrText({ added: ['POST /new'], removed: [] });
    expect(add.title).toBe('chore(flow): contract refresh');
    expect(add.body).toMatch(/Additions are safe/);
    const meta = refreshPrText({ added: [], removed: [] });
    expect(meta.body).toMatch(/no route changes/);
  });
});

describe('landFlowRefresh (real git)', () => {
  let bare: string;
  let repo: string;
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();

  const writeSnapshot = (keys: string[]): void => {
    mkdirSync(join(repo, '.dxkit', 'flow'), { recursive: true });
    writeFileSync(join(repo, '.dxkit', 'flow', 'served.json'), JSON.stringify(contract(keys)));
  };

  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'dxkit-land-bare-'));
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    repo = mkdtempSync(join(tmpdir(), 'dxkit-land-repo-'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@e.com');
    git(repo, 'config', 'user.name', 't');
    writeSnapshot(['GET /a']);
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

  it('a timestamp-only republish is CLEAN — no metadata-churn commits on every merge', () => {
    // Same routes, new generatedAt: exactly what every re-publish produces.
    const before = contract(['GET /a']);
    writeFileSync(
      join(repo, '.dxkit', 'flow', 'served.json'),
      JSON.stringify({ ...contract(['GET /a']), generatedAt: '2026-07-09T09:09:09.000Z' }),
    );
    const out = landFlowRefresh({ cwd: repo, mode: 'push', before, defaultBranch: 'main' });
    expect(out.outcome).toBe('clean');
    // And the volatile-only diff was reverted, leaving the tree clean.
    expect(
      execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(),
    ).toBe('');
  });

  it('clean when the snapshots are unchanged', () => {
    const out = landFlowRefresh({
      cwd: repo,
      mode: 'push',
      before: contract(['GET /a']),
      defaultBranch: 'main',
    });
    expect(out.outcome).toBe('clean');
  });

  it('push mode lands a [skip ci] commit on the default branch', () => {
    const before = contract(['GET /a']);
    writeSnapshot(['GET /a', 'POST /new']);
    const out = landFlowRefresh({ cwd: repo, mode: 'push', before, defaultBranch: 'main' });
    expect(out.outcome).toBe('pushed');
    expect(out.delta.added).toEqual(['POST /new']);
    const log = git(bare, 'log', '-1', '--format=%s', 'main');
    expect(log).toContain('[skip ci]');
    expect(git(bare, 'show', 'main:.dxkit/flow/served.json')).toContain('"/new"');
  });

  it('push mode runs --no-verify — a blocking pre-push hook does not stop the land (gh #156)', () => {
    // The SECOND internal-push consumer (land-refresh). Same class as the anchor
    // writer: a machine push must not fire the repo's pre-push guardrail hook.
    // Wire a hook that BLOCKS any ordinary push, then assert the land still pushes.
    const hooks = mkdtempSync(join(tmpdir(), 'dxkit-land-hooks-'));
    const sentinel = join(hooks, 'fired');
    const hook = join(hooks, 'pre-push');
    writeFileSync(hook, `#!/bin/sh\necho fired > "${sentinel}"\nexit 1\n`);
    chmodSync(hook, 0o755);
    git(repo, 'config', 'core.hooksPath', hooks);
    try {
      let blocked = false;
      try {
        git(repo, 'push', 'origin', 'HEAD:refs/heads/ordinary-probe');
      } catch {
        blocked = true;
      }
      expect(blocked).toBe(true); // the hook really blocks a normal push
      if (existsSync(sentinel)) rmSync(sentinel);

      const before = contract(['GET /a']);
      writeSnapshot(['GET /a', 'POST /new']);
      const out = landFlowRefresh({ cwd: repo, mode: 'push', before, defaultBranch: 'main' });
      expect(out.outcome).toBe('pushed'); // landed despite the blocking hook
      expect(existsSync(sentinel)).toBe(false); // the hook never fired (--no-verify)
      expect(git(bare, 'show', 'main:.dxkit/flow/served.json')).toContain('"/new"');
    } finally {
      git(repo, 'config', '--unset', 'core.hooksPath');
      rmSync(hooks, { recursive: true, force: true });
    }
  });

  it('pr mode pushes the standing branch and degrades gracefully without gh', () => {
    const before = contract(['GET /a']);
    writeSnapshot(['POST /new']); // one removed, one added
    const out = landFlowRefresh({ cwd: repo, mode: 'pr', before, defaultBranch: 'main' });
    // A bare local remote has no gh — the branch still lands, the note says
    // what to do, and nothing throws.
    expect(out.outcome).toBe('branch-pushed-no-pr');
    expect(out.note).toContain(FLOW_REFRESH_BRANCH);
    expect(git(bare, 'show', `${FLOW_REFRESH_BRANCH}:.dxkit/flow/served.json`)).toContain('"/new"');
    // The default branch is untouched — that is the whole point of pr mode.
    expect(git(bare, 'show', 'main:.dxkit/flow/served.json')).not.toContain('"/new"');
  });

  it('pr mode opens/updates the standing PR through gh when available (injected exec)', () => {
    const before = contract(['GET /a']);
    writeSnapshot(['GET /a', 'POST /new']);
    const calls: string[][] = [];
    const real = (cmd: string, args: string[]): string =>
      execFileSync(cmd, args, { cwd: repo, encoding: 'utf8' }).toString();
    // First run: no open PR → create.
    let out = landFlowRefresh({
      cwd: repo,
      mode: 'pr',
      before,
      defaultBranch: 'main',
      exec: (cmd, args) => {
        if (cmd === 'gh') {
          calls.push([cmd, ...args.slice(0, 2)]);
          if (args[1] === 'list') return '[]';
          if (args[1] === 'create') return 'https://github.com/o/r/pull/7\n';
          return '';
        }
        return real(cmd, [...args]);
      },
    });
    expect(out.outcome).toBe('pr-opened');
    expect(out.prUrl).toBe('https://github.com/o/r/pull/7');

    // Second run with the PR open → edit in place, never a second PR.
    writeSnapshot(['GET /a', 'POST /new', 'POST /newer']);
    out = landFlowRefresh({
      cwd: repo,
      mode: 'pr',
      before,
      defaultBranch: 'main',
      exec: (cmd, args) => {
        if (cmd === 'gh') {
          calls.push([cmd, ...args.slice(0, 2)]);
          if (args[1] === 'list') return '[{"url":"https://github.com/o/r/pull/7"}]';
          return '';
        }
        return real(cmd, [...args]);
      },
    });
    expect(out.outcome).toBe('pr-updated');
    expect(calls.some((c) => c[1] === 'pr' && c[2] === 'edit')).toBe(true);
    expect(calls.filter((c) => c[2] === 'create')).toHaveLength(1);
  });
});
