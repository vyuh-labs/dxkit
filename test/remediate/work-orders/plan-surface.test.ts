/**
 * `remediate plan --json` on a fixture repo: the work orders come from the
 * ONE gather adapter (a cheap stored floor by default, the live floor only
 * behind --with-floor; deferrals joined to a dependency scan with the
 * baseline as fallback, preferring a fresh persisted BoM artifact over a
 * live audit; debt excludes every active allowlist entry; repo facts from
 * the packs), the policy knob caps slice size, and every degraded read is
 * disclosed rather than crashing or silently emptying the plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRemediatePlan } from '../../../src/remediate/plan-cli';
import {
  BOM_FRESHNESS_DAYS,
  gatherWorkOrderInputs,
  installResolver,
  manifestRoots,
  planRepoWorkOrders,
} from '../../../src/remediate/work-orders/gather';
import { resolveRemediateConfig } from '../../../src/remediate/config';
import { getLanguage } from '../../../src/languages';
import type { CorrectnessFloorResult } from '../../../src/analyzers/correctness/run';
import type { DepVulnFinding } from '../../../src/languages/capabilities/types';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-work-orders-'));
  mkdirSync(join(repo, '.dxkit', 'baselines'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture","version":"0.0.0"}');
  writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":3}');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const TS = [getLanguage('typescript')!];
const NO_FLOOR: CorrectnessFloorResult = { ran: false, blocks: false, checks: [] };
const THROWING_FLOOR = () => {
  throw new Error('live floor must not run by default');
};

function writePolicy(policy: object): void {
  writeFileSync(join(repo, '.dxkit', 'policy.json'), JSON.stringify(policy));
}

function writeBaseline(findings: object[], floorDebt?: object): void {
  writeFileSync(
    join(repo, '.dxkit', 'baselines', 'main.json'),
    JSON.stringify({
      schemaVersion: 'dxkit-baseline/v1',
      name: 'main',
      createdAt: '2026-08-01T00:00:00.000Z',
      repo: { commitSha: 'base', branch: 'main', dirty: false },
      analysis: { dxkitVersion: 'test', toolchainHash: 'x' },
      tools: {},
      saltMode: 'none',
      findings,
      ...(floorDebt ? { floorDebt } : {}),
    }),
  );
}

function writeAllowlist(entries: object[]): void {
  writeFileSync(
    join(repo, '.dxkit', 'allowlist.json'),
    JSON.stringify({
      schemaVersion: 'dxkit-allowlist/v1',
      mode: 'full',
      identityScheme: 'v3',
      entries,
    }),
  );
}

const lintEntry = (id: string, file: string, line: number, rule: string) => ({
  id,
  kind: 'custom-check',
  check: 'lint:typescript',
  blocking: true,
  file,
  line,
  rule,
});

const FLOOR_DEBT = {
  capturedAtCommit: 'base',
  capturedAt: '2026-08-01T00:00:00.000Z',
  checks: [
    {
      pack: 'typescript',
      label: 'typecheck',
      command: 'npx tsc --noEmit',
      status: 'fail',
      output: 'stored tail',
    },
  ],
};

const FAILING_FLOOR: CorrectnessFloorResult = {
  ran: true,
  blocks: true,
  checks: [
    {
      pack: 'typescript',
      label: 'typecheck',
      bin: 'npx',
      args: ['tsc', '--noEmit'],
      status: 'fail',
      output: 'src/a.ts(1,1): error TS1',
    },
  ],
};

/** The shape the deferral producers emit: the deferred advisory is NOT in
 *  the baseline; it exists only in a scan (fingerprint-stamped). */
const SCAN_FINDING: DepVulnFinding = {
  id: 'GHSA-1',
  package: 'js-yaml',
  installedVersion: '3.13.0',
  tool: 'osv-scanner',
  packId: 'typescript',
  severity: 'high',
  fixedVersion: '4.1.0',
  reachable: true,
  fingerprint: 'dead000011112222',
};

const DEFER_ENTRY = {
  fingerprint: 'dead000011112222',
  kind: 'dep-vuln',
  category: 'deferred',
  reason: 'lane will fix',
  addedBy: 't',
  addedAt: '2026-08-01',
  expiresAt: '2026-09-15',
};

const NOW = new Date('2026-08-25T00:00:00Z');

