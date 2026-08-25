/**
 * `remediate plan --json` on a fixture repo: the work orders come from the
 * ONE gather adapter (entry floor attributed against the baseline's floor
 * envelope, lint debt from the baseline, active deferrals joined to their
 * entries), the policy knob caps slice size, and a gather failure is
 * disclosed rather than crashing the plan.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runRemediatePlan } from '../../../src/remediate/plan-cli';
import {
  gatherWorkOrderInputs,
  planRepoWorkOrders,
} from '../../../src/remediate/work-orders/gather';
import { resolveRemediateConfig } from '../../../src/remediate/config';
import type { CorrectnessFloorResult } from '../../../src/analyzers/correctness/run';

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

function captureJson(run: () => void): Record<string, unknown> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    run();
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(chunks.join('')) as Record<string, unknown>;
}

describe('remediate plan --json: work orders', () => {
  it('lists orders from the entry floor + lint debt + deferrals, with tier/budget/done and undispatchable', () => {
    writePolicy({ remediate: { enabled: true, tasks: ['fix-build', 'fix-lint', 'fix-vulns'] } });
    writeBaseline(
      [
        lintEntry('l1', 'src/a.ts', 1, 'eqeqeq'),
        lintEntry('l2', 'src/a.ts', 9, 'eqeqeq'),
        lintEntry('l3', 'src/b.ts', 2, 'no-unused-vars'),
        { id: 'v1', kind: 'dep-vuln', package: 'js-yaml', advisoryId: 'GHSA-1', severity: 'high' },
        { id: 'bin1', kind: 'custom-check', check: 'arch-check', blocking: true },
      ],
      // The recorded floor envelope says typecheck was already failing:
      // the live failure attributes pre-existing, not net-new.
      {
        capturedAtCommit: 'base',
        capturedAt: '2026-08-01T00:00:00.000Z',
        checks: [
          { pack: 'typescript', label: 'typecheck', command: 'npx tsc --noEmit', status: 'fail' },
        ],
      },
    );
    writeAllowlist([
      {
        fingerprint: 'v1',
        kind: 'dep-vuln',
        category: 'deferred',
        reason: 'lane will fix',
        addedBy: 't',
        addedAt: '2026-08-01',
        expiresAt: '2026-09-15',
      },
    ]);
    const out = captureJson(() =>
      runRemediatePlan(repo, {
        json: true,
        gather: { runFloor: () => FAILING_FLOOR, now: new Date('2026-08-25T00:00:00Z') },
      }),
    );
    expect(out.schema).toBe('remediate-plan.v1');
    expect(out.workOrderPlanError).toBeNull();
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
    expect(floorOrder.done).toMatchObject({ verifier: 'floor', absent: 1 });
    expect((floorOrder.budget as { derivation: string }).derivation).toContain('clamp(');
    const advisory = orders[0];
    expect(advisory.attribution).toEqual(['deferred']);
    expect(advisory.provenance).toEqual({
      source: 'deferred-advisory',
      earliestExpiry: '2026-09-15',
    });
    expect(advisory.envelope).toEqual({
      paths: ['package.json', 'package-lock.json'],
      manifests: true,
    });
    const lintA = orders[2];
    expect(lintA.findings).toBe(2);
    expect(lintA.tier).toBe('recipe');
    expect(lintA.recipe).toBe('lint-autofix');
    // the binary custom-check has no file to scope to: disclosed, not dropped
    const undispatchable = out.undispatchable as Array<{ reason: string; findings: unknown[] }>;
    expect(undispatchable).toHaveLength(1);
    expect(undispatchable[0].reason).toContain('binary');
    expect(undispatchable[0].findings).toEqual([{ kind: 'custom-check', id: 'bin1' }]);
  });

  it('an absent floor envelope attributes a live failure unattributed (never net-new by default)', () => {
    writePolicy({ remediate: { enabled: true } });
    writeBaseline([]);
    const plan = planRepoWorkOrders(repo, resolveRemediateConfig(repo), {
      runFloor: () => FAILING_FLOOR,
    });
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].findings[0].attribution).toBe('unattributed');
  });

  it('remediate.workOrders.maxSliceSize caps a debt slice and reaches the planner through the config', () => {
    writePolicy({ remediate: { enabled: true, workOrders: { maxSliceSize: 2 } } });
    writeBaseline([1, 2, 3, 4, 5].map((n) => lintEntry(`l${n}`, 'src/a.ts', n, 'eqeqeq')));
    const config = resolveRemediateConfig(repo);
    expect(config.workOrders.maxSliceSize).toBe(2);
    const plan = planRepoWorkOrders(repo, config, {
      runFloor: () => ({ ran: false, blocks: false, checks: [] }),
    });
    expect(plan.orders.map((o) => o.id)).toEqual([
      'lint-located:src/a.ts#1',
      'lint-located:src/a.ts#2',
      'lint-located:src/a.ts#3',
    ]);
    expect(plan.orders.map((o) => o.findings.length)).toEqual([2, 2, 1]);
  });

  it('the default slice size is 25 and an invalid knob falls back to it', () => {
    writePolicy({ remediate: { workOrders: { maxSliceSize: -3 } } });
    expect(resolveRemediateConfig(repo).workOrders.maxSliceSize).toBe(25);
  });

  it('gathers the repo facts once: pm install command and the root manifest + lockfile', () => {
    writePolicy({});
    const input = gatherWorkOrderInputs(repo, resolveRemediateConfig(repo), {
      runFloor: () => ({ ran: false, blocks: false, checks: [] }),
    });
    expect(input.install).toEqual({ bin: 'npm', args: ['ci'] });
    expect(input.manifests).toEqual([{ dir: '', files: ['package.json', 'package-lock.json'] }]);
    expect(input.entryFloor).toBeNull();
    expect(input.blocking).toEqual([]);
  });

  it('a gather failure is disclosed in the JSON, never a crashed plan', () => {
    writePolicy({ remediate: { enabled: true } });
    const out = captureJson(() =>
      runRemediatePlan(repo, {
        json: true,
        gather: {
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
