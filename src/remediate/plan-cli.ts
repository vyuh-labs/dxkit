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
          unknownTasks: config.unknownTasks,
          unenforceableCaps: driver
            ? [
                ...(driver.budgetSupport.turns ? [] : ['maxTurns']),
                ...(driver.budgetSupport.cost ? [] : ['maxUsd']),
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
  if (!driver.budgetSupport.turns) logger.warn(`maxTurns is not enforceable by ${driver.id}`);
  if (!driver.budgetSupport.cost) logger.warn(`maxUsd is not enforceable by ${driver.id}`);
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
}
