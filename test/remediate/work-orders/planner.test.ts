/**
 * The work-order planner: grouping per (class, natural unit), envelope
 * derivation per class, budget derivation from the finding set and the
 * selecting task's cap, value ordering, the undispatchable bucket, blocking +
 * deferred advisories merging into ONE order per package, and the recipe
 * registry driving the tier decision (synthetic-injection guarded).
 */
import { describe, it, expect } from 'vitest';
import {
  BUDGET_DERIVATION,
  assignTier,
  deriveBudget,
  planWorkOrders,
  selectOrders,
  uniformBudget,
  type AdvisoryInput,
  type FloorFailureInput,
  type PlannerInput,
} from '../../../src/remediate/work-orders/planner';
import { RECIPE_REGISTRY, matchRecipe } from '../../../src/remediate/work-orders/recipes-registry';
import { WORK_ORDER_CLASSES, floorFindingId } from '../../../src/remediate/work-orders/types';
import type {
  WorkOrder,
  WorkOrderClassDeclaration,
} from '../../../src/remediate/work-orders/types';
import { IMPORT_RESOLUTION_LABEL } from '../../../src/analyzers/correctness/run';
import type { RichBaselineEntry } from '../../../src/baseline/types';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';

const MANIFESTS = [
  { dir: '', files: ['package-lock.json', 'package.json'] },
  { dir: 'packages/api', files: ['package.json'] },
];

function empty(): PlannerInput {
  return {
    floorFailures: [],
    blocking: [],
    deferred: [],
    debt: [],
    manifests: MANIFESTS,
    install: { bin: 'npm', args: ['ci'] },
    policy: { maxSliceSize: 25, budgetFor: uniformBudget(DEFAULT_REMEDIATE_BUDGET) },
  };
}

const IMPORT_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: IMPORT_RESOLUTION_LABEL,
  command: '',
  output: 'three unresolved',
  attribution: 'net-new',
  precision: 'finding',
  netNewFindings: ['left-pad'],
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
      floorFindingId('typescript', IMPORT_RESOLUTION_LABEL, 'left-pad'),
      floorFindingId('typescript', IMPORT_RESOLUTION_LABEL, 'lodash'),
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
    expect(root.provenance).toEqual({
      source: 'entry-floor',
      check: `typescript/${IMPORT_RESOLUTION_LABEL}`,
    });
    expect(root.tier).toBe('recipe');
    expect(root.recipe).toBe('declare-dependency');
  });

  it('a floor failure with no finer identity is one order per check, class floor-failure, agent tier, command carried', () => {
    const plan = planWorkOrders({ ...empty(), floorFailures: [BUILD_FAILURE] });
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0];
    expect(order.class).toBe('floor-failure');
    expect(order.id).toBe('floor-failure:typescript:typecheck');
    expect(order.tier).toBe('agent');
    expect(order.findings[0].evidence).toMatchObject({
      type: 'floor',
      command: 'npx tsc --noEmit',
    });
    expect(order.outputTail).toBe('src/c.ts(3,1): error TS2304');
    expect(order.envelope.manifests).toBe(false);
    expect(order.constraints.install).toEqual({ bin: 'npm', args: ['ci'] });
  });

  it('no install command known: the order carries none (disclosed at render), never a guessed one', () => {
    const input: PlannerInput = { ...empty(), floorFailures: [BUILD_FAILURE] };
    delete (input as { install?: unknown }).install;
    expect(planWorkOrders(input).orders[0].constraints.install).toBeUndefined();
  });
});

describe('planWorkOrders: advisories', () => {
  it('ONE order per package unions blocking + deferred advisories (never drops either), envelope = manifests only', () => {
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
        { kind: 'dep-vuln', advisory: advisory('b1', 'lodash', 'GHSA-3', { severity: 'low' }) },
      ],
      deferred: [
        {
          fingerprint: 'a2',
          expiresAt: '2026-09-10',
          kind: 'dep-vuln',
          advisory: advisory('a2', 'axios', 'GHSA-2', { fixedVersion: '1.7.0' }),
        },
        {
          fingerprint: 'a1',
          expiresAt: '2026-09-01',
          kind: 'dep-vuln',
          advisory: advisory('a1', 'axios', 'GHSA-1'),
        },
      ],
    });
    expect(plan.undispatchable).toEqual([]);
    expect(plan.orders.map((o) => o.id)).toEqual(['dep-advisory:axios', 'dep-advisory:lodash']);
    const axios = plan.orders[0];
    expect(axios.findings.map((f) => [f.id, f.attribution])).toEqual([
      ['a1', 'net-new'],
      ['a2', 'deferred'],
    ]);
    expect(axios.provenance).toEqual({
      source: 'advisories',
      blocking: 1,
      deferred: 1,
      earliestExpiry: '2026-09-10',
    });
    expect(axios.envelope).toEqual({
      paths: ['package-lock.json', 'package.json'],
      manifests: true,
    });
    expect(axios.findings[0].evidence).toMatchObject({
      type: 'dep-vuln',
      fixedVersion: '1.7.0',
      reachable: true,
      severity: 'high',
    });
    expect(axios.done.verifier).toBe('guardrail');
    expect(axios.tier).toBe('recipe');
    expect(axios.recipe).toBe('override-pin');
    expect(plan.orders[1].tier).toBe('agent');
  });

  it('a deferral joined to nothing is undispatchable with the reason, never dropped', () => {
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

  it('a deferred located custom-check is a lint-located order (its class), attributed deferred', () => {
    const plan = planWorkOrders({
      ...empty(),
      deferred: [
        {
          fingerprint: 'l1',
          expiresAt: '2026-09-01',
          kind: 'custom-check',
          entry: lint('l1', 'src/a.ts', 'eqeqeq', 3),
        },
      ],
    });
    expect(plan.undispatchable).toEqual([]);
    expect(plan.orders.map((o) => [o.id, o.class])).toEqual([
      ['lint-located:src/a.ts', 'lint-located'],
    ]);
    expect(plan.orders[0].findings[0].attribution).toBe('deferred');
  });
});

