/**
 * `vyuh-dxkit remediate plan` — the dry-run resolution chain (no key, no
 * spend): per enabled task, task -> tier -> driver-native model, the
 * effective per-task budget, and the spend-ceiling-trimmed matrix the
 * managed workflow reads. Split from `cli.ts` purely for module size.
 */
import * as logger from '../logger';
import { budgetForTask, resolveRemediateConfig, tasksWithinSpendCeiling } from './config';
import { resolveModelSetting } from './driver';
import { AGENT_DRIVERS, driverById } from './registry';
import { remediateTaskById } from './tasks';
import { remediateBranchFor } from '../lanes/branches';
import { describeDeliveryProbe, probeDeliveryPreconditions } from '../lanes/delivery-preconditions';

export interface RemediatePlanOptions {
  readonly json?: boolean;
}

/** `remediate plan` — the resolution chain, computed not narrated. */
export function runRemediatePlan(cwd: string, opts: RemediatePlanOptions = {}): void {
  const config = resolveRemediateConfig(cwd);
  const driver = driverById(config.agent.driver);

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
  // The run-level spend ceiling, applied here so the WORKFLOW's matrix reads
  // the trimmed list from the plan (one derivation) instead of re-deriving it.
  const ceiling = tasksWithinSpendCeiling(config);
  // The disclosed per-RUN spend projection (the undisclosed-4x class): each
  // matrix task is its own invocation with its own maxUsd, so one firing may
  // spend the SUM — a ceiling multiplication the serial shape's coupling
  // used to hide. Derived from the same per-task budgets the runner
  // enforces, and shown whether or not maxSpendPerRun caps it.
  const projectedMaxSpendUsd = ceiling.run.reduce(
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
          /** The per-task workflow matrix: enabled tasks within the run's
           *  spend ceiling, in declaration order. */
          matrixTasks: ceiling.run,
          deferredBySpendCeiling: ceiling.deferred,
          maxSpendPerRun: config.maxSpendPerRun,
          /** What one firing may spend: Σ of the matrix tasks' per-task
           *  maxUsd (each matrix job is its own invocation with its own
           *  cap). Advisory where the driver only reports cost — see
           *  budgetSupport. */
          projectedMaxSpendUsd,
          unknownTasks: config.unknownTasks,
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
  if (!driver) {
    logger.fail(
      `unknown agent driver '${config.agent.driver}' — known drivers: ` +
        AGENT_DRIVERS.map((d) => d.id).join(', '),
    );
    process.exitCode = 1;
    return;
  }
  logger.info(
    `driver: ${driver.id}` +
      (availability && !availability.ok ? ` (NOT available here: ${availability.reason})` : ''),
  );
  logger.info(
    `budget: ${config.agent.budget.maxTurns} turns, ${config.agent.budget.maxMinutes} min, ` +
      `$${config.agent.budget.maxUsd} — salvage: ${config.salvage}`,
  );
  if (driver.budgetSupport.turns !== 'enforced') {
    logger.warn(`maxTurns is not enforceable by ${driver.id}`);
  }
  if (driver.budgetSupport.cost === 'none') {
    logger.warn(`maxUsd is not enforceable by ${driver.id} (no spend reporting)`);
  } else if (driver.budgetSupport.cost === 'reported') {
    logger.warn(
      `maxUsd is ADVISORY for ${driver.id} (cost is reported after the run, not enforced ` +
        `mid-run) — the enforced turn cap and wall clock bound real spend`,
    );
  }
  logger.info(
    `per-run spend projection: up to $${projectedMaxSpendUsd} across ${ceiling.run.length} ` +
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
  if (ceiling.deferred.length > 0) {
    logger.warn(
      `  spend ceiling ($${config.maxSpendPerRun}/run): ${ceiling.deferred.join(', ')} ` +
        'deferred to the next firing (disclosed, never dropped).',
    );
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
