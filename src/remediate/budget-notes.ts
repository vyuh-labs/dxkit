/**
 * Budget-envelope disclosures — split from `run.ts` at the large-file
 * bar, semantics unchanged. A cap below 'enforced' is a DISCLOSED
 * limitation phrased by what the driver CAN do: claiming an unenforced
 * cap as a cap is the $14.71 class (maxUsd read post-hoc while
 * max_turns silently governed real spend).
 */

import { LANE_TOKEN_PAT_SECRET_NAME } from '../lanes/lane-token';
import type { AgentDriver } from './driver';
import type { RemediateBudget } from './config';

/**
 * The minutes ceiling on the GitHub App token tier. An App INSTALLATION
 * token is hard-capped at ONE HOUR by GitHub with no longer-lived form,
 * and the lane's landing push authenticates with it — so the agent run
 * plus verify plus landing must fit inside the hour or the landing 401s
 * AFTER the full agent spend (the late-delivery death class the
 * delivery-preconditions preflight exists to kill, resurfacing at the
 * credential layer). The workflow re-mints immediately before the task
 * step, so the window starts at agent launch; 45 minutes leaves the
 * verify + landing tail inside it. The PAT and workflow-token tiers are
 * long-lived and never clamped.
 */
export const APP_TOKEN_SAFE_MINUTES = 45;

/**
 * Clamp the wall-clock budget to the credential's lifetime, disclosed
 * like every other budget limitation — never silent. The tier arrives
 * via `DXKIT_TOKEN_MODE` (set by the lane workflow's token resolution;
 * absent on local runs, which use the developer's own ambient auth and
 * are never clamped).
 */
export function clampBudgetToTokenLifetime(
  budget: RemediateBudget,
  env: Readonly<Record<string, string | undefined>>,
): { budget: RemediateBudget; notes: readonly string[] } {
  if (env.DXKIT_TOKEN_MODE !== 'app' || budget.maxMinutes <= APP_TOKEN_SAFE_MINUTES) {
    return { budget, notes: [] };
  }
  return {
    budget: { ...budget, maxMinutes: APP_TOKEN_SAFE_MINUTES },
    notes: [
      `maxMinutes ${budget.maxMinutes} clamped to ${APP_TOKEN_SAFE_MINUTES}: this lane pushes ` +
        `with a GitHub App installation token, which GitHub hard-caps at one hour, and the ` +
        `landing must fit inside it — a longer run would spend its full agent budget and then ` +
        `fail to deliver. For longer runs use the ${LANE_TOKEN_PAT_SECRET_NAME} PAT tier or lower the budget.`,
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
