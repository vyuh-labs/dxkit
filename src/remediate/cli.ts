/**
 * `vyuh-dxkit remediate` — the user surface over the verified-frame runner.
 *
 *   - `remediate plan` (dry-run, no key, no spend): per enabled task, the
 *     FULL resolution chain — task → tier → driver-native model — plus the
 *     budget envelope and which caps the driver can actually enforce.
 *   - `remediate --task <t> [--land pr]`: run ONE task; a `verified` outcome
 *     (or a `budget-exhausted` one under the draft-pr salvage policy) lands
 *     on the standing branch.
 *   - `remediate configured [--land pr]`: run every policy-configured task
 *     through the same executor — the managed workflow's entry point, so
 *     the task list is read HERE through the one config reader, never by a
 *     shell parse in the template (the policy-get de-inlining discipline).
 *
 * Landing guard: the standing branch is built from HEAD, so landing is
 * allowed only from the default branch or a detached CI checkout — running
 * `--land pr` from a feature branch would push unrelated commits into the
 * standing PR, and is refused with the remedy named.
 *
 * The local CLI runs regardless of `remediate.enabled` — that knob gates the
 * SCHEDULED workflow (unattended); a human at a terminal is its own consent.
 * The local CLI is the trusted boundary (bump-lane doctrine).
 */
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import * as logger from '../logger';
import { trustedLocalContext } from '../analysis-trust';
import { detectDefaultBranch } from '../ship-installers';
import { resolveRemediateConfig, type RemediateConfig } from './config';
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

export interface TaskRun {
  readonly result: RemediateResult;
  readonly prUrl?: string;
  /** Why a land-eligible outcome was NOT landed (the branch guard). */
  readonly landRefused?: string;
  /** The landing ran (branch pushed, PR opened/updated). */
  readonly landed: boolean;
  /** Truthful per-task success: verified/no-op, or a landed salvage draft. */
  readonly clean: boolean;
}

/** Current branch name, or 'HEAD' for a detached (CI) checkout. */
function currentBranch(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return 'HEAD';
  }
}

/** Run one task through the runner and (optionally) land it — the ONE
 *  executor `--task` and `configured` both use. */
async function executeTask(
  cwd: string,
  config: RemediateConfig,
  taskId: string,
  land: 'pr' | 'none',
): Promise<TaskRun> {
  const result = await runRemediateTask({
    cwd,
    trust: trustedLocalContext(),
    taskId,
    config,
    // CI injects the driver's credential env explicitly; locally the driver's
    // own default applies (claude-code: subscription mode).
    agentEnv: collectCredentialEnv(config.agent.driver),
  });

  const draftSalvage = result.outcome === 'budget-exhausted' && config.salvage === 'draft-pr';
  const landEligible = result.outcome === 'verified' || draftSalvage;
  if (land !== 'pr' || !landEligible) {
    return {
      result,
      landed: false,
      clean: result.outcome === 'verified' || result.outcome === 'no-op',
    };
  }

  // Landing guard (the standing branch is built from HEAD): a named
  // non-default branch would push unrelated commits into the standing PR.
  const defaultBranch = detectDefaultBranch(cwd);
  const branch = currentBranch(cwd);
  if (branch !== 'HEAD' && branch !== defaultBranch) {
    return {
      result,
      landed: false,
      clean: false,
      landRefused:
        `not landed: HEAD is on '${branch}', not '${defaultBranch}' — landing pushes HEAD ` +
        `to the standing branch, so run from '${defaultBranch}' (or let the scheduled ` +
        `workflow land it).`,
    };
  }

  // The delivery-ledger event rides the PR's own diff (committed by the
  // lander, pushed with the work) — delivered means MERGED, never "PR opened".
  const ledgerPath = appendLaneEvent(cwd, {
    schema_version: LANE_LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    lane: 'remediate',
    task: taskId,
    outcome: 'landed',
    ...(draftSalvage ? { partial: true } : {}),
    ...(result.envelope?.costUsd !== undefined ? { costUsd: result.envelope.costUsd } : {}),
    ...(result.envelope?.resolvedModelId
      ? { resolvedModelId: result.envelope.resolvedModelId }
      : {}),
    ...(result.envelope ? { driver: result.envelope.driver } : {}),
  });
  const landResult = landRemediateHead({
    cwd,
    taskId,
    defaultBranch,
    prTitle: `dxkit remediate: ${taskId}${draftSalvage ? ' (partial, budget-bounded)' : ''}`,
    prBody: result.ledger,
    draft: draftSalvage,
    ledgerPath,
  });
  return {
    result,
    ...(landResult.prUrl ? { prUrl: landResult.prUrl } : {}),
    landed: true,
    clean: result.outcome === 'verified' || draftSalvage,
  };
}

