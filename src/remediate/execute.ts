/**
 * The remediate task executor — run ONE task through the verified-frame
 * runner and (optionally) land it. Split from `cli.ts` for module size (the
 * plan-cli / configured-loop precedent); the CLI re-exports everything, so
 * consumers keep one import surface.
 *
 * This is the wiring layer BETWEEN the runner and the lander, and it is
 * where two live deliver-layer defects sat with zero coverage (#273 landing
 * crash, #274 salvage bypass) — hence the injection seams: the runner and
 * the lander are each unit-tested through their own seams, but the wiring
 * between them was untestable without spawning a real agent.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { assembleLanePrBody } from '../pr/assemble';
import * as logger from '../logger';
import { trustedLocalContext } from '../analysis-trust';
import { detectDefaultBranch } from '../ship-installers';
import { startPhaseReporter } from '../lanes/heartbeat';
import { runCorrectnessFloor, type CorrectnessFloorResult } from '../analyzers/correctness/run';
import { detectActiveLanguages } from '../languages';
import { prepareResume, type ResumeDecision } from './resume';
import { budgetForTask, salvageForTask, type RemediateConfig } from './config';
import { readDispatchOverrides } from './dispatch';
import { driverById } from './registry';
import { remediateTaskById } from './tasks';
import { runRemediateTask, type RemediateResult } from './run';
import { landRemediateHead, remediateBranchFor } from './land';
import { appendLaneEvent, LANE_LEDGER_SCHEMA_VERSION } from '../lanes/ledger';

export interface TaskRun {
  readonly result: RemediateResult;
  readonly prUrl?: string;
  /** Why a land-eligible outcome was NOT landed (the branch guard). */
  readonly landRefused?: string;
  /** The landing itself FAILED (push refused by rules/permissions, PR
   *  creation failed): the disclosed cause + remedy. The attempt record
   *  and ledger still render — a refused push loses the delivery, never
   *  the evidence (#273). */
  readonly landingBlocked?: string;
  /** The landing ran (branch pushed, PR opened/updated). */
  readonly landed: boolean;
  /** Truthful per-task success: verified/no-op, or a landed salvage draft. */
  readonly clean: boolean;
}

/**
 * Phrase a landing failure for the record + job log: the git/gh output is
 * the evidence, and a rules/permissions-shaped refusal names the remedy —
 * the class exists on every GitHub repo (a GITHUB_TOKEN push touching
 * workflow files is refused without the `workflows` permission), not only
 * where a push ruleset restricts paths.
 */
function describeLandingFailure(err: unknown): string {
  const e = err as { message?: string; stderr?: string | Buffer };
  const stderr = (e.stderr ?? '').toString().trim();
  const message = (e.message ?? String(err)).split('\n')[0];
  const evidence = stderr ? `${message}\n${stderr}` : message;
  const rulesShaped =
    /\b403\b|GH006|GH013|protected branch|ruleset|refusing to allow|permission/i.test(evidence);
  const remedy = rulesShaped
    ? '\nThis looks like a repository-rules or token-permissions refusal. Remedies: grant ' +
      'the workflow token the permission the push needs (e.g. the `workflows` permission ' +
      'for workflow-file changes), add a ruleset bypass for the bot, or keep the task ' +
      'away from the restricted paths (a prompt-level constraint like "do not touch ' +
      '.github/" holds in practice).'
    : '';
  return (
    `the landing push/PR was refused — the verified work did NOT land, but the attempt ` +
    `record and ledger carry the evidence (branch state left for inspection).\n${evidence}${remedy}`
  );
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

/** Injection seams for the executor — tests only; production callers pass
 *  nothing (see the module doc for why they exist). */
export interface ExecutorSeams {
  readonly runTask?: typeof runRemediateTask;
  readonly landHead?: typeof landRemediateHead;
  readonly branch?: (cwd: string) => string;
  readonly defaultBranch?: (cwd: string) => string;
}

/** Run one task through the runner and (optionally) land it — the ONE
 *  executor `--task` and `configured` both use. */
export async function executeTask(
  cwd: string,
  config: RemediateConfig,
  taskId: string,
  land: 'pr' | 'none',
  seams: ExecutorSeams = {},
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
    result = await (seams.runTask ?? runRemediateTask)({
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
  const defaultBranch = (seams.defaultBranch ?? detectDefaultBranch)(cwd);
  const branch = (seams.branch ?? currentBranch)(cwd);
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
  // Evidence BEFORE delivery (#273): the attempt record — with the commit
  // range the workflow's patch-artifact fallback needs — is written before
  // the push, landed:false, and flipped by the finalize below on success. A
  // refused push (ruleset, token permissions) must lose the delivery, never
  // the 18 minutes of verified evidence: the crash-shaped alternative left
  // no record, no ledger, and an empty patch artifact.
  writeAttemptRecord(cwd, taskId, { result, landed: false, clean: false });
  let landResult: ReturnType<typeof landRemediateHead>;
  try {
    landResult = (seams.landHead ?? landRemediateHead)({
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
      // The ONE lane PR-body assembler (#288): a generated, labeled
      // diff-scoped narrative on top; the ledger VERBATIM below (the
      // contractual record, never paraphrased). Fail-open to ledger-only.
      // The narrative range is the ATTEMPT's own commits (baseHead..HEAD) —
      // the lane advances the checked-out default branch, so a
      // defaultBranch..HEAD range would be empty by construction.
      prBody: assembleLanePrBody({
        cwd,
        ledger: result.ledger,
        base: result.baseHead ?? defaultBranch,
      }),
      draft: draftSalvage || blockedSalvage,
      ledgerPath,
    });
  } catch (err) {
    // A landing failure is a DISCLOSED outcome, never a crash: the ledger,
    // record, and step summary all render as usual — the GateFailure
    // discipline applied to the land layer.
    return finalizeTaskRun(cwd, taskId, {
      result,
      landed: false,
      clean: false,
      landingBlocked: describeLandingFailure(err),
    });
  }
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
  writeAttemptRecord(cwd, taskId, run);
  if (run.landingBlocked) {
    logger.warn(run.landingBlocked);
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
    const first = (run.landingBlocked ?? run.result.note ?? run.result.outcome).split('\n')[0];
    process.stdout.write(
      `::warning title=remediate ${taskId} did not land::${run.result.outcome}: ${first}\n`,
    );
  }
  return run;
}

/** The machine-readable attempt record — written pre-push (landed:false)
 *  AND at every finalize, so the evidence exists no matter where the
 *  landing dies. Best-effort plumbing, never a failure. */
function writeAttemptRecord(cwd: string, taskId: string, run: TaskRun): void {
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
}

export function taskRunJson(run: TaskRun): Record<string, unknown> {
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
    landingBlocked: run.landingBlocked ?? null,
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
