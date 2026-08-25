/**
 * `remediate plan --json` on a fixture repo: the work orders come from the
 * ONE gather adapter (a cheap stored floor by default, the live floor only
 * behind --with-floor; deferrals joined to the live dependency scan with the
 * baseline as fallback; debt excludes every active allowlist entry; repo
 * facts from the packs), the policy knob caps slice size, and a gather
 * failure is disclosed rather than crashing the plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRemediatePlan } from '../../../src/remediate/plan-cli';
import {
  gatherWorkOrderInputs,
  installCommandFor,
  manifestRoots,
  planRepoWorkOrders,
} from '../../../src/remediate/work-orders/gather';
import { resolveRemediateConfig } from '../../../src/remediate/config';
import { LANGUAGES, getLanguage } from '../../../src/languages';
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

/** The shape the deferral producers emit: the deferred advisory is NOT in the
 *  baseline; it exists in the live scan (fingerprint-stamped). */
const LIVE_SCAN: DepVulnFinding[] = [
  {
    id: 'GHSA-1',
    package: 'js-yaml',
    installedVersion: '3.13.0',
    tool: 'osv-scanner',
    severity: 'high',
    fixedVersion: '4.1.0',
    reachable: true,
    fingerprint: 'dead000011112222',
  },
];

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
  it('reads the stored floor envelope by default (no live floor), joins deferrals to the live scan, excludes every active allowlist entry from debt', async () => {
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
      {
        fingerprint: 'dead000011112222',
        kind: 'dep-vuln',
        category: 'deferred',
        reason: 'lane will fix',
        addedBy: 't',
        addedAt: '2026-08-01',
        expiresAt: '2026-09-15',
      },
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
    let liveFloorRan = false;
    const out = await captureJson(() =>
      runRemediatePlan(repo, {
        json: true,
        gather: {
          packs: TS,
          runFloor: undefined,
          scanDepVulns: async () => LIVE_SCAN,
          now: new Date('2026-08-25T00:00:00Z'),
        },
      }).then(() => {
        liveFloorRan = false;
      }),
    );
    expect(liveFloorRan).toBe(false);
    expect(out.workOrderPlanError).toBeNull();
    expect(out.workOrderFloorSource).toBe('baseline-envelope');
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
    // joined to the live scan: fixed version known, so override-pin tiers recipe
    expect(advisory.tier).toBe('recipe');
    expect(advisory.recipe).toBe('override-pin');
    expect(advisory.envelope).toEqual({
      paths: ['package-lock.json', 'package.json'],
      manifests: true,
    });
    expect(orders[2].findings).toBe(2);
    // fp1 (false-positive, active) is not planned anywhere
    expect(JSON.stringify(out)).not.toContain('"fp1"');
    const undispatchable = out.undispatchable as Array<{ reason: string; findings: unknown[] }>;
    expect(undispatchable).toHaveLength(1);
    expect(undispatchable[0].reason).toContain('binary');
  });

  it('--with-floor runs the live floor, attributed against the envelope through the one comparator', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([], FLOOR_DEBT);
    const withEnvelope = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      runFloor: () => FAILING_FLOOR,
    });
    expect(withEnvelope.floorSource).toBe('live');
    expect(withEnvelope.plan.orders[0].findings[0].attribution).toBe('pre-existing');
    expect(withEnvelope.plan.orders[0].outputTail).toBe('src/a.ts(1,1): error TS1');
    writeBaseline([]);
    const noEnvelope = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      runFloor: () => FAILING_FLOOR,
    });
    expect(noEnvelope.plan.orders[0].findings[0].attribution).toBe('unattributed');
    // and without a stored source or --with-floor there is simply no floor, disclosed
    const none = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), { packs: TS });
    expect(none.floorSource).toBe('none');
    expect(none.plan.orders).toEqual([]);
  });

  it('a deferral joined to neither the live scan nor the baseline is undispatchable, and the scan runs only when a dep-vuln deferral exists', async () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([]);
    writeAllowlist([
      {
        fingerprint: 'gone',
        kind: 'dep-vuln',
        category: 'deferred',
        reason: 'r',
        addedBy: 't',
        addedAt: '2026-08-01',
        expiresAt: '2026-09-15',
      },
    ]);
    let scans = 0;
    const joined = await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      scanDepVulns: async () => {
        scans += 1;
        return [];
      },
      now: new Date('2026-08-25T00:00:00Z'),
    });
    expect(scans).toBe(1);
    expect(joined.plan.undispatchable[0].findings[0].id).toBe('gone');
    writeAllowlist([]);
    await planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      packs: TS,
      scanDepVulns: async () => {
        scans += 1;
        return [];
      },
    });
    expect(scans).toBe(1);
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
    const { plan } = await planRepoWorkOrders(repo, config, { packs: TS });
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

  it('repo facts come from the packs: install = the first pack-declared provision, roots from the manifest-pattern union + nested discovery', async () => {
    writePolicy({});
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'api', 'package.json'), '{}');
    writeFileSync(join(repo, 'packages', 'api', 'pnpm-lock.yaml'), '');
    expect(installCommandFor(repo, TS)).toEqual({ bin: 'npm', args: ['ci'] });
    expect(manifestRoots(repo, TS)).toEqual([
      { dir: '', files: ['package-lock.json', 'package.json'] },
      { dir: 'packages/api', files: ['package.json', 'pnpm-lock.yaml'] },
    ]);
    // a stack whose packs declare no provision command: install is UNDEFINED, never npm
    const go = [getLanguage('go')!];
    expect(installCommandFor(repo, go)).toBeUndefined();
    const { input } = await gatherWorkOrderInputs(repo, resolveRemediateConfig(repo), {
      packs: go,
      runFloor: () => NO_FLOOR,
    });
    expect(input.install).toBeUndefined();
    expect(input.manifests[0].files).not.toContain('package.json');
    expect(input.blocking).toEqual([]);
    expect(LANGUAGES.length).toBeGreaterThan(0);
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
