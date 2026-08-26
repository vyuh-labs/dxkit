import { describe, it, expect } from 'vitest';
import {
  MODEL_TIERS,
  resolveModelSetting,
  type AgentDriver,
  type ModelTier,
} from '../../src/remediate/driver';
import {
  makeClaudeCodeDriver,
  realAgentExec,
  type AgentExec,
} from '../../src/remediate/claude-code-driver';
import { AGENT_DRIVERS, driverById, knownDriverIds } from '../../src/remediate/registry';
import {
  customDispatchTask,
  REMEDIATE_TASKS,
  remediateTaskById,
  SHARED_RULES,
} from '../../src/remediate/tasks';

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
      // Three-valued capability per dimension — 'reported' is not 'enforced'
      // (conflating them shipped a $14.71 spend against a $5 cap).
      expect(['enforced', 'reported', 'none']).toContain(driver.budgetSupport.turns);
      expect(['enforced', 'reported', 'none']).toContain(driver.budgetSupport.cost);
      expect(Array.isArray(driver.credentialEnv)).toBe(true);
      // The executor declaration: an exact pinned version (an unattended
      // lane never floats its CLI) or an explicit null — never absent.
      expect(driver.cli === null || /^\d+\.\d+\.\d+$/.test(driver.cli.version)).toBe(true);
    });
  }

  it('claude-code pins its installable CLI (the workflow renders from this)', () => {
    const cli = driverById('claude-code')!.cli;
    expect(cli?.package).toBe('@anthropic-ai/claude-code');
    expect(cli?.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('claude-code declares cost as REPORTED, never enforced (the honest cap)', () => {
    // The CLI cannot stop mid-run on spend; declaring cost 'enforced' here
    // is the $14.71-against-$5 class. Flipping this to 'enforced' requires
    // an actual mid-run enforcement mechanism in the driver.
    expect(driverById('claude-code')!.budgetSupport).toEqual({
      turns: 'enforced',
      cost: 'reported',
    });
  });
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
  it('declares the task set, each with a tier + rationale + verify signal', () => {
    expect(REMEDIATE_TASKS.map((t) => t.id).sort()).toEqual([
      'fix-build',
      'fix-lint',
      'fix-vulns',
      'improve-tests',
      'write-docs',
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

  it('every prompt bans .github/ writes — registry tasks AND the custom dispatch task', () => {
    // Validated live twice, in both directions: a write-docs agent wrote
    // .github/ templates and the landing push was refused by a path ruleset
    // (all work lost pre-#273); a custom run with an in-prompt ban complied
    // fully and verified end-to-end. Prompt-level constraint is the
    // mitigation with an evidence base — the learned restricted-paths layer
    // is the 4.3.8 root treatment.
    for (const t of REMEDIATE_TASKS) {
      expect(t.prompt).toContain('.github/');
      expect(t.prompt).toContain('Never create or edit ANYTHING under');
    }
    expect(customDispatchTask('write some docs').prompt).toContain(
      'Never create or edit ANYTHING under',
    );
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

  it('renders tool narrowing as variadic --disallowedTools / --allowedTools argv entries', async () => {
    const capture: { args?: readonly string[] } = {};
    const d = runWith({ stdout: '{"num_turns": 2}' }, capture);
    await d.run({
      cwd: '/tmp',
      prompt: 'p',
      budget,
      model: 'sonnet',
      env: {},
      tools: { disallowed: ['Bash(npm install:*)', 'Bash(pnpm add:*)'], allowed: ['Bash'] },
    });
    const args = [...(capture.args ?? [])];
    const denyIdx = args.indexOf('--disallowedTools');
    expect(denyIdx).toBeGreaterThan(-1);
    expect(args.slice(denyIdx + 1, denyIdx + 3)).toEqual([
      'Bash(npm install:*)',
      'Bash(pnpm add:*)',
    ]);
    const allowIdx = args.indexOf('--allowedTools');
    expect(args[allowIdx + 1]).toBe('Bash');
    // Deny rules coexist with the skip-permissions flag (documented against
    // the pinned CLI on the driver's toolPolicy declaration).
    expect(args).toContain('--dangerously-skip-permissions');
    expect(d.toolPolicy?.mechanism).toBe('disallowed-tools');
    expect(d.toolPolicy?.cliRequirement).toContain('2.1.222');
  });

  it('omits the tool flags entirely when no tools option is given (legacy path unchanged)', async () => {
    const capture: { args?: readonly string[] } = {};
    const d = runWith({ stdout: '{"num_turns": 2}' }, capture);
    await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(capture.args).not.toContain('--disallowedTools');
    expect(capture.args).not.toContain('--allowedTools');
  });

  it('strips ambient credentials unless explicitly injected, and arms the Stop-gate', async () => {
    const capture: { env?: Record<string, string | undefined> } = {};
    // Bracketed placeholder form: the fixture value carries no semantic weight
    // (the assertions are absence and pass-through), and a key-shaped literal
    // in a committed test is a secret finding under our own scanner.
    process.env.ANTHROPIC_API_KEY = '<ambient-key-must-not-leak>';
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
        env: { ANTHROPIC_API_KEY: '<explicit-ci-key>' },
      });
      expect(capture.env!.ANTHROPIC_API_KEY).toBe('<explicit-ci-key>');
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

  it('falls back to modelUsage keys for the concrete model id (the first production run reported neither modelId nor model)', async () => {
    const d = runWith({
      stdout: JSON.stringify({
        total_cost_usd: 2.72,
        num_turns: 80,
        is_error: false,
        modelUsage: { 'claude-sonnet-4-6': { inputTokens: 1 } },
      }),
    });
    const r = await d.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(r.resolvedModelId).toBe('claude-sonnet-4-6');
    // A multi-model run discloses all ids, never silently picks one.
    const d2 = runWith({
      stdout: JSON.stringify({
        is_error: false,
        modelUsage: { 'model-a': {}, 'model-b': {} },
      }),
    });
    const r2 = await d2.run({ cwd: '/tmp', prompt: 'p', budget, model: 'sonnet', env: {} });
    expect(r2.resolvedModelId).toBe('model-a + model-b');
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

describe('realAgentExec — deadline-first timeout classification (#272)', () => {
  // Real child processes, deliberately: the classification lives in the REAL
  // exec (the injected-exec tests above bypass it by design), and the two
  // SIGTERM encodings can only be produced by an actual kill.

  it('signal-death: a child killed by the timeout SIGTERM is timedOut', () => {
    const r = realAgentExec('sleep', ['2'], { cwd: '/tmp', env: {}, timeoutMs: 250 });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBeNull();
  });

  it('graceful-catch: a child that traps SIGTERM and exits 143 is timedOut, never never-ran-shaped', () => {
    // The claude CLI (2.1.222) traps SIGTERM and exits 143 with no result
    // JSON — signal null, status 143. The signal-only predicate read this as
    // a plain failed exit, which fell into the never-ran branch downstream
    // and discarded the stranded work. The background+wait shape matters:
    // bash defers traps until the foreground command exits, and the orphaned
    // sleep must not hold our pipes open.
    const r = realAgentExec(
      'bash',
      ['-c', 'trap "exit 143" TERM; sleep 2 >/dev/null 2>&1 & wait'],
      { cwd: '/tmp', env: {}, timeoutMs: 250 },
    );
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(143);
  });

  it('a natural failure exit before the deadline is NEVER a timeout (false-negative bias)', () => {
    const r = realAgentExec('bash', ['-c', 'exit 7'], { cwd: '/tmp', env: {}, timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(7);
  });

  it('a clean exit is a clean exit', () => {
    const r = realAgentExec('bash', ['-c', 'echo ok'], { cwd: '/tmp', env: {}, timeoutMs: 5000 });
    expect(r).toMatchObject({ code: 0, timedOut: false });
    expect(r.stdout).toContain('ok');
  });
});
