import { describe, it, expect } from 'vitest';
import { makeClaudeCodeDriver, type AgentExec } from '../../src/remediate/claude-code-driver';
import { runRemediateTask, type RemediateGit } from '../../src/remediate/run';
import { renderRemediateLedger } from '../../src/remediate/ledger-render';
import { renderFloorVerification } from '../../src/lanes/verification-render';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { RemediateConfig } from '../../src/remediate/config';
import { DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { AnalysisTrustContext } from '../../src/analysis-trust';

/**
 * The agent failure taxonomy — the honesty contract between a run and its
 * ledger. Pins the production class where an agent that could not
 * authenticate reported a green no-op: the claude CLI reports `num_turns: 1`
 * for the failed API call itself, defeating a zero-turns guard, and the
 * no-diff branch never consulted `completed`. Every arm here is a shape
 * OBSERVED live (invalid key, exhausted credit — byte-identical signatures
 * on CLI 2.1.222) or the guard one layer out (the runner's own completed
 * gate, for any future driver that misses its own failure shape).
 */

/** The observed credit-exhaustion result (CLI 2.1.222) — verbatim shape,
 *  including the `subtype: "success"` trap on a FAILED run. */
const CREDIT_EXHAUSTED = {
  is_error: true,
  num_turns: 1,
  total_cost_usd: 0,
  terminal_reason: 'api_error',
  modelUsage: {},
  result: 'Credit balance is too low',
  subtype: 'success',
};

/** Exec fixture that answers the version probe and the agent run
 *  separately — the driver calls both through the one injected seam. */
function execWith(run: {
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  version?: string;
}): AgentExec {
  return (bin, args) => {
    expect(bin).toBe('claude');
    if (args.includes('--version')) {
      return {
        code: 0,
        stdout: run.version ?? '2.1.222 (Claude Code)',
        stderr: '',
        timedOut: false,
      };
    }
    return {
      code: run.code ?? 0,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
      timedOut: run.timedOut ?? false,
    };
  };
}

const budget = { maxTurns: 80, maxMinutes: 30 };
const runOpts = { cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} };

describe('claude-code driver: API-level failure is never-ran, with the human cause', () => {
  it('credit exhaustion (the live signature, num_turns: 1) is never-ran naming the cause', async () => {
    const d = makeClaudeCodeDriver(execWith({ code: 1, stdout: JSON.stringify(CREDIT_EXHAUSTED) }));
    const r = await d.run(runOpts);
    expect(r.neverRan?.reason).toContain('Credit balance is too low');
    expect(r.neverRan?.reason).toContain('api_error');
    expect(r.completed).toBe(false);
  });

  it('an invalid key (same signature, different cause string) is never-ran', async () => {
    const d = makeClaudeCodeDriver(
      execWith({
        code: 1,
        stdout: JSON.stringify({ ...CREDIT_EXHAUSTED, result: 'Invalid API key provided' }),
      }),
    );
    const r = await d.run(runOpts);
    expect(r.neverRan?.reason).toContain('Invalid API key');
  });

  it('never keys on subtype ("success" is present on a FAILED run)', async () => {
    // The signature already carries subtype: 'success'; a regression that
    // trusts it would classify this run as completed.
    const d = makeClaudeCodeDriver(execWith({ code: 1, stdout: JSON.stringify(CREDIT_EXHAUSTED) }));
    const r = await d.run(runOpts);
    expect(r.completed).toBe(false);
    expect(r.neverRan).toBeDefined();
  });

  it('is_error with exit 0 and no progress is still never-ran (exit code is not the signal)', async () => {
    const d = makeClaudeCodeDriver(execWith({ code: 0, stdout: JSON.stringify(CREDIT_EXHAUSTED) }));
    const r = await d.run(runOpts);
    expect(r.neverRan).toBeDefined();
  });

  it('an api_error AFTER real work is a failed run with the cause, never never-ran', async () => {
    const d = makeClaudeCodeDriver(
      execWith({
        code: 1,
        stdout: JSON.stringify({
          is_error: true,
          terminal_reason: 'api_error',
          num_turns: 41,
          total_cost_usd: 2.53,
          result: 'Credit balance is too low',
          modelUsage: { 'claude-sonnet-5': {} },
        }),
      }),
    );
    const r = await d.run(runOpts);
    expect(r.neverRan).toBeUndefined();
    expect(r.completed).toBe(false);
    expect(r.failure?.reason).toContain('Credit balance is too low');
    expect(r.turns).toBe(41);
    expect(r.costUsd).toBe(2.53);
  });

  it('a plain non-zero exit after real turns reports the exit as the failure', async () => {
    const d = makeClaudeCodeDriver(execWith({ code: 1, stdout: '{"num_turns": 9}' }));
    const r = await d.run(runOpts);
    expect(r.neverRan).toBeUndefined();
    expect(r.failure?.reason).toBe('claude exit 1');
  });

  it('a successful run never reads the result field (the agent final message) as a failure', async () => {
    const d = makeClaudeCodeDriver(
      execWith({
        code: 0,
        stdout: JSON.stringify({
          is_error: false,
          num_turns: 12,
          total_cost_usd: 0.4,
          result: 'I fixed the build by declaring the missing packages.',
        }),
      }),
    );
    const r = await d.run(runOpts);
    expect(r.completed).toBe(true);
    expect(r.failure).toBeUndefined();
    expect(r.neverRan).toBeUndefined();
  });

  it('probes and reports the agent CLI build (run provenance)', async () => {
    const d = makeClaudeCodeDriver(
      execWith({ code: 0, stdout: '{"num_turns": 2}', version: '2.1.222 (Claude Code)' }),
    );
    const r = await d.run(runOpts);
    expect(r.cliVersion).toBe('2.1.222');
  });

  it('an unparseable version probe leaves the field absent, never fails the run', async () => {
    const d = makeClaudeCodeDriver(
      execWith({ code: 0, stdout: '{"num_turns": 2}', version: 'garbage' }),
    );
    const r = await d.run(runOpts);
    expect(r.cliVersion).toBeUndefined();
    expect(r.turns).toBe(2);
  });
});

