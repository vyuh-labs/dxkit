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
 * never raise it), and max_turns is clamped against the SAME spend
 * authority — turns govern real spend when the driver cannot enforce
 * maxUsd mid-run, so an unclamped turn override was a back door around the
 * ceiling. Every clamp is disclosed, never silent.
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

  // TURNS are clamped against the SAME committed spend authority. maxUsd is
  // advisory for a driver that only reports cost post-hoc, so the turn cap
  // is the lever that actually bounds real spend — an unclamped max_turns
  // was a back door around the ceiling ($14.71 spent against a $5 cap: the
  // dispatch raised turns 80 → 200 and the "clamped" USD cap never
  // enforced). A dispatch may lower turns freely; raising them beyond
  // policy scales with the declared spend authority (usdCeiling / policy
  // maxUsd), so with no maxDispatchBudget declared, turns cannot rise at
  // all — the documented "spend authority grows only in committed policy"
  // now holds for the lever that matters.
  const turnsCeiling = Math.max(
    policyBudget.maxTurns,
    Math.floor(policyBudget.maxTurns * (usdCeiling / policyBudget.maxUsd)),
  );
  let maxTurns = policyBudget.maxTurns;
  if (reqTurns !== undefined) {
    maxTurns = Math.min(reqTurns, turnsCeiling);
    if (maxTurns < reqTurns) {
      clamped.push(
        `max_turns override ${reqTurns} clamped to ${maxTurns} — turns govern real spend ` +
          `when the driver cannot enforce maxUsd mid-run, so raising them beyond policy ` +
          `(${policyBudget.maxTurns}) requires spend authority from ` +
          `remediate.maxDispatchBudget (committed policy, ${
            config.maxDispatchBudget > 0
              ? `$${config.maxDispatchBudget} declared — allows up to ${turnsCeiling} turns`
              : 'not declared'
          })`,
      );
    }
  }

  return {
    budget: {
      maxUsd,
      maxTurns,
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

/**
 * Stale-workflow detection for the dispatch override (scheduler memory,
 * 3F): the UPDATED managed workflow always defines DXKIT_DISPATCH_TASK on
 * the run step (empty on scheduled runs), and passes --dispatch-override
 * when the workflow_dispatch input names this task. A workflow_dispatch
 * run where the variable is entirely ABSENT is therefore running a
 * template from before the flag existed: its dispatches can never lift a
 * circuit-breaker pause, and the operator should refresh the workflow.
 * Pure over the env snapshot; the CLI surfaces the note as a warning.
 */
export function staleDispatchWorkflowNote(
  env: Readonly<Record<string, string | undefined>>,
  dispatchOverride: boolean,
): string | undefined {
  if (dispatchOverride) return undefined;
  if (env.GITHUB_ACTIONS !== 'true') return undefined;
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch') return undefined;
  if ('DXKIT_DISPATCH_TASK' in env) return undefined;
  return (
    'this looks like a workflow_dispatch run on a workflow template from before the ' +
    'dispatch-override flag: the dispatch cannot lift a circuit-breaker pause. Run ' +
    '`vyuh-dxkit update` to refresh the managed workflow.'
  );
}
