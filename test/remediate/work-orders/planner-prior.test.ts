/**
 * The planner reads the prior the guardrail reads (#387, Rule 2.30).
 *
 * Under the `branch` anchor transport the committed tree copy of the
 * baseline is whatever the last LOCAL capture wrote (install day); the side
 * branch is the source of truth and the refresh only updates that. The
 * planner used to open the tree path directly, so it minted dependency
 * orders for advisories the default branch had already fixed. Now its debt
 * comes from the ONE committed read (`readCommittedPrior`, anchor first,
 * tree copy second, fallback disclosed) and the plan always says which prior
 * it used. The anchor reader is injected here; the real-git parity with
 * `acquirePrior` lives in `test/gate/committed-prior-parity.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  planRepoWorkOrders,
  PRIOR_DISCLOSURE_PREFIX,
} from '../../../src/remediate/work-orders/gather';
import { runRemediatePlan } from '../../../src/remediate/plan-cli';
import { resolveRemediateConfig } from '../../../src/remediate/config';
import { describePriorSource, type AnchorReader } from '../../../src/gate/prior';
import { getLanguage } from '../../../src/languages';

let repo: string;
const tmps: string[] = [];

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-planner-prior-'));
  tmps.push(repo);
  mkdirSync(join(repo, '.dxkit', 'baselines'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
});

afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const TS = [getLanguage('typescript')!];
const NO_OSV = async () => null;

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
    findings,
    ...extra,
  });
}

/** The anchor's shape in the incident: fewer advisories (the default branch
 *  paid some down) and a later capture date than the install-day tree copy. */
const ANCHOR_FINDINGS = [depVuln('a'.repeat(16), 'js-yaml'), depVuln('b'.repeat(16), 'tmp')];
const TREE_FINDINGS = [
  ...ANCHOR_FINDINGS,
  depVuln('c'.repeat(16), 'form-data'),
  depVuln('d'.repeat(16), 'fast-uri'),
  depVuln('e'.repeat(16), 'body-parser'),
];

function writeTreeCopy(): void {
  writeFileSync(
    join(repo, '.dxkit', 'baselines', 'main.json'),
    baselineJson(TREE_FINDINGS, { capturedIn: 'local' }),
  );
}

function writeBranchPolicy(): void {
  writeFileSync(
    join(repo, '.dxkit', 'policy.json'),
    JSON.stringify({ baseline: { mode: 'committed-full', anchor: 'branch' } }),
  );
}

/** An anchor reader that materializes the anchor the way the real one does:
 *  gated on the `branch` transport, a temp file the caller reads, never the
 *  tree path. */
function anchorHolding(findings: object[]): AnchorReader {
  return (_cwd, _baselinePath, section) => {
    if (section?.anchor !== 'branch') return null;
    const dir = mkdtempSync(join(tmpdir(), 'dxkit-planner-anchor-'));
    tmps.push(dir);
    const p = join(dir, 'main.json');
    writeFileSync(
      p,
      baselineJson(findings, { createdAt: '2026-08-15T00:00:00.000Z', capturedIn: 'ci' }),
    );
    return p;
  };
}

const unreachableAnchor: AnchorReader = () => null;

function depAdvisoryFindings(plan: {
  orders: readonly { class: unknown; findings: readonly unknown[] }[];
}) {
  return plan.orders
    .filter((o) => o.class === 'dep-advisory')
    .reduce((n, o) => n + o.findings.length, 0);
}

