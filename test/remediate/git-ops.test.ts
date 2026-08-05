/**
 * The runner's real git operations: the runtime-artifact scrub (an agent
 * that commits dxkit scan output mid-run must not ship it in a remediation
 * PR — observed live on a salvage draft), and the content-based diff
 * question (a resume's empty marker commit is not a diff).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { realGit } from '../../src/remediate/git-ops';
import { DXKIT_RUNTIME_ARTIFACT_PATHS, isRuntimeArtifactPath } from '../../src/runtime-artifacts';
import { GITIGNORE_ENTRIES } from '../../src/ship-installers';

let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commitAll(msg: string): void {
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-git-ops-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(join(repo, 'src.js'), 'module.exports = 1;\n');
  commitAll('base');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('the ONE runtime-artifact list', () => {
  it('the gitignore block and the scrub read the same paths (Rule 2)', () => {
    expect(GITIGNORE_ENTRIES).toEqual([...DXKIT_RUNTIME_ARTIFACT_PATHS]);
    expect(isRuntimeArtifactPath('.dxkit/reports/health-audit-1.json')).toBe(true);
    expect(isRuntimeArtifactPath('.dxkit/cache/analysis-result-2.json')).toBe(true);
    expect(isRuntimeArtifactPath('.dxkit/dashboard.html')).toBe(true);
    // The guardrail anchor stays tracked — never a runtime artifact.
    expect(isRuntimeArtifactPath('.dxkit/baselines/main.json')).toBe(false);
    expect(isRuntimeArtifactPath('.dxkit/policy.json')).toBe(false);
  });
});

describe('scrubRuntimeArtifacts', () => {
  it('drops attempt-introduced scan state, keeps real work, and reports what it dropped', () => {
    const base = git('rev-parse', 'HEAD');
    // The "agent" commits real work AND scan output it generated mid-run.
    mkdirSync(join(repo, '.dxkit', 'reports'), { recursive: true });
    mkdirSync(join(repo, '.dxkit', 'cache'), { recursive: true });
    writeFileSync(join(repo, 'src.js'), 'module.exports = 2;\n');
    writeFileSync(join(repo, '.dxkit', 'reports', 'health-audit-1.json'), '{}');
    writeFileSync(join(repo, '.dxkit', 'cache', 'analysis-result-1.json'), '{}');
    commitAll('agent work + scan noise');

    const ops = realGit(repo);
    const scrubbed = ops.scrubRuntimeArtifacts(base);
    expect(scrubbed.sort()).toEqual([
      '.dxkit/cache/analysis-result-1.json',
      '.dxkit/reports/health-audit-1.json',
    ]);
    const changed = git('diff', '--name-only', base, 'HEAD').split('\n');
    expect(changed).toEqual(['src.js']);
    expect(ops.hasDiff(base)).toBe(true);
  });

  it('never touches runtime paths the repo tracked at BASE (a deliberate choice is respected)', () => {
    mkdirSync(join(repo, '.dxkit', 'reports'), { recursive: true });
    writeFileSync(join(repo, '.dxkit', 'reports', 'kept.md'), 'v1');
    commitAll('repo tracks its reports on purpose');
    const base = git('rev-parse', 'HEAD');

    writeFileSync(join(repo, '.dxkit', 'reports', 'kept.md'), 'v2');
    commitAll('agent updates the tracked report');

    const ops = realGit(repo);
    expect(ops.scrubRuntimeArtifacts(base)).toEqual([]);
    expect(git('diff', '--name-only', base, 'HEAD')).toBe('.dxkit/reports/kept.md');
  });

  it('an attempt whose ONLY content was scan state reads as no diff afterward', () => {
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(repo, '.dxkit', 'reports'), { recursive: true });
    writeFileSync(join(repo, '.dxkit', 'reports', 'only-noise.json'), '{}');
    commitAll('agent produced only scan output');

    const ops = realGit(repo);
    expect(ops.scrubRuntimeArtifacts(base).length).toBe(1);
    expect(ops.hasDiff(base)).toBe(false);
  });
});

describe('hasDiff is a CONTENT question', () => {
  it('an empty marker commit is not a diff (the resume counter is bookkeeping, not work)', () => {
    const base = git('rev-parse', 'HEAD');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t',
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      'marker',
    );
    const ops = realGit(repo);
    expect(ops.hasDiff(base)).toBe(false);
    writeFileSync(join(repo, 'src.js'), 'module.exports = 3;\n');
    commitAll('real change');
    expect(ops.hasDiff(base)).toBe(true);
  });
});
