/**
 * The work-order planner: grouping per (class, natural unit), envelope
 * derivation per class, budget derivation from the finding set, value
 * ordering, the undispatchable bucket, and the recipe registry driving the
 * tier decision (synthetic-injection guarded).
 */
import { describe, it, expect } from 'vitest';
import {
  BUDGET_DERIVATION,
  assignTier,
  deriveBudget,
  planWorkOrders,
  selectOrders,
  type PlannerInput,
} from '../../../src/remediate/work-orders/planner';
import { RECIPE_REGISTRY, matchRecipe } from '../../../src/remediate/work-orders/recipes-registry';
import { WORK_ORDER_CLASSES, floorFindingId } from '../../../src/remediate/work-orders/types';
import type { WorkOrder } from '../../../src/remediate/work-orders/types';
import { IMPORT_RESOLUTION_LABEL } from '../../../src/analyzers/correctness/run';
import type {
  CorrectnessCheckResult,
  CorrectnessFloorResult,
} from '../../../src/analyzers/correctness/run';
import type { AttributedFloorFailure } from '../../../src/analyzers/correctness/attribution';
import type { ClassifiedPair } from '../../../src/gate/result';
import type { RichBaselineEntry } from '../../../src/baseline/types';
import type { AllowlistEntry } from '../../../src/allowlist/file';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';

const POLICY = { maxSliceSize: 25, budget: DEFAULT_REMEDIATE_BUDGET };
const MANIFESTS = [
  { dir: '', files: ['package.json', 'package-lock.json'] },
  { dir: 'packages/api', files: ['package.json'] },
];

function empty(): PlannerInput {
  return {
    entryFloor: null,
    blocking: [],
    deferred: [],
    debt: [],
    manifests: MANIFESTS,
    install: { bin: 'npm', args: ['ci'] },
    policy: POLICY,
  };
}

function floor(
  checks: CorrectnessCheckResult[],
  attributed: AttributedFloorFailure[],
): PlannerInput['entryFloor'] {
  const result: CorrectnessFloorResult = { ran: true, checks, blocks: true };
  return { result, attributed };
}

const IMPORT_CHECK: CorrectnessCheckResult = {
  pack: 'typescript',
  label: IMPORT_RESOLUTION_LABEL,
  bin: '',
  status: 'fail',
  output: [
    "'lodash' does not resolve against the installed tree (imported by src/a.ts)",
    "'left-pad' does not resolve against the installed tree (imported by src/b.ts)",
    "'zod' does not resolve against the installed tree (imported by packages/api/src/x.ts)",
    'An import of an uninstalled/undeclared package fails at build or run time.',
  ].join('\n'),
  findings: ['lodash', 'left-pad', 'zod'],
};

const BUILD_CHECK: CorrectnessCheckResult = {
  pack: 'typescript',
  label: 'typecheck',
  bin: 'npx',
  args: ['tsc', '--noEmit'],
  status: 'fail',
  output: 'src/c.ts(3,1): error TS2304',
};

function depVuln(
  id: string,
  pkg: string,
  advisoryId: string,
  severity?: 'critical' | 'high' | 'medium' | 'low',
): Extract<RichBaselineEntry, { kind: 'dep-vuln' }> {
  return {
    id,
    kind: 'dep-vuln',
    package: pkg,
    installedVersion: '1.0.0',
    advisoryId,
    ...(severity ? { severity } : {}),
  };
}

function lint(
  id: string,
  file: string,
  rule: string,
  line: number,
): Extract<RichBaselineEntry, { kind: 'custom-check' }> {
  return { id, kind: 'custom-check', check: 'lint:typescript', blocking: true, file, line, rule };
}

function blockingPair(entry: RichBaselineEntry): {
  pair: ClassifiedPair;
  entry: RichBaselineEntry;
} {
  return {
    entry,
    pair: {
      pair: { currentId: entry.id, status: 'added', confidence: 1, reasons: [] },
      classification: { status: 'added', blocks: true, warns: false, reasons: [] },
      kind: entry.kind,
    },
  };
}

function deferred(fingerprint: string, expiresAt: string): AllowlistEntry {
  return {
    fingerprint,
    kind: 'dep-vuln',
    category: 'deferred',
    reason: 'lane will fix',
    addedBy: 't',
    addedAt: '2026-08-01',
    expiresAt,
  };
}

