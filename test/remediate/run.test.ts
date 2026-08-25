import { describe, it, expect } from 'vitest';
import { runRemediateTask, type RemediateGit } from '../../src/remediate/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';
import type { RemediateConfig } from '../../src/remediate/config';
import { resolveRemediateConfig, DEFAULT_REMEDIATE_BUDGET } from '../../src/remediate/config';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { AnalysisTrustContext } from '../../src/analysis-trust';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/**
 * The runner IS the verified frame: these tests pin that the agent's claim
 * of success is structurally untrusted (a net-new floor failure blocks no
 * matter what the agent said), that pre-existing debt discloses without
 * blocking, that every refusal/infra arm is truthful and distinct, that the
 * budget envelope is runner-enforced (wall-clock, turns, spend) with
 * undeclared caps DISCLOSED, and that the synthetic-driver seam works — a
 * driver injected into the registry argument is picked up with its tier
 * routing, exactly like the recipe-playbook proves language packs are.
 */

const TRUSTED: AnalysisTrustContext = {
  repoExecutionAllowed: true,
  source: 'local-workspace',
} as AnalysisTrustContext;
const UNTRUSTED: AnalysisTrustContext = {
  repoExecutionAllowed: false,
  source: 'untrusted-content',
} as AnalysisTrustContext;

const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };
const RED_FLOOR: CorrectnessFloorResult = {
  ran: true,
  checks: [{ pack: 'typescript', label: 'tests', bin: 'npx', status: 'fail' }] as never,
  blocks: true,
};

function fakeGit(opts: { diff?: boolean; sweepError?: string } = {}): RemediateGit {
  let head = 'base0000';
  return {
    head: () => head,
    sweepLeftovers: () => opts.sweepError,
    scrubRuntimeArtifacts: () => [],
    hasDiff: () => {
      if (opts.diff) head = 'head1111';
      return !!opts.diff;
    },
  };
}

function fakeDriver(
  result: Partial<AgentRunResult>,
  overrides: Partial<AgentDriver> = {},
): AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } {
  const driver: AgentDriver & { lastRun?: Parameters<AgentDriver['run']>[0] } = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: ['FAKE_KEY'],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async (opts) => {
      driver.lastRun = opts;
      return {
        completed: true,
        timedOut: false,
        transcriptTail: '',
        ...result,
      };
    },
    ...overrides,
  };
  return driver;
}

function config(
  partial: Partial<RemediateConfig['agent']> = {},
  salvage?: 'discard' | 'draft-pr',
): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-vulns'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: salvage ?? 'discard',
    agent: {
      driver: 'fake-agent',
      model: 'auto',
      budget: DEFAULT_REMEDIATE_BUDGET,
      ...partial,
    },
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
    runFloor: () => GREEN_FLOOR,
    runGuardrail: async () => ({ verdict: 'PASSED', ran: true, passesGate: true }),
    // The ONE tree verification (4.4.5) runs in a clean worktree after a
    // frozen install; both are seamed here so no git repo or package manager
    // is needed. The floor + guardrail seams above are forwarded into it.
    verifySeams: FAKE_TREE,
    ...extra,
  };
}

const FAKE_TREE: NonNullable<Parameters<typeof runRemediateTask>[0]['verifySeams']> = {
  worktree: async (_o, fn) => fn('/tmp/fake-worktree'),
  install: () => ({ status: 'installed', argv: ['npm', 'ci'] }),
  changedFiles: () => ['src/a.ts'],
};

