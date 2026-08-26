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
import * as logger from '../logger';
import { resolveRemediateConfig, tasksWithinSpendCeiling } from './config';
import { staleDispatchWorkflowNote } from './dispatch';
import { REMEDIATE_TASKS } from './tasks';

// The executor (run one task + land it) lives in `./execute`, `remediate
// plan` in `./plan-cli`, and the configured sequencing loop in
// `./configured-loop` (module-size splits); all re-exported so consumers
// keep one import surface.
export { runRemediatePlan, type RemediatePlanOptions } from './plan-cli';
export {
  runConfiguredLoop,
  type ConfiguredLoopOps,
  type ConfiguredLoopResult,
} from './configured-loop';
export { executeTask, taskRunJson, type ExecutorSeams, type TaskRun } from './execute';
import { headCommit, resetHardTo, runConfiguredLoop } from './configured-loop';
import { executeTask, taskRunJson, type TaskRun } from './execute';

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
  if (run.landingBlocked) logger.warn(run.landingBlocked);
  if (run.prUrl) logger.success(`standing PR: ${run.prUrl}`);
  console.log(''); // slop-ok
  process.stdout.write(run.result.ledger + '\n');
}

export interface RemediateOptions {
  readonly taskId: string;
  readonly land?: 'pr' | 'none';
  readonly json?: boolean;
  /** `--dispatch-override`: an explicit human dispatch that lifts a
   *  circuit-breaker pause on this task's classes for this one run. An
   *  EXPLICIT signal only — never inferred from ambient environment (an
   *  inferred override would let any non-Actions automation bypass every
   *  pause forever). */
  readonly dispatchOverride?: boolean;
}

/** `remediate --task <t>` — run one task, verify, optionally land. */
export async function runRemediate(cwd: string, opts: RemediateOptions): Promise<void> {
  const config = resolveRemediateConfig(cwd);
  logger.header(`dxkit remediate — ${opts.taskId}`);
  // The circuit-breaker override is the EXPLICIT --dispatch-override flag
  // and nothing else: the updated workflow passes it when a
  // workflow_dispatch names this task, and a human passes it at the
  // terminal. Ambient environment never bypasses a pause. A dispatch on a
  // pre-flag workflow is detectable and advised, not silently ignored.
  const staleNote = staleDispatchWorkflowNote(process.env, !!opts.dispatchOverride);
  if (staleNote) logger.warn(staleNote);
  const run = await executeTask(
    cwd,
    config,
    opts.taskId,
    opts.land === 'pr' ? 'pr' : 'none',
    {},
    { explicitDispatch: !!opts.dispatchOverride },
  );
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

  // The same spend ceiling the matrix reads from `plan --json` — the serial
  // path (local runs, pre-matrix installs) must not outspend the parallel one.
  const ceiling = tasksWithinSpendCeiling(config);
  if (ceiling.deferred.length > 0) {
    logger.warn(
      `spend ceiling ($${config.maxSpendPerRun}/run): deferring ${ceiling.deferred.join(', ')} ` +
        'to the next firing.',
    );
  }

  const outcome = await runConfiguredLoop(ceiling.run, {
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

/** Known task ids for the CLI usage line. */
export function remediateUsage(): string {
  return (
    `usage: vyuh-dxkit remediate --task <${REMEDIATE_TASKS.map((t) => t.id).join('|')}> ` +
    `[--land pr] [--dispatch-override] [--json] | remediate configured [--land pr] | remediate plan`
  );
}