describe('planWorkOrders: debt slices', () => {
  it('groups lint debt by file, then by rule + line, capped by maxSliceSize with slice provenance', () => {
    const debt: RichBaselineEntry[] = [];
    for (let i = 0; i < 7; i++)
      debt.push(lint(`f${i}`, 'src/big.ts', i % 2 === 0 ? 'no-unused-vars' : 'eqeqeq', i + 1));
    debt.push(lint('g1', 'src/small.ts', 'eqeqeq', 4));
    const plan = planWorkOrders({
      ...empty(),
      debt,
      policy: { maxSliceSize: 3, budgetFor: uniformBudget(DEFAULT_REMEDIATE_BUDGET) },
    });
    expect(plan.orders.map((o) => o.id)).toEqual([
      'lint-located:src/big.ts#1',
      'lint-located:src/big.ts#2',
      'lint-located:src/big.ts#3',
      'lint-located:src/small.ts',
    ]);
    const first = plan.orders[0];
    expect(first.findings).toHaveLength(3);
    expect(first.findings.every((f) => (f.evidence as { rule?: string }).rule === 'eqeqeq')).toBe(
      true,
    );
    expect(first.envelope).toEqual({ paths: ['src/big.ts'], manifests: false });
    expect(first.provenance).toEqual({ source: 'debt-slice', file: 'src/big.ts', slice: 1, of: 3 });
    expect(first.tier).toBe('recipe');
    expect(first.recipe).toBe('lint-autofix');
    expect(plan.orders[3].provenance).toEqual({
      source: 'debt-slice',
      file: 'src/small.ts',
      slice: 1,
      of: 1,
    });
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

  it('derives the budget from the finding count, capped by the task budget, formula recorded with CAPPED numbers', () => {
    const d = BUDGET_DERIVATION;
    const one = deriveBudget(1, DEFAULT_REMEDIATE_BUDGET);
    expect(one.turns).toBe(Math.max(d.minTurns, d.baseTurns + d.perFindingTurns));
    expect(one.derivation).toContain(`${d.baseTurns} + ${d.perFindingTurns} * 1`);
    const many = deriveBudget(1000, DEFAULT_REMEDIATE_BUDGET);
    expect(many.turns).toBe(DEFAULT_REMEDIATE_BUDGET.maxTurns);
    expect(many.minutes).toBe(DEFAULT_REMEDIATE_BUDGET.maxMinutes);
    expect(many.usd).toBe(DEFAULT_REMEDIATE_BUDGET.maxUsd);
    // a cap BELOW the derivation minimum wins, and the derivation says so
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

describe('recipe registry drives the tier (synthetic injection)', () => {
  const draft: Omit<WorkOrder, 'tier' | 'recipe'> = {
    id: 'synthetic-class:unit',
    class: 'synthetic-class',
    findings: [],
    envelope: { paths: ['x'], manifests: false },
    constraints: { forbidden: [] },
    done: { absentIds: [], verifier: 'guardrail', command: 'x' },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    provenance: { source: 'guardrail-blocking' },
  };

  it('an order of an unregistered class tiers agent under the built-in registry', () => {
    expect(assignTier(draft).tier).toBe('agent');
    expect(matchRecipe({ ...draft, tier: 'agent' })).toBeUndefined();
  });

  it('a fake recipe for a fake class, injected into the registry, tiers the order recipe', () => {
    const fake = {
      id: 'synthetic-fixer',
      class: 'synthetic-class',
      summary: 't',
      implemented: false,
      matches: () => true,
    };
    const tiered = assignTier(draft, [...RECIPE_REGISTRY, fake]);
    expect(tiered.tier).toBe('recipe');
    expect(tiered.recipe).toBe('synthetic-fixer');
  });

  it('the planner reads the registry it is handed (a fake recipe flips a real order)', () => {
    const input: PlannerInput = { ...empty(), floorFailures: [BUILD_FAILURE] };
    expect(planWorkOrders(input).orders[0].tier).toBe('agent');
    const fake = {
      id: 'floor-fixer',
      class: 'floor-failure',
      summary: 't',
      implemented: false,
      matches: () => true,
    };
    const flipped = planWorkOrders(input, { registry: [...RECIPE_REGISTRY, fake] }).orders[0];
    expect(flipped.tier).toBe('recipe');
    expect(flipped.recipe).toBe('floor-fixer');
  });

  it('the class table is the spine: every declared recipe is named by exactly its class, and vice versa', () => {
    const ids = RECIPE_REGISTRY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fromTable = Object.entries(WORK_ORDER_CLASSES)
      .filter(([, d]) => d.recipe !== null)
      .map(([c, d]) => [d.recipe, c]);
    expect(RECIPE_REGISTRY.map((r) => [r.id, r.class]).sort()).toEqual(fromTable.sort());
    for (const r of RECIPE_REGISTRY) expect(r.implemented).toBe(false);
    // a class with no producer carries a reason (the DEFERRED_KINDS discipline)
    for (const d of Object.values(WORK_ORDER_CLASSES) as WorkOrderClassDeclaration[]) {
      if (d.producers.includes('pending')) expect(d.pendingReason).toBeTruthy();
      else expect(d.producers.length).toBeGreaterThan(0);
    }
  });
});
