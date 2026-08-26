/**
 * The `remediate` policy block, normalized (policy design §5). Conservative
 * by construction:
 *
 *   - `budget` is required-with-defaults: an enabled block with no budget
 *     gets the conservative caps below, echoed in the ledger — never an
 *     unbounded run (the stranded-spend scar);
 *   - `salvage` defaults to `auto`: the decision follows each task's
 *     declared completion shape (open-ended → draft-pr, bounded → discard;
 *     see `salvageForTask`) unless policy pins one value for every task;
 *   - unknown task ids are RETAINED in `unknownTasks` (disclosed by the
 *     caller, never silently dropped — a typo must not read as "nothing to
 *     do");
 *   - credentials are never read from policy (policy is committed); the
 *     workflow injects them from repo secrets.
 */
import { readPolicySection } from '../baseline/policy-text';
import { knownTaskIds, remediateTaskById, type RemediateTask, type RemediateTaskId } from './tasks';
import { DEFAULT_MAX_SLICE_SIZE } from './work-orders/shared';

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

/** Default `remediate.maxOrdersPerRun`. */
export const DEFAULT_MAX_ORDERS_PER_RUN = 3;

export interface RemediateConfig {
  readonly enabled: boolean;
  readonly tasks: readonly RemediateTaskId[];
  /** Task ids in policy that match no registered task — disclosed upstream. */
  readonly unknownTasks: readonly string[];
  /** Cadence for the managed workflow (the cadence-knob grammar). */
  readonly schedule: string;
  /**
   * The salvage POSTURE as configured. `'auto'` (the default when policy
   * says nothing) resolves PER TASK from its declared completion shape —
   * see `salvageForTask`. An explicit `'discard'` / `'draft-pr'` overrides
   * every task. Consumers of a concrete decision go through
   * `salvageForTask`, never this raw field.
   */
  readonly salvage: 'discard' | 'draft-pr' | 'auto';
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
  /** Dispatch-campaign USD ceiling (`remediate.maxDispatchBudget`, 0 =
   *  undeclared): the most a workflow_dispatch override may raise `maxUsd`
   *  to. Undeclared ⇒ dispatch can lower spend but never raise it beyond
   *  the policy cap — spend authority grows only in committed policy,
   *  never in a dispatch form field. */
  readonly maxDispatchBudget: number;
  /** Opt-in resume (`remediate.resume`, default false): when a prior
   *  budget-bounded attempt landed as a draft PR (salvage: draft-pr), the
   *  next run CONTINUES from its branch instead of starting over — the
   *  entry floor still snapshots the pristine default tree, so a broken
   *  partial can never grandfather its own breakage. Hard cap of
   *  MAX_RESUME_ATTEMPTS per branch (resume.ts). */
  readonly resume: boolean;
  /** Most agent-tier work orders one run dispatches, ONE ORDER PER AGENT
   *  RUN, highest value first (`remediate.maxOrdersPerRun`, default 3;
   *  0 turns order-driven dispatch off and restores the single open-ended
   *  task prompt). Orders beyond the cap are disclosed, never silently
   *  dropped. */
  readonly maxOrdersPerRun: number;
  /** Work-order planning knobs (`remediate.workOrders`). */
  readonly workOrders: {
    /** Largest number of findings one debt slice may carry
     *  (`remediate.workOrders.maxSliceSize`, default 25). */
    readonly maxSliceSize: number;
  };
  /** The deterministic recipe tier (`remediate.recipes`). */
  readonly recipes: {
    /** Run recipe-tier work orders inside the frame before any agent spawns
     *  (`remediate.recipes.enabled`, default true: a $0 deterministic fix
     *  beats an agent run; set false to route every order to the agent). */
    readonly enabled: boolean;
  };
}

/**
 * The effective salvage decision for ONE task — the single resolver every
 * consumer reads (the CLI's land eligibility, the runner's disposition
 * note, resume eligibility). An explicit policy setting wins; `'auto'`
 * follows the task's declared completion shape: open-ended tasks (docs,
 * tests — no completion test, every outcome is budget-bounded) default to
 * `draft-pr` so their verified work is never structurally discarded;
 * bounded tasks keep the conservative `discard`.
 */
export function salvageForTask(
  config: Pick<RemediateConfig, 'salvage'>,
  // Accepts the resolved task OR its raw id string. The string arm exists so
  // callers that hold only an id (the CLI executor, where 'custom' is
  // deliberately outside the registry) route through THIS resolver instead of
  // re-deriving from a registry lookup — the lookup-returns-undefined path is
  // exactly how the executor's second derivation forced 'discard' on a
  // verified custom run (#274). An id that resolves to nothing and is not
  // 'custom' reads as bounded → discard (conservative).
  task: Pick<RemediateTask, 'completion'> | string,
): 'discard' | 'draft-pr' {
  if (config.salvage !== 'auto') return config.salvage;
  const shape =
    typeof task === 'string'
      ? // 'custom' lives outside the registry (dispatch-only) and has no
        // completion test — open-ended by construction.
        (remediateTaskById(task)?.completion ?? (task === 'custom' ? 'open-ended' : 'bounded'))
      : task.completion;
  return shape === 'open-ended' ? 'draft-pr' : 'discard';
}

/** The effective budget for one task: the per-task override merged over the
 *  shared agent budget — the ONE derivation every surface (runner, plan,
 *  matrix trim) reads. Accepts a raw id string so the executor never branches
 *  on "is this a registry task" to pick a budget: an id with no override slot
 *  ('custom', or a typo the runner will refuse anyway) gets the shared agent
 *  budget. */
export function budgetForTask(config: RemediateConfig, taskId: string): RemediateBudget {
  const override = config.taskBudgets[taskId as RemediateTaskId] ?? {};
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
    salvage:
      raw.salvage === 'draft-pr' ? 'draft-pr' : raw.salvage === 'discard' ? 'discard' : 'auto',
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
    maxDispatchBudget:
      typeof raw.maxDispatchBudget === 'number' &&
      Number.isFinite(raw.maxDispatchBudget) &&
      raw.maxDispatchBudget > 0
        ? raw.maxDispatchBudget
        : 0,
    resume: raw.resume === true,
    // 0 is a meaningful value (order dispatch off), so this is NOT
    // positiveNumber: any non-negative integer stands, anything else
    // falls back to the default.
    maxOrdersPerRun:
      typeof raw.maxOrdersPerRun === 'number' &&
      Number.isInteger(raw.maxOrdersPerRun) &&
      raw.maxOrdersPerRun >= 0
        ? raw.maxOrdersPerRun
        : DEFAULT_MAX_ORDERS_PER_RUN,
    workOrders: {
      maxSliceSize: positiveNumber(
        ((raw.workOrders ?? {}) as Record<string, unknown>).maxSliceSize,
        DEFAULT_MAX_SLICE_SIZE,
      ),
    },
    recipes: {
      enabled: ((raw.recipes ?? {}) as Record<string, unknown>).enabled !== false,
    },
  };
}
