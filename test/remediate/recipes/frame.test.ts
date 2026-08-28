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
    enforceEnvelope: () => ({ dropped: [] }),
    resetTo: () => {},
    changedPaths: () => [],
    commitPaths: () => {},
    cleanPaths: () => {},
    revertPaths: () => {},
    revertRange: () => {},
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
    maxOrdersPerRun: 0,
    pauseAfterFailures: 0,
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
      install: () => ({ status: 'no-provision-declared', packs: [] }) as const,
      changedFiles: () => ['package.json'],
    },
    armInLoopGate: () => ({ mode: 'backstop-only' as const, reason: 'test' }),
    runRecipePhase: async () => summary,
  };
}

/** A git whose head advances once (the recipe commit) and whose diff answer
 *  is per-base: the run's baseHead question and the agent's own-base
 *  question must be distinguishable. */
function recipeCommitGit(diffs: Record<string, boolean>): RemediateGit {
  let calls = 0;
  return {
    head: () => (calls++ === 0 ? 'base0000' : 'recipe111'),
    sweepLeftovers: () => undefined,
    scrubRuntimeArtifacts: () => [],
    enforceEnvelope: () => ({ dropped: [] }),
    resetTo: () => {},
    changedPaths: () => [],
    commitPaths: () => {},
    cleanPaths: () => {},
    revertPaths: () => {},
    revertRange: () => {},
    hasDiff: (base: string) => diffs[base] ?? false,
  };
}

describe('the agent diff is measured from the post-recipe head', () => {
  it('an HONEST never-ran claim is not contradicted by the recipes own commits', async () => {
    const driver = throwingDriver();
    driver.run = async () => ({
      completed: false,
      timedOut: false,
      transcriptTail: '',
      neverRan: { reason: 'credential missing' },
    });
    const summary = phase({ selectedAgentTier: 1 }); // mixed plan: agent path runs
    const r = await runRemediateTask({
      ...base(true, summary),
      drivers: [driver],
      // Recipe committed (base0000 -> recipe111); the agent added NOTHING on
      // top of recipe111.
      git: recipeCommitGit({ base0000: true, recipe111: false }),
    });
    expect(r.outcome).toBe('agent-never-ran');
    // The claim stood UNCONTRADICTED: no demotion note about tree evidence.
    expect(r.envelope?.failure ?? '').not.toContain('contradicted');
    expect(r.note).toContain('credential missing');
  });

  it('an agent that cleanly adds nothing on top of applied recipe commits still verifies the combined head', async () => {
    const driver = throwingDriver();
    driver.run = async () => ({ completed: true, timedOut: false, transcriptTail: '' });
    const summary = phase({ selectedAgentTier: 1 });
    const r = await runRemediateTask({
      ...base(true, summary),
      drivers: [driver],
      git: recipeCommitGit({ base0000: true, recipe111: false }),
    });
    // Not a no-op: the recipe commits are real work and go through the one
    // tree verification, anchored at the PRE-recipe base.
    expect(r.outcome).toBe('verified');
    expect(r.baseHead).toBe('base0000');
  });
});

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

  it('every recipe refused at $0 is recipes-refused (NOT a clean no-op the lane green-loops on)', async () => {
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
    // A recipe-only run has no agent tier to fall back to, so all-refused
    // must surface as a NON-CLEAN outcome; 'no-op' here would starve the
    // orders forever while the schedule reads green.
    expect(r.outcome).toBe('recipes-refused');
    expect(r.note).toContain('No agent was spawned');
    expect(r.note).toContain('orders remain open');
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

describe('circuit-breaker pauses inside the frame', () => {
  it('an all-paused selection completes as a $0 no-op naming the pause, and the ledger renders it (no agent spawn)', async () => {
    const summary = phase({
      ran: false,
      records: [],
      selectedRecipeTier: 0,
      selectedAgentTier: 0,
      paused: [
        {
          orderId: 'dep-advisory:js-yaml',
          class: 'dep-advisory',
          tier: 'recipe',
          findings: 2,
          reason: 'the last 2 counted outcome(s) for this class were failures',
          unpause: 'change the remediate policy, upgrade dxkit, or dispatch fix-vulns',
        },
      ],
    });
    const result = await runRemediateTask(base(false, summary));
    expect(result.outcome).toBe('no-op');
    expect(result.note).toContain('PAUSED by the circuit breaker');
    expect(result.note).toContain('dep-advisory');
    expect(result.note).toContain('Unpause:');
    expect(result.ledger).toContain('Paused by the circuit breaker');
    expect(result.ledger).toContain('dep-advisory:js-yaml');
  });

  it('a selection with one open and one paused order proceeds, with the pause disclosed in the ledger', async () => {
    const summary = phase({
      selectedRecipeTier: 1,
      selectedAgentTier: 0,
      paused: [
        {
          orderId: 'lint-located:src/a.ts',
          class: 'lint-located',
          tier: 'recipe',
          findings: 3,
          reason: 'streak',
          unpause: 'policy change',
        },
      ],
      agentOrders: [],
    });
    const result = await runRemediateTask(base(true, summary));
    expect(result.outcome).toBe('verified');
    expect(result.ledger).toContain('Paused by the circuit breaker');
    expect(result.ledger).toContain('lint-located:src/a.ts');
  });
});
