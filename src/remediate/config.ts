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
  };
}
