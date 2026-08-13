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
