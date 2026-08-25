/**
 * The recipe registry as the tier decider, synthetic-injection guarded, and
 * the class table as the spine (recipes and pending producers pinned).
 */
import { describe, it, expect } from 'vitest';
import {
  assignTier,
  planWorkOrders,
  type FloorFailureInput,
  type PlannerInput,
} from '../../../src/remediate/work-orders/planner';
import { RECIPE_REGISTRY, matchRecipe } from '../../../src/remediate/work-orders/recipes-registry';
import {
  WORK_ORDER_CLASSES,
  type WorkOrderClassDeclaration,
} from '../../../src/remediate/work-orders/types';
import type { WorkOrder } from '../../../src/remediate/work-orders/types';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';

const NPM_CI = { bin: 'npm', args: ['ci'] };

function empty(): PlannerInput {
  return {
    floorFailures: [],
    blocking: [],
    deferred: [],
    debt: [],
    manifests: [{ dir: '', files: ['package-lock.json', 'package.json'] }],
    installFor: () => NPM_CI,
    policy: { maxSliceSize: 25, budgetFor: () => DEFAULT_REMEDIATE_BUDGET },
  };
}

const BUILD_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: 'typecheck',
  command: 'npx tsc --noEmit',
  attribution: 'pre-existing',
};

const IMPORT_FAILURE: FloorFailureInput = {
  pack: 'typescript',
  label: 'import-resolution',
  command: '',
  attribution: 'net-new',
  precision: 'finding',
  netNewFindings: ['left-pad'],
  findings: ['left-pad'],
  unresolved: [{ specifier: 'left-pad', file: 'src/b.ts' }],
};

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

  it('a recipe needing the install step declines an order without one (a python-shaped repo never tiers an npm recipe)', () => {
    const noInstall = planWorkOrders({
      ...empty(),
      floorFailures: [IMPORT_FAILURE],
      installFor: () => undefined,
    });
    for (const o of noInstall.orders.filter((x) => x.class === 'unresolved-import')) {
      expect(o.tier).toBe('agent');
    }
  });

  it('the class table is the spine: every declared recipe is named by exactly its class, and vice versa', () => {
    const ids = RECIPE_REGISTRY.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fromTable = Object.entries(WORK_ORDER_CLASSES)
      .filter(([, d]) => d.recipe !== null)
      .map(([c, d]) => [d.recipe, c]);
    expect(RECIPE_REGISTRY.map((r) => [r.id, r.class]).sort()).toEqual(fromTable.sort());
    // `implemented` and `execute` are one fact stated twice (4.4.5): the
    // plan surface reads the flag, the phase runner calls the function.
    for (const r of RECIPE_REGISTRY) {
      expect(r.implemented).toBe(r.execute !== undefined);
      expect(r.implemented).toBe(true);
    }
    // a class with no producer carries a reason (the DEFERRED_KINDS discipline)
    for (const d of Object.values(WORK_ORDER_CLASSES) as WorkOrderClassDeclaration[]) {
      if (d.producers.includes('pending')) expect(d.pendingReason).toBeTruthy();
      else expect(d.producers.length).toBeGreaterThan(0);
    }
  });
});

describe('order-intrinsic feasibility lives in matches (an executor-certain refusal tiers agent)', () => {
  const draftBase = {
    findings: [],
    envelope: { paths: ['package.json', 'package-lock.json'], manifests: true },
    constraints: { install: NPM_CI, forbidden: [] },
    done: { absentIds: [], verifier: 'floor' as const, command: 'x' },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    provenance: { source: 'guardrail-blocking' as const },
  };
  const floorFinding = (pack: string, specifier?: string) => ({
    kind: 'floor-check',
    id: 'f',
    attribution: 'pre-existing' as const,
    evidence: {
      type: 'floor' as const,
      pack,
      label: 'x',
      command: '',
      ...(specifier !== undefined ? { specifier } : {}),
    },
  });
  const lintFinding = (check: string) => ({
    kind: 'custom-check',
    id: 'l',
    attribution: 'pre-existing' as const,
    evidence: { type: 'custom-check' as const, check, file: 'src/a.ts', rule: 'eqeqeq' },
  });
  const advisoryFinding = (fixedVersion: string) => ({
    kind: 'dep-vuln',
    id: 'a',
    attribution: 'deferred' as const,
    evidence: { type: 'dep-vuln' as const, package: 'p', advisoryId: 'GHSA-1', fixedVersion },
  });
  const tierOf = (partial: Partial<WorkOrder> & Pick<WorkOrder, 'id' | 'class'>) =>
    assignTier({ ...draftBase, ...partial }).tier;

  it('lockfile-sync: a pack without a lockfileCheck, or an ambiguous root, tiers agent', () => {
    const ok = { id: 'stale-lockfile:typescript', class: 'stale-lockfile' as const };
    expect(tierOf({ ...ok, findings: [floorFinding('typescript')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [floorFinding('go')] })).toBe('agent');
    expect(
      tierOf({
        ...ok,
        findings: [floorFinding('typescript')],
        envelope: { paths: ['package.json', 'sub/package.json'], manifests: true },
      }),
    ).toBe('agent');
  });

  it('override-pin: a range-shaped fixed version or a two-root envelope tiers agent', () => {
    const ok = { id: 'dep-advisory:p', class: 'dep-advisory' as const };
    expect(tierOf({ ...ok, findings: [advisoryFinding('4.1.1')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [advisoryFinding('>=4.1.1')] })).toBe('agent');
    expect(
      tierOf({
        ...ok,
        findings: [advisoryFinding('4.1.1')],
        envelope: { paths: ['package.json', 'sub/package.json'], manifests: true },
      }),
    ).toBe('agent');
  });

  it('declare-dependency: an unsupported pack or a flag-shaped specifier tiers agent', () => {
    const ok = { id: 'unresolved-import:typescript:.', class: 'unresolved-import' as const };
    expect(tierOf({ ...ok, findings: [floorFinding('typescript', 'left-pad')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [floorFinding('python', 'requests')] })).toBe('agent');
    expect(tierOf({ ...ok, findings: [floorFinding('typescript', '--registry=https://x')] })).toBe(
      'agent',
    );
    expect(tierOf({ ...ok, findings: [floorFinding('typescript', './src/missing')] })).toBe(
      'agent',
    );
  });

  it('lint-autofix: a user check, a fixCommand-less pack, or a sliced order tiers agent', () => {
    const ok = {
      id: 'lint-located:src/a.ts',
      class: 'lint-located' as const,
      envelope: { paths: ['src/a.ts'], manifests: false },
      provenance: { source: 'debt-slice' as const, file: 'src/a.ts', slice: 1, of: 1 },
    };
    expect(tierOf({ ...ok, findings: [lintFinding('lint:typescript')] })).toBe('recipe');
    expect(tierOf({ ...ok, findings: [lintFinding('arch-rules')] })).toBe('agent');
    expect(tierOf({ ...ok, findings: [lintFinding('lint:go')] })).toBe('agent');
    expect(
      tierOf({
        ...ok,
        findings: [lintFinding('lint:typescript')],
        provenance: { source: 'debt-slice', file: 'src/a.ts', slice: 1, of: 3 },
      }),
    ).toBe('agent');
  });
});
