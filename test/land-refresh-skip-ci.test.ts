import { describe, it, expect } from 'vitest';
import { landRefreshPaths, type Exec } from '../src/land-refresh';

/**
 * #304 — the [skip ci] stamp is push-mode ONLY. GitHub honors the marker
 * on a PR head commit for `pull_request` workflows, so a stamped standing
 * PR could never run a single check: a code-carrying lane PR presented
 * with zero CI, silently defeated DXKIT_BOT_TOKEN's stated purpose, and
 * under required checks was permanently unmergeable. PR-mode commits are
 * clean by default; an artifact-only refresh PR opts in per consumer.
 */

function recordingExec(): { exec: Exec; commands: string[][] } {
  const commands: string[][] = [];
  const exec: Exec = (bin, args) => {
    commands.push([bin, ...args]);
    if (bin === 'git' && args[0] === 'status') return ' M some/file\n';
    if (bin === 'git' && args[0] === 'rev-parse') return 'main';
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'list') return '[]';
    if (bin === 'gh' && args[0] === 'pr' && args[1] === 'create') return 'https://example/pr/1';
    return '';
  };
  return { exec, commands };
}

function commitMessageFrom(commands: string[][]): string {
  const commit = commands.find((c) => c[0] === 'git' && c.includes('commit'));
  expect(commit, 'a commit must have been issued').toBeDefined();
  return commit![commit!.indexOf('-m') + 1];
}

const baseOpts = {
  cwd: '/fake',
  paths: ['some/file'],
  branchName: 'dxkit/test-refresh',
  defaultBranch: 'main',
  commitTitle: 'chore: refresh',
  prTitle: 'dxkit: refresh',
  prBody: 'body',
};

describe('landRefreshPaths — the [skip ci] boundary (#304)', () => {
  it('push mode keeps the [skip ci] stamp (a default-branch artifact refresh must not churn CI)', () => {
    const { exec, commands } = recordingExec();
    landRefreshPaths({ ...baseOpts, mode: 'push', exec });
    expect(commitMessageFrom(commands)).toBe('chore: refresh [skip ci]');
  });

  it('PR mode commits CLEAN by default — the standing PR must be able to run checks', () => {
    const { exec, commands } = recordingExec();
    landRefreshPaths({ ...baseOpts, mode: 'pr', exec });
    const message = commitMessageFrom(commands);
    expect(message).toBe('dxkit: refresh');
    expect(message).not.toContain('[skip ci]');
  });

  it('an artifact-only consumer can opt back in, explicitly', () => {
    const { exec, commands } = recordingExec();
    landRefreshPaths({ ...baseOpts, mode: 'pr', prSkipCi: true, exec });
    expect(commitMessageFrom(commands)).toContain('[skip ci]');
  });
});
