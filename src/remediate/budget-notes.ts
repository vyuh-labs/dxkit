/**
 * Budget-envelope disclosures — split from `run.ts` at the large-file
 * bar, semantics unchanged. A cap below 'enforced' is a DISCLOSED
 * limitation phrased by what the driver CAN do: claiming an unenforced
 * cap as a cap is the $14.71 class (maxUsd read post-hoc while
 * max_turns silently governed real spend).
 */

import type { AgentDriver } from './driver';
import type { RemediateBudget } from './config';

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
