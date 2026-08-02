/**
 * The `remediate` policy block, normalized (policy design §5). Conservative
 * by construction:
 *
 *   - `budget` is required-with-defaults: an enabled block with no budget
 *     gets the conservative caps below, echoed in the ledger — never an
 *     unbounded run (the stranded-spend scar);
 *   - `salvage` defaults to `discard`: a partial diff from a budget-killed
 *     run is dropped unless the repo opts into draft PRs;
 *   - unknown task ids are RETAINED in `unknownTasks` (disclosed by the
 *     caller, never silently dropped — a typo must not read as "nothing to
 *     do");
 *   - credentials are never read from policy (policy is committed); the
 *     workflow injects them from repo secrets.
 */
import { readPolicySection } from '../baseline/policy-text';
import { knownTaskIds, type RemediateTaskId } from './tasks';

export interface RemediateBudget {
  readonly maxTurns: number;
  readonly maxMinutes: number;
  readonly maxUsd: number;
}

export const DEFAULT_REMEDIATE_BUDGET: RemediateBudget = {
  maxTurns: 80,
  maxMinutes: 30,
  maxUsd: 5,
};

export interface RemediateConfig {
  readonly enabled: boolean;
  readonly tasks: readonly RemediateTaskId[];
  /** Task ids in policy that match no registered task — disclosed upstream. */
  readonly unknownTasks: readonly string[];
  /** Cadence for the managed workflow (the cadence-knob grammar). */
  readonly schedule: string;
  readonly salvage: 'discard' | 'draft-pr';
  readonly agent: {
    readonly driver: string;
    /** 'auto' | a tier name | a driver-native id (resolved per task). */
    readonly model: string;
    readonly budget: RemediateBudget;
  };
  /** Per-task budget overrides (`remediate.taskBudgets.<id>`), merged over
   *  `agent.budget` by `budgetForTask`. Lets a repo give fix-build more
   *  headroom than fix-lint without raising every task's cap. */
  readonly taskBudgets: Readonly<Partial<Record<RemediateTaskId, Partial<RemediateBudget>>>>;
  /** Run-level USD ceiling (`remediate.maxSpendPerRun`, 0 = no ceiling): the
   *  org guard for the per-task matrix, where a failing task no longer
   *  starves its siblings and every enabled task may spend its own cap in
   *  one firing. Tasks beyond the ceiling are DEFERRED (disclosed), in
   *  declaration order — never silently dropped. */
  readonly maxSpendPerRun: number;
}

/** The effective budget for one task: the per-task override merged over the
 *  shared agent budget — the ONE derivation every surface (runner, plan,
 *  matrix trim) reads. */
export function budgetForTask(config: RemediateConfig, taskId: RemediateTaskId): RemediateBudget {
  const override = config.taskBudgets[taskId] ?? {};
  return {
    maxTurns: positiveNumber(override.maxTurns, config.agent.budget.maxTurns),
    maxMinutes: positiveNumber(override.maxMinutes, config.agent.budget.maxMinutes),
    maxUsd: positiveNumber(override.maxUsd, config.agent.budget.maxUsd),
  };
}

/** Apply the run-level spend ceiling: tasks whose cumulative per-task maxUsd
 *  fits run now; the rest are deferred to the next firing (deterministic —
 *  declaration order). No ceiling → everything runs. */
export function tasksWithinSpendCeiling(config: RemediateConfig): {
  readonly run: readonly RemediateTaskId[];
  readonly deferred: readonly RemediateTaskId[];
} {
  if (config.maxSpendPerRun <= 0) return { run: config.tasks, deferred: [] };
  const run: RemediateTaskId[] = [];
  const deferred: RemediateTaskId[] = [];
  let spend = 0;
  for (const taskId of config.tasks) {
    const usd = budgetForTask(config, taskId).maxUsd;
    if (spend + usd <= config.maxSpendPerRun) {
      spend += usd;
      run.push(taskId);
    } else {
      deferred.push(taskId);
    }
  }
  return { run, deferred };
}

function positiveNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Normalize the raw `remediate` policy section. Absent section → disabled. */
export function resolveRemediateConfig(cwd: string): RemediateConfig {
  const raw = readPolicySection(cwd, 'remediate') ?? {};
  const agent = (raw.agent ?? {}) as Record<string, unknown>;
  const budget = (agent.budget ?? {}) as Record<string, unknown>;

  const known = new Set(knownTaskIds());
  const rawTasks = Array.isArray(raw.tasks)
    ? raw.tasks.filter((t): t is string => typeof t === 'string')
    : [];
  const tasks = rawTasks.filter((t): t is RemediateTaskId => known.has(t));
  const unknownTasks = rawTasks.filter((t) => !known.has(t));

  const rawTaskBudgets = (raw.taskBudgets ?? {}) as Record<string, unknown>;
  const taskBudgets: Partial<Record<RemediateTaskId, Partial<RemediateBudget>>> = {};
  for (const [id, value] of Object.entries(rawTaskBudgets)) {
    if (!known.has(id) || typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    const override: Partial<RemediateBudget> = {
      ...(typeof v.maxTurns === 'number' && v.maxTurns > 0 ? { maxTurns: v.maxTurns } : {}),
      ...(typeof v.maxMinutes === 'number' && v.maxMinutes > 0 ? { maxMinutes: v.maxMinutes } : {}),
      ...(typeof v.maxUsd === 'number' && v.maxUsd > 0 ? { maxUsd: v.maxUsd } : {}),
    };
    if (Object.keys(override).length > 0) taskBudgets[id as RemediateTaskId] = override;
  }

  return {
    enabled: raw.enabled === true,
    tasks: tasks.length > 0 ? tasks : (['fix-vulns'] as const),
    unknownTasks,
    schedule: typeof raw.schedule === 'string' && raw.schedule.trim() ? raw.schedule : 'weekly',
    salvage: raw.salvage === 'draft-pr' ? 'draft-pr' : 'discard',
    agent: {
      driver:
        typeof agent.driver === 'string' && agent.driver.trim() ? agent.driver : 'claude-code',
      model: typeof agent.model === 'string' && agent.model.trim() ? agent.model : 'auto',
      budget: {
        maxTurns: positiveNumber(budget.maxTurns, DEFAULT_REMEDIATE_BUDGET.maxTurns),
        maxMinutes: positiveNumber(budget.maxMinutes, DEFAULT_REMEDIATE_BUDGET.maxMinutes),
        maxUsd: positiveNumber(budget.maxUsd, DEFAULT_REMEDIATE_BUDGET.maxUsd),
      },
    },
    taskBudgets,
    maxSpendPerRun:
      typeof raw.maxSpendPerRun === 'number' &&
      Number.isFinite(raw.maxSpendPerRun) &&
      raw.maxSpendPerRun > 0
        ? raw.maxSpendPerRun
        : 0,
  };
}
