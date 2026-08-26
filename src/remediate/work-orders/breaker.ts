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
 * walking a class's rows newest-first, a success ends the streak, a failure
 * extends it, and everything else (a refusal, an infra never-ran, a paused
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

function unpauseConditions(cls: string): string {
  const task = isBuiltinWorkOrderClass(cls) ? WORK_ORDER_CLASSES[cls].task : undefined;
  return (
    'the pause lifts when the remediate policy changes, when dxkit is upgraded, ' +
    (task
      ? `when the '${task}' task is dispatched explicitly (workflow dispatch, or a local ` +
        `\`vyuh-dxkit remediate --task ${task}\`), `
      : 'when the owning task is dispatched explicitly, ') +
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
    const newestFirst = [...list].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    let failures = 0;
    let latest: OrderOutcomeRow | undefined;
    for (const row of newestFirst) {
      const outcome = row.outcome;
      if (ORDER_SUCCESS_OUTCOMES.has(outcome)) break;
      if (ORDER_FAILURE_OUTCOMES.has(outcome)) {
        failures += 1;
        latest = latest ?? row;
      }
      // neutral rows (refused, never-ran, paused, ...) neither count nor reset
    }
    if (failures < opts.threshold || !latest) continue;

    const streak =
      `the last ${failures} counted outcome(s) for this class were failures ` +
      `(latest: ${latest.outcome} at ${latest.timestamp})`;
    if (latest.dxkitVersion !== opts.current.dxkitVersion) {
      disclosures.push(
        `circuit breaker: class '${cls}' would be paused (${streak}), but dxkit changed ` +
          `since (${latest.dxkitVersion} -> ${opts.current.dxkitVersion}): retrying`,
      );
      continue;
    }
    if (latest.policyHash !== opts.current.policyHash) {
      disclosures.push(
        `circuit breaker: class '${cls}' would be paused (${streak}), but the remediate ` +
          'policy changed since the failures: retrying',
      );
      continue;
    }
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
