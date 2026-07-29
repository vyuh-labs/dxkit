import { describe, it, expect } from 'vitest';
import {
  MODEL_TIERS,
  resolveModelSetting,
  type AgentDriver,
  type ModelTier,
} from '../../src/remediate/driver';
import { makeClaudeCodeDriver, type AgentExec } from '../../src/remediate/claude-code-driver';
import { AGENT_DRIVERS, driverById, knownDriverIds } from '../../src/remediate/registry';
import { REMEDIATE_TASKS, remediateTaskById, SHARED_RULES } from '../../src/remediate/tasks';

/**
 * The driver seam is the "other agents later" promise: these tests pin the
 * contract every registered driver must satisfy (tier totality, budget
 * declaration, credential declaration), the three-shape model resolution the
 * policy exposes, the task registry's tier column (nothing auto-selects
 * deep), and the claude-code driver's ported scars — ambient-credential
 * stripping, never-ran detection, wall-clock salvage — via an injected exec,
 * no real claude binary anywhere.
 */

describe('driver registry contract', () => {
  it('ids are unique and resolvable', () => {
    const ids = AGENT_DRIVERS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(driverById(id)?.id).toBe(id);
    expect(driverById('nope')).toBeUndefined();
    expect(knownDriverIds()).toContain('claude-code');
  });

  for (const driver of AGENT_DRIVERS) {
    it(`'${driver.id}' resolves every tier and declares budget + credentials`, () => {
      for (const tier of MODEL_TIERS) {
        const native = driver.resolveModel(tier);
        expect(typeof native).toBe('string');
        expect(native.length).toBeGreaterThan(0);
        // rolling aliases, never dated snapshot ids (the deprecation rule)
        expect(native).not.toMatch(/\d{8}/);
      }
      expect(typeof driver.budgetSupport.turns).toBe('boolean');
      expect(typeof driver.budgetSupport.cost).toBe('boolean');
      expect(Array.isArray(driver.credentialEnv)).toBe(true);
    });
  }
});

describe('resolveModelSetting (the three accepted shapes)', () => {
  const driver = makeClaudeCodeDriver();

  it('auto (and blank/undefined) resolves the task tier through the driver', () => {
    for (const setting of ['auto', undefined, '  ']) {
      const r = resolveModelSetting(driver, setting, 'light');
      expect(r).toMatchObject({ native: 'haiku', source: 'auto-tier', tier: 'light' });
    }
  });

  it('a tier name pins all tasks to that tier (driver-portable)', () => {
    const r = resolveModelSetting(driver, 'deep', 'light');
    expect(r).toMatchObject({ native: 'opus', source: 'pinned-tier', tier: 'deep' });
    expect(r.warning).toBeUndefined();
  });

  it('a known native alias passes through without a warning', () => {
    const r = resolveModelSetting(driver, 'sonnet', 'light');
    // 'sonnet' is not a tier name, but IS a known native alias
    expect(r).toMatchObject({ native: 'sonnet', source: 'pinned-native' });
    expect(r.warning).toBeUndefined();
  });

  it('an unknown native id warns and passes through (never a hard refusal)', () => {
    const r = resolveModelSetting(driver, 'claude-next-6', 'standard');
    expect(r.native).toBe('claude-next-6');
    expect(r.source).toBe('pinned-native');
    expect(r.warning).toContain('claude-next-6');
    expect(r.warning).toContain('agent-never-ran');
  });
});

describe('task registry', () => {
  it('declares four v1 tasks, each with a tier + rationale + verify signal', () => {
    expect(REMEDIATE_TASKS.map((t) => t.id).sort()).toEqual([
      'fix-build',
      'fix-lint',
      'fix-vulns',
      'improve-tests',
    ]);
    for (const t of REMEDIATE_TASKS) {
      expect(MODEL_TIERS).toContain(t.tier);
      expect(t.tierWhy.length).toBeGreaterThan(10);
      expect(['floor', 'guardrail']).toContain(t.verify);
    }
  });

  it('nothing auto-selects deep — that spend decision is the repo pin', () => {
    for (const t of REMEDIATE_TASKS) expect(t.tier).not.toBe('deep');
  });

  it('every prompt carries the ground rules, including the baseline-refresh ban', () => {
    for (const t of REMEDIATE_TASKS) {
      expect(t.prompt).toContain('Ground rules (non-negotiable)');
      expect(t.prompt).toContain('NEVER run `vyuh-dxkit baseline create`');
    }
    expect(SHARED_RULES).toContain('docs/DXKIT-REMEDIATION-NOTES.md');
    expect(remediateTaskById('fix-lint')?.tier).toBe('light');
    expect(remediateTaskById('unknown-task')).toBeUndefined();
  });
});