describe('refusal + infra arms (each truthful and distinct)', () => {
  it('refuses an untrusted tree before anything spawns', async () => {
    const driver = fakeDriver({});
    const r = await runRemediateTask(base(driver, { trust: UNTRUSTED }));
    expect(r.outcome).toBe('refused');
    expect(r.note).toContain('default branch only');
    expect(driver.lastRun).toBeUndefined();
  });

  it('refuses an unknown task, naming the known ones', async () => {
    const r = await runRemediateTask(base(fakeDriver({}), { taskId: 'fix-everything' }));
    expect(r.outcome).toBe('refused');
    expect(r.note).toContain('fix-vulns');
    expect(r.note).toContain('fix-build');
  });

  it('refuses an unknown driver, naming the known ones (never a silent fallback)', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({}), { config: config({ driver: 'gpt-nine' }) }),
    );
    expect(r.outcome).toBe('refused');
    expect(r.note).toContain("unknown agent driver 'gpt-nine'");
    expect(r.note).toContain('fake-agent');
  });

  it('an unavailable driver is agent-never-ran with the remedy', async () => {
    const driver = fakeDriver(
      {},
      { available: () => ({ ok: false, reason: 'claude CLI missing' }) },
    );
    const r = await runRemediateTask(base(driver));
    expect(r.outcome).toBe('agent-never-ran');
    expect(r.note).toContain('claude CLI missing');
  });

  it('a driver-reported never-ran carries the cause into the outcome', async () => {
    const driver = fakeDriver({
      completed: false,
      neverRan: { reason: 'claude exit 1: bad auth' },
    });
    // A genuinely never-ran agent leaves a clean tree — the claim stands.
    const r = await runRemediateTask(base(driver, { git: fakeGit({ diff: false }) }));
    expect(r.outcome).toBe('agent-never-ran');
    expect(r.note).toContain('bad auth');
  });

  it('the sweep runs BEFORE a never-ran claim is honored (#272: evidence first)', async () => {
    let swept = false;
    const git: RemediateGit = {
      head: () => 'base0000',
      sweepLeftovers: () => {
        swept = true;
        return undefined;
      },
      scrubRuntimeArtifacts: () => [],
      hasDiff: () => false,
    };
    const driver = fakeDriver({ completed: false, neverRan: { reason: 'exit 143' } });
    const r = await runRemediateTask(base(driver, { git }));
    expect(r.outcome).toBe('agent-never-ran');
    expect(swept).toBe(true);
  });

  it('a never-ran claim CONTRADICTED by committed work is demoted — verification decides (#272)', async () => {
    // The live class: a wall-clock-killed run the driver misread as "never
    // ran" returned early and discarded 30 minutes of committed work. The
    // tree is the arbiter: work means the agent ran, whatever the driver's
    // exit-encoding taxonomy concluded. The claim demotes to a disclosed
    // failure and the verified frame decides the work's fate.
    const driver = fakeDriver({
      completed: false,
      neverRan: { reason: 'claude exit 143: (no stderr)' },
    });
    const r = await runRemediateTask(base(driver, { git: fakeGit({ diff: true }) }));
    expect(r.outcome).not.toBe('agent-never-ran');
    expect(r.outcome).toBe('verified'); // green floor + PASSED guardrail in `base`
    expect(r.envelope?.failure).toContain('contradicted');
    expect(r.ledger).toBeTruthy();
  });

  it('a never-ran claim with UNCOMMITTABLE leftovers is also contradicted — nothing is discarded silently', async () => {
    const driver = fakeDriver({ completed: false, neverRan: { reason: 'exit 143' } });
    const r = await runRemediateTask(
      base(driver, { git: fakeGit({ diff: false, sweepError: 'index locked' }) }),
    );
    // The sweep-failed arm (agent left uncommitted work it could not commit)
    // reports the evidence rather than the driver's claim.
    expect(r.note).toContain('uncommitted work');
    expect(r.envelope?.failure).toContain('contradicted');
  });
});

