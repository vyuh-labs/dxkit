/**
 * Dispatch campaigns (E2/E3): env-transported overrides with clamped spend,
 * and the custom task's trust mechanics — refused without a prompt, ground
 * rules appended, dispatcher + verbatim prompt + no-hinge disclosure in the
 * ledger.
 */
import { describe, it, expect } from 'vitest';
import { DISPATCH_ENV, readDispatchOverrides } from '../../src/remediate/dispatch';
import { customDispatchTask, SHARED_RULES } from '../../src/remediate/tasks';
import { runRemediateTask, type RemediateGit } from '../../src/remediate/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { RemediateConfig } from '../../src/remediate/config';
import { DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { AnalysisTrustContext } from '../../src/analysis-trust';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';

const BUDGET = DEFAULT_REMEDIATE_BUDGET; // 80 turns / 30 min / $5

describe('readDispatchOverrides', () => {
  it('no env → policy budget, nothing clamped, any=false', () => {
    const d = readDispatchOverrides({}, BUDGET, { maxDispatchBudget: 0 });
    expect(d.any).toBe(false);
    expect(d.budget).toEqual(BUDGET);
    expect(d.clamped).toEqual([]);
  });

  it('without a declared ceiling, dispatch can LOWER spend but never raise it', () => {
    const lower = readDispatchOverrides({ [DISPATCH_ENV.maxUsd]: '2' }, BUDGET, {
      maxDispatchBudget: 0,
    });
    expect(lower.budget.maxUsd).toBe(2);
    expect(lower.clamped).toEqual([]);

    const raise = readDispatchOverrides({ [DISPATCH_ENV.maxUsd]: '50' }, BUDGET, {
      maxDispatchBudget: 0,
    });
    expect(raise.budget.maxUsd).toBe(BUDGET.maxUsd);
    expect(raise.clamped[0]).toContain('clamped');
    expect(raise.clamped[0]).toContain('maxDispatchBudget');
  });

  it('a declared ceiling authorizes raising spend up to it, clamping beyond', () => {
    const within = readDispatchOverrides({ [DISPATCH_ENV.maxUsd]: '15' }, BUDGET, {
      maxDispatchBudget: 20,
    });
    expect(within.budget.maxUsd).toBe(15);
    expect(within.clamped).toEqual([]);

    const beyond = readDispatchOverrides({ [DISPATCH_ENV.maxUsd]: '25' }, BUDGET, {
      maxDispatchBudget: 20,
    });
    expect(beyond.budget.maxUsd).toBe(20);
    expect(beyond.clamped[0]).toContain('$20');
  });

  it('turns/minutes/model/prompt/actor flow through; junk numbers are ignored', () => {
    const d = readDispatchOverrides(
      {
        [DISPATCH_ENV.maxTurns]: '120',
        [DISPATCH_ENV.maxMinutes]: 'lots',
        [DISPATCH_ENV.model]: 'sonnet-tier',
        [DISPATCH_ENV.customPrompt]: 'Increase docstring coverage in src/api.',
        GITHUB_ACTOR: 'octocat',
      },
      BUDGET,
      { maxDispatchBudget: 0 },
    );
    expect(d.budget.maxTurns).toBe(120);
    expect(d.budget.maxMinutes).toBe(BUDGET.maxMinutes); // junk ignored
    expect(d.model).toBe('sonnet-tier');
    expect(d.customPrompt).toContain('docstring');
    expect(d.actor).toBe('octocat');
    expect(d.any).toBe(true);
  });
});

describe('customDispatchTask', () => {
  it('appends the non-negotiable ground rules to the human prompt', () => {
    const t = customDispatchTask('Do the thing.');
    expect(t.id).toBe('custom');
    expect(t.prompt.startsWith('Do the thing.')).toBe(true);
    expect(t.prompt).toContain(SHARED_RULES.trim().slice(0, 40));
    expect(t.scoreHinge).toBeUndefined();
  });
});

// ─── The custom task through the runner (trust mechanics) ────────────────────

const TRUSTED = { repoExecutionAllowed: true, source: 'local-workspace' } as AnalysisTrustContext;
const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };

function fakeGit(): RemediateGit {
  let head = 'base0000';
  return {
    head: () => head,
    sweepLeftovers: () => undefined,
    hasDiff: () => {
      head = 'head1111';
      return true;
    },
  };
}

function fakeDriver(): AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } {
  const driver: AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } = {
    id: 'fake-agent',
    budgetSupport: { turns: true, cost: true },
    credentialEnv: [],
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async (opts) => {
      driver.lastRun = opts;
      return { completed: true, timedOut: false, transcriptTail: '' } as AgentRunResult;
    },
  };
  return driver;
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
  };
}

describe('runRemediateTask — the custom dispatch task', () => {
  it('REFUSES custom without a prompt (never an empty-prompt agent run)', async () => {
    const driver = fakeDriver();
    const r = await runRemediateTask({
      cwd: '/tmp/fake',
      trust: TRUSTED,
      taskId: 'custom',
      config: config(),
      drivers: [driver],
      git: fakeGit(),
      runFloor: () => GREEN_FLOOR,
      runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    });
    expect(r.outcome).toBe('refused');
    expect(r.note).toContain('prompt');
    expect(driver.lastRun).toBeUndefined();
  });

  it('runs with the prompt + ground rules, and the ledger discloses actor, verbatim prompt, no-hinge', async () => {
    const driver = fakeDriver();
    const r = await runRemediateTask({
      cwd: '/tmp/fake',
      trust: TRUSTED,
      taskId: 'custom',
      config: config(),
      drivers: [driver],
      git: fakeGit(),
      runFloor: () => GREEN_FLOOR,
      runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
      dispatch: {
        budget: DEFAULT_REMEDIATE_BUDGET,
        customPrompt: 'Raise docstring coverage in src/api only.',
        actor: 'octocat',
        clamped: ['maxUsd override $50 clamped to $5 (no remediate.maxDispatchBudget declared)'],
        any: true,
      },
    });
    expect(r.outcome).toBe('verified');
    // The agent got the prompt WITH the non-negotiables appended.
    expect(driver.lastRun?.prompt).toContain('Raise docstring coverage');
    expect(driver.lastRun?.prompt).toContain('NEVER run');
    // The ledger (= the PR body) carries the full disclosure.
    expect(r.ledger).toContain('Dispatch campaign');
    expect(r.ledger).toContain('octocat');
    expect(r.ledger).toContain('Raise docstring coverage in src/api only.');
    expect(r.ledger).toContain('no score hinge');
    expect(r.ledger).toContain('clamped');
  });
});