// ── The runner's own guard (driver-independent) ─────────────────────────────

const TRUSTED: AnalysisTrustContext = {
  repoExecutionAllowed: true,
  source: 'local-workspace',
} as AnalysisTrustContext;

const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };
const RED_FLOOR: CorrectnessFloorResult = {
  ran: true,
  checks: [
    { pack: 'typescript', label: 'import-resolution', bin: 'node', status: 'fail' },
  ] as never,
  blocks: true,
};

function fakeGit(opts: { diff?: boolean } = {}): RemediateGit {
  return {
    head: () => 'base0000',
    sweepLeftovers: () => undefined,
    hasDiff: () => !!opts.diff,
  };
}

function fakeDriver(result: Partial<AgentRunResult>): AgentDriver {
  return {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: ['FAKE_KEY'],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async () => ({ completed: true, timedOut: false, transcriptTail: '', ...result }),
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
  };
}

function base(driver: AgentDriver, extra: Partial<Parameters<typeof runRemediateTask>[0]> = {}) {
  return {
    cwd: '/tmp/fake',
    trust: TRUSTED,
    taskId: 'fix-vulns',
    config: config(),
    drivers: [driver],
    git: fakeGit({ diff: true }),
    runFloor: () => RED_FLOOR,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    ...extra,
  };
}

describe('runner: an errored no-diff run is agent-failed, never a benign no-op', () => {
  it('completed: false with no diff is agent-failed, naming the driver cause', async () => {
    const r = await runRemediateTask(
      base(
        fakeDriver({
          completed: false,
          failure: { reason: 'Credit balance is too low (api_error)' },
          transcriptTail: 'API Error: 400',
        }),
        { git: fakeGit({ diff: false }) },
      ),
    );
    expect(r.outcome).toBe('agent-failed');
    expect(r.note).toContain('Credit balance is too low');
    expect(r.transcriptTail).toBe('API Error: 400');
    // The entry floor rides the result — "not run (dry run)" was FALSE here
    // (the floor ran; it is why the agent spawned).
    expect(r.floor).toBe(RED_FLOOR);
    expect(r.ledger).toContain('entry snapshot');
    expect(r.ledger).not.toContain('dry run');
  });

  it('a budget-cut no-diff run stays a no-op with the partial flag (a true statement)', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: false, timedOut: true }), { git: fakeGit({ diff: false }) }),
    );
    expect(r.outcome).toBe('no-op');
    expect(r.partial).toBe(true);
  });

  it('a clean no-diff run is a no-op and carries the entry floor', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: true }), { git: fakeGit({ diff: false }) }),
    );
    expect(r.outcome).toBe('no-op');
    expect(r.floor).toBe(RED_FLOOR);
  });

  it('agent-never-ran carries the entry floor too (the ledger names pre-existing debt)', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: false, neverRan: { reason: 'Credit balance is too low' } })),
    );
    expect(r.outcome).toBe('agent-never-ran');
    expect(r.note).toContain('agent never ran: Credit balance is too low');
    expect(r.floor).toBe(RED_FLOOR);
  });

  it('an errored run WITH committed work still verifies, and the failure is disclosed', async () => {
    const r = await runRemediateTask(
      base(
        fakeDriver({
          completed: false,
          failure: { reason: 'claude exit 1' },
          turns: 30,
          costUsd: 1.1,
        }),
        { runFloor: () => GREEN_FLOOR },
      ),
    );
    // Verification decides the committed work's fate — here it passes.
    expect(r.outcome).toBe('verified');
    expect(r.envelope?.failure).toBe('claude exit 1');
    expect(r.ledger).toContain('driver-reported failure: claude exit 1');
  });
});