async function captureJson(run: () => Promise<void>): Promise<Record<string, unknown>> {
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
  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

describe('remediate plan --json: work orders', () => {
  it('reads the stored floor by default (a live runFloor would throw), joins deferrals to the scan, excludes active allowlist entries from debt', async () => {
    writePolicy({ remediate: { enabled: true, tasks: ['fix-build', 'fix-lint', 'fix-vulns'] } });
    writeBaseline(
      [
        lintEntry('l1', 'src/a.ts', 1, 'eqeqeq'),
        lintEntry('l2', 'src/a.ts', 9, 'eqeqeq'),
        lintEntry('l3', 'src/b.ts', 2, 'no-unused-vars'),
        lintEntry('fp1', 'src/c.ts', 2, 'eqeqeq'),
        { id: 'bin1', kind: 'custom-check', check: 'arch-check', blocking: true },
      ],
      FLOOR_DEBT,
    );
    writeAllowlist([
      DEFER_ENTRY,
      // an accepted false positive: NOT debt to close
      {
        fingerprint: 'fp1',
        kind: 'custom-check',
        category: 'false-positive',
        reason: 'not real',
        addedBy: 't',
        addedAt: '2026-08-01',
      },
    ]);
    const out = await captureJson(() =>
      runRemediatePlan(repo, {
        json: true,
        gather: { packs: TS, scanDepVulns: async () => [SCAN_FINDING], now: NOW },
      }),
    );
    expect(out.workOrderPlanError).toBeNull();
    expect(out.workOrderFloorSource).toBe('baseline-envelope');
    expect(out.workOrderDepScanSource).toBe('injected');
    const orders = out.workOrders as Array<Record<string, unknown>>;
    expect(orders.map((o) => o.id)).toEqual([
      'dep-advisory:js-yaml',
      'floor-failure:typescript:typecheck',
      'lint-located:src/a.ts',
      'lint-located:src/b.ts',
    ]);
    const floorOrder = orders[1];
    expect(floorOrder.attribution).toEqual(['pre-existing']);
    expect(floorOrder.tier).toBe('agent');
    expect(floorOrder.install).toEqual({ bin: 'npm', args: ['ci'] });
    expect(floorOrder.done).toMatchObject({ verifier: 'floor', absent: 1 });
    const advisory = orders[0];
    expect(advisory.attribution).toEqual(['deferred']);
    expect(advisory.provenance).toEqual({
      source: 'advisories',
      blocking: 0,
      deferred: 1,
      earliestExpiry: '2026-09-15',
    });
    // joined to the scan: fixed version known, so override-pin tiers recipe
    expect(advisory.tier).toBe('recipe');
    expect(advisory.recipe).toBe('override-pin');
    expect(orders[2].findings).toBe(2);
    // fp1 (false-positive, active) is not planned anywhere
    expect(JSON.stringify(out)).not.toContain('"fp1"');
    const undispatchable = out.undispatchable as Array<{ reason: string; findings: unknown[] }>;
    expect(undispatchable).toHaveLength(1);
    expect(undispatchable[0].reason).toContain('binary');
  });

  it('no live floor runs by default: a throwing runFloor injected as scanless default is never called without --with-floor', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([], FLOOR_DEBT);
    // withFloor absent + runFloor absent: gatherFloor must read the envelope.
    const stored = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), { packs: TS });
    expect(stored.floorSource).toBe('baseline-envelope');
    expect(stored.plan.orders[0].outputTail).toBe('stored tail');
    // proving the pin bites: an injected runFloor IS used (throw surfaces)
    await expect(
      planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
        packs: TS,
        runFloor: THROWING_FLOOR,
      }),
    ).rejects.toThrow('live floor must not run by default');
  });

  it('--with-floor runs the live floor, attributed against the envelope through the one comparator', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([], FLOOR_DEBT);
    const live = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      runFloor: () => FAILING_FLOOR,
    });
    expect(live.floorSource).toBe('live');
    expect(live.plan.orders[0].findings[0].attribution).toBe('pre-existing');
    writeBaseline([]);
    const noEnvelope = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      runFloor: () => FAILING_FLOOR,
    });
    expect(noEnvelope.plan.orders[0].findings[0].attribution).toBe('unattributed');
    const none = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), { packs: TS });
    expect(none.floorSource).toBe('none');
    expect(none.plan.orders).toEqual([]);
  });

  it('a corrupt baseline is a DISCLOSURE, never a silent "backlog clear"', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeFileSync(join(repo, '.dxkit', 'baselines', 'main.json'), '{ not json');
    const out = await captureJson(() =>
      runRemediatePlan(repo, { json: true, gather: { packs: TS } }),
    );
    const disclosures = out.workOrderDisclosures as string[];
    expect(disclosures.some((d) => d.includes('could not be read'))).toBe(true);
    expect(out.workOrderPlanError).toBeNull();
  });

  it('prefers a fresh persisted BoM artifact over a live audit for the deferral join, disclosed; a stale one is ignored', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([]);
    writeAllowlist([DEFER_ENTRY]);
    const freshDate = new Date(NOW.getTime() - 86_400_000).toISOString();
    writeFileSync(
      join(repo, '.dxkit', 'bom.json'),
      JSON.stringify({ analyzedAt: freshDate, entries: [{ vulns: [SCAN_FINDING] }] }),
    );
    const fresh = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      now: NOW,
      runFloor: () => NO_FLOOR,
    });
    expect(fresh.depScanSource).toBe('bom-artifact');
    expect(fresh.disclosures.some((d) => d.includes('bom.json'))).toBe(true);
    expect(fresh.plan.orders[0].id).toBe('dep-advisory:js-yaml');
    expect(fresh.plan.orders[0].tier).toBe('recipe');
    // stale artifact: not read (the source would be the live audit)
    const staleDate = new Date(NOW.getTime() - (BOM_FRESHNESS_DAYS + 1) * 86_400_000).toISOString();
    writeFileSync(
      join(repo, '.dxkit', 'bom.json'),
      JSON.stringify({ analyzedAt: staleDate, entries: [{ vulns: [SCAN_FINDING] }] }),
    );
    const stale = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      now: NOW,
      runFloor: () => NO_FLOOR,
      // injected scan stands in for the live audit path's result
      scanDepVulns: async () => [],
    });
    expect(stale.depScanSource).toBe('injected');
    expect(stale.plan.undispatchable[0].findings[0].id).toBe('dead000011112222');
  });

  it('the scan runs only when a dep-vuln deferral exists', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([]);
    writeAllowlist([]);
    let scans = 0;
    await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      runFloor: () => NO_FLOOR,
      scanDepVulns: async () => {
        scans += 1;
        return [];
      },
    });
    expect(scans).toBe(0);
  });

  it('remediate.workOrders.maxSliceSize caps a debt slice, and each class is capped by its task budget', async () => {
    writePolicy({
      remediate: {
        enabled: true,
        workOrders: { maxSliceSize: 2 },
        taskBudgets: { 'fix-lint': { maxTurns: 3 } },
      },
    });
    writeBaseline([1, 2, 3, 4, 5].map((n) => lintEntry(`l${n}`, 'src/a.ts', n, 'eqeqeq')));
    const config = resolveRemediateConfig(repo);
    expect(config.workOrders.maxSliceSize).toBe(2);
    const { plan } = await planRepoWorkOrders(repo, config, {
      packs: TS,
      runFloor: () => NO_FLOOR,
    });
    expect(plan.orders.map((o) => o.id)).toEqual([
      'lint-located:src/a.ts#1',
      'lint-located:src/a.ts#2',
      'lint-located:src/a.ts#3',
    ]);
    expect(plan.orders.map((o) => o.findings.length)).toEqual([2, 2, 1]);
    expect(plan.orders.every((o) => o.budget.turns === 3)).toBe(true);
  });

  it('the default slice size is 25 and an invalid knob falls back to it', () => {
    writePolicy({ remediate: { workOrders: { maxSliceSize: -3 } } });
    expect(resolveRemediateConfig(repo).workOrders.maxSliceSize).toBe(25);
  });

  it('repo facts come from the packs: per-ecosystem install commands, glob-aware manifest roots via the shared per-pack discovery', async () => {
    writePolicy({});
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'api', 'package.json'), '{}');
    writeFileSync(join(repo, 'packages', 'api', 'pnpm-lock.yaml'), '');
    const installFor = installResolver(repo, TS);
    expect(installFor('typescript')).toEqual({ bin: 'npm', args: ['ci'] });
    // single-ecosystem repo: an unattributed finding still gets the one command
    expect(installFor(undefined)).toEqual({ bin: 'npm', args: ['ci'] });
    const disclosures: string[] = [];
    expect(manifestRoots(repo, TS, disclosures)).toEqual([
      { dir: '', files: ['package-lock.json', 'package.json'] },
      { dir: 'packages/api', files: ['package.json', 'pnpm-lock.yaml'] },
    ]);
    expect(disclosures).toEqual([]);
    // a GLOB-pattern ecosystem: requirements*.txt must match via the
    // canonical matcher, not fs.existsSync on the literal
    const py = [getLanguage('python')!];
    writeFileSync(join(repo, 'requirements-dev.txt'), '');
    writeFileSync(join(repo, 'requirements.txt'), '');
    const pyRoots = manifestRoots(repo, py, []);
    expect(pyRoots[0].files).toContain('requirements-dev.txt');
    expect(pyRoots[0].files).toContain('requirements.txt');
    // python's own provision command, per ecosystem, never npm
    expect(installResolver(repo, py)('python')).toEqual({
      bin: 'pip',
      args: ['install', '-r', 'requirements.txt'],
    });
    // a pack with no derivable provision: undefined, disclosed at render
    const go = [getLanguage('go')!];
    expect(installResolver(repo, go)('go')).toBeUndefined();
    const { input } = await gatherWorkOrderInputs(repo, resolveRemediateConfig(repo), {
      packs: go,
      runFloor: () => NO_FLOOR,
    });
    expect(input.installFor('go')).toBeUndefined();
    expect(input.blocking).toEqual([]);
  });

  it('a gather failure is disclosed in the JSON, never a crashed plan', async () => {
    writePolicy({ remediate: { enabled: true } });
    const out = await captureJson(() =>
      runRemediatePlan(repo, {
        json: true,
        gather: {
          packs: TS,
          runFloor: () => {
            throw new Error('floor exploded');
          },
        },
      }),
    );
    expect(out.workOrderPlanError).toContain('floor exploded');
    expect(out.workOrders).toEqual([]);
  });
});