describe('the verified frame (the agent is never trusted)', () => {
  it('verified: diff + net-new-clean floor + guardrail ran', async () => {
    const driver = fakeDriver({ turns: 12, costUsd: 0.8, resolvedModelId: 'fake-model-v2' });
    const r = await runRemediateTask(base(driver));
    expect(r.outcome).toBe('verified');
    expect(r.guardrailVerdict).toBe('PASSED');
    expect(r.envelope).toMatchObject({
      driver: 'fake-agent',
      model: 'fake-standard', // fix-vulns tier = standard, via the driver
      modelSource: 'auto-tier',
      resolvedModelId: 'fake-model-v2',
      turns: 12,
      costUsd: 0.8,
    });
    // #305: the envelope always answers whether the in-loop gate was wired.
    // The fake driver declares no mechanism → honestly backstop-only, and
    // the ledger says so.
    expect(r.envelope?.inLoopGate.mode).toBe('backstop-only');
    expect(r.envelope?.inLoopGate.reason).toContain('no in-loop gate mechanism');
    expect(r.ledger).toContain('in-loop gate: BACKSTOP-ONLY');
    expect(r.ledger).toContain('never');
    expect(r.ledger).toContain('trusted');
  });

  it('#305: an injected in-loop-gate probe reaches the envelope and the ledger', async () => {
    const r = await runRemediateTask({
      ...base(fakeDriver({ turns: 3 })),
      armInLoopGate: () => ({
        mode: 'in-loop-gated' as const,
        reason: 'Stop hook declared, workspace trusted, command resolves',
      }),
    });
    expect(r.envelope?.inLoopGate.mode).toBe('in-loop-gated');
    expect(r.ledger).toContain('in-loop gate: ARMED');
  });

  it('#285: a no-op records the agent FINAL MESSAGE — the account of why nothing changed', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ finalMessage: 'inventory shows only deferred items I cannot see' }), {
        git: fakeGit({ diff: false }),
      }),
    );
    expect(r.outcome).toBe('no-op');
    expect(r.agentFinalMessage).toBe('inventory shows only deferred items I cannot see');
  });

  it('no-op: an agent run with no committed change opens nothing', async () => {
    const r = await runRemediateTask(base(fakeDriver({}), { git: fakeGit({ diff: false }) }));
    expect(r.outcome).toBe('no-op');
  });

  it('floor-red: a net-new floor failure blocks EVEN when the agent claims done', async () => {
    const floors = [GREEN_FLOOR, RED_FLOOR]; // entry, then post-agent
    const r = await runRemediateTask(
      base(fakeDriver({ completed: true }), { runFloor: () => floors.shift()! }),
    );
    expect(r.outcome).toBe('floor-red');
    expect(r.note).toContain('NET-NEW');
    expect(r.ledger).toContain('FAILED — net-new failures');
  });

  // 4.4.5: the lane verifies the COMMITTED head on a clean checkout with the
  // repo's frozen install, exactly as CI will. A tree CI cannot install is
  // its own outcome and lands nothing; the ledger says what CI's install
  // step would have done.
  it('install-failed: a clean checkout CI cannot install lands nothing, even with a green floor', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: true }), {
        verifySeams: {
          ...FAKE_TREE,
          install: () => ({
            status: 'failed',
            argv: ['npm', 'ci', '--legacy-peer-deps'],
            output:
              'npm ERR! code EUSAGE\nnpm ERR! package.json and package-lock.json are not in sync',
          }),
        },
      }),
    );
    expect(r.outcome).toBe('install-failed');
    expect(r.note).toContain('EUSAGE');
    expect(r.ledger).toContain('outcome: **install-failed**');
    expect(r.ledger).toContain('FAILED on a clean checkout');
  });

  it('the verification runs against the committed HEAD in a clean worktree, diff-scoped vs base', async () => {
    let ref: string | undefined;
    let floorArgs: unknown;
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        verifySeams: {
          ...FAKE_TREE,
          worktree: async (o, fn) => {
            ref = o.ref;
            return fn('/tmp/clean-wt');
          },
          changedFiles: (wt, baseHead) => {
            floorArgs = { wt, baseHead };
            return ['src/a.ts'];
          },
        },
      }),
    );
    expect(r.outcome).toBe('verified');
    expect(ref).toBe('head1111');
    expect(floorArgs).toEqual({ wt: '/tmp/clean-wt', baseHead: 'base0000' });
    expect(r.ledger).toContain('`npm ci` succeeded on a clean checkout');
  });

  it('a verification that cannot run (worktree failure) fails CLOSED with the step named', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        verifySeams: {
          ...FAKE_TREE,
          worktree: async () => {
            throw new Error('Cannot resolve baseline ref head1111.');
          },
        },
      }),
    );
    expect(r.outcome).toBe('guardrail-red');
    expect(r.guardrailVerdict).toContain("step 'worktree'");
    expect(r.note).toContain('could not run');
  });

  it('pre-existing floor debt discloses without blocking', async () => {
    // entry AND post-agent both red with the SAME check → pre-existing
    const r = await runRemediateTask(base(fakeDriver({}), { runFloor: () => RED_FLOOR }));
    expect(r.outcome).toBe('verified');
    expect(r.ledger).toContain('Pre-existing floor debt');
  });

  it('guardrail-red: a BLOCKED guardrail lands nothing, even on a clean floor', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: true }), {
        runGuardrail: async () => ({ verdict: 'BLOCKED', ran: true, passesGate: false }),
      }),
    );
    expect(r.outcome).toBe('guardrail-red');
    expect(r.note).toContain('BLOCKED');
    expect(r.note).toContain('nothing merges');
  });

  it('guardrail-red: an UNRUNNABLE guardrail fails closed for the agent lane', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        runGuardrail: async () => ({
          verdict: 'unavailable (boom)',
          ran: false,
          passesGate: false,
        }),
      }),
    );
    expect(r.outcome).toBe('guardrail-red');
    expect(r.note).toContain('never pushed unverified');
  });

  it('guardrail-red outranks budget-exhausted: a partial diff that fails the gate never salvages', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: false, timedOut: true }), {
        runGuardrail: async () => ({ verdict: 'BLOCKED', ran: true, passesGate: false }),
        config: { ...config(), salvage: 'draft-pr' },
      }),
    );
    expect(r.outcome).toBe('guardrail-red');
  });
});

