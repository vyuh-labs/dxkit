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
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as logger from '../logger';
import { trustedLocalContext } from '../analysis-trust';
import { detectDefaultBranch } from '../ship-installers';
import { startPhaseReporter } from '../lanes/heartbeat';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../analyzers/correctness/run';
import { detectActiveLanguages } from '../languages';
import { prepareResume, type ResumeDecision } from './resume';
import {
  budgetForTask,
  resolveRemediateConfig,
  salvageForTask,
  tasksWithinSpendCeiling,
  type RemediateConfig,
} from './config';
import { readDispatchOverrides } from './dispatch';
import { driverById } from './registry';
import { REMEDIATE_TASKS, remediateTaskById } from './tasks';
import { runRemediateTask, type RemediateResult } from './run';
import { landRemediateHead, remediateBranchFor } from './land';
import { appendLaneEvent, LANE_LEDGER_SCHEMA_VERSION } from '../lanes/ledger';

// `remediate plan` lives in `./plan-cli` and the configured sequencing loop
// in `./configured-loop` (module-size splits); re-exported so consumers keep
// one import surface.
export { runRemediatePlan, type RemediatePlanOptions } from './plan-cli';
export {
  runConfiguredLoop,
  type ConfiguredLoopOps,
  type ConfiguredLoopResult,
} from './configured-loop';
import { headCommit, resetHardTo, runConfiguredLoop } from './configured-loop';

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
  // Per-task budget: the override-merged budget rides a task-scoped config
  // copy, so the runner's enforcement + ledger see the effective caps.
  // Dispatch-campaign overrides (env-transported, clamped) layer on top —
  // the runner receives the disclosure and folds it into the ledger.
  // Both derivations take the RAW id string — never `task ? … : fallback`.
  // 'custom' is deliberately outside the registry, so a registry-lookup
  // guard here is a second, weaker derivation of the same concept the
  // resolvers already own (the #274 class: it forced salvage to 'discard'
  // on a verified custom run, overriding explicit policy).
  const policyBudget = budgetForTask(config, taskId);
  const dispatch = readDispatchOverrides(process.env, policyBudget, config);
  // The concrete salvage decision for THIS task (the one resolver: explicit
  // policy wins, 'auto' follows the task's completion shape) — threaded into
  // the runner's config so the ledger note and the landing below agree.
  const salvage = salvageForTask(config, taskId);
  const taskConfig: RemediateConfig = {
    ...config,
    salvage,
    agent: {
      ...config.agent,
      budget: dispatch.any ? dispatch.budget : policyBudget,
      ...(dispatch.model !== undefined ? { model: dispatch.model } : {}),
    },
  };
  // Resume-from-salvage (opt-in, remediate.resume): the entry floor is
  // captured FIRST on the pristine tree, THEN the salvage branch is checked
  // out — attribution stays anchored to the original base, so a broken
  // partial reads NET-NEW and can never grandfather its own breakage.
  let entryFloor: CorrectnessFloorResult | undefined;
  let resume: ResumeDecision = { resumed: false };
  if (land === 'pr' && config.resume && taskId === 'custom') {
    // DELIBERATE, not a registry-lookup accident: a custom dispatch carries a
    // human-supplied prompt, and a later dispatch may carry a DIFFERENT one —
    // resuming would continue a prior attempt's goal under this run's prompt
    // and ledger. Disclosed here, never a silent guard (#274's second half).
    logger.warn(
      'resume: unavailable for custom dispatch tasks — a later dispatch may carry a ' +
        'different prompt than the salvaged attempt; starting fresh.',
    );
  }
  if (land === 'pr' && config.resume && taskId !== 'custom' && remediateTaskById(taskId)) {
    // (salvage above is the task-resolved decision — resume needs draft-pr)
    entryFloor = runCorrectnessFloor({
      cwd,
      changedFiles: [],
      scope: 'full',
      packs: detectActiveLanguages(cwd),
    });
    resume = prepareResume(cwd, taskId, { resume: config.resume, salvage });
    if (resume.note) logger.warn(`resume: ${resume.note}`);
    if (resume.resumed) {
      logger.info(`resuming budget-bounded attempt #${resume.attempt} from the salvage branch`);
    }
  }
  const reporter = startPhaseReporter(`remediate:${taskId}`);
  let result: RemediateResult;
  try {
    result = await runRemediateTask({
      cwd,
      trust: trustedLocalContext(),
      taskId,
      config: taskConfig,
      // CI injects the driver's credential env explicitly; locally the driver's
      // own default applies (claude-code: subscription mode).
      agentEnv: collectCredentialEnv(config.agent.driver),
      onPhase: (phase) => reporter.phase(phase),
      dispatch,
      ...(entryFloor !== undefined ? { entryFloor } : {}),
      ...(resume.resumed && resume.attempt !== undefined
        ? {
            resume: {
              attempt: resume.attempt,
              ...(resume.blockingContext ? { blockingContext: resume.blockingContext } : {}),
            },
          }
        : {}),
    });
  } finally {
    reporter.stop();
  }

  const draftSalvage = result.outcome === 'budget-exhausted' && salvage === 'draft-pr';
  // Guardrail-red under draft-pr salvage: the BLOCKED attempt is pushed as a
  // RED draft — its own required guardrail check keeps it unmergeable, so
  // "nothing merges" holds while the work + blocking findings survive the
  // ephemeral runner and the next run can RESUME from them (guardrail-red
  // was the outcome where the most valuable partial work died). Only a
  // RAN-and-blocked verdict qualifies; an unrunnable guardrail never pushes.
  const blockedSalvage = result.outcome === 'guardrail-red' && salvage === 'draft-pr';
  const landEligible = result.outcome === 'verified' || draftSalvage || blockedSalvage;
  if (land !== 'pr' || !landEligible) {
    return finalizeTaskRun(cwd, taskId, {
      result,
      landed: false,
      clean: result.outcome === 'verified' || result.outcome === 'no-op',
    });
  }

  // Landing guard (the standing branch is built from HEAD): a named
  // non-default branch would push unrelated commits into the standing PR.
  const defaultBranch = detectDefaultBranch(cwd);
  const branch = currentBranch(cwd);
  if (branch !== 'HEAD' && branch !== defaultBranch) {
    return finalizeTaskRun(cwd, taskId, {
      result,
      landed: false,
      clean: false,
      landRefused:
        `not landed: HEAD is on '${branch}', not '${defaultBranch}' — landing pushes HEAD ` +
        `to the standing branch, so run from '${defaultBranch}' (or let the scheduled ` +
        `workflow land it).`,
    });
  }

  // The delivery-ledger event rides the PR's own diff (committed by the
  // lander, pushed with the work) — delivered means MERGED, never "PR opened".
  const ledgerPath = appendLaneEvent(cwd, {
    schema_version: LANE_LEDGER_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    lane: 'remediate',
    task: taskId,
    outcome: 'landed',
    ...(draftSalvage || blockedSalvage ? { partial: true } : {}),
    ...(blockedSalvage ? { blocked: true } : {}),
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
    prTitle:
      `dxkit remediate: ${taskId}` +
      (blockedSalvage
        ? ' (blocked: guardrail-red — do not merge)'
        : draftSalvage
          ? ' (partial, budget-bounded)'
          : ''),
    prBody: result.ledger,
    draft: draftSalvage || blockedSalvage,
    ledgerPath,
  });
  return finalizeTaskRun(cwd, taskId, {
    result,
    ...(landResult.prUrl ? { prUrl: landResult.prUrl } : {}),
    landed: true,
    // A blocked salvage is NOT clean: the draft exists for inspection and
    // resume, but the task did not end well — the job stays red.
    clean: result.outcome === 'verified' || draftSalvage,
  });
}

