/**
 * Race a Promise against a deadline. The wrapper always settles within
 * `deadlineMs + epsilon`, whether the inner Promise resolves, rejects,
 * or never settles at all. Rejection of the inner Promise propagates
 * untouched so callers can still see real provider errors.
 *
 * Why this exists: capability providers shell out to external tools
 * (semgrep, jscpd, graphify, npm audit, pip-audit, …) and occasionally
 * produce a Promise that never settles — typically because the
 * provider awaits multiple async operations in turn and one of them
 * (a `Promise.all`, a non-`runDetached` subprocess, a network call)
 * silently hangs. `runDetached` has its own safety-deadline that
 * forces its Promise to resolve, but providers can produce abandoned
 * Promises outside `runDetached` too. The dispatcher used to wrap
 * those calls in `Promise.allSettled`, which only collapses settled
 * Promises — an unsettled Promise inside leaves the whole capability
 * gather pending forever, the Node event loop empties, and the
 * subprocess exits cleanly with no work done — a silent rc=0 with
 * no report on disk. The reproducible offender on at least one
 * heavy JS-stack customer audit has been `license-checker` walking
 * a deep `node_modules` tree, which occasionally produces an
 * unsettling Promise under concurrent subprocess load.
 *
 * The dispatcher applies this helper per-provider so any single
 * provider that stalls is bounded; the rest of the Promise.allSettled
 * still completes; the stalled source ends up in
 * `DispatchOutcome.skipped` with a deadline reason that surfaces
 * downstream in `toolsUnavailable`. Two non-dispatcher gathers
 * (`gatherDepVulnsWithAvailability`, `gatherLicensesWithAvailability`)
 * iterate packs themselves; they apply the same pattern at their
 * own iteration site.
 */

export type DeadlineOutcome<T> =
  | { stalled: false; value: T }
  | { stalled: true; stalledMs: number };

/**
 * Race `promise` against a `deadlineMs` timer. Returns:
 *  - `{ stalled: false, value }` if the Promise resolves before the deadline
 *  - `{ stalled: true, stalledMs }` if the deadline fires first
 *
 * Rejections of the inner Promise propagate as rejections of the
 * returned Promise — callers handle them separately (e.g. via
 * `Promise.allSettled`). The internal timer is cleared on settle so a
 * resolved Promise doesn't leave a stray pending timer keeping Node
 * alive past process exit.
 */
export function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({ stalled: true, stalledMs: deadlineMs });
    }, deadlineMs);
  });
  const racedInner = promise.then(
    (value): DeadlineOutcome<T> => {
      if (timer !== undefined) clearTimeout(timer);
      return { stalled: false, value };
    },
    (err) => {
      if (timer !== undefined) clearTimeout(timer);
      throw err;
    },
  );
  return Promise.race([racedInner, deadlinePromise]);
}

/**
 * Default per-provider deadline for capability gathers. Chosen so the
 * deadline only fires on genuine abandoned-Promise hangs, not on slow
 * legitimate tool runs:
 *  - jscpd's `runDetached` timeout is 600s; its safety-deadline adds 30s
 *  - semgrep's `runDetached` timeout is 300s
 *  - depVulns providers (npm/pip/gem audit, govulncheck, cargo-audit,
 *    dotnet) typically settle within 60–180s on large monorepos
 *
 * 720s (12 min) sits above the slowest legitimate provider by ~90s of
 * slack for parsing + aggregation. Real provider runs on the customer
 * benchmark repos finish well inside this; only the stuck case trips
 * it.
 */
export const DEFAULT_PROVIDER_DEADLINE_MS = 720_000;
