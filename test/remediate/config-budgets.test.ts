/**
 * WP5 config surface: per-task budget overrides + the run-level spend
 * ceiling (the org guard for the per-task matrix, where a failing task no
 * longer starves siblings and every task may spend its own cap).
 */
import { customDispatchTask, REMEDIATE_TASKS } from '../../src/remediate/tasks';
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  budgetForTask,
  resolveRemediateConfig,
  salvageForTask,
  tasksWithinSpendCeiling,
  DEFAULT_REMEDIATE_BUDGET,
  type RemediateConfig,
} from '../../src/remediate/config';
import {
  APP_TOKEN_SAFE_MINUTES,
  clampBudgetToTokenLifetime,
} from '../../src/remediate/budget-notes';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function repoWithPolicy(remediate: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-remcfg-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.dxkit'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dxkit', 'policy.json'), JSON.stringify({ remediate }));
  return dir;
}

function cfg(partial: Partial<RemediateConfig>): RemediateConfig {
  return {
    enabled: true,
    tasks: ['fix-build', 'fix-vulns', 'write-docs'],
    unknownTasks: [],
    schedule: 'weekly',
    salvage: 'discard',
    agent: { driver: 'claude-code', model: 'auto', budget: DEFAULT_REMEDIATE_BUDGET },
    taskBudgets: {},
    maxSpendPerRun: 0,
    maxDispatchBudget: 0,
    maxOrdersPerRun: 0,
    resume: false,
    workOrders: { maxSliceSize: 25 },
    recipes: { enabled: true },
    ...partial,
  };
}

describe('budgetForTask', () => {
  it('merges the per-task override over the shared budget, field by field', () => {
    const config = cfg({ taskBudgets: { 'fix-build': { maxUsd: 12, maxMinutes: 60 } } });
    expect(budgetForTask(config, 'fix-build')).toEqual({
      maxTurns: DEFAULT_REMEDIATE_BUDGET.maxTurns,
      maxMinutes: 60,
      maxUsd: 12,
    });
    // A task with no override gets the shared budget untouched.
    expect(budgetForTask(config, 'fix-vulns')).toEqual(DEFAULT_REMEDIATE_BUDGET);
  });

  it('accepts a raw id string: custom (outside the registry) gets the shared budget', () => {
    // The executor holds only the id string — it must not branch on "is this
    // a registry task" to pick a budget (#274's sibling derivation).
    expect(budgetForTask(cfg({}), 'custom')).toEqual(DEFAULT_REMEDIATE_BUDGET);
    expect(budgetForTask(cfg({}), 'no-such-task')).toEqual(DEFAULT_REMEDIATE_BUDGET);
  });
});

describe('tasksWithinSpendCeiling', () => {
  it('no ceiling → every enabled task runs', () => {
    const { run, deferred } = tasksWithinSpendCeiling(cfg({}));
    expect(run).toEqual(['fix-build', 'fix-vulns', 'write-docs']);
    expect(deferred).toEqual([]);
  });

  it('defers tasks beyond the ceiling in declaration order, never dropping them', () => {
    // Default maxUsd is 5 per task; a $12 ceiling fits two.
    const { run, deferred } = tasksWithinSpendCeiling(cfg({ maxSpendPerRun: 12 }));
    expect(run).toEqual(['fix-build', 'fix-vulns']);
    expect(deferred).toEqual(['write-docs']);
  });

  it('per-task overrides count at their overridden cost', () => {
    const config = cfg({
      maxSpendPerRun: 12,
      taskBudgets: { 'fix-build': { maxUsd: 10 } },
    });
    const { run, deferred } = tasksWithinSpendCeiling(config);
    // fix-build (10) fits; fix-vulns (5) would exceed 12 → deferred, and the
    // walk stays in order (no knapsack cleverness — determinism wins).
    expect(run).toEqual(['fix-build']);
    expect(deferred).toEqual(['fix-vulns', 'write-docs']);
  });
});

describe('resolveRemediateConfig parsing', () => {
  it('reads taskBudgets + maxSpendPerRun; ignores unknown tasks and junk values', () => {
    const dir = repoWithPolicy({
      enabled: true,
      tasks: ['fix-build', 'fix-vulns'],
      maxSpendPerRun: 15,
      taskBudgets: {
        'fix-build': { maxUsd: 10, maxTurns: -3 },
        'no-such-task': { maxUsd: 99 },
        'fix-vulns': 'not-an-object',
      },
    });
    const config = resolveRemediateConfig(dir);
    expect(config.maxSpendPerRun).toBe(15);
    expect(config.taskBudgets).toEqual({ 'fix-build': { maxUsd: 10 } });
    expect(budgetForTask(config, 'fix-build').maxUsd).toBe(10);
    expect(budgetForTask(config, 'fix-build').maxTurns).toBe(DEFAULT_REMEDIATE_BUDGET.maxTurns);
  });

  it('absent knobs keep the pre-WP5 shape (no ceiling, no overrides)', () => {
    const dir = repoWithPolicy({ enabled: true });
    const config = resolveRemediateConfig(dir);
    expect(config.maxSpendPerRun).toBe(0);
    expect(config.taskBudgets).toEqual({});
  });

  it('maxOrdersPerRun defaults to 3, accepts 0 (dispatch off), rejects junk', () => {
    expect(resolveRemediateConfig(repoWithPolicy({ enabled: true })).maxOrdersPerRun).toBe(3);
    expect(
      resolveRemediateConfig(repoWithPolicy({ enabled: true, maxOrdersPerRun: 0 })).maxOrdersPerRun,
    ).toBe(0);
    expect(
      resolveRemediateConfig(repoWithPolicy({ enabled: true, maxOrdersPerRun: 5 })).maxOrdersPerRun,
    ).toBe(5);
    for (const junk of [-1, 1.5, 'many', null]) {
      expect(
        resolveRemediateConfig(repoWithPolicy({ enabled: true, maxOrdersPerRun: junk }))
          .maxOrdersPerRun,
      ).toBe(3);
    }
  });
});

