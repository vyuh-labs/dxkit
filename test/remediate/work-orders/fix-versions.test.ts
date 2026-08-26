/**
 * The advisory fix-version join (4.4.5 estate fix): the rehearsal estate
 * tiered EVERY dep-advisory order to the agent because nothing threaded a
 * concrete fixed version into the planner's evidence. These pin the three
 * shapes that must tier `recipe` now — a deferral joined from a live-scan
 * finding that carries the fix, a deferral or debt advisory whose fix OSV
 * can resolve, and the fill-missing-only discipline — plus the honest
 * negative: no knowable fix stays agent-tier, disclosed.
 */
import { beforeEach, describe, it, expect } from 'vitest';
import {
  advisoryDetailMap,
  OSV_FIX_RESOLUTION_CAP,
} from '../../../src/remediate/work-orders/fix-versions';
import {
  planWorkOrders,
  type DeferredInput,
  type PlannerInput,
} from '../../../src/remediate/work-orders/planner';
import type { RichBaselineEntry } from '../../../src/baseline/types';
import type { DepVulnFinding } from '../../../src/languages/capabilities/types';
import { __clearOsvCache, type OsvFetcher, type OsvVuln } from '../../../src/analyzers/tools/osv';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';

const NPM_CI = { bin: 'npm', args: ['ci'] };

/** Single-root manifests: the owning root is unambiguous, so tier depends
 *  only on the advisory evidence (the estate's layout). */
function input(partial: Partial<PlannerInput>): PlannerInput {
  return {
    floorFailures: [],
    blocking: [],
    deferred: [],
    debt: [],
    manifests: [{ dir: '', files: ['package-lock.json', 'package.json'] }],
    installFor: () => NPM_CI,
    policy: { maxSliceSize: 25, budgetFor: () => DEFAULT_REMEDIATE_BUDGET },
    ...partial,
  };
}

function debtEntry(
  id: string,
  pkg: string,
  advisoryId: string,
  installedVersion?: string,
): Extract<RichBaselineEntry, { kind: 'dep-vuln' }> {
  return {
    id,
    kind: 'dep-vuln',
    package: pkg,
    ...(installedVersion !== undefined ? { installedVersion } : {}),
    advisoryId,
    severity: 'high',
  } as Extract<RichBaselineEntry, { kind: 'dep-vuln' }>;
}

function deferredAdvisory(
  id: string,
  pkg: string,
  advisoryId: string,
  extra: Record<string, unknown> = {},
): DeferredInput {
  return {
    fingerprint: id,
    expiresAt: '2026-09-15',
    kind: 'dep-vuln',
    advisory: { id, package: pkg, advisoryId, installedVersion: '3.13.0', ...extra },
  } as DeferredInput;
}

function scannedFinding(fingerprint: string, extra: Partial<DepVulnFinding> = {}): DepVulnFinding {
  return {
    id: 'GHSA-1',
    package: 'js-yaml',
    installedVersion: '3.13.0',
    tool: 'osv-scanner',
    severity: 'high',
    fingerprint,
    ...extra,
  };
}

/** An OSV record whose ranges declare the given fixed events. */
function osvRecord(fixed: string[]): OsvVuln {
  return { affected: [{ ranges: [{ type: 'SEMVER', events: fixed.map((f) => ({ fixed: f })) }] }] };
}

function fetcherWith(records: Record<string, OsvVuln>): { fetcher: OsvFetcher; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    fetcher: async (id) => {
      asked.push(id);
      return records[id] ?? null;
    },
  };
}

