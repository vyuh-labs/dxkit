/**
 * The lanes' standing-branch NAMES — one home (Rule 2), imported by the
 * landers that push them AND the delivery-preconditions prober that
 * probes them (#286/#287), so the probed set can never drift from the
 * pushed set. Leaf module by design: nothing here may import from the
 * lanes, or the prober's imports cycle.
 */

/** The dep-bump lane's one standing branch. */
export const DEP_BUMP_BRANCH = 'dxkit/dep-bump';

/** The remediate lane's standing branch for a task. */
export function remediateBranchFor(taskId: string): string {
  return `dxkit/remediate-${taskId}`;
}

/**
 * The remediate lane's ATTEMPT branch for a task: where a guardrail-red or
 * budget-exhausted salvage goes while the standing branch holds a VERIFIED
 * landing a human has not merged yet (#372). Force-pushed per attempt like
 * the standing branch; it never carries the standing PR.
 */
export function remediateAttemptBranchFor(taskId: string): string {
  return `${remediateBranchFor(taskId)}-attempt`;
}

/**
 * The remediate lane's PENDING ref for a task (#375): the durable copy of
 * verified-but-not-yet-landed work. The task step pushes the verified head
 * here (plus one bookkeeping commit carrying the landing record and the
 * run's ledger files) BEFORE the fresh-credential land step runs, so a
 * landing that never completes (a credential preflight failure, a land
 * crash, runner death) leaves the work on the remote instead of on an
 * ephemeral runner. Machine-owned and force-pushed per run; a successful
 * `remediate land` deletes it, and the next run's plan step re-lands a
 * survivor before planning new work. It never carries a PR.
 */
export function remediatePendingBranchFor(taskId: string): string {
  return `${remediateBranchFor(taskId)}-pending`;
}

/** A task's branch TRIPLE: the standing branch, its attempt sibling, and
 *  the pending ref that preserves un-landed verified work. */
export interface RemediateBranches {
  readonly standing: string;
  readonly attempt: string;
  readonly pending: string;
}

/** The ONE way to build the triple (Rule 2.30): every consumer that needs
 *  them (the lander, the preflight, the plan probes, resume, the order
 *  ledger's compose and history reads, the pending-ref push and re-land)
 *  derives them here, never by hand. */
export function remediateBranchesFor(taskId: string): RemediateBranches {
  return {
    standing: remediateBranchFor(taskId),
    attempt: remediateAttemptBranchFor(taskId),
    pending: remediatePendingBranchFor(taskId),
  };
}
