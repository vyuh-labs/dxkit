/**
 * Dispatch campaigns (E2/E3): env-transported overrides with clamped spend,
 * and the custom task's trust mechanics — refused without a prompt, ground
 * rules appended, dispatcher + verbatim prompt + no-hinge disclosure in the
 * ledger.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  DISPATCH_ENV,
  readDispatchOverrides,
  staleDispatchWorkflowNote,
} from '../../src/remediate/dispatch';
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
    // 120 turns exceeds policy (80) with no declared spend authority — the
    // turn clamp holds (turns govern real spend; see the clamp tests below).
    expect(d.budget.maxTurns).toBe(BUDGET.maxTurns);
    expect(d.budget.maxMinutes).toBe(BUDGET.maxMinutes); // junk ignored
    expect(d.model).toBe('sonnet-tier');
    expect(d.customPrompt).toContain('docstring');
    expect(d.actor).toBe('octocat');
    expect(d.any).toBe(true);
  });
});

describe('the turn clamp (the $14.71 back door)', () => {
  it('without a declared ceiling, dispatch can LOWER turns but never raise them', () => {
    const lower = readDispatchOverrides({ [DISPATCH_ENV.maxTurns]: '20' }, BUDGET, {
      maxDispatchBudget: 0,
    });
    expect(lower.budget.maxTurns).toBe(20);
    expect(lower.clamped).toEqual([]);

    // The incident dispatch: max_turns=200 against 80-turn/$5 policy. The
    // old passthrough made turns an unclamped back door around the spend
    // ceiling ($14.71 actually spent against the "clamped" $5 cap).
    const raise = readDispatchOverrides({ [DISPATCH_ENV.maxTurns]: '200' }, BUDGET, {
      maxDispatchBudget: 0,
    });
    expect(raise.budget.maxTurns).toBe(BUDGET.maxTurns);
    expect(raise.clamped[0]).toContain('max_turns override 200 clamped to 80');
    expect(raise.clamped[0]).toContain('maxDispatchBudget');
  });

  it('declared spend authority raises the turn ceiling proportionally', () => {
    // $15 authority over a $5 policy cap = 3x → up to 240 turns.
    const within = readDispatchOverrides({ [DISPATCH_ENV.maxTurns]: '200' }, BUDGET, {
      maxDispatchBudget: 15,
    });
    expect(within.budget.maxTurns).toBe(200);
    expect(within.clamped).toEqual([]);

    const beyond = readDispatchOverrides({ [DISPATCH_ENV.maxTurns]: '500' }, BUDGET, {
      maxDispatchBudget: 15,
    });
    expect(beyond.budget.maxTurns).toBe(240);
    expect(beyond.clamped[0]).toContain('clamped to 240');
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
    scrubRuntimeArtifacts: () => [],
    enforceEnvelope: () => ({ dropped: [] }),
    resetTo: () => {},
    changedPaths: () => [],
    commitPaths: () => {},
    hasDiff: () => {
      head = 'head1111';
      return true;
    },
  };
}

function fakeDriver(): AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } {
  const driver: AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
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
    maxOrdersPerRun: 0,
    pauseAfterFailures: 0,
    resume: false,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
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
      verifySeams: {
        worktree: async <T>(_o: unknown, fn: (wt: string) => Promise<T>) =>
          fn('/tmp/fake-worktree'),
        install: () => ({
          status: 'installed' as const,
          steps: [{ pack: 'typescript', argv: ['npm', 'ci'] }],
        }),
        changedFiles: () => ['src/a.ts'],
      },
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
      verifySeams: {
        worktree: async <T>(_o: unknown, fn: (wt: string) => Promise<T>) =>
          fn('/tmp/fake-worktree'),
        install: () => ({
          status: 'installed' as const,
          steps: [{ pack: 'typescript', argv: ['npm', 'ci'] }],
        }),
        changedFiles: () => ['src/a.ts'],
      },
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

describe('staleDispatchWorkflowNote (the pre-flag workflow detector)', () => {
  const base = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' };

  it('advises vyuh-dxkit update on a workflow_dispatch run whose template never defined the dispatch env', () => {
    const note = staleDispatchWorkflowNote(base, false);
    expect(note).toContain('vyuh-dxkit update');
  });

  it('stays silent when the updated template defined the variable (even blank), when the flag was passed, on scheduled runs, and outside Actions', () => {
    expect(staleDispatchWorkflowNote({ ...base, DXKIT_DISPATCH_TASK: '' }, false)).toBeUndefined();
    expect(staleDispatchWorkflowNote(base, true)).toBeUndefined();
    expect(
      staleDispatchWorkflowNote({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' }, false),
    ).toBeUndefined();
    expect(staleDispatchWorkflowNote({}, false)).toBeUndefined();
  });
});

describe('the workflow template carries the explicit override flag', () => {
  it('derives --dispatch-override from the dispatch input and defines DXKIT_DISPATCH_TASK on the run step', () => {
    const template = readFileSync(
      join(__dirname, '..', '..', 'src-templates', '.github', 'workflows', 'dxkit-remediate.yml'),
      'utf8',
    );
    expect(template).toContain('OVERRIDE="--dispatch-override"');
    expect(template).toContain('--land pr $OVERRIDE');
    expect(template).toContain("DXKIT_DISPATCH_TASK: ${{ github.event.inputs.task || '' }}");
  });
});
