/**
 * `vyuh-dxkit baseline refresh` — the D4 advisory decision lane (4.1.4).
 *
 * The class both ways:
 *   - ABSORPTION (the failure this closes): the old refresh (`create --force`)
 *     silently grandfathered advisories the feed published after the previous
 *     capture — no decision, no expiry pressure, defer-forever.
 *   - FALSE HOLD-OUT (the over-trigger): a diff that DID change a dependency
 *     manifest may legitimately bring new advisories with it — those absorb as
 *     ordinary pre-existing debt, the standard refresh contract.
 *
 * The discriminator is the ONE `changedFilesTouchDependencyManifest` (Rule
 * 2.30 — the same helper the classifier and the ref-based skip consume). The
 * capture itself is injected (`_capture`) — these tests exercise the decision
 * lane, not the analyzers. The decision branch is verified on a real bare
 * origin: entries, expiry carry-over across re-raises, and zero working-tree /
 * HEAD impact.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ADVISORY_DECISION_BRANCH,
  decisionPrBody,
  runBaselineRefresh,
} from '../../src/baseline/refresh';
import { BASELINE_SCHEMA_VERSION, type BaselineFile } from '../../src/baseline/baseline-file';
import type { AllowlistFile } from '../../src/allowlist/file';
import { DEFER_ADVISORY_EXPIRY_DAYS } from '../../src/allowlist/categories';

const tmps: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepoWithOrigin(): { repo: string; bare: string } {
  const bare = mk('dxkit-refresh-bare-');
  const repo = mk('dxkit-refresh-');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@e.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'fx', version: '1' }));
  fs.writeFileSync(path.join(repo, 'src.js'), 'const a = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  return { repo, bare };
}

function mk(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function depVuln(id: string, pkg: string, advisoryId: string) {
  return { id, kind: 'dep-vuln' as const, package: pkg, installedVersion: '1.0.0', advisoryId };
}

function baselineFile(cwd: string, commitSha: string, findings: unknown[]): BaselineFile {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: 'main',
    createdAt: '2026-07-20T00:00:00.000Z',
    repo: { commitSha, branch: 'main', root: cwd },
    analysis: {
      dxkitVersion: 'test',
      policyHash: '0'.repeat(16),
      ignoreHash: '0'.repeat(16),
      toolchainHash: '0'.repeat(16),
      configHash: '0'.repeat(16),
    },
    tools: {},
    saltMode: 'deterministic',
    findings: findings as BaselineFile['findings'],
  } as BaselineFile;
}

function writeTreeBaseline(repo: string, file: BaselineFile): string {
  const p = path.join(repo, '.dxkit', 'baselines', 'main.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(file));
  return p;
}

/** A capture seam that writes `findings` as the fresh baseline. */
function captureWriting(repo: string, findings: unknown[]) {
  return async () => {
    writeTreeBaseline(repo, baselineFile(repo, git(repo, 'rev-parse', 'HEAD').trim(), findings));
  };
}

/** Commit a change so HEAD moves past the prior anchor. */
function commitChange(repo: string, rel: string, content: string): void {
  fs.writeFileSync(path.join(repo, rel), content);
  git(repo, 'add', rel);
  git(repo, 'commit', '-q', '-m', `change ${rel}`);
}

function decisionAllowlist(bare: string): AllowlistFile {
  const raw = execFileSync('git', ['show', `${ADVISORY_DECISION_BRANCH}:.dxkit/allowlist.json`], {
    cwd: bare,
    encoding: 'utf8',
  });
  return JSON.parse(raw) as AllowlistFile;
}

