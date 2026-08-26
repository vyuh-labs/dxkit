/**
 * The work-order planner: grouping per (class, natural unit), envelope
 * derivation per class, budget derivation from the finding set and the
 * selecting task's cap, value ordering, the undispatchable bucket, the
 * per-package advisory union across every source, the per-file lint union,
 * and the recipe registry driving the tier decision (synthetic-injection
 * guarded).
 */
import { describe, it, expect } from 'vitest';
import {
  BUDGET_DERIVATION,
  deriveBudget,
  planWorkOrders,
  selectOrders,
  type AdvisoryInput,
  type FloorFailureInput,
  type PlannerInput,
} from '../../../src/remediate/work-orders/planner';
import { floorFindingId } from '../../../src/remediate/work-orders/types';
import { checkKey } from '../../../src/analyzers/correctness/attribution';
import { LOCKFILE_SYNC_LABEL } from '../../../src/languages/capabilities/correctness';
import type { RichBaselineEntry } from '../../../src/baseline/types';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';

const MANIFESTS = [
  { dir: '', files: ['package-lock.json', 'package.json'] },
  { dir: 'packages/api', files: ['package.json'] },
];

const NPM_CI = { bin: 'npm', args: ['ci'] };

function empty(): PlannerInput {
  return {
    floorFailures: [],
    blocking: [],
    deferred: [],
    debt: [],
    manifests: MANIFESTS,
    installFor: () => NPM_CI,
    policy: { maxSliceSize: 25, budgetFor: () => DEFAULT_REMEDIATE_BUDGET },
  };
}

const IMPORT_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: 'import-resolution',
  command: '',
  output: 'three unresolved',
  attribution: 'net-new',
  precision: 'finding',
  netNewFindings: ['left-pad'],
  findings: ['lodash', 'left-pad', 'zod'],
  unresolved: [
    { specifier: 'lodash', file: 'src/a.ts' },
    { specifier: 'lodash', file: 'src/z.ts' },
    { specifier: 'left-pad', file: 'src/b.ts' },
    { specifier: 'zod', file: 'packages/api/src/x.ts' },
  ],
};

const BUILD_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: 'typecheck',
  command: 'npx tsc --noEmit',
  output: 'src/c.ts(3,1): error TS2304',
  attribution: 'pre-existing',
};

function advisory(
  id: string,
  pkg: string,
  advisoryId: string,
  extra: Partial<AdvisoryInput> = {},
): AdvisoryInput {
  return { id, package: pkg, installedVersion: '1.0.0', advisoryId, ...extra };
}

function lint(
  id: string,
  file: string,
  rule: string,
  line: number,
): Extract<RichBaselineEntry, { kind: 'custom-check' }> {
  return { id, kind: 'custom-check', check: 'lint:typescript', blocking: true, file, line, rule };
}