/**
 * Every executeTask exit funnels through here: write the machine-readable
 * attempt record (the workflow's artifact step reads it to upload the diff
 * of a blocked/failed attempt — evidence must survive the ephemeral runner)
 * and, under Actions, annotate a not-landed attempt so it is visible from
 * the run page without opening logs.
 */
function finalizeTaskRun(cwd: string, taskId: string, run: TaskRun): TaskRun {
  try {
    const dir = path.join(cwd, '.dxkit', 'cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `remediate-${taskId}.json`),
      JSON.stringify(taskRunJson(run), null, 2) + '\n',
      'utf8',
    );
  } catch {
    // the record is evidence plumbing, never a failure
  }
  if (!run.clean) {
    // A non-clean outcome must be diagnosable from the run page: the agent
    // phase group otherwise closes with ZERO output (the driver captures the
    // CLI's streams), so the failure's own evidence — the driver-reported
    // cause and the transcript tail — surfaces in the LOG here. Log only,
    // never the ledger/PR body.
    if (run.result.envelope?.failure) {
      logger.warn(`driver-reported failure: ${run.result.envelope.failure}`);
    }
    if (run.result.transcriptTail) {
      logger.warn(`agent transcript (last lines):\n${run.result.transcriptTail}`);
    }
  }
  if (process.env.GITHUB_ACTIONS === 'true' && !run.clean) {
    const first = (run.result.note ?? run.result.outcome).split('\n')[0];
    process.stdout.write(
      `::warning title=remediate ${taskId} did not land::${run.result.outcome}: ${first}\n`,
    );
  }
  return run;
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
    landed: run.landed,
    // The commit range of the attempt — what the workflow's evidence step
    // format-patches into a run artifact when nothing landed.
    baseHead: r.baseHead ?? null,
    head: r.head ?? null,
    // Failure evidence (machine-readable record only — never the PR body).
    transcriptTail: r.transcriptTail ?? null,
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
