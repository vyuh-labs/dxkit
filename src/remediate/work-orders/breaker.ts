/**
 * The circuit breaker (remediate rethink, section 3F): a work-order CLASS
 * whose recent history is an unbroken failure streak is PAUSED — the
 * planner still plans its orders, every surface still shows them, but no
 * tier dispatches them, so the scheduled lane stops re-buying the same
 * failure every firing.
 *
 * The evidence is the order-outcome ledger (`src/lanes/order-ledger.ts`),
 * read through its ONE reader. The counting rules live beside the row
 * vocabulary there (`ORDER_FAILURE_OUTCOMES` / `ORDER_SUCCESS_OUTCOMES`):
 * walking a class's FIRINGS newest-first (rows grouped by run timestamp;
 * one red run is one failure event however many orders it carried), a
 * success ends the streak, a failure extends it, and everything else (a refusal, an infra never-ran, a paused
 * row this breaker itself wrote) is neutral — it neither counts nor resets,
 * because nothing was actually tried.
 *
 * A pause LIFTS, by design, on any signal that the next attempt would not
 * be a rerun of the same failure:
 *   - the remediate policy changed (every row carries `policyHash`);
 *   - dxkit changed (every row carries `dxkitVersion`);
 *   - a human explicitly dispatched the class's task (workflow_dispatch
 *     naming the task, or a local `remediate --task <t>`);
 *   - the failures aged out of the bounded history window (the natural
 *     retry horizon — a pause is never a forever-off switch).
 * Each lift is DISCLOSED, never silent, same as the pause itself.
 */
import {
  ORDER_FAILURE_OUTCOMES,
  ORDER_SUCCESS_OUTCOMES,
  type OrderOutcomeRow,
} from '../../lanes/order-ledger';
import { hashRecallInputs } from '../../baseline/recall';
import { readPolicySection } from '../../baseline/policy-text';
import { VERSION } from '../../constants';
import {
  WORK_ORDER_CLASSES,
  isBuiltinWorkOrderClass,
  type WorkOrder,
  type WorkOrderPause,
  type WorkOrderPlan,
} from './types';

/** The environment stamps every ledger row carries and every pause
 *  evaluation compares against. */
export interface RemediateStamp {
  readonly dxkitVersion: string;
  readonly policyHash: string;
}

/** The current stamps for a repo: dxkit's own version plus a stable hash of
 *  the committed `remediate` policy section (through the one policy reader;
 *  an absent section hashes as the empty object, so adding one IS a policy
 *  change). Non-identity hashing — Rule 9 does not apply. */
export function remediateStamp(cwd: string): RemediateStamp {
  let section: unknown = {};
  try {
    section = readPolicySection(cwd, 'remediate') ?? {};
  } catch {
    // fail-open: an unreadable policy stamps as empty (and a later readable
    // one reads as a policy change, which unpauses — the safe direction)
  }
  return {
    dxkitVersion: VERSION,
    policyHash: hashRecallInputs({ remediate: JSON.stringify(section) }),
  };
}

/** One paused class, with everything a surface needs to disclose it. */
export interface ClassPause {
  readonly class: string;
  /** Consecutive counted failures in the streak. */
  readonly failures: number;
  /** The newest failure's outcome + timestamp (the evidence pointer). */
  readonly latestOutcome: string;
  readonly latestAt: string;
  readonly reason: string;
  readonly unpause: string;
}

export interface BreakerOptions {
  /** `remediate.pauseAfterFailures`; <= 0 disables the breaker. */
  readonly threshold: number;
  readonly current: RemediateStamp;
  /** A task explicitly named by a human (workflow_dispatch input, or a
   *  local `remediate --task`): its classes bypass any pause, disclosed. */
  readonly dispatchedTask?: string;
}

/** Which stamp on a failure row differs from the current environment, if
 *  any: the ONE stamp comparison the streak walk reads (a stale stamp is
 *  where the counted streak stops). */
function staleStampOf(row: OrderOutcomeRow, current: RemediateStamp): 'dxkit' | 'policy' | null {
  if (row.dxkitVersion !== current.dxkitVersion) return 'dxkit';
  if (row.policyHash !== current.policyHash) return 'policy';
  return null;
}

function unpauseConditions(cls: string): string {
  const task = isBuiltinWorkOrderClass(cls) ? WORK_ORDER_CLASSES[cls].task : undefined;
  return (
    'the pause lifts when the remediate policy changes, when dxkit is upgraded, ' +
    (task
      ? `on an explicit dispatch override (locally: \`vyuh-dxkit remediate --task ${task} ` +
        `--dispatch-override\`; or the managed workflow's Run-workflow form with task ` +
        `'${task}', which needs the current workflow template, so run \`vyuh-dxkit update\` ` +
        `first if a dispatch does not lift the pause), `
      : 'on an explicit dispatch override of the owning task, ') +
    'or when the failures age out of the history window'
  );
}

/**
 * Evaluate the breaker for every class in the history. Returns the paused
 * classes plus the disclosures for pauses that were LIFTED by an unpause
 * condition (a lift must be as visible as the pause it replaces).
 */