describe('planWorkOrders: entry floor', () => {
  it('groups unresolved imports by the manifest root their importers share; envelope = EVERY importer + manifest + lockfile', () => {
    const plan = planWorkOrders({ ...empty(), floorFailures: [IMPORT_FAILURE] });
    const imports = plan.orders.filter((o) => o.class === 'unresolved-import');
    expect(imports.map((o) => o.id).sort()).toEqual([
      'unresolved-import:typescript:.',
      'unresolved-import:typescript:packages/api',
    ]);
    const root = imports.find((o) => o.id.endsWith(':.'))!;
    expect(root.findings.map((f) => f.id).sort()).toEqual([
      floorFindingId('typescript', 'import-resolution', 'left-pad'),
      floorFindingId('typescript', 'import-resolution', 'lodash'),
    ]);
    // both importers of lodash, not only the first
    expect(root.envelope).toEqual({
      paths: ['src/a.ts', 'src/b.ts', 'src/z.ts', 'package-lock.json', 'package.json'],
      manifests: true,
    });
    const lodash = root.findings.find((f) => f.id.endsWith('#lodash'))!;
    expect(lodash.evidence).toMatchObject({
      type: 'floor',
      specifier: 'lodash',
      importingFiles: ['src/a.ts', 'src/z.ts'],
    });
    expect(lodash.attribution).toBe('pre-existing');
    expect(root.findings.find((f) => f.id.endsWith('#left-pad'))!.attribution).toBe('net-new');
    const nested = imports.find((o) => o.id.endsWith('packages/api'))!;
    expect(nested.envelope.paths).toEqual(['packages/api/src/x.ts', 'packages/api/package.json']);
    expect(root.done.verifier).toBe('floor');
    expect(root.done.absentIds).toEqual(root.findings.map((f) => f.id));
    expect(root.outputTail).toBe('three unresolved');
    expect(root.tier).toBe('recipe');
    expect(root.recipe).toBe('declare-dependency');
  });

  it('floor finding ids build on the canonical checkKey (pack:label), never a second formula', () => {
    expect(floorFindingId('typescript', 'typecheck')).toBe(checkKey('typescript', 'typecheck'));
    expect(floorFindingId('typescript', 'typecheck', 'x')).toBe(
      `${checkKey('typescript', 'typecheck')}#x`,
    );
  });

  it('a floor failure with no finer identity is one order per check, class floor-failure, agent tier, command carried', () => {
    const plan = planWorkOrders({ ...empty(), floorFailures: [BUILD_FAILURE] });
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0];
    expect(order.class).toBe('floor-failure');
    expect(order.id).toBe('floor-failure:typescript:typecheck');
    expect(order.tier).toBe('agent');
    expect(order.findings[0].id).toBe(checkKey('typescript', 'typecheck'));
    expect(order.findings[0].evidence).toMatchObject({
      type: 'floor',
      command: 'npx tsc --noEmit',
    });
    expect(order.outputTail).toBe('src/c.ts(3,1): error TS2304');
    expect(order.envelope.manifests).toBe(false);
    expect(order.constraints.install).toEqual(NPM_CI);
  });

  it('a check with finding-level identities decomposes generically (not keyed on a label): per-finding attribution', () => {
    const tests: FloorFailureInput = {
      pack: 'typescript',
      label: 'affected-tests',
      command: 'npx vitest run',
      attribution: 'net-new',
      precision: 'finding',
      netNewFindings: ['suite/b'],
      findings: ['suite/a', 'suite/b'],
    };
    const plan = planWorkOrders({ ...empty(), floorFailures: [tests] });
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0];
    expect(order.class).toBe('floor-failure');
    expect(order.findings.map((f) => [f.id, f.attribution])).toEqual([
      [`${checkKey('typescript', 'affected-tests')}#suite/a`, 'pre-existing'],
      [`${checkKey('typescript', 'affected-tests')}#suite/b`, 'net-new'],
    ]);
  });

  it('a failing lockfile-sync check mints the stale-lockfile class: root manifest envelope, floor done, the lockfile-sync recipe', () => {
    const lockfile: FloorFailureInput = {
      pack: 'typescript',
      label: LOCKFILE_SYNC_LABEL,
      command: 'npm ci --dry-run --ignore-scripts --no-audit --no-fund',
      output: 'npm error Missing: left-pad@1.3.0 from lock file',
      attribution: 'net-new',
    };
    const plan = planWorkOrders({ ...empty(), floorFailures: [lockfile] });
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0];
    expect(order.id).toBe('stale-lockfile:typescript');
    expect(order.class).toBe('stale-lockfile');
    expect(order.findings[0].id).toBe(checkKey('typescript', LOCKFILE_SYNC_LABEL));
    expect(order.envelope).toEqual({
      paths: ['package-lock.json', 'package.json'],
      manifests: true,
    });
    expect(order.done.verifier).toBe('floor');
    expect(order.outputTail).toContain('Missing: left-pad');
    expect(order.tier).toBe('recipe');
    expect(order.recipe).toBe('lockfile-sync');
    // without an install command the recipe cannot run its reinstall: agent
    const noInstall = planWorkOrders({
      ...empty(),
      floorFailures: [lockfile],
      installFor: () => undefined,
    });
    expect(noInstall.orders[0].tier).toBe('agent');
  });

  it('no install command known: the order carries none (disclosed at render), never a guessed one', () => {
    const input: PlannerInput = {
      ...empty(),
      floorFailures: [BUILD_FAILURE],
      installFor: () => undefined,
    };
    expect(planWorkOrders(input).orders[0].constraints.install).toBeUndefined();
  });
});

