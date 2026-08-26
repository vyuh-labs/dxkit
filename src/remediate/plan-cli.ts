/**
 * `vyuh-dxkit remediate plan` — the dry-run resolution chain (no key, no
 * spend): per enabled task, task -> tier -> driver-native model, the
 * effective per-task budget, and the spend-ceiling-trimmed matrix the
 * managed workflow reads. Split from `cli.ts` purely for module size.
 */
import * as logger from '../logger';
import { budgetForTask, resolveRemediateConfig } from './config';
import { resolveModelSetting } from './driver';
import { AGENT_DRIVERS, driverById } from './registry';
import { remediateTaskById } from './tasks';
import { remediateBranchFor } from '../lanes/branches';
import { describeDeliveryProbe, probeDeliveryPreconditions } from '../lanes/delivery-preconditions';
import {
  planRepoWorkOrders,
  type DepScanSource,
  type FloorSource,
  type GatherWorkOrderOptions,
} from './work-orders/gather';
import { renderWorkOrderSummary } from './work-orders/render';
import type { WorkOrderPlan } from './work-orders/types';
import type { ClassPause } from './work-orders/breaker';
import { deriveScheduledMatrix } from './work-orders/schedule';

export interface RemediatePlanOptions {
  readonly json?: boolean;
  /** Run the live correctness floor for the work-order plan (default: read
   *  the baseline's recorded envelope, so the plan stays a $0 dry-run). */
  readonly withFloor?: boolean;
  /** Injected for tests (a fake floor run, a fixed clock). */
  readonly gather?: GatherWorkOrderOptions;
}

/** Human phrasing of which floor source the work-order plan read. */
function describeFloorSource(source: FloorSource): string {
  switch (source) {
    case 'live':
      return 'live floor run (--with-floor)';
    case 'baseline-envelope':
      return "the baseline's recorded floor envelope (pass --with-floor to re-run it)";
    case 'loop-snapshot':
      return "the loop's floor snapshot (pass --with-floor to re-run it)";
    case 'none':
      return 'no floor source (no baseline envelope, no loop snapshot; pass --with-floor)';
  }
}

/** The plan surface's projection of one order: what a reader needs to see
 *  where determinism applies and what each unit costs, without the full
 *  evidence payload. */
function projectWorkOrders(plan: WorkOrderPlan) {
  return {
    workOrders: plan.orders.map((o) => ({
      id: o.id,
      class: o.class,
      tier: o.tier,
      recipe: o.recipe ?? null,
      findings: o.findings.length,
      findingIds: o.findings.map((f) => f.id),
      paused: o.paused ?? null,
      attribution: [...new Set(o.findings.map((f) => f.attribution))],
      envelope: o.envelope,
      install: o.constraints.install ?? null,
      budget: o.budget,
      done: { verifier: o.done.verifier, command: o.done.command, absent: o.done.absentIds.length },
      provenance: o.provenance,
    })),
    undispatchable: plan.undispatchable.map((u) => ({
      reason: u.reason,
      findings: u.findings.map((f) => ({ kind: f.kind, id: f.id })),
    })),
  };
}