describe('the budget envelope (runner-enforced, disclosed)', () => {
  it('wall-clock kill → budget-exhausted, salvage policy named (discard default)', async () => {
    const r = await runRemediateTask(base(fakeDriver({ completed: false, timedOut: true })));
    expect(r.outcome).toBe('budget-exhausted');
    expect(r.partial).toBe(true);
    expect(r.note).toContain('wall-clock');
    expect(r.note).toContain('discard');
  });

  it('spend over maxUsd → budget-exhausted via the envelope, not the agent claim', async () => {
    const r = await runRemediateTask(base(fakeDriver({ costUsd: 99 })));
    expect(r.outcome).toBe('budget-exhausted');
    expect(r.note).toContain('maxUsd');
  });

  it('draft-pr salvage policy is named when configured', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ completed: false, timedOut: true }), {
        config: { ...config(), salvage: 'draft-pr' },
      }),
    );
    expect(r.note).toContain('draft-pr');
  });

  it('the App-tier token lifetime clamps the wall clock, disclosed in the envelope', async () => {
    process.env.DXKIT_TOKEN_MODE = 'app';
    try {
      const driver = fakeDriver({});
      const r = await runRemediateTask(
        base(driver, {
          config: {
            ...config(),
            agent: { ...config().agent, budget: { maxTurns: 80, maxMinutes: 90, maxUsd: 5 } },
          },
        }),
      );
      // The driver's enforced wall clock IS the clamped value — enforcement
      // and disclosure read the same budget.
      expect(driver.lastRun?.budget.maxMinutes).toBe(45);
      expect(r.envelope!.unenforceableCaps.join(' ')).toContain('one hour');
    } finally {
      delete process.env.DXKIT_TOKEN_MODE;
    }
  });

  it('a driver that cannot enforce a cap yields a DISCLOSED limitation, never silence', async () => {
    const driver = fakeDriver({ costUsd: 99 }, { budgetSupport: { turns: 'none', cost: 'none' } });
    const r = await runRemediateTask(base(driver));
    // cost unsupported → the runner does NOT enforce maxUsd from a number the
    // driver cannot vouch for; both limitations are disclosed in the envelope
    expect(r.outcome).toBe('verified');
    expect(r.envelope!.unenforceableCaps.join(' ')).toContain('maxTurns');
    expect(r.envelope!.unenforceableCaps.join(' ')).toContain('maxUsd');
    expect(r.ledger).toContain('disclosed limitation');
  });

  it('an UNENFORCEABLE turn cap is never claimed as HIT (the cost clause, applied to turns)', async () => {
    // A driver may report turns informationally while lacking the flag to
    // enforce them. Reaching maxTurns naturally is then a completion, not a
    // cap hit — claiming otherwise contradicts the envelope's own disclosure
    // and discards verified work under the default salvage policy.
    const driver = fakeDriver(
      { turns: DEFAULT_REMEDIATE_BUDGET.maxTurns },
      { budgetSupport: { turns: 'reported', cost: 'reported' } },
    );
    const r = await runRemediateTask(base(driver));
    expect(r.outcome).toBe('verified');
    expect(r.partial).toBeUndefined();
    expect(r.envelope!.unenforceableCaps.join(' ')).toContain('maxTurns');
    // the enforceable direction still bites
    const enforcing = fakeDriver({ turns: DEFAULT_REMEDIATE_BUDGET.maxTurns });
    const hit = await runRemediateTask(base(enforcing));
    expect(hit.outcome).toBe('budget-exhausted');
    expect(hit.note).toContain('maxTurns');
  });
});