describe('baseline refresh — the advisory decision lane', () => {
  it('holds newly published advisories OUT of the baseline and raises the decision branch', async () => {
    const { repo, bare } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(
      repo,
      baselineFile(repo, priorSha, [depVuln('a'.repeat(16), 'axios', 'GHSA-old')]),
    );
    // A NON-manifest change since the prior anchor — the feed, not the diff.
    commitChange(repo, 'src.js', 'const a = 2;\n');

    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [
        depVuln('a'.repeat(16), 'axios', 'GHSA-old'),
        depVuln('b'.repeat(16), 'fast-uri', 'GHSA-new-1'),
        depVuln('c'.repeat(16), 'svgo', 'GHSA-new-2'),
      ]),
    });

    // Held out of the written baseline — never absorbed.
    expect(result.heldOut.map((a) => a.advisoryId).sort()).toEqual(['GHSA-new-1', 'GHSA-new-2']);
    const written = JSON.parse(
      fs.readFileSync(path.join(repo, '.dxkit', 'baselines', 'main.json'), 'utf8'),
    ) as BaselineFile;
    expect(written.findings.map((f) => f.id)).toEqual(['a'.repeat(16)]);

    // The decision branch landed on the origin, parented on HEAD (mergeable),
    // carrying deferred entries with the short expiry.
    const allow = decisionAllowlist(bare);
    const fps = allow.entries.map((e) => e.fingerprint).sort();
    expect(fps).toEqual(['b'.repeat(16), 'c'.repeat(16)]);
    for (const e of allow.entries) {
      expect(e).toMatchObject({ kind: 'dep-vuln', category: 'deferred', addedBy: 'dxkit-refresh' });
      const days = Math.round(
        (new Date(`${e.expiresAt}T00:00:00Z`).getTime() - Date.now()) / 86_400_000,
      );
      expect(days).toBeGreaterThanOrEqual(DEFER_ADVISORY_EXPIRY_DAYS - 1);
      expect(days).toBeLessThanOrEqual(DEFER_ADVISORY_EXPIRY_DAYS);
    }
    const parent = execFileSync('git', ['rev-parse', `${ADVISORY_DECISION_BRANCH}^`], {
      cwd: bare,
      encoding: 'utf8',
    }).trim();
    expect(parent).toBe(git(repo, 'rev-parse', 'HEAD').trim());

    // Zero working-tree / HEAD impact: no allowlist file appeared in the tree,
    // HEAD did not move, the tree is clean apart from the baseline rewrite.
    expect(fs.existsSync(path.join(repo, '.dxkit', 'allowlist.json'))).toBe(false);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
  }, 120_000);

  it('a manifest-touching diff ABSORBS new advisories (the standard refresh contract)', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    commitChange(repo, 'package.json', JSON.stringify({ name: 'fx', version: '2' }));

    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [depVuln('d'.repeat(16), 'newdep', 'GHSA-x')]),
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('dependency manifest changed');
    const written = JSON.parse(
      fs.readFileSync(path.join(repo, '.dxkit', 'baselines', 'main.json'), 'utf8'),
    ) as BaselineFile;
    expect(written.findings).toHaveLength(1);
  }, 120_000);

  it('re-raise preserves the ORIGINAL expiry (no rolling defer-forever)', async () => {
    const { repo, bare } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    commitChange(repo, 'src.js', 'const a = 3;\n');

    const firstNow = new Date();
    await runBaselineRefresh({
      cwd: repo,
      now: firstNow,
      _capture: captureWriting(repo, [depVuln('e'.repeat(16), 'immutable', 'GHSA-y')]),
    });
    const firstExpiry = decisionAllowlist(bare).entries[0].expiresAt;

    // Three days later the refresh runs again; the advisory is still undecided
    // (prior baseline unchanged on the tree — the decision PR is unmerged).
    writeTreeBaseline(repo, baselineFile(repo, priorSha, []));
    const laterNow = new Date(firstNow.getTime() + 3 * 86_400_000);
    await runBaselineRefresh({
      cwd: repo,
      now: laterNow,
      _capture: captureWriting(repo, [depVuln('e'.repeat(16), 'immutable', 'GHSA-y')]),
    });
    expect(decisionAllowlist(bare).entries[0].expiresAt).toBe(firstExpiry);
  }, 120_000);

  it('no prior baseline → plain capture, disclosed', async () => {
    const { repo } = makeRepoWithOrigin();
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, [depVuln('f'.repeat(16), 'axios', 'GHSA-z')]),
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('first capture');
  }, 120_000);

  it('ref-based mode is a graceful, explained no-op (the class cannot arise there)', async () => {
    const { repo } = makeRepoWithOrigin();
    fs.mkdirSync(path.join(repo, '.dxkit'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { mode: 'ref-based', ref: 'origin/main' } }),
    );
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: async () => {
        throw new Error('capture must not run in ref-based mode');
      },
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('ref-based');
    expect(result.note).toContain('Nothing to do');
  }, 60_000);

  it('a quiet feed refreshes normally with a note', async () => {
    const { repo } = makeRepoWithOrigin();
    const priorSha = git(repo, 'rev-parse', 'HEAD').trim();
    const same = [depVuln('a'.repeat(16), 'axios', 'GHSA-old')];
    writeTreeBaseline(repo, baselineFile(repo, priorSha, same));
    commitChange(repo, 'src.js', 'const a = 4;\n');
    const result = await runBaselineRefresh({
      cwd: repo,
      _capture: captureWriting(repo, same),
    });
    expect(result.heldOut).toEqual([]);
    expect(result.note).toContain('no newly published advisories');
  }, 120_000);
});

describe('decisionPrBody', () => {
  it('names both lanes and every advisory', () => {
    const body = decisionPrBody(
      [
        {
          fingerprint: 'b'.repeat(16),
          package: 'fast-uri',
          installedVersion: '3.1.2',
          advisoryId: 'GHSA-new-1',
        },
      ],
      [
        {
          fingerprint: 'b'.repeat(16),
          kind: 'dep-vuln',
          category: 'deferred',
          reason: 'r',
          addedBy: 'dxkit-refresh',
          addedAt: '2026-07-22',
          expiresAt: '2026-07-29',
        },
      ],
    );
    expect(body).toContain('fast-uri@3.1.2');
    expect(body).toContain('GHSA-new-1');
    expect(body).toContain('2026-07-29');
    expect(body).toContain('Lane 1 — fix');
    expect(body).toContain('Lane 2 — defer');
    expect(body).toContain('held out of the refreshed baseline');
  });
});