describe('the planner reads the prior the guardrail reads (#387)', () => {
  it('branch anchor holds N dep-vulns, tree copy holds M: the plan counts N and names the anchor', async () => {
    writeBranchPolicy();
    writeTreeCopy();
    const out = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
      anchorReader: anchorHolding(ANCHOR_FINDINGS),
    });
    expect(depAdvisoryFindings(out.plan)).toBe(ANCHOR_FINDINGS.length);
    expect(out.priorSource).toBe("anchor branch 'dxkit-baselines' captured 2026-08-15");
    expect(out.disclosures).toContain(`${PRIOR_DISCLOSURE_PREFIX}${out.priorSource}`);
    // Nothing the tree copy alone held reaches the plan.
    expect(out.plan.orders.map((o) => o.id)).not.toContain('dep-advisory:form-data');
  });

  it('anchor unreachable: the tree copy is used and disclosed as a stale-capable local fallback', async () => {
    writeBranchPolicy();
    writeTreeCopy();
    const out = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
      anchorReader: unreachableAnchor,
    });
    expect(depAdvisoryFindings(out.plan)).toBe(TREE_FINDINGS.length);
    expect(out.priorSource).toContain('tree copy captured locally 2026-08-01');
    expect(out.priorSource).toContain("anchor branch 'dxkit-baselines' unreachable");
    expect(out.priorSource).toContain('STALE');
    expect(out.disclosures).toContain(`${PRIOR_DISCLOSURE_PREFIX}${out.priorSource}`);
  });

  it('the tree transport carries no fallback wording: the tree copy IS the source of truth', async () => {
    writeTreeCopy();
    const out = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
      // Not consulted on the tree transport; asserting it would be wrong here.
      anchorReader: anchorHolding(ANCHOR_FINDINGS),
    });
    expect(out.priorSource).toBe('tree copy captured locally 2026-08-01');
    expect(depAdvisoryFindings(out.plan)).toBe(TREE_FINDINGS.length);
  });

  it('no baseline at all: no prior line, and the plan stays evidence-honest', async () => {
    const out = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      osvFetcher: NO_OSV,
      anchorReader: unreachableAnchor,
    });
    expect(out.priorSource).toBeNull();
    expect(out.disclosures.some((d) => d.startsWith(PRIOR_DISCLOSURE_PREFIX))).toBe(false);
  });

  it('describePriorSource is the one phrasing for every shape', () => {
    const base = {
      createdAt: '2026-08-15T10:00:00.000Z',
      capturedIn: 'ci' as const,
    } as unknown as import('../../../src/baseline/baseline-file').BaselineFile;
    expect(
      describePriorSource({
        baseline: base,
        anchorSource: { used: 'anchor', anchorRef: 'dxkit-baselines', note: '' },
      }),
    ).toBe("anchor branch 'dxkit-baselines' captured 2026-08-15");
    expect(
      describePriorSource({
        baseline: { ...base, capturedIn: 'local' },
        anchorSource: { used: 'tree-fallback', anchorRef: 'dxkit-baselines', note: '' },
      }),
    ).toBe(
      "tree copy captured locally 2026-08-15 (anchor branch 'dxkit-baselines' unreachable: " +
        'not created yet, offline, or unfetchable; the tree copy may be STALE)',
    );
    expect(describePriorSource({ baseline: base })).toBe('tree copy captured in CI 2026-08-15');
    expect(describePriorSource({ baseline: { ...base, capturedIn: undefined } })).toBe(
      'tree copy captured 2026-08-15',
    );
  });
});

describe('remediate plan prints which prior it read', () => {
  async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      await run();
    } finally {
      spy.mockRestore();
    }
    return chunks.join('');
  }

  it('--json carries workOrderPriorSource', async () => {
    writeBranchPolicy();
    writeTreeCopy();
    const raw = await captureStdout(() =>
      runRemediatePlan(repo, {
        json: true,
        gather: { packs: TS, osvFetcher: NO_OSV, anchorReader: anchorHolding(ANCHOR_FINDINGS) },
      }),
    );
    const out = JSON.parse(raw) as Record<string, unknown>;
    expect(out.workOrderPriorSource).toBe("anchor branch 'dxkit-baselines' captured 2026-08-15");
    const orders = out.workOrders as Array<{ id: string }>;
    expect(orders.map((o) => o.id).filter((id) => id.startsWith('dep-advisory:'))).toEqual([
      'dep-advisory:js-yaml',
      'dep-advisory:tmp',
    ]);
  });

  it('the human header prints the prior line once', async () => {
    writeBranchPolicy();
    writeTreeCopy();
    // The human path writes through console.log (the logger's non-json sink).
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
      lines.push(String(line));
    });
    try {
      await runRemediatePlan(repo, {
        gather: { packs: TS, osvFetcher: NO_OSV, anchorReader: anchorHolding(ANCHOR_FINDINGS) },
      });
    } finally {
      spy.mockRestore();
    }
    const raw = lines.join('\n');
    const line = "prior: anchor branch 'dxkit-baselines' captured 2026-08-15";
    expect(raw).toContain(line);
    expect(raw.split(line).length - 1).toBe(1);
  });
});
