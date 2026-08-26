/**
 * The order-derived scheduled matrix (remediate rethink 3F): tasks come
 * from the OPEN orders in value order, a task with no open orders spawns
 * no job, a paused-only task spawns no job (with a pause-shaped
 * disclosure), the spend ceiling trims lowest-value first through the one
 * ceiling helper, open-ended tasks stay scheduled only by explicit policy
 * (disclosed as the legacy shape), and a missing plan falls back to the
 * static list rather than silently turning the schedule off. Plus the
 * injection guard: an order whose class is outside the built-in registry
 * is disclosed, never silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { deriveScheduledMatrix } from '../../../src/remediate/work-orders/schedule';
import type { RemediateConfig } from '../../../src/remediate/config';
import type { WorkOrder, WorkOrderPlan } from '../../../src/remediate/work-orders/types';

function order(id: string, cls: string, overrides: Partial<WorkOrder> = {}): WorkOrder {
  return {
    id,
    class: cls,
    findings: [],
    envelope: { paths: ['x'], manifests: false },
    constraints: { forbidden: [] },
    done: { absentIds: [], verifier: 'floor', command: 'x' },
    budget: { turns: 1, minutes: 1, usd: 1, derivation: 'x' },
    tier: 'agent',
    provenance: { source: 'guardrail-blocking' },
    ...overrides,
  };
}

function config(overrides: Partial<RemediateConfig> = {}): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-build', 'fix-vulns', 'fix-lint'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'auto',
    agent: {
      driver: 'claude-code',
      model: 'auto',
      budget: { maxTurns: 80, maxMinutes: 30, maxUsd: 5 },
    },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    resume: false,
    maxOrdersPerRun: 3,
    pauseAfterFailures: 2,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
    ...overrides,
  };
}

function plan(orders: WorkOrder[]): WorkOrderPlan {
  return { orders, undispatchable: [] };
}

describe('deriveScheduledMatrix', () => {
  it('derives tasks from open orders in value order; a class-selecting task with no orders spawns no job', () => {
    const m = deriveScheduledMatrix({
      config: config(),
      // Value order: an advisory order first, then a floor order.
      plan: plan([order('a', 'dep-advisory'), order('b', 'stale-lockfile')]),
    });
    expect(m.source).toBe('orders');
    expect(m.run).toEqual(['fix-vulns', 'fix-build']);
    expect(m.noOpenOrders).toEqual(['fix-lint']);
    expect(
      m.disclosures.some((d) => d.includes("'fix-lint'") && d.includes('no open work orders')),
    ).toBe(true);
  });

  it('a paused-only task spawns no job, with a pause-shaped disclosure', () => {
    const m = deriveScheduledMatrix({
      config: config({ tasks: ['fix-vulns'] }),
      plan: plan([
        order('a', 'dep-advisory', { paused: { reason: 'streak', unpause: 'policy change' } }),
      ]),
    });
    expect(m.run).toEqual([]);
    expect(m.noOpenOrders).toEqual(['fix-vulns']);
    expect(m.disclosures.some((d) => d.includes('PAUSED by the circuit breaker'))).toBe(true);
  });

  it('a task with both paused and open orders still spawns (the open ones are worth the job)', () => {
    const m = deriveScheduledMatrix({
      config: config({ tasks: ['fix-vulns'] }),
      plan: plan([
        order('a', 'dep-advisory', { paused: { reason: 'streak', unpause: 'x' } }),
        order('b', 'dep-advisory'),
      ]),
    });
    expect(m.run).toEqual(['fix-vulns']);
  });

  it('the spend ceiling trims from the END of the value order, disclosed as deferred', () => {
    const m = deriveScheduledMatrix({
      config: config({ maxSpendPerRun: 5 }),
      plan: plan([order('a', 'dep-advisory'), order('b', 'lint-located')]),
    });
    expect(m.run).toEqual(['fix-vulns']);
    expect(m.deferred).toEqual(['fix-lint']);
  });

  it('open-ended tasks stay scheduled only via explicit policy, appended after order tasks, disclosed as legacy', () => {
    const m = deriveScheduledMatrix({
      config: config({ tasks: ['improve-tests', 'fix-vulns', 'write-docs'] }),
      plan: plan([order('a', 'dep-advisory')]),
    });
    expect(m.run).toEqual(['fix-vulns', 'improve-tests', 'write-docs']);
    expect(m.legacyOpenEnded).toEqual(['improve-tests', 'write-docs']);
    expect(m.disclosures.filter((d) => d.includes('legacy shape'))).toHaveLength(2);
  });

  it('legacy-policy compatibility: the default policy shape keeps working with zero orders (no jobs, all disclosed)', () => {
    const m = deriveScheduledMatrix({ config: config({ tasks: ['fix-vulns'] }), plan: plan([]) });
    expect(m.run).toEqual([]);
    expect(m.noOpenOrders).toEqual(['fix-vulns']);
  });

  it('DEGRADED evidence falls back to the static policy list, disclosed; healthy zero orders stays a legitimate no-job firing', () => {
    // A fail-open gather (unreadable baseline, no floor evidence) yields
    // zero orders that prove nothing: spawning nothing weekly on that
    // basis would be a silent off-switch.
    const degraded = deriveScheduledMatrix({
      config: config({ tasks: ['fix-vulns'] }),
      plan: plan([]),
      evidenceDegraded: 'the baseline exists but could not be read',
    });
    expect(degraded.source).toBe('static-fallback');
    expect(degraded.run).toEqual(['fix-vulns']);
    expect(degraded.disclosures.some((d) => d.includes('could not be read'))).toBe(true);
    // Healthy evidence with zero orders remains the $0 win.
    const healthy = deriveScheduledMatrix({
      config: config({ tasks: ['fix-vulns'] }),
      plan: plan([]),
      evidenceDegraded: null,
    });
    expect(healthy.source).toBe('orders');
    expect(healthy.run).toEqual([]);
  });

  it('no plan (planning failed) falls back to the static policy list, disclosed, never a silent off-switch', () => {
    const m = deriveScheduledMatrix({
      config: config({ maxSpendPerRun: 10 }),
      plan: null,
      planError: 'boom',
    });
    expect(m.source).toBe('static-fallback');
    expect(m.run).toEqual(['fix-build', 'fix-vulns']);
    expect(m.deferred).toEqual(['fix-lint']);
    expect(m.disclosures.some((d) => d.includes('boom'))).toBe(true);
  });

  it('an order class outside the built-in registry is DISCLOSED, never silently dropped (injection guard)', () => {
    const m = deriveScheduledMatrix({
      config: config(),
      plan: plan([order('a', 'synthetic-class'), order('b', 'dep-advisory')]),
    });
    expect(m.run).toEqual(['fix-vulns']);
    expect(m.disclosures.some((d) => d.includes("'synthetic-class'"))).toBe(true);
  });

  it('an order for a task policy did not enable never widens the matrix', () => {
    const m = deriveScheduledMatrix({
      config: config({ tasks: ['fix-vulns'] }),
      plan: plan([order('a', 'lint-located'), order('b', 'dep-advisory')]),
    });
    expect(m.run).toEqual(['fix-vulns']);
  });
});