/** Append a ledger to the GitHub Actions step summary when running in CI. */
function appendStepSummary(ledger: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, ledger + '\n\n', 'utf8');
  } catch {
    // summary is best-effort decoration — never a failure
  }
}

function reportTaskRun(run: TaskRun, json: boolean): void {
  if (json) return; // aggregate JSON is emitted by the caller
  logger.info(`outcome: ${run.result.outcome}`);
  if (run.result.note) logger.info(run.result.note);
  if (run.landRefused) logger.warn(run.landRefused);
  if (run.prUrl) logger.success(`standing PR: ${run.prUrl}`);
  console.log(''); // slop-ok
  process.stdout.write(run.result.ledger + '\n');
}

function taskRunJson(run: TaskRun): Record<string, unknown> {
  const r = run.result;
  return {
    outcome: r.outcome,
    task: r.task ?? null,
    note: r.note ?? null,
    partial: r.partial ?? false,
    envelope: r.envelope ?? null,
    guardrailVerdict: r.guardrailVerdict ?? null,
    branch: r.task ? remediateBranchFor(r.task) : null,
    prUrl: run.prUrl ?? null,
    landRefused: run.landRefused ?? null,
    ledger: r.ledger,
  };
}

export interface RemediateOptions {
  readonly taskId: string;
  readonly land?: 'pr' | 'none';
  readonly json?: boolean;
}

/** `remediate --task <t>` — run one task, verify, optionally land. */
export async function runRemediate(cwd: string, opts: RemediateOptions): Promise<void> {
  const config = resolveRemediateConfig(cwd);
  logger.header(`dxkit remediate — ${opts.taskId}`);
  const run = await executeTask(cwd, config, opts.taskId, opts.land === 'pr' ? 'pr' : 'none');
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ schema: 'remediate.v1', ...taskRunJson(run) }, null, 2) + '\n',
    );
  } else {
    reportTaskRun(run, false);
  }
  appendStepSummary(run.result.ledger);
  if (!run.clean) process.exitCode = 1;
}

export interface RemediateConfiguredOptions {
  readonly land?: 'pr' | 'none';
  readonly json?: boolean;
}

/** The seams the configured loop drives — injectable so the sequencing
 *  POLICY is unit-testable without git or an agent. */
export interface ConfiguredLoopOps {
  execute(taskId: string): Promise<TaskRun>;
  /** Current commit, or null when unreadable. */
  head(): string | null;
  /** Hard-reset the tree to a commit; false on failure. */
  resetTo(head: string): boolean;
  report(taskId: string, run: TaskRun): void;
}

export interface ConfiguredLoopResult {
  readonly runs: ReadonlyArray<{ readonly taskId: string; readonly run: TaskRun }>;
  /** Tasks NOT run because an earlier task left unlanded work in the tree
   *  (or a reset failed) — disclosed, never silent. */
  readonly skipped: readonly string[];
  readonly failed: boolean;
}

