/**
 * D4d (4.1.4) — the `branch` anchor transport's hydrate precedence and its
 * failure disclosure.
 *
 * The incident: a production repo's guardrail footer cited the STALE
 * committed tree baseline while a fresher side-branch anchor existed — and
 * nothing in the output said which file had loaded. Two pins close it:
 *
 * 1. The reader must materialize the side ref even on a clone whose fetch
 *    refspec does not map it (single-branch clones and actions/checkout
 *    workspaces): a bare `git fetch origin <ref>` only writes FETCH_HEAD
 *    there, so `origin/<ref>` never resolves and the read silently failed.
 *    The fix fetches with an explicit `+refs/heads/<ref>:refs/dxkit/anchor/…`
 *    refspec.
 * 2. When both an anchor and a tree copy exist, the ANCHOR wins (precedence),
 *    and when the anchor is unreachable the fallback to the tree copy is
 *    DISCLOSED (`anchorSource.used === 'tree-fallback'`) in the result and
 *    every renderer — fail-open, never silent.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createBaseline } from '../../src/baseline/create';
import { runGuardrailCheck } from '../../src/baseline/check';
import { renderConsole, renderJson, renderMarkdown } from '../../src/baseline/check-renderers';
import { readFromAnchorRef, publishFilesToAnchorRef } from '../../src/baseline/anchor-publish';
import { loadAnchorFromBranch } from '../../src/baseline/anchor';

const tmps: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** A repo with a bare origin — the anchor side ref lives on the origin, the
 *  clone reads it back, exactly the CI topology. */
function makeRepoWithOrigin(): { repo: string; bare: string } {
  const bare = mkdtempSync(join(tmpdir(), 'dxkit-anchorprec-bare-'));
  const repo = mkdtempSync(join(tmpdir(), 'dxkit-anchorprec-'));
  tmps.push(bare, repo);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@e.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, bare };
}

afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

let savedSalt: string | undefined;
beforeAll(() => {
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  delete process.env.DXKIT_BASELINE_SALT;
});
afterAll(() => {
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
});

describe('readFromAnchorRef — narrow-refspec clones (the incident shape)', () => {
  it('reads the side ref even when the clone fetch refspec does not map it', () => {
    const { repo } = makeRepoWithOrigin();
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: 'dxkit-baselines',
      files: [{ path: '.dxkit/baselines/main.json', content: '{"marker":"from-anchor"}' }],
      message: 'anchor',
      baseParent: false,
    });
    // The narrow refspec actions/checkout and single-branch clones configure:
    // only main maps to a remote-tracking ref. Remove any refs the publish left
    // locally so the read MUST go through its own fetch.
    git(repo, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
    for (const ref of [
      'refs/remotes/origin/dxkit-baselines',
      'refs/heads/dxkit-baselines',
      'refs/dxkit/anchor/dxkit-baselines',
    ]) {
      try {
        git(repo, 'update-ref', '-d', ref);
      } catch {
        /* ref did not exist */
      }
    }
    const content = readFromAnchorRef(repo, 'dxkit-baselines', '.dxkit/baselines/main.json');
    expect(content).toContain('from-anchor');
  });

  it('loadAnchorFromBranch returns null for a non-branch transport (tree stays source of truth)', () => {
    const { repo } = makeRepoWithOrigin();
    expect(loadAnchorFromBranch(repo, join(repo, '.dxkit/baselines/main.json'), undefined)).toBe(
      null,
    );
    expect(
      loadAnchorFromBranch(repo, join(repo, '.dxkit/baselines/main.json'), { anchor: 'tree' }),
    ).toBe(null);
  });
});

describe('hydrate precedence + disclosure (integration)', () => {
  it('anchor WINS over a stale tree copy, and the result says so', async () => {
    const { repo } = makeRepoWithOrigin();
    mkdirSync(join(repo, '.dxkit'), { recursive: true });
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'committed-full', anchor: 'branch' } }),
    );
    // Capture a baseline (writes the tree copy), publish it to the side branch,
    // then STALE-IFY the tree copy by rewriting its commitSha marker.
    await createBaseline({ cwd: repo });
    const treePath = join(repo, '.dxkit', 'baselines', 'main.json');
    const fresh = JSON.parse(readFileSync(treePath, 'utf8'));
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: 'dxkit-baselines',
      files: [{ path: '.dxkit/baselines/main.json', content: JSON.stringify(fresh) }],
      message: 'anchor',
      baseParent: false,
    });
    const stale = { ...fresh, repo: { ...fresh.repo, commitSha: 'f'.repeat(40) } };
    writeFileSync(treePath, JSON.stringify(stale));

    const result = await runGuardrailCheck({ cwd: repo });
    // The loaded baseline is the ANCHOR's (fresh commitSha), not the doctored
    // tree copy — precedence pinned end-to-end, visible in the footer SHA.
    expect(result.baseline.repo.commitSha).toBe(fresh.repo.commitSha);
    expect(result.anchorSource).toMatchObject({ used: 'anchor', anchorRef: 'dxkit-baselines' });
    expect(renderConsole(result)).toContain("side branch 'dxkit-baselines'");
    expect(renderMarkdown(result)).toContain('anchor: `dxkit-baselines`');
    expect(renderJson(result).baseline.anchorSource?.used).toBe('anchor');
  }, 240_000);

  it('an unreachable side branch falls back to the tree copy — DISCLOSED, never silent', async () => {
    const { repo } = makeRepoWithOrigin();
    mkdirSync(join(repo, '.dxkit'), { recursive: true });
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'committed-full', anchor: 'branch' } }),
    );
    // Tree copy exists; the side branch was never created (the incident's
    // silent-fallback shape).
    await createBaseline({ cwd: repo });

    const result = await runGuardrailCheck({ cwd: repo });
    expect(result.anchorSource?.used).toBe('tree-fallback');
    expect(result.anchorSource?.note).toContain('may be STALE');
    expect(renderConsole(result)).toContain('TREE FALLBACK');
    expect(renderMarkdown(result)).toContain('Baseline anchor fallback');
    expect(renderJson(result).baseline.anchorSource?.used).toBe('tree-fallback');
  }, 240_000);

  it('the tree transport carries NO anchor disclosure (nothing to disclose)', async () => {
    const { repo } = makeRepoWithOrigin();
    await createBaseline({ cwd: repo });
    const result = await runGuardrailCheck({ cwd: repo });
    expect(result.anchorSource).toBeUndefined();
    expect(renderConsole(result)).not.toContain('TREE FALLBACK');
  }, 240_000);
});