describe('planWorkOrders: entry floor', () => {
  it('groups unresolved imports by the manifest root their importing files share, with the envelope = importers + manifest + lockfile', () => {
    const input: PlannerInput = {
      ...empty(),
      entryFloor: floor(
        [IMPORT_CHECK],
        [
          {
            check: IMPORT_CHECK,
            attribution: 'net-new',
            precision: 'finding',
            netNewFindings: ['left-pad'],
          },
        ],
      ),
    };
    const plan = planWorkOrders(input);
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
    expect(root.envelope).toEqual({
      paths: ['src/a.ts', 'src/b.ts', 'package.json', 'package-lock.json'],
      manifests: true,
    });
    // finding-level attribution: only left-pad is the change's own
    const byId = new Map(root.findings.map((f) => [f.id, f.attribution]));
    expect(byId.get(floorFindingId('typescript', IMPORT_RESOLUTION_LABEL, 'left-pad'))).toBe(
      'net-new',
    );
    expect(byId.get(floorFindingId('typescript', IMPORT_RESOLUTION_LABEL, 'lodash'))).toBe(
      'pre-existing',
    );
    const nested = imports.find((o) => o.id.endsWith('packages/api'))!;
    expect(nested.envelope.paths).toEqual(['packages/api/src/x.ts', 'packages/api/package.json']);
    // the importing file is carried as structured evidence
    const zod = nested.findings[0];
    expect(zod.evidence).toMatchObject({
      type: 'floor',
      specifier: 'zod',
      importingFile: 'packages/api/src/x.ts',
    });
    expect(root.done.verifier).toBe('floor');
    expect(root.done.absentIds).toEqual(root.findings.map((f) => f.id));
    expect(root.provenance).toEqual({
      source: 'entry-floor',
      check: `typescript/${IMPORT_RESOLUTION_LABEL}`,
    });
    // bare specifiers: the declare-dependency recipe matches
    expect(root.tier).toBe('recipe');
    expect(root.recipe).toBe('declare-dependency');
  });

  it('a floor failure with no finer identity is one order per check, class floor-failure, agent tier, with the failing command', () => {
    const input: PlannerInput = {
      ...empty(),
      entryFloor: floor([BUILD_CHECK], [{ check: BUILD_CHECK, attribution: 'pre-existing' }]),
    };
    const plan = planWorkOrders(input);
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0];
    expect(order.class).toBe('floor-failure');
    expect(order.id).toBe('floor-failure:typescript:typecheck');
    expect(order.tier).toBe('agent');
    expect(order.findings[0].evidence).toMatchObject({
      type: 'floor',
      command: 'npx tsc --noEmit',
      outputTail: 'src/c.ts(3,1): error TS2304',
    });
    expect(order.envelope.manifests).toBe(false);
    expect(order.evidence).toEqual(['src/c.ts(3,1): error TS2304']);
  });

  it('a passing check yields no order', () => {
    const pass: CorrectnessCheckResult = { ...BUILD_CHECK, status: 'pass' };
    const input: PlannerInput = { ...empty(), entryFloor: floor([pass], []) };
    expect(planWorkOrders(input).orders).toEqual([]);
  });
});

