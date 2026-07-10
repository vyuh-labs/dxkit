import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadAnchorFromBranch,
  publishBaselineAnchor,
  anchorBranchStatus,
} from '../../src/baseline/anchor';
import { DEFAULT_ANCHOR_REF } from '../../src/baseline/modes';

/**
 * Real-git tests for `baseline publish` — the write half of the branch anchor
 * transport. The load-bearing assertion is WRITER↔READER PARITY: the publish
 * and the guardrail's anchor read resolve the transport + ref from the same
 * policy section, so what `publishBaselineAnchor` pushes is byte-for-byte what
 * `loadAnchorFromBranch` hands the check. The two consumers hold different
 * shapes of the concept (a directory of files vs a hydrated temp file), which
 * is exactly the divergence class CLAUDE.md 2.30 says needs a parity test, not
 * a grep rule.
 */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).toString();
}

const BASELINE_REL = join('.dxkit', 'baselines', 'default.json');

describe('publishBaselineAnchor', () => {
  let bare: string;
  let repo: string;

  const writePolicy = (section: Record<string, unknown>): void => {
    mkdirSync(join(repo, '.dxkit'), { recursive: true });
    writeFileSync(join(repo, '.dxkit', 'policy.json'), JSON.stringify({ baseline: section }));
  };
  const writeBaseline = (content: string): void => {
    mkdirSync(join(repo, '.dxkit', 'baselines'), { recursive: true });
    writeFileSync(join(repo, BASELINE_REL), content);
  };

  beforeEach(() => {
    bare = mkdtempSync(join(tmpdir(), 'dxkit-blpub-bare-'));
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    repo = mkdtempSync(join(tmpdir(), 'dxkit-blpub-repo-'));
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

  it('refuses when the policy transport is not branch (the check would never read it)', () => {
    writePolicy({ anchor: 'tree' });
    writeBaseline('{"findings":[]}');
    const out = publishBaselineAnchor(repo);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/anchor transport is not 'branch'/);

    // Policy absent entirely → same refusal (nothing says the side branch is live).
    rmSync(join(repo, '.dxkit', 'policy.json'));
    expect(publishBaselineAnchor(repo).ok).toBe(false);
  });

  it('refuses when nothing has been captured yet', () => {
    writePolicy({ anchor: 'branch' });
    const out = publishBaselineAnchor(repo);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/baseline create/);
  });

  it('WRITER↔READER PARITY: what publish pushes is exactly what the guardrail read loads', () => {
    writePolicy({ anchor: 'branch' });
    const content = JSON.stringify({ identityScheme: 'v2', findings: [{ id: 'abc' }] });
    writeBaseline(content);

    const treeBefore = git(repo, 'status', '--porcelain');
    const out = publishBaselineAnchor(repo);
    expect(out.ok).toBe(true);
    expect(out.publish?.pushed).toBe(true);
    expect(out.files).toBe(1);
    // Plumbing publish: the checkout's working tree stays untouched.
    expect(git(repo, 'status', '--porcelain')).toBe(treeBefore);

    // The READ side — the exact call `guardrail check` makes — resolves the same
    // policy section and must hand back the published bytes.
    const tmp = loadAnchorFromBranch(repo, join(repo, BASELINE_REL), { anchor: 'branch' });
    expect(tmp).not.toBeNull();
    expect(readFileSync(tmp as string, 'utf8')).toBe(content);
  });

  it('publish → read parity holds for a custom anchorRef from the same policy section', () => {
    writePolicy({ anchor: 'branch', anchorRef: 'my-anchors' });
    writeBaseline('{"findings":[]}');
    const out = publishBaselineAnchor(repo);
    expect(out.ok).toBe(true);
    expect(out.anchorRef).toBe('my-anchors');
    const tmp = loadAnchorFromBranch(repo, join(repo, BASELINE_REL), {
      anchor: 'branch',
      anchorRef: 'my-anchors',
    });
    expect(tmp).not.toBeNull();
    // And nothing landed on the default ref.
    expect(
      anchorBranchStatus(repo, { anchor: 'branch', anchorRef: DEFAULT_ANCHOR_REF }).branchExists,
    ).toBe(false);
  });

  it('is idempotent (unchanged content publishes nothing) and latest-wins on change', () => {
    writePolicy({ anchor: 'branch' });
    writeBaseline('v1');
    expect(publishBaselineAnchor(repo).publish?.pushed).toBe(true);

    const again = publishBaselineAnchor(repo);
    expect(again.ok).toBe(true);
    expect(again.publish?.pushed).toBe(false);
    expect(again.publish?.reason).toBe('no change');

    writeBaseline('v2');
    expect(publishBaselineAnchor(repo).publish?.pushed).toBe(true);
    const tmp = loadAnchorFromBranch(repo, join(repo, BASELINE_REL), { anchor: 'branch' });
    expect(readFileSync(tmp as string, 'utf8')).toBe('v2');
    // Replace-all: the ref history stays a single orphan commit, no accretion.
    expect(git(bare, 'log', '--oneline', DEFAULT_ANCHOR_REF).trim().split('\n')).toHaveLength(1);
  });

  it('self-heals a deleted anchor branch even when the baseline is byte-identical', () => {
    writePolicy({ anchor: 'branch' });
    writeBaseline('stable');
    expect(publishBaselineAnchor(repo).publish?.pushed).toBe(true);

    git(bare, 'update-ref', '-d', `refs/heads/${DEFAULT_ANCHOR_REF}`);
    const healed = publishBaselineAnchor(repo);
    expect(healed.ok).toBe(true);
    expect(healed.publish?.pushed).toBe(true);
    expect(healed.selfHealed).toBe(true);
    expect(anchorBranchStatus(repo, { anchor: 'branch' }).branchExists).toBe(true);
  });

  it('degrades to a reported non-push when there is no origin remote', () => {
    git(repo, 'remote', 'remove', 'origin');
    writePolicy({ anchor: 'branch' });
    writeBaseline('x');
    const out = publishBaselineAnchor(repo);
    expect(out.ok).toBe(true);
    expect(out.publish?.pushed).toBe(false);
    expect(out.publish?.reason).toBe('no origin remote');
  });
});
