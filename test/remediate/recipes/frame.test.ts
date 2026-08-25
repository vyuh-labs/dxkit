/**
 * Frame integration: a recipe-only plan completes WITHOUT any agent spawn
 * (the driver here throws if invoked), the combined result still goes
 * through the one tree verification, a mixed plan still runs the agent
 * with the recipe summary disclosed, and the ledger renders the per-order
 * outcomes with their reasons.
 */
import { describe, it, expect } from 'vitest';
import { runRemediateTask, type RemediateGit } from '../../../src/remediate/run';
import type { AgentDriver } from '../../../src/remediate/driver';
import type { RemediateConfig } from '../../../src/remediate/config';
import { DEFAULT_REMEDIATE_BUDGET } from '../../../src/remediate/config';
import type { CorrectnessFloorResult } from '../../../src/analyzers/correctness/run';
import { trustedLocalContext } from '../../../src/analysis-trust';
import type { RecipePhaseSummary } from '../../../src/remediate/recipes/run-recipes';

const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };

function fakeGit(diff: boolean): RemediateGit {
  return {
    head: () => (diff ? 'head1111' : 'base0000'),
    sweepLeftovers: () => undefined,
    scrubRuntimeArtifacts: () => [],
    hasDiff: () => diff,
  };
}

/** A driver that must never run on a recipe-only plan. */
function throwingDriver(): AgentDriver {
  return {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async () => {
      throw new Error('the driver must not be invoked on a recipe-only plan');
    },
  };
}

function config(): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-vulns'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'discard',
    agent: { driver: 'fake-agent', model: 'auto', budget: DEFAULT_REMEDIATE_BUDGET },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    resume: false,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
  };
}

function phase(overrides: Partial<RecipePhaseSummary>): RecipePhaseSummary {
  return {
    ran: true,
    disclosures: [],
    selectedRecipeTier: 1,
    selectedAgentTier: 0,
    records: [
      {
        orderId: 'dep-advisory:js-yaml',
        class: 'dep-advisory',
        recipe: 'override-pin',
        outcome: { kind: 'applied', changedFiles: ['package.json', 'package-lock.json'] },
      },
    ],
    ...overrides,
  };
}

function base(diff: boolean, summary: RecipePhaseSummary) {
  return {
    cwd: '/tmp/fake',
    trust: trustedLocalContext(),
    taskId: 'fix-vulns',
    config: config(),
    drivers: [throwingDriver()],
    git: fakeGit(diff),
    runFloor: () => GREEN_FLOOR,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    verifySeams: {
      worktree: async <T>(_o: unknown, fn: (p: string) => Promise<T>) => fn('/tmp/fake-wt'),
      install: () => ({ status: 'nothing-to-install' }) as const,
      changedFiles: () => ['package.json'],
    },
    armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
    runRecipePhase: async () => summary,
  };
}

describe('recipe-only remediate runs', () => {
  it('completes VERIFIED with no agent spawn when every selected order was recipe-tier and applied', async () => {
    const r = await runRemediateTask(base(true, phase({})));
    expect(r.outcome).toBe('verified');
    expect(r.envelope).toBeUndefined(); // no agent envelope: nothing spawned
    expect(r.note).toContain('$0');
    expect(r.recipes?.records[0].outcome.kind).toBe('applied');
    expect(r.ledger).toContain('Deterministic recipes');
    expect(r.ledger).toContain('override-pin');
  });

  it('completes NO-OP at $0 when every recipe refused (reasons in the ledger)', async () => {
    const summary = phase({
      records: [
        {
          orderId: 'dep-advisory:js-yaml',
          class: 'dep-advisory',
          recipe: 'override-pin',
          outcome: { kind: 'refused', reason: 'pinning would introduce GHSA-x' },
        },
      ],
    });
    const r = await runRemediateTask(base(false, summary));
    expect(r.outcome).toBe('no-op');
    expect(r.note).toContain('No agent was spawned');
    expect(r.ledger).toContain('pinning would introduce GHSA-x');
  });

  it('a recipe-only diff that fails the guardrail is guardrail-red, never landed silently', async () => {
    const opts = {
      ...base(true, phase({})),
      runGuardrail: async () => ({ verdict: 'BLOCKED', ran: true, passesGate: false }),
    };
    const r = await runRemediateTask(opts);
    expect(r.outcome).toBe('guardrail-red');
  });

  it('a mixed plan (agent-tier orders remain) still runs the agent, with the recipe summary disclosed', async () => {
    const summary = phase({ selectedAgentTier: 2 });
    const driver = throwingDriver();
    let ran = false;
    driver.run = async () => {
      ran = true;
      return { completed: true, timedOut: false, transcriptTail: '' };
    };
    const r = await runRemediateTask({ ...base(true, summary), drivers: [driver] });
    expect(ran).toBe(true);
    expect(r.recipes?.selectedAgentTier).toBe(2);
    expect(r.ledger).toContain('Deterministic recipes');
  });

  it('a plan that selects nothing keeps the pre-recipe behavior byte-for-byte (agent path)', async () => {
    const summary = phase({ ran: false, selectedRecipeTier: 0, records: [] });
    const driver = throwingDriver();
    let ran = false;
    driver.run = async () => {
      ran = true;
      return { completed: true, timedOut: false, transcriptTail: '' };
    };
    const r = await runRemediateTask({ ...base(true, summary), drivers: [driver] });
    expect(ran).toBe(true);
    expect(r.outcome).toBe('verified');
    // A phase that never ran renders no recipe section.
    expect(r.ledger).not.toContain('Deterministic recipes');
  });

  it('a recipe-phase failure is fail-open: disclosed planError, agent path proceeds', async () => {
    const driver = throwingDriver();
    let ran = false;
    driver.run = async () => {
      ran = true;
      return { completed: true, timedOut: false, transcriptTail: '' };
    };
    const opts = {
      ...base(true, phase({})),
      drivers: [driver],
      runRecipePhase: async () => {
        throw new Error('planner exploded');
      },
    };
    const r = await runRemediateTask(opts);
    expect(ran).toBe(true);
    expect(r.recipes?.planError).toContain('planner exploded');
    expect(r.ledger).toContain('planner exploded');
  });
});