describe('claude-code driver (exec injected)', () => {
  function runWith(
    outcome: Partial<ReturnType<AgentExec>>,
    capture?: { env?: Record<string, string | undefined>; args?: readonly string[] },
  ): AgentDriver {
    const exec: AgentExec = (bin, args, opts) => {
      expect(bin).toBe('claude');
      if (capture) {
        capture.env = { ...opts.env };
        capture.args = args;
      }
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...outcome };
    };
    return makeClaudeCodeDriver(exec);
  }

  const budget = { maxTurns: 40, maxMinutes: 20 };

  it('maps tiers to rolling CLI aliases', () => {
    const d = makeClaudeCodeDriver();
    expect((['light', 'standard', 'deep'] as ModelTier[]).map((t) => d.resolveModel(t))).toEqual([
      'haiku',
      'sonnet',
      'opus',
    ]);
  });

  it('strips ambient credentials unless explicitly injected, and arms the Stop-gate', async () => {
    const capture: { env?: Record<string, string | undefined> } = {};
    process.env.ANTHROPIC_API_KEY = 'ambient-key-must-not-leak';
    try {
      const d = runWith({ stdout: '{"num_turns": 2}' }, capture);
      await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
      expect(capture.env!.ANTHROPIC_API_KEY).toBeUndefined();
      expect(capture.env!.DXKIT_LOOP_ACTIVE).toBe('1');

      await d.run({
        cwd: '/tmp',
        prompt: 'p',
        budget,
        model: 'sonnet',
        env: { ANTHROPIC_API_KEY: 'explicit-ci-key' },
      });
      expect(capture.env!.ANTHROPIC_API_KEY).toBe('explicit-ci-key');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('passes budget + model through the CLI argv', async () => {
    const capture: { args?: readonly string[] } = {};
    const d = runWith({ stdout: '{}' }, capture);
    await d.run({ cwd: '/tmp', prompt: 'the task', budget, model: 'opus', env: {} });
    const args = capture.args!;
    expect(args).toContain('--max-turns');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('40');
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('-p') + 1]).toBe('the task');
  });

  it('parses the spend envelope from the JSON result', async () => {
    const d = runWith({
      stdout: JSON.stringify({
        total_cost_usd: 1.23,
        num_turns: 17,
        is_error: false,
        modelId: 'claude-sonnet-5',
      }),
    });
    const r = await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(r).toMatchObject({
      completed: true,
      turns: 17,
      costUsd: 1.23,
      resolvedModelId: 'claude-sonnet-5',
      timedOut: false,
    });
  });

  it('reports a wall-clock kill as timedOut (salvage territory, not failure)', async () => {
    const d = runWith({ code: null, timedOut: true, stderr: 'killed' });
    const r = await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(r.timedOut).toBe(true);
    expect(r.completed).toBe(false);
    expect(r.neverRan).toBeUndefined();
  });

  it('detects agent-never-ran: non-zero exit with zero turns names the cause', async () => {
    const d = runWith({ code: 1, stdout: '', stderr: 'Invalid API key' });
    const r = await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(r.neverRan?.reason).toContain('claude exit 1');
    expect(r.neverRan?.reason).toContain('Invalid API key');
  });

  it('a non-zero exit AFTER real turns is a failed run, not never-ran', async () => {
    const d = runWith({ code: 1, stdout: '{"num_turns": 9}' });
    const r = await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(r.neverRan).toBeUndefined();
    expect(r.completed).toBe(false);
    expect(r.turns).toBe(9);
  });
});
