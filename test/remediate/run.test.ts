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
    budgetSupport: { turns: true, cost: true },
    credentialEnv: ['FAKE_KEY'],
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
    runGuardrail: async () => 'PASSED',
    ...extra,
  };
}

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
    const r = await runRemediateTask(base(driver));
    expect(r.outcome).toBe('agent-never-ran');
    expect(r.note).toContain('bad auth');
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
    expect(r.ledger).toContain('never');
    expect(r.ledger).toContain('trusted');
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

  it('pre-existing floor debt discloses without blocking', async () => {
    // entry AND post-agent both red with the SAME check → pre-existing
    const r = await runRemediateTask(base(fakeDriver({}), { runFloor: () => RED_FLOOR }));
    expect(r.outcome).toBe('verified');
    expect(r.ledger).toContain('Pre-existing floor debt');
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

  it('a driver that cannot enforce a cap yields a DISCLOSED limitation, never silence', async () => {
    const driver = fakeDriver({ costUsd: 99 }, { budgetSupport: { turns: false, cost: false } });
    const r = await runRemediateTask(base(driver));
    // cost unsupported → the runner does NOT enforce maxUsd from a number the
    // driver cannot vouch for; both limitations are disclosed in the envelope
    expect(r.outcome).toBe('verified');
    expect(r.envelope!.unenforceableCaps.join(' ')).toContain('maxTurns');
    expect(r.envelope!.unenforceableCaps.join(' ')).toContain('maxUsd');
    expect(r.ledger).toContain('disclosed limitation');
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
      expect(c.salvage).toBe('discard');
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
