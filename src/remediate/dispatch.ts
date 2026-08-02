/**
 * Dispatch-campaign inputs (E2/E3): a one-time, human-triggered remediate
 * run with per-run overrides — task selection, budget, model, and (for the
 * `custom` task) a free-text prompt.
 *
 * TRUST MODEL, stated once: the scheduled lane runs dxkit-authored prompts
 * only. A dispatch campaign relaxes that for a WRITE-GATED surface — GitHub
 * only lets users with write access fire workflow_dispatch — and the work
 * still lands ONLY via a PR through the identical verified frame (entry
 * snapshot, floor attribution, guardrail, sweep). The prompt is transported
 * via ENV (the comment-defer pattern — never shell-interpolated, never
 * argv), and the ledger/PR body disclose the dispatcher and the verbatim
 * prompt so a reviewer sees exactly what was asked.
 *
 * Budget overrides are CLAMPED: maxUsd may never exceed
 * `remediate.maxDispatchBudget` (when unset, the policy's own per-task cap
 * is the ceiling — a dispatch without a declared ceiling can lower spend,
 * never raise it). Every clamp is disclosed, never silent.
 */
import type { RemediateBudget, RemediateConfig } from './config';
import { customDispatchTask, knownTaskIds, remediateTaskById, type RemediateTask } from './tasks';

/** Env names — the one place they are spelled. The workflow maps its typed
 *  dispatch inputs onto exactly these. */
export const DISPATCH_ENV = {
  maxUsd: 'DXKIT_DISPATCH_MAX_USD',
  maxTurns: 'DXKIT_DISPATCH_MAX_TURNS',
  maxMinutes: 'DXKIT_DISPATCH_MAX_MINUTES',
  model: 'DXKIT_DISPATCH_MODEL',
  customPrompt: 'DXKIT_CUSTOM_PROMPT',
} as const;

export interface DispatchOverrides {
  /** Effective budget after overrides + clamping (absent field = policy). */
  readonly budget: RemediateBudget;
  /** Model override, when given (else the policy model applies). */
  readonly model?: string;
  /** The custom task's verbatim prompt (task `custom` only). */
  readonly customPrompt?: string;
  /** Who fired the dispatch (GITHUB_ACTOR) — ledger disclosure. */
  readonly actor?: string;
  /** Human-phrased clamp disclosures (empty = nothing clamped). */
  readonly clamped: readonly string[];
  /** True when any dispatch input was present at all. */
  readonly any: boolean;
}

/**
 * Resolve the task for a run, dispatch-aware (the runner's one entry).
 * `custom` exists only for a dispatch carrying a prompt — it is not in the
 * registry, so policy can never schedule it, and without a prompt it is a
 * refusal, never an empty-prompt agent run. Also computes the disclosure
 * that must ride EVERY result's ledger.
 */
export function resolveDispatchedTask(
  taskId: string,
  dispatch: DispatchOverrides | undefined,
): {
  readonly task?: RemediateTask;
  readonly refusalNote?: string;
  readonly disclosure?: NonNullable<RemediateResultDispatch>;
} {
  const task =
    taskId === 'custom'
      ? dispatch?.customPrompt
        ? customDispatchTask(dispatch.customPrompt)
        : undefined
      : remediateTaskById(taskId);
  if (!task) {
    return {
      refusalNote:
        taskId === 'custom'
          ? `refused: the custom task requires a prompt (the workflow_dispatch 'prompt' input, ` +
            `transported via env) — none was provided.`
          : `refused: unknown task '${taskId}' — known tasks: ${knownTaskIds().join(', ')}.`,
    };
  }
  const disclosure =
    dispatch && (dispatch.any || taskId === 'custom')
      ? {
          ...(dispatch.actor !== undefined ? { actor: dispatch.actor } : {}),
          ...(taskId === 'custom' && dispatch.customPrompt !== undefined
            ? { prompt: dispatch.customPrompt }
            : {}),
          clamped: dispatch.clamped,
        }
      : undefined;
  return { task, ...(disclosure ? { disclosure } : {}) };
}

/** The result's dispatch-disclosure shape (mirrors `RemediateResult.dispatch`). */
export type RemediateResultDispatch =
  | {
      readonly actor?: string;
      readonly prompt?: string;
      readonly clamped: readonly string[];
    }
  | undefined;

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Read the dispatch env against the policy budget for one task. Pure over
 * its inputs; the CLI passes `process.env`.
 */
export function readDispatchOverrides(
  env: Readonly<Record<string, string | undefined>>,
  policyBudget: RemediateBudget,
  config: Pick<RemediateConfig, 'maxDispatchBudget'>,
): DispatchOverrides {
  const clamped: string[] = [];
  const reqUsd = num(env[DISPATCH_ENV.maxUsd]);
  const reqTurns = num(env[DISPATCH_ENV.maxTurns]);
  const reqMinutes = num(env[DISPATCH_ENV.maxMinutes]);
  const model = env[DISPATCH_ENV.model]?.trim() || undefined;
  const customPrompt = env[DISPATCH_ENV.customPrompt]?.trim() || undefined;

  // The USD ceiling: an explicit maxDispatchBudget, else the policy's own
  // cap (a dispatch may spend LESS than policy without any declaration, but
  // raising spend requires the committed ceiling to say so).
  const usdCeiling = config.maxDispatchBudget > 0 ? config.maxDispatchBudget : policyBudget.maxUsd;
  let maxUsd = policyBudget.maxUsd;
  if (reqUsd !== undefined) {
    maxUsd = Math.min(reqUsd, usdCeiling);
    if (maxUsd < reqUsd) {
      clamped.push(
        `maxUsd override $${reqUsd} clamped to $${maxUsd} ` +
          (config.maxDispatchBudget > 0
            ? '(remediate.maxDispatchBudget)'
            : '(no remediate.maxDispatchBudget declared — dispatch may not raise spend beyond policy)'),
      );
    }
  }

  return {
    budget: {
      maxUsd,
      maxTurns: reqTurns ?? policyBudget.maxTurns,
      maxMinutes: reqMinutes ?? policyBudget.maxMinutes,
    },
    ...(model !== undefined ? { model } : {}),
    ...(customPrompt !== undefined ? { customPrompt } : {}),
    ...(env.GITHUB_ACTOR ? { actor: env.GITHUB_ACTOR } : {}),
    clamped,
    any:
      reqUsd !== undefined ||
      reqTurns !== undefined ||
      reqMinutes !== undefined ||
      model !== undefined ||
      customPrompt !== undefined,
  };
}