describe('planWorkOrders: advisories', () => {
  it('ONE order per package unions blocking + deferred + debt advisories; both facts survive on a doubly-sourced advisory', () => {
    const plan = planWorkOrders({
      ...empty(),
      blocking: [
        {
          kind: 'dep-vuln',
          advisory: advisory('a1', 'axios', 'GHSA-1', {
            severity: 'high',
            fixedVersion: '1.7.0',
            reachable: true,
          }),
        },
      ],
      deferred: [
        // the SAME advisory is also deferred: expiry must still count
        {
          fingerprint: 'a1',
          expiresAt: '2026-09-01',
          kind: 'dep-vuln',
          advisory: advisory('a1', 'axios', 'GHSA-1'),
        },
        {
          fingerprint: 'a2',
          expiresAt: '2026-09-10',
          kind: 'dep-vuln',
          advisory: advisory('a2', 'axios', 'GHSA-2', { fixedVersion: '1.7.0' }),
        },
      ],
      debt: [
        { id: 'b1', kind: 'dep-vuln', package: 'lodash', advisoryId: 'GHSA-3', severity: 'low' },
      ],
    });
    expect(plan.undispatchable).toEqual([]);
    expect(plan.orders.map((o) => o.id)).toEqual(['dep-advisory:axios', 'dep-advisory:lodash']);
    const axios = plan.orders[0];
    expect(axios.findings.map((f) => [f.id, f.attribution])).toEqual([
      ['a1', 'net-new'],
      ['a2', 'deferred'],
    ]);
    // the blocking copy keeps its richness AND gains the expiry window
    expect(axios.findings[0].evidence).toMatchObject({
      fixedVersion: '1.7.0',
      reachable: true,
      severity: 'high',
      expiresAt: '2026-09-01',
    });
    expect(axios.provenance).toEqual({
      source: 'advisories',
      blocking: 1,
      deferred: 2,
      earliestExpiry: '2026-09-01',
    });
    // TWO manifest roots and no per-advisory rootDir: the owning manifest is
    // ambiguous, which the executor could only refuse at runtime, so the
    // registry's matches tiers the order to the agent (4.4.5 review).
    expect(axios.tier).toBe('agent');
    expect(axios.recipe).toBeUndefined();
    // baselined dep-vuln DEBT produces an order too (fix-vulns' backlog)
    const lodash = plan.orders[1];
    expect(lodash.findings[0].attribution).toBe('pre-existing');
    expect(lodash.tier).toBe('agent');
    expect(lodash.provenance).toEqual({ source: 'advisories', blocking: 0, deferred: 0 });
  });

  it('envelope scopes to the owning nested root when every finding knows it, else every discovered root', () => {
    const nested = planWorkOrders({
      ...empty(),
      blocking: [
        {
          kind: 'dep-vuln',
          advisory: advisory('n1', 'inner', 'GHSA-N', { rootDir: 'packages/api' }),
        },
      ],
    });
    expect(nested.orders[0].envelope.paths).toEqual(['packages/api/package.json']);
    const unknown = planWorkOrders({
      ...empty(),
      blocking: [{ kind: 'dep-vuln', advisory: advisory('u1', 'outer', 'GHSA-U') }],
    });
    // root unknown: every root's manifests, so the fix's files are inside
    expect(unknown.orders[0].envelope.paths).toEqual([
      'package-lock.json',
      'package.json',
      'packages/api/package.json',
    ]);
  });

  it('a deferral joined to nothing is undispatchable with identity-only evidence, never dropped', () => {
    const plan = planWorkOrders({
      ...empty(),
      deferred: [
        {
          fingerprint: 'gone',
          expiresAt: '2026-09-01',
          kind: 'unjoined',
          declaredKind: 'dep-vuln',
        },
      ],
    });
    expect(plan.orders).toEqual([]);
    expect(plan.undispatchable).toHaveLength(1);
    expect(plan.undispatchable[0].reason).toContain('matches no finding dxkit can see');
    expect(plan.undispatchable[0].findings[0]).toEqual({
      kind: 'dep-vuln',
      id: 'gone',
      attribution: 'deferred',
      evidence: { type: 'none' },
    });
  });
});

