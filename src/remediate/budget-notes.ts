/**
 * Budget-envelope disclosures — split from `run.ts` at the large-file
 * bar, semantics unchanged. A cap below 'enforced' is a DISCLOSED
 * limitation phrased by what the driver CAN do: claiming an unenforced
 * cap as a cap is the $14.71 class (maxUsd read post-hoc while
 * max_turns silently governed real spend).
 */

import { LANE_TOKEN_PAT_SECRET_NAME } from '../lanes/lane-token';
import { deferredLandingRequested } from './landing-record';
import type { AgentDriver, AgentRunResult } from './driver';
import type { RemediateBudget } from './config';

/**
 * The minutes ceiling on the GitHub App token tier WHEN the landing still
 * rides the task step's own credential. An App INSTALLATION token is
 * hard-capped at ONE HOUR by GitHub with no longer-lived form, so on an
 * older installed workflow (task-time mint, inline landing) the agent run
 * plus verify plus landing must fit inside the hour or the landing 401s
 * AFTER the full agent spend. Under two-phase landing (4.4.7) the clamp's
 * reason is GONE: the landing step mints its own fresh token, so the agent
 * budget is decoupled from the credential lifetime (see the resolver
 * below). The PAT and workflow-token tiers are long-lived and never clamped.
 */
export const APP_TOKEN_SAFE_MINUTES = 45;

/**
 * Resolve the wall-clock budget against the credential's lifetime,
 * disclosed like every other budget limitation, never silent. The tier
 * arrives via `DXKIT_TOKEN_MODE` (set by the lane workflow's token
 * resolution; absent on local runs, which use the developer's own ambient
 * auth and are never touched). Honest derivation per landing mode:
 *
 *   - deferred landing signaled (the current workflow template): NO clamp.
 *     The landing pushes under a token minted fresh by its own step, and
 *     the verify tail was never boundable by an agent clamp anyway (it
 *     scales with repo size). The tier is still DISCLOSED. In-run git
 *     fetches (a resume, a private git-pinned install) keep their own
 *     fail-open disclosures and do not justify capping the agent.
 *   - no deferred signal on the app tier (an older installed workflow that
 *     still lands inline with the task-time token): the clamp keeps its
 *     original reason and stays.
 */
export function clampBudgetToTokenLifetime(
  budget: RemediateBudget,
  env: Readonly<Record<string, string | undefined>>,
): { budget: RemediateBudget; notes: readonly string[] } {
  if (env.DXKIT_TOKEN_MODE !== 'app') {
    return { budget, notes: [] };
  }
  if (deferredLandingRequested(env)) {
    return {
      budget,
      notes: [
        'GitHub App token tier: the landing is deferred to a post-task workflow step that ' +
          'mints a fresh installation token, so the agent budget is not clamped to the ' +
          "token's one-hour lifetime.",
      ],
    };
  }
  if (budget.maxMinutes <= APP_TOKEN_SAFE_MINUTES) {
    return { budget, notes: [] };
  }
  return {
    budget: { ...budget, maxMinutes: APP_TOKEN_SAFE_MINUTES },
    notes: [
      `maxMinutes ${budget.maxMinutes} clamped to ${APP_TOKEN_SAFE_MINUTES}: this workflow ` +
        `lands with a GitHub App installation token minted before the task, which GitHub ` +
        `hard-caps at one hour, and the landing must fit inside it: a longer run would spend ` +
        `its full agent budget and then fail to deliver. Run \`vyuh-dxkit update\` to install ` +
        `the two-phase landing workflow (which lifts this clamp), use the ` +
        `${LANE_TOKEN_PAT_SECRET_NAME} PAT tier, or lower the budget.`,
    ],
  };
}

/** The per-driver unenforceable-cap disclosures for a budget. */
export function unenforceableCapsFor(driver: AgentDriver, budget: RemediateBudget): string[] {
  const caps: string[] = [];
  if (driver.budgetSupport.turns !== 'enforced') {
    caps.push(
      `maxTurns is not enforceable by ${driver.id}; the wall-clock cap (${budget.maxMinutes} min) applies`,
    );
  }
  if (driver.budgetSupport.cost === 'none') {
    caps.push(
      `maxUsd is not enforceable by ${driver.id} (no spend reporting); the wall-clock cap applies`,
    );
  } else if (driver.budgetSupport.cost === 'reported') {
    caps.push(
      `maxUsd ($${budget.maxUsd}) is ADVISORY for ${driver.id}: the CLI reports spend only ` +
        `after the run and cannot stop mid-run on cost. Real spend is bounded by the ` +
        `enforced turn cap (${budget.maxTurns}) and the wall clock (${budget.maxMinutes} min); ` +
        `an overrun is disclosed and the attempt marked partial`,
    );
  }
  return caps;
}

/** The budget-awareness paragraph appended to every agent prompt: the agent
 *  is TOLD its caps so it lands work in mergeable increments instead of
 *  being surprised mid-edit by the kill. Phrased here, the one home of
 *  budget wording, never baked into the task prompts. */
export function budgetPromptNote(budget: RemediateBudget): string {
  return (
    `\nBudget for this run (runner-enforced): ~${budget.maxMinutes} minutes, ` +
    `${budget.maxTurns} turns, $${budget.maxUsd}. Commit completed units as you go, and ` +
    `reserve the final minutes to commit ALL remaining work and record where you stopped ` +
    `in docs/DXKIT-REMEDIATION-NOTES.md, since work committed before the cap survives ` +
    `while uncommitted edits are swept into a single unlabeled-context commit.`
  );
}

/** Post-run budget-overrun facts, derived only where dxkit may claim them:
 *  a reported cost over the advisory cap is an honest post-hoc statement
 *  for any driver that at least REPORTS cost, while a turn cap counts as
 *  HIT only when the driver ENFORCES turns (a report-only driver would
 *  mislabel a natural completion as budget-exhausted while the envelope
 *  discloses the cap as unenforceable). Lives beside the other budget
 *  phrasing/derivations, the one home of budget reasoning. */
export function budgetOverruns(
  driver: Pick<AgentDriver, 'budgetSupport'>,
  result: Pick<AgentRunResult, 'timedOut' | 'turns' | 'costUsd'>,
  budget: RemediateBudget,
): { overUsd: boolean; overTurns: boolean; partial: boolean } {
  const overUsd =
    driver.budgetSupport.cost !== 'none' &&
    result.costUsd !== undefined &&
    result.costUsd > budget.maxUsd;
  const overTurns =
    driver.budgetSupport.turns === 'enforced' &&
    result.turns !== undefined &&
    result.turns >= budget.maxTurns;
  return { overUsd, overTurns, partial: result.timedOut || overUsd || overTurns };
}
