/**
 * The scheduled task matrix, derived from the OPEN work orders (remediate
 * rethink, section 3F): a weekly firing spends its bounded budget on the
 * highest-value open orders, so the matrix a scheduled run spawns comes
 * from the plan — a task with no open (unpaused) orders spawns NO job —
 * instead of the static policy task list.
 *
 * The static list is still consulted twice, deliberately:
 *   - only policy-ENABLED tasks may appear (the plan never widens what a
 *     repo opted into);
 *   - open-ended tasks (no work-order classes: improve-tests, write-docs)
 *     cannot have orders by nature, so a policy that explicitly lists them
 *     keeps them scheduled — the legacy shape, kept working and DISCLOSED
 *     as such (the default policy task set does not include them).
 *
 * The spend ceiling (`remediate.maxSpendPerRun`) applies over the derived
 * VALUE order through the one ceiling helper, so a trim cuts the
 * lowest-value tasks first, disclosed. Fail-open: with no plan (planning
 * failed, or an old caller), the matrix falls back to the static list — a
 * broken planner must not silently turn the whole schedule off — and says
 * why. The dispatch-override path is untouched: a workflow_dispatch naming
 * a task runs exactly that task, bypassing this derivation entirely.
 */
import { tasksWithinSpendCeiling, type RemediateConfig } from '../config';
import { classesSelectedBy, isBuiltinWorkOrderClass, WORK_ORDER_CLASSES } from './types';
import type { WorkOrderPlan } from './types';
import type { RemediateTaskId } from '../tasks';

export interface ScheduledMatrix {
  /** The tasks one scheduled firing runs, value order, ceiling applied. */
  readonly run: readonly RemediateTaskId[];
  /** Tasks trimmed by `remediate.maxSpendPerRun`, disclosed. */
  readonly deferred: readonly RemediateTaskId[];
  /** Enabled class-selecting tasks with no open orders: no job spawned
   *  (a paused-only task lands here too — the pause is disclosed). */
  readonly noOpenOrders: readonly RemediateTaskId[];
  /** Enabled open-ended tasks kept by explicit policy (legacy shape). */
  readonly legacyOpenEnded: readonly RemediateTaskId[];
  /** 'orders' = derived from the plan; 'static-fallback' = no plan was
   *  available and the policy task list ran the matrix (disclosed). */
  readonly source: 'orders' | 'static-fallback';
  readonly disclosures: readonly string[];
}

export interface ScheduledMatrixInput {
  readonly config: RemediateConfig;
  /** The work-order plan with circuit-breaker marks applied, or null when
   *  planning failed / was unavailable. */
  readonly plan: WorkOrderPlan | null;
  readonly planError?: string | null;
}

/** Derive the scheduled matrix. Pure — every read is from the arguments. */
export function deriveScheduledMatrix(input: ScheduledMatrixInput): ScheduledMatrix {
  const { config, plan } = input;
  const disclosures: string[] = [];

  if (!plan) {
    const ceiling = tasksWithinSpendCeiling(config);
    disclosures.push(
      'matrix: no work-order plan was available' +
        (input.planError ? ` (${input.planError})` : '') +
        '; fell back to the static policy task list (a broken planner must not turn the ' +
        'schedule off silently)',
    );
    return {
      run: ceiling.run,
      deferred: ceiling.deferred,
      noOpenOrders: [],
      legacyOpenEnded: [],
      source: 'static-fallback',
      disclosures,
    };
  }

  const enabled = new Set<string>(config.tasks);

  // Value-ordered tasks from the OPEN orders: the plan's order IS the value
  // order, so the first open order of a task fixes the task's rank.
  const orderedTasks: RemediateTaskId[] = [];
  const pausedOnly = new Map<string, number>(); // task -> paused order count
  const unroutableClasses = new Set<string>();
  for (const order of plan.orders) {
    const cls = String(order.class);
    if (!isBuiltinWorkOrderClass(cls)) {
      // An order whose class is outside the built-in spine cannot be routed
      // to a scheduled task — disclosed, never silently dropped.
      unroutableClasses.add(cls);
      continue;
    }
    const task = WORK_ORDER_CLASSES[cls].task as RemediateTaskId;
    if (!enabled.has(task)) continue;
    if (order.paused) {
      pausedOnly.set(task, (pausedOnly.get(task) ?? 0) + 1);
      continue;
    }
    if (!orderedTasks.includes(task)) orderedTasks.push(task);
  }
  for (const cls of unroutableClasses) {
    disclosures.push(
      `matrix: order class '${cls}' is not in the built-in class registry, so its orders ` +
        'cannot be routed to a scheduled task (they remain visible in the plan)',
    );
  }

  // Enabled class-selecting tasks that earned no matrix slot: no job.
  const noOpenOrders: RemediateTaskId[] = [];
  const legacyOpenEnded: RemediateTaskId[] = [];
  for (const task of config.tasks) {
    if (classesSelectedBy(task).length === 0) {
      // Open-ended by nature (improve-tests, write-docs): no orders can
      // exist, so explicit policy keeps it scheduled — the legacy shape.
      legacyOpenEnded.push(task);
      disclosures.push(
        `matrix: '${task}' is open-ended (no work-order classes) and stays scheduled ` +
          'because policy lists it explicitly; the default task set does not (legacy shape)',
      );
      continue;
    }
    if (orderedTasks.includes(task)) continue;
    noOpenOrders.push(task);
    const paused = pausedOnly.get(task);
    disclosures.push(
      paused !== undefined
        ? `matrix: '${task}' spawns no job: its only open order(s) are PAUSED by the ` +
            `circuit breaker (${paused} order(s); see the plan's pause disclosures)`
        : `matrix: '${task}' spawns no job: no open work orders (nothing to spend on, $0)`,
    );
  }

  // Value order first, then the legacy open-ended tail; the ceiling trims
  // from the end (lowest value first) through the ONE ceiling helper.
  const ceiling = tasksWithinSpendCeiling(config, [...orderedTasks, ...legacyOpenEnded]);
  return {
    run: ceiling.run,
    deferred: ceiling.deferred,
    noOpenOrders,
    legacyOpenEnded,
    source: 'orders',
    disclosures,
  };
}