describe('the leftover sweep (staged work must never ride the landing commit)', () => {
  it('a failed sweep blocks even when the agent DID commit work', async () => {
    // sweepLeftovers ran `git add -A` before its commit failed, so the
    // leftovers sit staged. Landing would commit them alongside the ledger
    // and force-push them unreviewed — nothing lands, and the note says why.
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        git: fakeGit({ diff: true, sweepError: 'pre-commit hook rejected' }),
      }),
    );
    expect(r.outcome).toBe('sweep-failed');
    expect(r.note).toContain('pre-commit hook rejected');
    expect(r.note).toContain('unreviewed');
  });

  it('a failed sweep with no committed work stays agent-never-ran', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        git: fakeGit({ diff: false, sweepError: 'nothing to commit' }),
      }),
    );
    expect(r.outcome).toBe('agent-never-ran');
    expect(r.note).toContain('nothing to commit');
  });

  it('a clean sweep with committed work still verifies (no over-blocking)', async () => {
    const r = await runRemediateTask(base(fakeDriver({}), { git: fakeGit({ diff: true }) }));
    expect(r.outcome).toBe('verified');
  });
});

describe('the synthetic-driver seam (tier routing + budget passthrough)', () => {
  it('routes the task tier through the injected driver and passes the caps', async () => {
    const driver = fakeDriver({});
    await runRemediateTask(base(driver, { taskId: 'fix-lint' }));
    expect(driver.lastRun!.model).toBe('fake-light'); // fix-lint tier = light
    expect(driver.lastRun!.budget).toEqual({ maxTurns: 80, maxMinutes: 30 });
    expect(driver.lastRun!.prompt).toContain('lint');
  });

  it('a pinned tier overrides the task tier; a native pin passes through with a warning', async () => {
    const driver = fakeDriver({});
    await runRemediateTask(base(driver, { config: config({ model: 'deep' }) }));
    expect(driver.lastRun!.model).toBe('fake-deep');

    const r = await runRemediateTask(base(driver, { config: config({ model: 'mystery-9' }) }));
    expect(driver.lastRun!.model).toBe('mystery-9');
    expect(r.envelope!.modelWarning).toContain('mystery-9');
  });
});