describe('advisoryDetailMap', () => {
  // resolveFixVersions rides the OSV client's process-wide session cache;
  // isolate the tests from each other's records.
  beforeEach(() => __clearOsvCache());

  it('threads the PAID scan into baseline debt (fix, reachability, pack) with no OSV call', async () => {
    const disclosures: string[] = [];
    const { fetcher, asked } = fetcherWith({});
    const details = await advisoryDetailMap({
      deferred: [],
      debt: [debtEntry('d1', 'js-yaml', 'GHSA-1')],
      scanned: new Map([
        [
          'd1',
          scannedFinding('d1', { fixedVersion: '4.1.0', reachable: true, packId: 'typescript' }),
        ],
      ]),
      osvFetcher: fetcher,
      disclosures,
    });
    expect(details.get('d1')).toMatchObject({
      fixedVersion: '4.1.0',
      reachable: true,
      pack: 'typescript',
    });
    expect(asked).toEqual([]);
  });

  it('resolves a missing fix via OSV, installed-version-correct (the minimal safe move)', async () => {
    const disclosures: string[] = [];
    const { fetcher } = fetcherWith({ 'GHSA-1': osvRecord(['3.14.1', '4.1.0']) });
    const details = await advisoryDetailMap({
      deferred: [deferredAdvisory('a1', 'js-yaml', 'GHSA-1')],
      debt: [],
      scanned: new Map(),
      osvFetcher: fetcher,
      disclosures,
    });
    // installed 3.13.0: the backport branch fix (3.14.1), never a surprise major.
    expect(details.get('a1')).toEqual({ fixedVersion: '3.14.1' });
    expect(disclosures.join(' ')).toContain('1 of 1 advisories resolved via OSV');
  });

  it('two installations of one advisory resolve separately, each to its own minimal safe move', async () => {
    const disclosures: string[] = [];
    const { fetcher } = fetcherWith({ 'GHSA-1': osvRecord(['3.14.1', '4.1.0']) });
    // Same advisory, two packages/roots at different installed versions:
    // keyed by advisory alone the last-resolved answer (4.1.0) was handed to
    // BOTH, so the 3.x installation got a surprise major.
    const details = await advisoryDetailMap({
      deferred: [],
      debt: [
        debtEntry('d-old', 'js-yaml', 'GHSA-1', '3.13.0'),
        debtEntry('d-new', 'js-yaml', 'GHSA-1', '4.0.0'),
      ],
      scanned: new Map(),
      osvFetcher: fetcher,
      disclosures,
    });
    expect(details.get('d-old')).toEqual({ fixedVersion: '3.14.1' });
    expect(details.get('d-new')).toEqual({ fixedVersion: '4.1.0' });
  });

  it('an unreachable OSV is fail-open and DISCLOSED: no fix, no crash, no guess', async () => {
    const disclosures: string[] = [];
    const details = await advisoryDetailMap({
      deferred: [deferredAdvisory('a1', 'js-yaml', 'GHSA-1')],
      debt: [debtEntry('d1', 'lodash', 'GHSA-2')],
      scanned: new Map(),
      osvFetcher: async () => null,
      disclosures,
    });
    expect(details.get('a1')).toBeUndefined();
    expect(details.get('d1')).toBeUndefined();
    expect(disclosures.join(' ')).toContain('0 of 2 advisories resolved via OSV');
  });

  it('caps the OSV spend, deferrals first, and discloses the capped tail', async () => {
    const disclosures: string[] = [];
    const debt = Array.from({ length: OSV_FIX_RESOLUTION_CAP + 5 }, (_, i) =>
      debtEntry(`d${i}`, `pkg${i}`, `GHSA-${i}`),
    );
    await advisoryDetailMap({
      deferred: [],
      debt,
      scanned: new Map(),
      osvFetcher: async () => null,
      disclosures,
    });
    expect(disclosures.join(' ')).toContain(`capped at ${OSV_FIX_RESOLUTION_CAP}`);
    expect(disclosures.join(' ')).toContain('5 more');
  });
});

describe('the estate shape: dep-advisory orders tier recipe wherever the fix is knowable', () => {
  it('a deferral joined from a live-scan finding WITH fixedVersion tiers recipe (no details needed)', () => {
    const plan = planWorkOrders(
      input({
        deferred: [deferredAdvisory('a1', 'js-yaml', 'GHSA-1', { fixedVersion: '4.1.0' })],
      }),
    );
    expect(plan.orders[0].tier).toBe('recipe');
    expect(plan.orders[0].recipe).toBe('override-pin');
  });

  it('a deferral whose scan carried no fix tiers recipe once the detail join supplies one', () => {
    const bare = planWorkOrders(input({ deferred: [deferredAdvisory('a1', 'js-yaml', 'GHSA-1')] }));
    expect(bare.orders[0].tier).toBe('agent');
    const joined = planWorkOrders(
      input({
        deferred: [deferredAdvisory('a1', 'js-yaml', 'GHSA-1')],
        advisoryDetails: new Map([['a1', { fixedVersion: '4.1.0' }]]),
      }),
    );
    expect(joined.orders[0].tier).toBe('recipe');
    expect(joined.orders[0].recipe).toBe('override-pin');
    const evidence = joined.orders[0].findings[0].evidence;
    expect(evidence.type === 'dep-vuln' && evidence.fixedVersion).toBe('4.1.0');
  });

  it('a baseline DEBT advisory with an OSV-resolvable fix tiers recipe; no knowable fix stays agent', () => {
    const debt = [debtEntry('d1', 'js-yaml', 'GHSA-1'), debtEntry('d2', 'left-pad', 'GHSA-2')];
    const plan = planWorkOrders(
      input({ debt, advisoryDetails: new Map([['d1', { fixedVersion: '4.1.0' }]]) }),
    );
    const jsYaml = plan.orders.find((o) => o.id === 'dep-advisory:js-yaml')!;
    const leftPad = plan.orders.find((o) => o.id === 'dep-advisory:left-pad')!;
    expect(jsYaml.tier).toBe('recipe');
    expect(jsYaml.recipe).toBe('override-pin');
    expect(leftPad.tier).toBe('agent');
  });

  it('the detail join fills MISSING fields only: the finding source always wins', () => {
    const plan = planWorkOrders(
      input({
        deferred: [deferredAdvisory('a1', 'js-yaml', 'GHSA-1', { fixedVersion: '4.1.1' })],
        advisoryDetails: new Map([['a1', { fixedVersion: '9.9.9', reachable: true }]]),
      }),
    );
    const evidence = plan.orders[0].findings[0].evidence;
    expect(evidence.type === 'dep-vuln' && evidence.fixedVersion).toBe('4.1.1');
    expect(evidence.type === 'dep-vuln' && evidence.reachable).toBe(true);
  });
});