/** `remediate plan` — the resolution chain, computed not narrated. */
export async function runRemediatePlan(
  cwd: string,
  opts: RemediatePlanOptions = {},
): Promise<void> {
  const config = resolveRemediateConfig(cwd);
  const driver = driverById(config.agent.driver);
  // Validate the driver BEFORE any gathering: an unknown driver is a config
  // error the human surface reports without paying a scan.
  if (!opts.json && !driver) {
    logger.header('dxkit remediate plan');
    logger.fail(
      `unknown agent driver '${config.agent.driver}' — known drivers: ` +
        AGENT_DRIVERS.map((d) => d.id).join(', '),
    );
    process.exitCode = 1;
    return;
  }

  const rows = config.tasks.map((taskId) => {
    const task = remediateTaskById(taskId)!;
    const choice = driver ? resolveModelSetting(driver, config.agent.model, task.tier) : undefined;
    return {
      task: taskId,
      tier: task.tier,
      tierWhy: task.tierWhy,
      model: choice?.native ?? null,
      modelSource: choice?.source ?? null,
      warning: choice?.warning ?? null,
      budget: budgetForTask(config, task.id),
    };
  });

  const availability = driver ? driver.available(cwd) : undefined;

  // The work-order plan (remediate rethink, section 3A): the finite units the
  // lane would dispatch, from the live entry floor + debt + deferrals via the
  // ONE gather adapter (circuit-breaker pauses applied there). Fail-open: a
  // gather failure is disclosed, never a crashed plan.
  let plan: WorkOrderPlan | null = null;
  let floorSource: FloorSource | null = null;
  let depScanSource: DepScanSource | null = null;
  let disclosures: readonly string[] = [];
  let pauses: readonly ClassPause[] = [];
  let evidenceDegraded: string | null = null;
  let planError: string | null = null;
  try {
    const gathered = await planRepoWorkOrders(cwd, config, {
      ...(opts.withFloor ? { withFloor: true } : {}),
      ...opts.gather,
    });
    plan = gathered.plan;
    floorSource = gathered.floorSource;
    depScanSource = gathered.depScanSource;
    disclosures = gathered.disclosures;
    pauses = gathered.pauses;
    evidenceDegraded = gathered.evidenceDegraded;
  } catch (err) {
    planError = err instanceof Error ? err.message : String(err);
  }

  // The scheduled matrix, derived from the OPEN orders (section 3F): a task
  // with no open (unpaused) orders spawns no job; the value order comes from
  // the plan; the spend ceiling trims lowest-value first. Falls back to the
  // static policy task list when no plan exists, disclosed.
  const matrix = deriveScheduledMatrix({ config, plan, planError, evidenceDegraded });
  // The disclosed per-RUN spend projection (the undisclosed-4x class): each
  // matrix task is its own invocation with its own maxUsd, so one firing may
  // spend the SUM — a ceiling multiplication the serial shape's coupling
  // used to hide. Derived from the same per-task budgets the runner
  // enforces, and shown whether or not maxSpendPerRun caps it.
  const projectedMaxSpendUsd = matrix.run.reduce(
    (sum, taskId) => sum + budgetForTask(config, taskId).maxUsd,
    0,
  );

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'remediate-plan.v1',
          enabled: config.enabled,
          driver: config.agent.driver,
          driverKnown: !!driver,
          driverAvailable: availability ? availability.ok : null,
          model: config.agent.model,
          budget: config.agent.budget,
          salvage: config.salvage,
          schedule: config.schedule,
          tasks: rows,
          /** The per-task workflow matrix: derived from the OPEN work orders
           *  (value order, spend ceiling applied); a task with no open
           *  orders spawns no job. Static policy-list fallback when no plan
           *  exists (matrixSource says which). */
          matrixTasks: matrix.run,
          deferredBySpendCeiling: matrix.deferred,
          matrixSource: matrix.source,
          matrixEvidenceDegraded: evidenceDegraded,
          matrixNoOpenOrders: matrix.noOpenOrders,
          matrixLegacyOpenEnded: matrix.legacyOpenEnded,
          matrixDisclosures: matrix.disclosures,
          /** Classes the circuit breaker paused (orders carry per-order
           *  marks; this is the class-level summary with the reasons). */
          pausedClasses: pauses,
          maxSpendPerRun: config.maxSpendPerRun,
          /** What one firing may spend: Σ of the matrix tasks' per-task
           *  maxUsd (each matrix job is its own invocation with its own
           *  cap). Advisory where the driver only reports cost — see
           *  budgetSupport. */
          projectedMaxSpendUsd,
          unknownTasks: config.unknownTasks,
          /** The planned work orders (tier / recipe / budget / done summary)
           *  and the findings no class could take, with the reason. */
          ...(plan ? projectWorkOrders(plan) : { workOrders: [], undispatchable: [] }),
          /** Which floor source the plan read: 'live' only with --with-floor. */
          workOrderFloorSource: floorSource,
          /** Which source answered the deferral join (bom-artifact / live-scan
           *  / injected / not-needed). */
          workOrderDepScanSource: depScanSource,
          /** Degraded gather reads, phrased for humans (corrupt baseline,
           *  capped roots, which scan was paid). Empty = nothing degraded. */
          workOrderDisclosures: disclosures,
          workOrderPlanError: planError,
          /** Per-dimension driver capability: 'enforced' | 'reported' |
           *  'none'. A dimension below 'enforced' also appears in
           *  unenforceableCaps. */
          budgetSupport: driver ? driver.budgetSupport : null,
          unenforceableCaps: driver
            ? [
                ...(driver.budgetSupport.turns === 'enforced' ? [] : ['maxTurns']),
                ...(driver.budgetSupport.cost === 'enforced' ? [] : ['maxUsd']),
              ]
            : [],
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  logger.header('dxkit remediate plan');
  // The early return above guarantees a known driver on this path.
  const d = driver!;
  logger.info(
    `driver: ${d.id}` +
      (availability && !availability.ok ? ` (NOT available here: ${availability.reason})` : ''),
  );
  logger.info(
    `budget: ${config.agent.budget.maxTurns} turns, ${config.agent.budget.maxMinutes} min, ` +
      `$${config.agent.budget.maxUsd} — salvage: ${config.salvage}`,
  );
  if (d.budgetSupport.turns !== 'enforced') {
    logger.warn(`maxTurns is not enforceable by ${d.id}`);
  }
  if (d.budgetSupport.cost === 'none') {
    logger.warn(`maxUsd is not enforceable by ${d.id} (no spend reporting)`);
  } else if (d.budgetSupport.cost === 'reported') {
    logger.warn(
      `maxUsd is ADVISORY for ${d.id} (cost is reported after the run, not enforced ` +
        `mid-run) — the enforced turn cap and wall clock bound real spend`,
    );
  }
  logger.info(
    `per-run spend projection: up to $${projectedMaxSpendUsd} across ${matrix.run.length} ` +
      `task(s) in one firing` +
      (config.maxSpendPerRun > 0
        ? ` (maxSpendPerRun: $${config.maxSpendPerRun})`
        : ' (no remediate.maxSpendPerRun ceiling declared)'),
  );
  logger.info(`schedule (managed workflow): ${config.schedule}`);
  if (!config.enabled) {
    logger.dim('remediate.enabled is not set — the scheduled workflow is off; local runs work.');
  }
  for (const row of rows) {
    const source =
      row.modelSource === 'auto-tier'
        ? `auto: ${row.tier} tier (${row.tierWhy})`
        : row.modelSource === 'pinned-tier'
          ? `tier pinned by policy`
          : `pinned by policy`;
    logger.info(`  ${row.task} → ${row.model} (${source})`);
    if (row.warning) logger.warn(`    ${row.warning}`);
  }
  for (const unknown of config.unknownTasks) {
    logger.warn(`  unknown task in policy (ignored): '${unknown}'`);
  }
  if (matrix.deferred.length > 0) {
    logger.warn(
      `  spend ceiling ($${config.maxSpendPerRun}/run): ${matrix.deferred.join(', ')} ` +
        'deferred to the next firing (disclosed, never dropped).',
    );
  }
  logger.info(
    `scheduled matrix (${matrix.source}): ` +
      (matrix.run.length > 0 ? matrix.run.join(', ') : 'no jobs (nothing to spend on)'),
  );
  for (const d of matrix.disclosures) logger.dim(`  ${d}`);
  for (const pause of pauses) {
    logger.warn(`  circuit breaker: class '${pause.class}' PAUSED: ${pause.reason}`);
    logger.warn(`    unpause: ${pause.unpause}`);
  }

  if (planError) {
    logger.warn(`work orders: could not plan (${planError})`);
  } else if (plan) {
    logger.dim(`work orders: floor read from ${describeFloorSource(floorSource ?? 'none')}`);
    for (const d of disclosures) logger.dim(`work orders: ${d}`);
    logger.info(
      `work orders: ${plan.orders.length} planned` +
        (plan.undispatchable.length > 0
          ? `, ${plan.undispatchable.reduce((n, u) => n + u.findings.length, 0)} finding(s) undispatchable`
          : ''),
    );
    for (const order of plan.orders) logger.info(`  ${renderWorkOrderSummary(order)}`);
    for (const u of plan.undispatchable) {
      logger.dim(`  undispatchable (${u.findings.length}): ${u.reason}`);
    }
  }

  // The delivery line (#287): can the lanes actually LAND here? The ONE
  // prober the $0 preflight and doctor consume. Fail-open: an unverifiable
  // probe is one dim line, never a warning — the plan must not invent a
  // refusal it cannot evidence.
  const delivery = probeDeliveryPreconditions(process.cwd(), {
    branches: config.tasks.map((t) => remediateBranchFor(t)),
  });
  if (delivery.unverifiable) {
    logger.dim(
      'delivery: could not verify branch rules here (no gh / not GitHub) — probes run in CI too.',
    );
  } else {
    for (const p of delivery.probes) {
      if (p.verdict === 'ok') logger.info(`  delivery ${p.branch}: OK`);
      else if (p.verdict === 'blocked') logger.fail(`  delivery ${describeDeliveryProbe(p)}`);
      else logger.warn(`  delivery ${describeDeliveryProbe(p)}`);
    }
  }
}
