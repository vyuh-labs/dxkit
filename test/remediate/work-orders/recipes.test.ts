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
    for (const r of RECIPE_REGISTRY) expect(r.implemented).toBe(false);
    // a class with no producer carries a reason (the DEFERRED_KINDS discipline)
    for (const d of Object.values(WORK_ORDER_CLASSES) as WorkOrderClassDeclaration[]) {
      if (d.producers.includes('pending')) expect(d.pendingReason).toBeTruthy();
      else expect(d.producers.length).toBeGreaterThan(0);
    }
  });
});