describe('salvageForTask — the one salvage resolver (task-shape defaults)', () => {
  const auto = { salvage: 'auto' as const };

  it('auto follows the task completion shape: open-ended draft-pr, bounded discard', () => {
    // Open-ended tasks never finish (no completion test) — discard would
    // structurally throw away their verified work every run (observed live:
    // 454 verified doc lines, guardrail PASSED, discarded).
    expect(salvageForTask(auto, 'write-docs')).toBe('draft-pr');
    expect(salvageForTask(auto, 'improve-tests')).toBe('draft-pr');
    expect(salvageForTask(auto, 'custom')).toBe('draft-pr');
    expect(salvageForTask(auto, 'fix-build')).toBe('discard');
    expect(salvageForTask(auto, 'fix-vulns')).toBe('discard');
    expect(salvageForTask(auto, 'fix-lint')).toBe('discard');
  });

  it('an explicit policy value overrides every task', () => {
    expect(salvageForTask({ salvage: 'discard' }, 'write-docs')).toBe('discard');
    expect(salvageForTask({ salvage: 'draft-pr' }, 'fix-build')).toBe('draft-pr');
  });

  it('custom honors explicit policy and auto — never a structural discard (#274)', () => {
    // The live class: a registry-lookup guard in the CLI executor forced
    // 'discard' for custom, overriding BOTH an explicit draft-pr policy and
    // 'auto' — a verified, guardrail-PASSED docs run was thrown away.
    expect(salvageForTask({ salvage: 'draft-pr' }, 'custom')).toBe('draft-pr');
    expect(salvageForTask(auto, 'custom')).toBe('draft-pr');
    expect(salvageForTask({ salvage: 'discard' }, 'custom')).toBe('discard');
  });

  it('PARITY: the id-string arm and the resolved-task arm agree for every task', () => {
    // The CLI executor passes the raw id string; the runner passes the
    // resolved task object. Both hit this one resolver — this pins that the
    // two call shapes cannot diverge (the Rule 2.30 net for #274).
    const policies = [
      { salvage: 'auto' },
      { salvage: 'draft-pr' },
      { salvage: 'discard' },
    ] as const;
    for (const policy of policies) {
      for (const t of REMEDIATE_TASKS) {
        expect(salvageForTask(policy, t.id)).toBe(salvageForTask(policy, t));
      }
      expect(salvageForTask(policy, 'custom')).toBe(
        salvageForTask(policy, customDispatchTask('any prompt')),
      );
    }
  });

  it('an unknown id string (typo — the runner will refuse it) reads bounded → discard', () => {
    expect(salvageForTask(auto, 'no-such-task')).toBe('discard');
  });

  it('every registered task declares its completion shape', () => {
    for (const t of REMEDIATE_TASKS) {
      expect(['bounded', 'open-ended']).toContain(t.completion);
    }
    // Fast-exit tasks are bounded by construction: skipWhenEntryFloorGreen
    // IS a completion test.
    for (const t of REMEDIATE_TASKS) {
      if (t.skipWhenEntryFloorGreen) expect(t.completion).toBe('bounded');
    }
  });
});

describe('clampBudgetToTokenLifetime (the App-token 1h hard cap)', () => {
  const base = { maxTurns: 80, maxMinutes: 90, maxUsd: 5 };

  it('clamps the wall clock on the app tier and discloses the remedy', () => {
    const { budget, notes } = clampBudgetToTokenLifetime(base, { DXKIT_TOKEN_MODE: 'app' });
    expect(budget.maxMinutes).toBe(APP_TOKEN_SAFE_MINUTES);
    // Only the wall clock moves — turns and spend are untouched.
    expect(budget.maxTurns).toBe(base.maxTurns);
    expect(budget.maxUsd).toBe(base.maxUsd);
    expect(notes).toHaveLength(1);
    // The disclosure names the cause and BOTH remedies (never silent).
    expect(notes[0]).toContain('one hour');
    expect(notes[0]).toContain('DXKIT_BOT_TOKEN');
  });

  it('a budget already inside the lifetime is untouched, no note', () => {
    const small = { ...base, maxMinutes: 30 };
    const { budget, notes } = clampBudgetToTokenLifetime(small, { DXKIT_TOKEN_MODE: 'app' });
    expect(budget).toEqual(small);
    expect(notes).toEqual([]);
  });

  it('long-lived tiers (pat, workflow) and local runs (env absent) are never clamped', () => {
    for (const env of [{ DXKIT_TOKEN_MODE: 'pat' }, { DXKIT_TOKEN_MODE: 'workflow' }, {}]) {
      const { budget, notes } = clampBudgetToTokenLifetime(base, env);
      expect(budget).toEqual(base);
      expect(notes).toEqual([]);
    }
  });
});