describe('planWorkOrders: advisories', () => {
  it('groups blocking advisories per package (all its advisories), envelope = manifests only', () => {
    const input: PlannerInput = {
      ...empty(),
      blocking: [
        blockingPair(depVuln('a1', 'axios', 'GHSA-1', 'high')),
        blockingPair(depVuln('a2', 'axios', 'GHSA-2', 'medium')),
        blockingPair(depVuln('b1', 'lodash', 'GHSA-3', 'low')),
      ],
      advisoryDetails: {
        a1: { fixedVersion: '1.7.0', reachable: true },
        a2: { fixedVersion: '1.7.0' },
      },
    };
    const plan = planWorkOrders(input);
    expect(plan.orders.map((o) => o.id)).toEqual(['dep-advisory:axios', 'dep-advisory:lodash']);
    const axios = plan.orders[0];
    expect(axios.findings).toHaveLength(2);
    expect(axios.envelope).toEqual({
      paths: ['package.json', 'package-lock.json'],
      manifests: true,
    });
    expect(axios.findings[0].evidence).toMatchObject({
      type: 'dep-vuln',
      package: 'axios',
      advisoryId: 'GHSA-1',
      fixedVersion: '1.7.0',
      reachable: true,
      severity: 'high',
    });
    expect(axios.done.verifier).toBe('guardrail');
    expect(axios.provenance).toEqual({ source: 'guardrail-blocking' });
    // every advisory has a fixed version: override-pin matches
    expect(axios.tier).toBe('recipe');
    expect(axios.recipe).toBe('override-pin');
    // no fixed version known: agent
    expect(plan.orders[1].tier).toBe('agent');
    expect(plan.orders[1].evidence[0]).toContain('no fixed version known here');
  });

  it('deferred advisories join their baseline entry, carry expiresAt, and are attributed deferred', () => {
    const input: PlannerInput = {
      ...empty(),
      deferred: [
        { allow: deferred('d1', '2026-09-10'), entry: depVuln('d1', 'js-yaml', 'GHSA-9', 'high') },
        { allow: deferred('d2', '2026-09-01'), entry: depVuln('d2', 'js-yaml', 'GHSA-8', 'high') },
      ],
    };
    const plan = planWorkOrders(input);
    expect(plan.orders).toHaveLength(1);
    const order = plan.orders[0];
    expect(order.id).toBe('dep-advisory:js-yaml');
    expect(order.findings.every((f) => f.attribution === 'deferred')).toBe(true);
    expect(order.provenance).toEqual({ source: 'deferred-advisory', earliestExpiry: '2026-09-01' });
    expect(
      order.findings.map((f) => (f.evidence as { expiresAt?: string }).expiresAt).sort(),
    ).toEqual(['2026-09-01', '2026-09-10']);
  });

  it('a deferred entry with no baseline join is undispatchable with the reason, never dropped', () => {
    const input: PlannerInput = {
      ...empty(),
      deferred: [{ allow: deferred('gone', '2026-09-01'), entry: null }],
    };
    const plan = planWorkOrders(input);
    expect(plan.orders).toEqual([]);
    expect(plan.undispatchable).toHaveLength(1);
    expect(plan.undispatchable[0].reason).toContain('not in the baseline');
    expect(plan.undispatchable[0].findings[0].id).toBe('gone');
  });
});

describe('planWorkOrders: debt slices', () => {
  it('groups lint debt by file, then by rule, capped by maxSliceSize with slice provenance', () => {
    const debt: RichBaselineEntry[] = [];
    for (let i = 0; i < 7; i++)
      debt.push(lint(`f${i}`, 'src/big.ts', i % 2 === 0 ? 'no-unused-vars' : 'eqeqeq', i + 1));
    debt.push(lint('g1', 'src/small.ts', 'eqeqeq', 4));
    const plan = planWorkOrders({ ...empty(), debt, policy: { ...POLICY, maxSliceSize: 3 } });
    const ids = plan.orders.map((o) => o.id);
    expect(ids).toEqual([
      'lint-located:src/big.ts#1',
      'lint-located:src/big.ts#2',
      'lint-located:src/big.ts#3',
      'lint-located:src/small.ts',
    ]);
    const first = plan.orders[0];
    expect(first.findings).toHaveLength(3);
    // rule-sorted within the file: the eqeqeq findings come first
    expect(first.findings.every((f) => (f.evidence as { rule?: string }).rule === 'eqeqeq')).toBe(
      true,
    );
    expect(first.envelope).toEqual({ paths: ['src/big.ts'], manifests: false });
    expect(first.provenance).toEqual({
      source: 'debt-slice',
      file: 'src/big.ts',
      slice: 1,
      of: 3,
    });
    expect(first.tier).toBe('recipe');
    expect(first.recipe).toBe('lint-autofix');
    expect(plan.orders[3].provenance).toEqual({
      source: 'debt-slice',
      file: 'src/small.ts',
      slice: 1,
      of: 1,
    });
  });

  it('binary custom-check debt and other kinds land in undispatchable with reasons', () => {
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
  });
});