describe('runner: auth-path disclosure (#24)', () => {
  it('an injected declared credential is api-key; none is subscription', async () => {
    const withKey = await runRemediateTask(base(fakeDriver({}), { agentEnv: { FAKE_KEY: 'k' } }));
    expect(withKey.envelope?.auth).toBe('api-key');
    expect(withKey.ledger).toContain('api-key (billed API spend)');

    const without = await runRemediateTask(base(fakeDriver({})));
    expect(without.envelope?.auth).toBe('subscription');
  });

  it('subscription costs are labeled API-equivalent, never spend', async () => {
    const r = await runRemediateTask(base(fakeDriver({ turns: 4, costUsd: 0.08 })));
    expect(r.ledger).toContain('API-equivalent cost: $0.08');
    expect(r.ledger).toContain('not billed spend');
    expect(r.ledger).not.toMatch(/- spend:/);
  });

  it('api-key costs stay labeled spend', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ turns: 4, costUsd: 0.08 }), { agentEnv: { FAKE_KEY: 'k' } }),
    );
    expect(r.ledger).toContain('- spend: $0.08');
  });
});

describe('envelope provenance (#13)', () => {
  it('the agent CLI build reaches the envelope and the ledger; absence is disclosed', async () => {
    const withVersion = await runRemediateTask(base(fakeDriver({ cliVersion: '2.1.222' })));
    expect(withVersion.envelope?.cliVersion).toBe('2.1.222');
    expect(withVersion.ledger).toContain('agent CLI 2.1.222');

    const without = await runRemediateTask(base(fakeDriver({})));
    expect(without.ledger).toContain('agent CLI version not reported');
  });

  it('the transcript tail never reaches the ledger (job-log evidence only)', async () => {
    const r = await runRemediateTask(
      base(
        fakeDriver({
          completed: false,
          failure: { reason: 'x' },
          transcriptTail: 'SECRET-TAIL-MARKER',
        }),
        {
          git: fakeGit({ diff: false }),
        },
      ),
    );
    expect(r.transcriptTail).toBe('SECRET-TAIL-MARKER');
    expect(r.ledger).not.toContain('SECRET-TAIL-MARKER');
  });
});

describe('renderFloorVerification: the entry-snapshot arm (#11)', () => {
  it('a red entry floor with no attribution renders as pre-existing debt, never "passed"', () => {
    const lines = renderFloorVerification(RED_FLOOR, undefined, 'the pre-agent entry run');
    const text = lines.join('\n');
    expect(text).toContain('entry snapshot');
    expect(text).toContain('red (pre-existing debt');
    expect(text).not.toContain('**passed**');
    expect(text).toContain('typescript/import-resolution: fail');
  });

  it('a green entry floor renders green', () => {
    const text = renderFloorVerification(GREEN_FLOOR, undefined, 'x').join('\n');
    expect(text).toContain('**green**');
  });

  it('an absent floor still renders the dry-run line (plan paths)', () => {
    expect(renderFloorVerification(undefined, undefined, 'x')[0]).toContain('not run (dry run)');
  });

  it('an attributed floor keeps the attributed headline', () => {
    const text = renderFloorVerification(GREEN_FLOOR, [], 'the pre-agent entry run').join('\n');
    expect(text).toContain('attributed vs the pre-agent entry run');
    expect(text).toContain('**passed**');
  });
});

describe('ledger: the failure ledger is complete without leaking evidence', () => {
  it('renders driver failure + auth + CLI build in one envelope', () => {
    const ledger = renderRemediateLedger({
      outcome: 'agent-failed',
      task: 'fix-build',
      note: 'the agent run ended in an error and produced no committed change: Credit balance is too low.',
      envelope: {
        driver: 'claude-code',
        model: 'sonnet',
        modelSource: 'auto-tier',
        auth: 'api-key',
        cliVersion: '2.1.222',
        failure: 'Credit balance is too low (api_error)',
        turns: 1,
        costUsd: 0,
        budget: { maxTurns: 80, maxMinutes: 30, maxUsd: 5 },
        unenforceableCaps: [],
      },
    });
    expect(ledger).toContain('outcome: **agent-failed**');
    expect(ledger).toContain('Credit balance is too low');
    expect(ledger).toContain('agent CLI 2.1.222');
    expect(ledger).toContain('api-key (billed API spend)');
  });
});