/**
 * The sequencing policy of `remediate configured` (X-1): tasks share one
 * tree, so isolation between them is explicit —
 *
 *   - after a LANDED task, the tree resets to the initial head (the work
 *     lives on the pushed standing branch), so the next task's PR carries
 *     ONLY its own diff;
 *   - a task that left UNLANDED work in the tree (floor-red, guardrail-red,
 *     a discarded partial, a refused landing) STOPS the loop: resetting
 *     would destroy the work the ledger promises stays for inspection, and
 *     running the next task on a polluted tree would stack diffs into its
 *     PR. The remaining tasks are named as skipped; the next scheduled run
 *     picks them up on a fresh checkout.
 */
export async function runConfiguredLoop(
  tasks: readonly string[],
  ops: ConfiguredLoopOps,
): Promise<ConfiguredLoopResult> {
  const initialHead = ops.head();
  const runs: Array<{ taskId: string; run: TaskRun }> = [];
  let skipped: string[] = [];
  let failed = false;

  for (let i = 0; i < tasks.length; i++) {
    const taskId = tasks[i];
    const run = await ops.execute(taskId);
    ops.report(taskId, run);
    runs.push({ taskId, run });
    if (!run.clean) failed = true;

    const moved = initialHead !== null && ops.head() !== initialHead;
    if (!moved) continue;

    const remaining = tasks.slice(i + 1);
    if (run.landed) {
      if (ops.resetTo(initialHead!)) continue;
      skipped = remaining; // a failed reset means a polluted tree — stop
      failed = true;
      break;
    }
    skipped = remaining;
    break;
  }
  return { runs, skipped, failed };
}

/**
 * `remediate configured` — every policy-configured task through the one
 * executor, sequenced by `runConfiguredLoop`. The managed workflow calls
 * exactly this; per-task ledgers land in the step summary, unknown task ids
 * and skipped tasks are disclosed, and the exit code is the truthful
 * aggregate (any non-clean task fails the job).
 */
export async function runRemediateConfigured(
  cwd: string,
  opts: RemediateConfiguredOptions = {},
): Promise<void> {
  const config = resolveRemediateConfig(cwd);
  const land = opts.land === 'pr' ? 'pr' : 'none';

  for (const unknown of config.unknownTasks) {
    logger.warn(`unknown task in policy (ignored): '${unknown}'`);
  }

  const outcome = await runConfiguredLoop(config.tasks, {
    execute: (taskId) => executeTask(cwd, config, taskId, land),
    head: () => headCommit(cwd),
    resetTo: (head) => resetHardTo(cwd, head),
    report: (taskId, run) => {
      logger.header(`dxkit remediate — ${taskId}`);
      reportTaskRun(run, !!opts.json);
      appendStepSummary(run.result.ledger);
    },
  });

  if (outcome.skipped.length > 0) {
    logger.warn(
      `skipped ${outcome.skipped.length} remaining task(s) (${outcome.skipped.join(', ')}) — ` +
        'an earlier task left unlanded work in the tree; the next scheduled run picks them up.',
    );
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'remediate-configured.v1',
          tasks: outcome.runs.map(({ run }) => taskRunJson(run)),
          unknownTasks: config.unknownTasks,
          skipped: outcome.skipped,
          failed: outcome.failed,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (outcome.failed) process.exitCode = 1;
}

/** Current commit sha, or null when unreadable. */
function headCommit(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Hard-reset to a commit (used only after a LANDED task — the work is on
 *  the pushed standing branch). False on failure. */
function resetHardTo(cwd: string, head: string): boolean {
  try {
    execFileSync('git', ['reset', '--hard', head], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
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

/** Known task ids for the CLI usage line. */
export function remediateUsage(): string {
  return (
    `usage: vyuh-dxkit remediate --task <${REMEDIATE_TASKS.map((t) => t.id).join('|')}> ` +
    `[--land pr] [--json] | remediate configured [--land pr] | remediate plan`
  );
}
