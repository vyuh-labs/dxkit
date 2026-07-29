/**
 * `vyuh-dxkit remediate` — the user surface over the verified-frame runner.
 *
 *   - `remediate plan` (dry-run, no key, no network beyond nothing): per
 *     enabled task, the FULL resolution chain — task → tier → driver-native
 *     model — plus the budget envelope and which caps the driver can
 *     actually enforce. This is the answer to "which model will MY config
 *     use?", which no static doc can answer honestly.
 *   - `remediate --task <t> [--land pr]`: run one task through the runner;
 *     a `verified` outcome (or a `budget-exhausted` one under the draft-pr
 *     salvage policy) lands on the standing branch. Exit is truthful: only
 *     verified / no-op / a landed draft exit 0.
 *
 * The local CLI runs regardless of `remediate.enabled` — that knob gates the
 * SCHEDULED workflow (unattended); a human at a terminal is its own consent.
 */
import * as logger from '../logger';
import { trustedLocalContext } from '../analysis-trust';
import { detectDefaultBranch } from '../ship-installers';
import { resolveRemediateConfig } from './config';
import { resolveModelSetting } from './driver';
import { AGENT_DRIVERS, driverById } from './registry';
import { REMEDIATE_TASKS, remediateTaskById } from './tasks';
import { runRemediateTask, type RemediateResult } from './run';
import { landRemediateHead, remediateBranchFor } from './land';
import { appendLaneEvent, LANE_LEDGER_SCHEMA_VERSION } from '../lanes/ledger';

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
    };
  });

  const availability = driver ? driver.available(cwd) : undefined;

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
}

export interface RemediateOptions {
  readonly taskId: string;
  readonly land?: 'pr' | 'none';
  readonly json?: boolean;
}

/** `remediate --task <t>` — run, verify, optionally land. The local CLI IS
 *  the trusted boundary (a human at a terminal on their own checkout; the
 *  managed workflow checks out the default branch) — same doctrine as the
 *  bump lane's CLI. */
export async function runRemediate(cwd: string, opts: RemediateOptions): Promise<void> {
  const config = resolveRemediateConfig(cwd);
  const trust = trustedLocalContext();

  const result = await runRemediateTask({
    cwd,
    trust,
    taskId: opts.taskId,
    config,
    // CI injects the driver's credential env explicitly; locally the driver's
    // own default applies (claude-code: subscription mode).
    agentEnv: collectCredentialEnv(config.agent.driver),
  });

  let landed: RemediateResult & { prUrl?: string } = result;
  const wantLand = opts.land === 'pr';
  const draftSalvage = result.outcome === 'budget-exhausted' && config.salvage === 'draft-pr';
  if (wantLand && (result.outcome === 'verified' || draftSalvage)) {
    // The delivery-ledger event rides the PR's own diff (committed here,
    // pushed by the lander) — delivered means MERGED, never "PR opened".
    const ledgerPath = appendLaneEvent(cwd, {
      schema_version: LANE_LEDGER_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      lane: 'remediate',
      task: opts.taskId,
      outcome: 'landed',
      ...(draftSalvage ? { partial: true } : {}),
      ...(result.envelope?.costUsd !== undefined ? { costUsd: result.envelope.costUsd } : {}),
      ...(result.envelope?.resolvedModelId
        ? { resolvedModelId: result.envelope.resolvedModelId }
        : {}),
      ...(result.envelope ? { driver: result.envelope.driver } : {}),
    });
    const land = landRemediateHead({
      cwd,
      taskId: opts.taskId,
      defaultBranch: detectDefaultBranch(cwd),
      prTitle: `dxkit remediate: ${opts.taskId}${draftSalvage ? ' (partial, budget-bounded)' : ''}`,
      prBody: result.ledger,
      draft: draftSalvage,
      ledgerPath,
    });
    landed = { ...result, ...(land.prUrl ? { prUrl: land.prUrl } : {}) };
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ schema: 'remediate.v1', ...serializable(landed) }, null, 2) + '\n',
    );
  } else {
    logger.header(`dxkit remediate — ${opts.taskId}`);
    logger.info(`outcome: ${result.outcome}`);
    if (result.note) logger.info(result.note);
    if (landed.prUrl) logger.success(`standing PR: ${landed.prUrl}`);
    console.log(''); // slop-ok
    process.stdout.write(result.ledger + '\n');
  }

  // Truthful exit: verified/no-op (and a landed draft) are the only clean ends.
  const clean =
    result.outcome === 'verified' || result.outcome === 'no-op' || (draftSalvage && wantLand);
  if (!clean) process.exitCode = 1;
}

/** Credentials the configured driver declares, read from THIS process env
 *  (CI: injected by the workflow from repo secrets). Only declared names are
 *  forwarded — never the whole environment. */
function collectCredentialEnv(driverId: string): Record<string, string> {
  const driver = driverById(driverId);
  const out: Record<string, string> = {};
  for (const name of driver?.credentialEnv ?? []) {
    const value = process.env[name];
    if (value) out[name] = value;
  }
  return out;
}

function serializable(r: RemediateResult & { prUrl?: string }): Record<string, unknown> {
  return {
    outcome: r.outcome,
    task: r.task ?? null,
    note: r.note ?? null,
    partial: r.partial ?? false,
    envelope: r.envelope ?? null,
    guardrailVerdict: r.guardrailVerdict ?? null,
    branch: r.task ? remediateBranchFor(r.task) : null,
    prUrl: r.prUrl ?? null,
    ledger: r.ledger,
  };
}

/** Known task ids for the CLI usage line. */
export function remediateUsage(): string {
  return (
    `usage: vyuh-dxkit remediate --task <${REMEDIATE_TASKS.map((t) => t.id).join('|')}> ` +
    `[--land pr] [--json] | remediate plan`
  );
}
