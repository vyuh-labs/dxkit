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
    expect([...scrubbed].sort()).toEqual([
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

describe('enforceEnvelope (the envelope enforcement half — real git)', () => {
  it('reverts out-of-envelope commits (edits AND new files) in one disclosure commit, keeps in-envelope work', () => {
    const base = git('rev-parse', 'HEAD');
    // The "agent" edits an in-envelope file, an out-of-envelope tracked
    // file, and adds a new out-of-envelope file.
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'inside.js'), 'ok\n');
    writeFileSync(join(repo, 'src.js'), 'module.exports = 99;\n');
    writeFileSync(join(repo, 'stray.md'), 'sprawl\n');
    commitAll('agent work');

    const ops = realGit(repo);
    const allowed = (p: string) => p.startsWith('src/');
    const result = ops.enforceEnvelope(base, allowed);
    expect(result.error).toBeUndefined();
    expect([...result.dropped].sort()).toEqual(['src.js', 'stray.md']);
    // The tree after enforcement: in-envelope work kept, sprawl reverted.
    expect(git('show', 'HEAD:src/inside.js')).toBe('ok');
    expect(git('show', 'HEAD:src.js')).toBe('module.exports = 1;');
    expect(() => git('show', 'HEAD:stray.md')).toThrow();
    // Disclosed as its own commit; the working tree is clean.
    expect(git('log', '-1', '--format=%s')).toContain('out-of-envelope');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('an out-of-envelope RENAME restores the base file AND removes the new path (rename-aware)', () => {
    // The destructive class: with rename detection, the diff lists only the
    // rename's post-image, so enforcement deleted the base file and landed
    // that change undisclosed. Both sides must be reverted.
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'inside.js'), 'ok\n');
    git('mv', 'src.js', 'moved.js');
    commitAll('agent renamed a file out of envelope + real work');

    const ops = realGit(repo);
    const result = ops.enforceEnvelope(base, (p) => p.startsWith('src/'));
    expect(result.error).toBeUndefined();
    expect([...result.dropped].sort()).toEqual(['moved.js', 'src.js']);
    // The base file is BACK, the rename target is gone, in-envelope work kept.
    expect(git('show', 'HEAD:src.js')).toBe('module.exports = 1;');
    expect(() => git('show', 'HEAD:moved.js')).toThrow();
    expect(git('show', 'HEAD:src/inside.js')).toBe('ok');
    expect(git('status', '--porcelain')).toBe('');
  });

  it('is a no-op (no commit) when everything is inside the envelope', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'src.js'), 'module.exports = 2;\n');
    commitAll('agent work');
    const head = git('rev-parse', 'HEAD');
    const ops = realGit(repo);
    const result = ops.enforceEnvelope(base, () => true);
    expect(result).toEqual({ dropped: [] });
    expect(git('rev-parse', 'HEAD')).toBe(head);
  });

  it('returns a named error instead of throwing when git cannot answer (fail-closed at the caller)', () => {
    const ops = realGit(repo);
    const result = ops.enforceEnvelope('not-a-ref', () => true);
    expect(result.dropped).toEqual([]);
    expect(result.error).toBeTruthy();
  });
});
