/**
 * The $0 landing preflight (#286), split from `execute.ts` at the
 * module-size bar (the defer / attempt-record precedent): when a run
 * intends to LAND, probe the delivery preconditions of the task's branch
 * triple BEFORE any agent spawns. A branch-creation ruleset that will 403
 * the landing is knowable from one API read, and the live class spent
 * full agent budgets discovering it at push time. Only POSITIVE refusal
 * evidence blocks; an unanswerable probe proceeds (the preflight never
 * invents a refusal).
 *
 * Every ref the run may push is probed (the ONE triple builder, so the
 * probed set is the pushed set). A block on the attempt branch ALONE
 * refuses only when it is the only landing target, i.e. while the
 * standing branch holds verified work a salvage must not replace (#372);
 * otherwise it is a disclosed warning and the run proceeds.
 */
import * as logger from '../logger';
import { makeExec } from '../land-refresh';
import { remediateBranchesFor } from '../lanes/branches';
import { describeDeliveryProbe, probeDeliveryPreconditions } from '../lanes/delivery-preconditions';
import { branchHolding, readRemediateBranchStates, standingReplaceable } from './standing-branch';
import type { RemediateResult } from './outcome';

export interface LandingPreflightSeams {
  readonly probeDelivery?: typeof probeDeliveryPreconditions;
  readonly readBranchStates?: typeof readRemediateBranchStates;
}

/** The refusal result when delivery is structurally impossible, else null
 *  (proceed). `task` is omitted from the refusal: the preflight runs
 *  before task-id resolution narrows the raw string; the note + ledger
 *  name it. */
export function landingPreflightRefusal(
  cwd: string,
  taskId: string,
  seams: LandingPreflightSeams = {},
): RemediateResult | null {
  const branches = remediateBranchesFor(taskId);
  // The whole triple is probed: the standing + attempt branches the lander
  // may push, and the pending ref the task step pushes the verified work
  // to before the land step (#375). A blocked pending ref is a warning,
  // not a refusal: it costs the durable copy, never the landing itself.
  const preflight = (seams.probeDelivery ?? probeDeliveryPreconditions)(cwd, {
    branches: [branches.standing, branches.attempt, branches.pending],
  });
  const pendingBlocked = preflight.probes.find(
    (p) => p.verdict === 'blocked' && p.branch === branches.pending,
  );
  if (pendingBlocked) {
    logger.warn(
      `delivery: ${describeDeliveryProbe(pendingBlocked)}; the pending ref only preserves ` +
        'un-landed verified work across runs, so the run proceeds without that durable copy',
    );
  }
  const blockedOn = (branch: string) =>
    preflight.probes.find((p) => p.verdict === 'blocked' && p.branch === branch);
  let blocked = blockedOn(branches.standing);
  let onlyTarget = '';
  const attemptBlocked = blocked ? undefined : blockedOn(branches.attempt);
  if (attemptBlocked) {
    const standing = (seams.readBranchStates ?? readRemediateBranchStates)(
      taskId,
      makeExec(cwd),
    ).standing;
    if (standingReplaceable(standing)) {
      logger.warn(
        `delivery: ${describeDeliveryProbe(attemptBlocked)}; the attempt branch is needed ` +
          'only while the standing branch holds verified work, which it does not now, so the ' +
          'run proceeds',
      );
    } else {
      blocked = attemptBlocked;
      onlyTarget =
        ' The attempt branch is the only landing target a salvage has right now: ' +
        `${branchHolding(standing).evidence}.`;
    }
  }
  if (!blocked) return null;
  const note =
    `landing-unavailable (preflight, $0, no agent was spawned): ` +
    `${describeDeliveryProbe(blocked)}${onlyTarget}`;
  return {
    outcome: 'refused',
    note,
    ledger: `## dxkit remediate: ${taskId}\n\noutcome: **refused**\n\n${note}\n`,
  };
}