describe('planWorkOrders: lint (one order per file, every source)', () => {
  it('a file with a deferred finding AND grandfathered debt is ONE order (the duplicate-id plan-killer), ranked by expiry', () => {
    const plan = planWorkOrders({
      ...empty(),
      deferred: [
        {
          fingerprint: 'd1',
          expiresAt: '2026-09-05',
          kind: 'custom-check',
          entry: lint('d1', 'src/a.ts', 'eqeqeq', 3),
        },
      ],
      debt: [lint('l1', 'src/a.ts', 'no-unused-vars', 9), lint('l2', 'src/b.ts', 'eqeqeq', 1)],
    });
    expect(plan.orders.map((o) => o.id)).toEqual([
      'lint-located:src/a.ts',
      'lint-located:src/b.ts',
    ]);
    const merged = plan.orders[0];
    expect(merged.findings.map((f) => [f.id, f.attribution])).toEqual([
      ['d1', 'deferred'],
      ['l1', 'pre-existing'],
    ]);
    expect(merged.provenance).toMatchObject({
      source: 'debt-slice',
      file: 'src/a.ts',
      deferred: 1,
    });
    // ranked in the expiring band, ahead of the pure-debt file
    expect(plan.orders[1].findings[0].id).toBe('l2');
    expect(plan.undispatchable).toEqual([]);
  });

  it('blocking lint findings join the same per-file order and rank in the blocking band', () => {
    const plan = planWorkOrders({
      ...empty(),
      blocking: [{ kind: 'custom-check', entry: lint('b1', 'src/a.ts', 'eqeqeq', 2) }],
      debt: [lint('l1', 'src/a.ts', 'eqeqeq', 9)],
    });
    expect(plan.orders).toHaveLength(1);
    expect(plan.orders[0].findings.map((f) => f.attribution)).toEqual(['net-new', 'pre-existing']);
    expect(plan.orders[0].provenance).toMatchObject({ blocking: 1 });
  });

  it('slices by maxSliceSize with #n suffixes (no id collision) and slice provenance', () => {
    const debt: RichBaselineEntry[] = [];
    for (let i = 0; i < 7; i++)
      debt.push(lint(`f${i}`, 'src/big.ts', i % 2 === 0 ? 'no-unused-vars' : 'eqeqeq', i + 1));
    const plan = planWorkOrders({
      ...empty(),
      debt,
      policy: { maxSliceSize: 3, budgetFor: () => DEFAULT_REMEDIATE_BUDGET },
    });
    expect(plan.orders.map((o) => o.id)).toEqual([
      'lint-located:src/big.ts#1',
      'lint-located:src/big.ts#2',
      'lint-located:src/big.ts#3',
    ]);
    expect(
      plan.orders[0].findings.every((f) => (f.evidence as { rule?: string }).rule === 'eqeqeq'),
    ).toBe(true);
    expect(plan.orders[0].provenance).toEqual({
      source: 'debt-slice',
      file: 'src/big.ts',
      slice: 1,
      of: 3,
    });
    // A SLICED order cannot be file-scope autofixed and verified per slice,
    // so it tiers to the agent by matches (4.4.5 review), not via a runtime
    // refusal the plan surface would render as executable determinism.
    expect(plan.orders[0].tier).toBe('agent');
    expect(plan.orders[0].recipe).toBeUndefined();
  });

  it('binary custom-check debt and other kinds land in undispatchable with identity-only evidence', () => {
    const binary: RichBaselineEntry = {
      id: 'bin1',
      kind: 'custom-check',
      check: 'arch-check',
      blocking: true,
    };
    const secret: RichBaselineEntry = {
      id: 's1',
      kind: 'secret',
      tool: 'gitleaks',
      rule: 'generic',
      file: 'x',
      line: 1,
    };
    const plan = planWorkOrders({ ...empty(), debt: [binary, secret] });
    expect(plan.orders).toEqual([]);
    const reasons = plan.undispatchable.map((u) => u.reason);
    expect(reasons.some((r) => r.includes('binary'))).toBe(true);
    expect(reasons.some((r) => r.includes('secret'))).toBe(true);
    const s = plan.undispatchable.flatMap((u) => u.findings).find((f) => f.id === 's1')!;
    expect(s.evidence).toEqual({ type: 'none' });
  });
});