describe('resolveRemediateConfig (conservative normalization)', () => {
  let repo: string;
  const withPolicy = (text: string): string => {
    repo = mkdtempSync(join(tmpdir(), 'dxkit-remediate-config-'));
    mkdirSync(join(repo, '.dxkit'));
    writeFileSync(join(repo, '.dxkit', 'policy.json'), text, 'utf8');
    return repo;
  };

  it('absent section → disabled with full conservative defaults', () => {
    const cwd = withPolicy('{}');
    try {
      const c = resolveRemediateConfig(cwd);
      expect(c.enabled).toBe(false);
      expect(c.agent).toEqual({
        driver: 'claude-code',
        model: 'auto',
        budget: { maxTurns: 80, maxMinutes: 30, maxUsd: 5 },
      });
      // 'auto' resolves per task shape via salvageForTask (open-ended →
      // draft-pr, bounded → discard); the raw default is the posture, not
      // a concrete decision.
      expect(c.salvage).toBe('auto');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an enabled block with no budget gets the conservative caps (never unbounded)', () => {
    const cwd = withPolicy('{"remediate": {"enabled": true, "tasks": ["fix-lint"]}}');
    try {
      const c = resolveRemediateConfig(cwd);
      expect(c.enabled).toBe(true);
      expect(c.tasks).toEqual(['fix-lint']);
      expect(c.agent.budget).toEqual(DEFAULT_REMEDIATE_BUDGET);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('unknown task ids are retained for disclosure, never silently dropped', () => {
    const cwd = withPolicy('{"remediate": {"enabled": true, "tasks": ["fix-vulns", "fix-world"]}}');
    try {
      const c = resolveRemediateConfig(cwd);
      expect(c.tasks).toEqual(['fix-vulns']);
      expect(c.unknownTasks).toEqual(['fix-world']);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reads a commented (JSONC) remediate stanza — the scaffold uncomment path', () => {
    const cwd = withPolicy(`{
  // uncommented from the scaffold
  "remediate": {
    "enabled": true,
    "agent": { "model": "deep", "budget": { "maxUsd": 2, } },
  },
}`);
    try {
      const c = resolveRemediateConfig(cwd);
      expect(c.enabled).toBe(true);
      expect(c.agent.model).toBe('deep');
      expect(c.agent.budget.maxUsd).toBe(2);
      expect(c.agent.budget.maxTurns).toBe(80);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ─── the score hinge (write-docs, 4.3.4) ────────────────────────────────────

describe('the score hinge — the task goal as a land condition', () => {
  const hingeBase = (
    driver: AgentDriver,
    scores: { entry: [number, number]; after: [number, number] },
  ) => {
    let call = 0;
    return base(driver, {
      taskId: 'write-docs',
      config: { ...config(), tasks: ['write-docs' as const] },
      hingeScores: async () => {
        const [improve, hold] = call++ === 0 ? scores.entry : scores.after;
        return { improve, holds: [hold] };
      },
    });
  };

  it('an improved dimension with holds intact lands, evidence in the ledger', async () => {
    const r = await runRemediateTask(
      hingeBase(fakeDriver({}), { entry: [42, 70], after: [55, 70] }),
    );
    expect(r.outcome).toBe('verified');
    expect(r.scoreHinge).toEqual({
      dimension: 'documentation',
      before: 42,
      after: 55,
      holds: [{ dimension: 'quality', before: 70, after: 70 }],
    });
    expect(r.ledger).toContain('score hinge');
    expect(r.ledger).toContain('42 -> 55');
  });

  it('a score that does not move is score-red — cosmetic churn never lands', async () => {
    const r = await runRemediateTask(
      hingeBase(fakeDriver({}), { entry: [42, 70], after: [42, 70] }),
    );
    expect(r.outcome).toBe('score-red');
    expect(r.note).toContain('did not improve');
    expect(r.note).toContain('42 -> 42');
  });

  it('improving the goal by degrading a held dimension is score-red', async () => {
    const r = await runRemediateTask(
      hingeBase(fakeDriver({}), { entry: [42, 70], after: [60, 61] }),
    );
    expect(r.outcome).toBe('score-red');
    expect(r.note).toContain('quality 70 -> 61');
  });

  it('tasks without a hinge never pay the probe', async () => {
    let probed = 0;
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        hingeScores: async () => {
          probed++;
          return { improve: 0, holds: [] };
        },
      }),
    );
    expect(r.outcome).toBe('verified');
    expect(probed).toBe(0);
    expect(r.scoreHinge).toBeUndefined();
  });
});

describe('WP5: fast-exit, phases, cap accounting, blocked evidence', () => {
  it('fix-build with a GREEN entry floor is a $0 no-op — no agent spawns', async () => {
    const driver = fakeDriver({});
    let spawned = false;
    driver.run = async () => {
      spawned = true;
      return { completed: true, timedOut: false, transcriptTail: '' };
    };
    const r = await runRemediateTask(
      base(driver, { taskId: 'fix-build', runFloor: () => GREEN_FLOOR }),
    );
    expect(r.outcome).toBe('no-op');
    expect(spawned).toBe(false);
    expect(r.note).toContain('no agent was spawned');
  });

  it('fix-build with a RED entry floor still runs the agent (the over-skip guard)', async () => {
    const driver = fakeDriver({});
    let spawned = false;
    const origRun = driver.run.bind(driver);
    driver.run = async (o) => {
      spawned = true;
      return origRun(o);
    };
    const floors = [RED_FLOOR, RED_FLOOR];
    const r = await runRemediateTask(
      base(driver, { taskId: 'fix-build', runFloor: () => floors.shift() ?? RED_FLOOR }),
    );
    expect(spawned).toBe(true);
    // Pre-existing failure on both sides — disclosed, not weaponized.
    expect(r.outcome).toBe('verified');
  });

  it('reports phases in order through onPhase', async () => {
    const phases: string[] = [];
    const r = await runRemediateTask(base(fakeDriver({}), { onPhase: (p) => phases.push(p) }));
    expect(r.outcome).toBe('verified');
    expect(phases).toEqual([
      'entry-floor',
      'agent',
      'sweep',
      'verify-install',
      'verify-floor',
      'guardrail',
    ]);
  });

  it('a guardrail-red ledger names the blocking findings (evidence survives the runner)', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({}), {
        runGuardrail: async () => ({
          verdict: 'BLOCKED',
          ran: true,
          passesGate: false,
          blocking: ['[secret] src/config.ts:12', '[dep-vuln] axios@1.6.0 · GHSA-xxxx'],
        }),
      }),
    );
    expect(r.outcome).toBe('guardrail-red');
    expect(r.note).toContain('Blocking findings:');
    expect(r.note).toContain('[secret] src/config.ts:12');
    expect(r.ledger).toContain('[dep-vuln] axios@1.6.0');
  });

  it('a driver turn count one over the cap is explained, not left reading as broken enforcement', async () => {
    const r = await runRemediateTask(
      base(fakeDriver({ turns: DEFAULT_REMEDIATE_BUDGET.maxTurns + 1, costUsd: 3.12 })),
    );
    expect(r.outcome).toBe('budget-exhausted');
    expect(r.ledger).toContain("includes the run's closing turn");
    expect(r.ledger).toContain('the cap did enforce');
  });
});

describe('budget awareness (WP9)', () => {
  it('the agent is told its caps and the commit-before-the-kill rule', async () => {
    const driver = fakeDriver({});
    await runRemediateTask(base(driver));
    expect(driver.lastRun?.prompt).toContain('Budget for this run');
    expect(driver.lastRun?.prompt).toContain(`${DEFAULT_REMEDIATE_BUDGET.maxMinutes} minutes`);
    expect(driver.lastRun?.prompt).toContain('reserve the final minutes');
  });
});