export function evaluateClassPauses(
  rows: readonly OrderOutcomeRow[],
  opts: BreakerOptions,
): { pauses: ReadonlyMap<string, ClassPause>; disclosures: readonly string[] } {
  const pauses = new Map<string, ClassPause>();
  const disclosures: string[] = [];
  if (opts.threshold <= 0) return { pauses, disclosures };

  const dispatchedClasses = new Set<string>(
    opts.dispatchedTask
      ? Object.entries(WORK_ORDER_CLASSES)
          .filter(([, decl]) => decl.task === opts.dispatchedTask)
          .map(([cls]) => cls)
      : [],
  );

  const byClass = new Map<string, OrderOutcomeRow[]>();
  for (const row of rows) {
    const list = byClass.get(row.class) ?? [];
    list.push(row);
    byClass.set(row.class, list);
  }

  for (const [cls, list] of byClass) {
    // The unit of counting is a FIRING, not a row: one run stamps every
    // row with one timestamp, and the shared tree verification smears the
    // run verdict onto every committed order — so a single red firing that
    // carried two orders of a class is ONE failure event, never two (a
    // per-row count would let one firing hit the threshold by itself).
    const firings = new Map<string, OrderOutcomeRow[]>();
    for (const row of list) {
      const key = `${row.task}\0${row.timestamp}`;
      const rowsOf = firings.get(key) ?? [];
      rowsOf.push(row);
      firings.set(key, rowsOf);
    }
    const newestFirst = [...firings.values()].sort((a, b) =>
      b[0].timestamp.localeCompare(a[0].timestamp),
    );
    let failures = 0;
    let latest: OrderOutcomeRow | undefined;
    let sawSuccess = false;
    // A failure stamped by an OLDER dxkit / remediate policy is a lift
    // point: the walk stops there, so only failures under the CURRENT
    // stamps count. A lift therefore RESETS the streak. The shipped shape
    // compared only the newest failure's stamp while the streak still
    // counted the older ones, so one new failure after a lift re-paused
    // the class at an effective threshold of 1.
    let lift: { readonly by: 'dxkit' | 'policy'; readonly row: OrderOutcomeRow } | undefined;
    let staleFailures = 0;
    for (const firing of newestFirst) {
      // A firing with any success row RESETS (the class produced verified
      // work, whatever else happened alongside); else any failure row
      // makes it one failure event; else it is neutral (nothing tried).
      if (firing.some((r) => ORDER_SUCCESS_OUTCOMES.has(r.outcome))) {
        sawSuccess = true;
        break;
      }
      const failureRow = firing.find((r) => ORDER_FAILURE_OUTCOMES.has(r.outcome));
      if (failureRow) {
        const by = staleStampOf(failureRow, opts.current);
        if (by) {
          lift = lift ?? { by, row: failureRow };
          staleFailures += 1;
          continue;
        }
        if (lift) continue; // past the lift point: nothing older counts
        failures += 1;
        latest = latest ?? failureRow;
      }
      // neutral firings (refused, never-ran, paused markers) neither count nor reset
    }
    if (failures < opts.threshold || !latest) {
      const wasPaused = list.some((r) => r.outcome === 'paused');
      // A lift is disclosed when it is what keeps the class running: the
      // class was paused on the stale evidence, or the stale streak alone
      // would have paused it.
      if (lift && (wasPaused || failures + staleFailures >= opts.threshold)) {
        // The stamp lift, DISCLOSED: the evidence the pause stood on was
        // recorded under a different dxkit / policy, so it says nothing
        // about the next attempt; the streak restarts from the lift.
        disclosures.push(
          lift.by === 'dxkit'
            ? `circuit breaker: class '${cls}' would be paused on failures recorded before ` +
                `dxkit changed (${lift.row.dxkitVersion} -> ${opts.current.dxkitVersion}); ` +
                'those no longer count and the failure streak restarts from zero: retrying'
            : `circuit breaker: class '${cls}' would be paused on failures recorded before ` +
                'the remediate policy changed; those no longer count and the failure streak ' +
                'restarts from zero: retrying',
        );
        continue;
      }
      // The documented age-out lift, DISCLOSED: a paused marker in the
      // window with the failure streak no longer meeting the threshold
      // (and no success explaining the reset) means the evidence aged out
      // of the bounded window — the retry horizon engaging, never silent.
      if (!sawSuccess && !lift && wasPaused) {
        disclosures.push(
          `circuit breaker: class '${cls}' was paused previously and its failure evidence ` +
            'aged out of the bounded history window, so the pause lifted (the documented ' +
            'retry horizon): retrying',
        );
      }
      continue;
    }

    // Every counted failure carries the current stamps by construction
    // (the walk stopped at the first stale one), so a pause here is never
    // evidence from another dxkit or another policy.
    const streak =
      `the last ${failures} counted firing(s) for this class were failures ` +
      `(latest: ${latest.outcome} at ${latest.timestamp})`;
    if (dispatchedClasses.has(cls)) {
      disclosures.push(
        `circuit breaker: class '${cls}' is paused (${streak}), but this run was ` +
          `dispatched explicitly for its task ('${opts.dispatchedTask}'), so the pause is ` +
          'overridden for this run',
      );
      continue;
    }
    pauses.set(cls, {
      class: cls,
      failures,
      latestOutcome: latest.outcome,
      latestAt: latest.timestamp,
      reason: `${streak}; paused to stop re-spending on the same failure (remediate.pauseAfterFailures: ${opts.threshold})`,
      unpause: unpauseConditions(cls),
    });
  }
  return { pauses, disclosures };
}

/** Mark every order of a paused class. The plan keeps its shape and value
 *  order; only the `paused` mark is added — planned, disclosed, not
 *  dispatchable. */
export function applyClassPauses(
  plan: WorkOrderPlan,
  pauses: ReadonlyMap<string, ClassPause>,
): WorkOrderPlan {
  if (pauses.size === 0) return plan;
  const orders: WorkOrder[] = plan.orders.map((o) => {
    const pause = pauses.get(String(o.class));
    if (!pause) return o;
    const mark: WorkOrderPause = { reason: pause.reason, unpause: pause.unpause };
    return { ...o, paused: mark };
  });
  return { ...plan, orders };
}
