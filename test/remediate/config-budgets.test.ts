/**
 * WP5 config surface: per-task budget overrides + the run-level spend
 * ceiling (the org guard for the per-task matrix, where a failing task no
 * longer starves siblings and every task may spend its own cap).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  budgetForTask,
  resolveRemediateConfig,
  tasksWithinSpendCeiling,
  DEFAULT_REMEDIATE_BUDGET,
  type RemediateConfig,
} from '../../src/remediate/config';

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
});
