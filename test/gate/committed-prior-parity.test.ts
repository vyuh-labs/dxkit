/**
 * Parity net for the committed prior (#387, the Rule 2.30 semantic-divergence
 * shape): the guardrail's `acquirePrior` and the remediation planner must
 * agree on WHICH baseline is the prior for the same repo state. Both route
 * through the ONE read `readCommittedPrior` (anchor branch first, tree copy
 * second, fallback disclosed); this test runs them side by side on a real
 * repo with a bare origin so the anchor read goes through the real side-ref
 * reader, not an injected stand-in.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { acquirePrior, readCommittedPrior } from '../../src/gate/prior';
import { publishFilesToAnchorRef } from '../../src/baseline/anchor-publish';
import { planRepoWorkOrders } from '../../src/remediate/work-orders/gather';
import { resolveRemediateConfig } from '../../src/remediate/config';
import { getLanguage } from '../../src/languages';
import { trustedLocalContext } from '../../src/analysis-trust';
import type { ResolvedMode } from '../../src/baseline/modes';

const tmps: string[] = [];
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepoWithOrigin(): string {
  const bare = mkdtempSync(join(tmpdir(), 'dxkit-prior-parity-bare-'));
  const repo = mkdtempSync(join(tmpdir(), 'dxkit-prior-parity-'));
  tmps.push(bare, repo);
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@e.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
  mkdirSync(join(repo, '.dxkit', 'baselines'), { recursive: true });
  writeFileSync(
    join(repo, '.dxkit', 'policy.json'),
    JSON.stringify({ baseline: { mode: 'committed-full', anchor: 'branch' } }),
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-q', 'origin', 'main');
  return repo;
}

afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TS = [getLanguage('typescript')!];
const NO_OSV = async () => null;
const COMMITTED: ResolvedMode = { mode: 'committed-full', source: 'cli', explanation: 'test' };

function depVuln(id: string, pkg: string) {
  return {
    id,
    kind: 'dep-vuln',
    package: pkg,
    installedVersion: '1.0.0',
    advisoryId: `GHSA-${pkg}`,
    severity: 'high',
  };
}

function baselineJson(findings: object[], extra: object = {}): string {
  return JSON.stringify({
    schemaVersion: 'dxkit-baseline/v1',
    name: 'main',
    createdAt: '2026-08-01T00:00:00.000Z',
    repo: { commitSha: 'base', branch: 'main', dirty: false },
    analysis: { dxkitVersion: 'test', toolchainHash: 'x' },
    tools: {},
    saltMode: 'none',
    identityScheme: 'v3',
    findings,
    ...extra,
  });
}

const ANCHOR_FINDINGS = [depVuln('a'.repeat(16), 'js-yaml'), depVuln('b'.repeat(16), 'tmp')];
const TREE_FINDINGS = [
  ...ANCHOR_FINDINGS,
  depVuln('c'.repeat(16), 'form-data'),
  depVuln('d'.repeat(16), 'fast-uri'),
  depVuln('e'.repeat(16), 'body-parser'),
];

function depAdvisoryFindings(plan: {
  orders: readonly { class: unknown; findings: readonly unknown[] }[];
}): number {
  return plan.orders
    .filter((o) => o.class === 'dep-advisory')
    .reduce((n, o) => n + o.findings.length, 0);
}

describe('acquirePrior and the planner read the same committed prior', () => {
  it('anchor branch holds N, tree copy holds M: both read N from the anchor', async () => {
    const repo = makeRepoWithOrigin();
    writeFileSync(
      join(repo, '.dxkit', 'baselines', 'main.json'),
      baselineJson(TREE_FINDINGS, { capturedIn: 'local' }),
    );
    publishFilesToAnchorRef({
      cwd: repo,
      anchorRef: 'dxkit-baselines',
      files: [
        {
          path: '.dxkit/baselines/main.json',
          content: baselineJson(ANCHOR_FINDINGS, {
            createdAt: '2026-08-15T00:00:00.000Z',
            capturedIn: 'ci',
          }),
        },
      ],
      message: 'anchor',
      baseParent: false,
    });

    const gate = await acquirePrior(repo, COMMITTED, { trust: trustedLocalContext() });
    expect(gate.anchorSource?.used).toBe('anchor');
    expect(gate.baseline.findings).toHaveLength(ANCHOR_FINDINGS.length);

    const shared = readCommittedPrior(repo);
    expect(shared.prior).toEqual(gate);

    const plan = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
    });
    expect(depAdvisoryFindings(plan.plan)).toBe(gate.baseline.findings.length);
    expect(plan.priorSource).toBe("anchor branch 'dxkit-baselines' captured 2026-08-15");
  }, 60_000);

  it('anchor unreachable: both fall back to the tree copy and both disclose it', async () => {
    const repo = makeRepoWithOrigin();
    // The side branch was never published: the incident's silent-fallback shape.
    writeFileSync(
      join(repo, '.dxkit', 'baselines', 'main.json'),
      baselineJson(TREE_FINDINGS, { capturedIn: 'local' }),
    );

    const gate = await acquirePrior(repo, COMMITTED, { trust: trustedLocalContext() });
    expect(gate.anchorSource?.used).toBe('tree-fallback');
    expect(gate.baseline.findings).toHaveLength(TREE_FINDINGS.length);
    expect(readCommittedPrior(repo).prior).toEqual(gate);

    const plan = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
    });
    expect(depAdvisoryFindings(plan.plan)).toBe(gate.baseline.findings.length);
    expect(plan.priorSource).toContain('tree copy captured locally 2026-08-01');
    expect(plan.priorSource).toContain("anchor branch 'dxkit-baselines' unreachable");
  }, 60_000);

  it('no baseline anywhere: the gate refuses with the capture remedy, the planner plans without debt', async () => {
    const repo = makeRepoWithOrigin();
    await expect(acquirePrior(repo, COMMITTED, { trust: trustedLocalContext() })).rejects.toThrow(
      /baseline file not found/,
    );
    expect(readCommittedPrior(repo).prior).toBeNull();
    const plan = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
    });
    expect(plan.priorSource).toBeNull();
    expect(depAdvisoryFindings(plan.plan)).toBe(0);
  }, 60_000);
});