describe('planWorkOrders: value ordering + budget', () => {
  it('orders net-new floor > expiring defers (soonest first) > reachable high/critical > debt', () => {
    const input: PlannerInput = {
      ...empty(),
      entryFloor: floor([BUILD_CHECK], [{ check: BUILD_CHECK, attribution: 'net-new' }]),
      blocking: [blockingPair(depVuln('r1', 'reach', 'GHSA-R', 'critical'))],
      advisoryDetails: { r1: { reachable: true } },
      deferred: [
        { allow: deferred('d1', '2026-09-10'), entry: depVuln('d1', 'late', 'GHSA-L', 'low') },
        { allow: deferred('d2', '2026-09-01'), entry: depVuln('d2', 'soon', 'GHSA-S', 'low') },
      ],
      debt: [lint('l1', 'src/a.ts', 'eqeqeq', 1)],
    };
    const ids = planWorkOrders(input).orders.map((o) => o.id);
    expect(ids).toEqual([
      'floor-failure:typescript:typecheck',
      'dep-advisory:soon',
      'dep-advisory:late',
      'dep-advisory:reach',
      'lint-located:src/a.ts',
    ]);
  });

  it('derives the budget from the finding count, clamped to policy, with the formula recorded', () => {
    const one = deriveBudget(1, DEFAULT_REMEDIATE_BUDGET);
    const d = BUDGET_DERIVATION;
    expect(one.turns).toBe(Math.max(d.minTurns, d.baseTurns + d.perFindingTurns));
    expect(one.derivation).toContain(`clamp(${d.baseTurns} + ${d.perFindingTurns} * 1`);
    const many = deriveBudget(1000, DEFAULT_REMEDIATE_BUDGET);
    expect(many.turns).toBe(DEFAULT_REMEDIATE_BUDGET.maxTurns);
    expect(many.minutes).toBe(DEFAULT_REMEDIATE_BUDGET.maxMinutes);
    expect(many.usd).toBe(DEFAULT_REMEDIATE_BUDGET.maxUsd);
    const zero = deriveBudget(0, DEFAULT_REMEDIATE_BUDGET);
    expect(zero.turns).toBe(d.minTurns);
    expect(zero.usd).toBeGreaterThan(0);
  });

  it('selectOrders filters by class (a task is a selector over orders)', () => {
    const plan = planWorkOrders({
      ...empty(),
      entryFloor: floor([BUILD_CHECK], [{ check: BUILD_CHECK, attribution: 'net-new' }]),
      debt: [lint('l1', 'src/a.ts', 'eqeqeq', 1)],
    });
    expect(selectOrders(plan, ['lint-located']).map((o) => o.class)).toEqual(['lint-located']);
    expect(selectOrders(plan, []).length).toBe(0);
  });

  it('is deterministic for the same input', () => {
    const input: PlannerInput = {
      ...empty(),
      debt: [lint('l2', 'src/b.ts', 'eqeqeq', 1), lint('l1', 'src/a.ts', 'eqeqeq', 1)],
    };
    expect(planWorkOrders(input)).toEqual(planWorkOrders(input));
  });
});

describe('recipe registry drives the tier (synthetic injection)', () => {
  const draft: Omit<WorkOrder, 'tier' | 'recipe'> = {
    id: 'synthetic-class:unit',
    class: 'synthetic-class',
    findings: [],
    envelope: { paths: ['x'], manifests: false },
    constraints: { forbidden: [] },
    done: {
      absentIds: [],
      verifier: 'guardrail',
      command: 'x',
      noNetNewInsideEnvelope: true,
      identityScheme: 'v3',
    },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    evidence: [],
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
      summary: 'test',
      implemented: false,
      matches: (o: WorkOrder) => o.class === 'synthetic-class',
    };
    const tiered = assignTier(draft, [...RECIPE_REGISTRY, fake]);
    expect(tiered.tier).toBe('recipe');
    expect(tiered.recipe).toBe('synthetic-fixer');
  });

  it('the planner reads the registry it is handed (a fake recipe flips a real order)', () => {
    const input: PlannerInput = {
      ...empty(),
      entryFloor: floor([BUILD_CHECK], [{ check: BUILD_CHECK, attribution: 'net-new' }]),
    };
    expect(planWorkOrders(input).orders[0].tier).toBe('agent');
    const fake = {
      id: 'floor-fixer',
      class: 'floor-failure',
      summary: 'test',
      implemented: false,
      matches: (o: WorkOrder) => o.class === 'floor-failure',
    };
    const flipped = planWorkOrders(input, { registry: [...RECIPE_REGISTRY, fake] }).orders[0];
    expect(flipped.tier).toBe('recipe');
    expect(flipped.recipe).toBe('floor-fixer');
  });

  it('every declared recipe names a built-in class, is not yet executable, and ids are unique', () => {
    const ids = RECIPE_REGISTRY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      ['declare-dependency', 'lint-autofix', 'lockfile-sync', 'override-pin'].sort(),
    );
    for (const r of RECIPE_REGISTRY) {
      expect(Object.keys(WORK_ORDER_CLASSES)).toContain(r.class);
      expect(r.implemented).toBe(false);
    }
  });
});