describe('planWorkOrders: value ordering + budget', () => {
  it('orders net-new floor > expiring defers (soonest first) > reachable high/critical > other blocking > pre-existing floor > debt', () => {
    const plan = planWorkOrders({
      ...empty(),
      floorFailures: [
        { ...BUILD_FAILURE, attribution: 'net-new' },
        { ...BUILD_FAILURE, label: 'tests' },
      ],
      blocking: [
        {
          kind: 'dep-vuln',
          advisory: advisory('r1', 'reach', 'GHSA-R', { severity: 'critical', reachable: true }),
        },
        { kind: 'dep-vuln', advisory: advisory('o1', 'other', 'GHSA-O', { severity: 'medium' }) },
      ],
      deferred: [
        {
          fingerprint: 'd1',
          expiresAt: '2026-09-10',
          kind: 'dep-vuln',
          advisory: advisory('d1', 'late', 'GHSA-L'),
        },
        {
          fingerprint: 'd2',
          expiresAt: '2026-09-01',
          kind: 'dep-vuln',
          advisory: advisory('d2', 'soon', 'GHSA-S'),
        },
      ],
      debt: [lint('l1', 'src/a.ts', 'eqeqeq', 1)],
    });
    expect(plan.orders.map((o) => o.id)).toEqual([
      'floor-failure:typescript:typecheck',
      'dep-advisory:soon',
      'dep-advisory:late',
      'dep-advisory:reach',
      'dep-advisory:other',
      'floor-failure:typescript:tests',
      'lint-located:src/a.ts',
    ]);
  });

  it('derives the budget from the finding count, capped by the task budget; the cap wins below the minimum and the derivation records capped numbers', () => {
    const d = BUDGET_DERIVATION;
    const one = deriveBudget(1, DEFAULT_REMEDIATE_BUDGET);
    expect(one.turns).toBe(Math.max(d.minTurns, d.baseTurns + d.perFindingTurns));
    expect(one.derivation).toContain(`${d.baseTurns} + ${d.perFindingTurns} * 1`);
    const many = deriveBudget(1000, DEFAULT_REMEDIATE_BUDGET);
    expect(many.turns).toBe(DEFAULT_REMEDIATE_BUDGET.maxTurns);
    expect(many.minutes).toBe(DEFAULT_REMEDIATE_BUDGET.maxMinutes);
    expect(many.usd).toBe(DEFAULT_REMEDIATE_BUDGET.maxUsd);
    const tiny = deriveBudget(0, { maxTurns: 4, maxMinutes: 2, maxUsd: 1 });
    expect(tiny).toMatchObject({ turns: 4, minutes: 2, usd: 1 });
    expect(tiny.derivation).toContain('= 4;');
    expect(tiny.derivation).toContain('= 1');
    expect(deriveBudget(0, DEFAULT_REMEDIATE_BUDGET).usd).toBeGreaterThan(0);
  });

  it('each class is capped by ITS selecting task budget (budgetFor is consulted per class)', () => {
    const asked: string[] = [];
    const plan = planWorkOrders({
      ...empty(),
      floorFailures: [BUILD_FAILURE],
      debt: [lint('l1', 'src/a.ts', 'eqeqeq', 1)],
      policy: {
        maxSliceSize: 25,
        budgetFor: (cls) => {
          asked.push(cls);
          return cls === 'lint-located'
            ? { maxTurns: 3, maxMinutes: 3, maxUsd: 1 }
            : DEFAULT_REMEDIATE_BUDGET;
        },
      },
    });
    expect(asked.sort()).toEqual(['floor-failure', 'lint-located']);
    expect(plan.orders.find((o) => o.class === 'lint-located')!.budget.turns).toBe(3);
    expect(plan.orders.find((o) => o.class === 'floor-failure')!.budget.turns).toBeGreaterThan(3);
  });

  it('selectOrders filters by class; deterministic for the same input', () => {
    const input: PlannerInput = {
      ...empty(),
      floorFailures: [BUILD_FAILURE],
      debt: [lint('l2', 'src/b.ts', 'eqeqeq', 1), lint('l1', 'src/a.ts', 'eqeqeq', 1)],
    };
    const plan = planWorkOrders(input);
    expect(selectOrders(plan, ['lint-located']).map((o) => o.class)).toEqual([
      'lint-located',
      'lint-located',
    ]);
    expect(selectOrders(plan, []).length).toBe(0);
    expect(planWorkOrders(input)).toEqual(plan);
  });
});
