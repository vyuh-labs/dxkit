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
import { describeDeliveryProbe, probeDeliveryPreconditions } from '../lanes/delivery-preconditions';
import { appendLaneEvent, LANE_LEDGER_SCHEMA_VERSION } from '../lanes/ledger';
import { orderOutcomeRows, publishOrderRows, writeLocalOrderLedger } from './order-outcomes';
import { remediateStamp } from './work-orders/breaker';
import { currentHead, writeAttemptRecord, writeProvisionalRecord } from './attempt-record';
import { deferredLandingRequested } from './landing-record';
import { deferLanding, deferPublishRows } from './defer';

// Attempt-record helpers live in `./attempt-record` (module-size split);
// re-exported so consumers keep one import surface.
export { taskRunJson } from './attempt-record';

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
  /** Two-phase landing (4.4.7): the pushes were DEFERRED to a landing
   *  record for the workflow's fresh-credential `remediate land` step:
   *  disclosed, never silent. */
  readonly landingDeferred?: string;
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
export function describeLandingFailure(err: unknown): string {
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
  /** Injected for tests: the $0 landing preflight (#286). */
  readonly probeDelivery?: typeof probeDeliveryPreconditions;
  /** Injected for tests: the order-outcome ledger writers (3F). */
  readonly writeOrderLedger?: typeof writeLocalOrderLedger;
  readonly publishOrderRows?: typeof publishOrderRows;
  /** Injected for tests: the environment the deferred-landing signal is
   *  read from (production reads process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Executor extras beyond the positional contract (kept separate from the
 *  test-only seams: these are production inputs). */
export interface ExecuteTaskExtras {
  /** A human explicitly asked for this task (workflow_dispatch naming it,
   *  or a local `remediate --task`): circuit-breaker pauses on its classes
   *  are overridden for this run, disclosed. */
  readonly explicitDispatch?: boolean;
}

/** Run one task through the runner and (optionally) land it — the ONE
 *  executor `--task` and `configured` both use. */
export async function executeTask(
  cwd: string,
  config: RemediateConfig,
  taskId: string,
  land: 'pr' | 'none',
  seams: ExecutorSeams = {},
  extras: ExecuteTaskExtras = {},
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
  // Evidence before the agent phase (#289): a SIGKILLed frame cannot write
  // its own record, so it exists BEFORE the spawn.
  writeProvisionalRecord(cwd, taskId, currentHead(cwd) ?? '');

  const reporter = startPhaseReporter(`remediate:${taskId}`);
  // The $0 landing preflight (#286): when this run intends to LAND, probe
  // the standing branch's delivery preconditions BEFORE any agent spawns —
  // a branch-creation ruleset that will 403 the landing is knowable from
  // one API read, and the live class spent full agent budgets discovering
  // it at push time. Only POSITIVE refusal evidence blocks; an
  // unanswerable probe proceeds (the preflight never invents a refusal).
  if (land === 'pr') {
    const preflight = (seams.probeDelivery ?? probeDeliveryPreconditions)(cwd, {
      branches: [remediateBranchFor(taskId)],
    });
    const blocked = preflight.probes.find((p) => p.verdict === 'blocked');
    if (blocked) {
      const note =
        `landing-unavailable (preflight, $0 — no agent was spawned): ` +
        `${describeDeliveryProbe(blocked)}`;
      // `task` is omitted: the preflight runs before task-id resolution
      // narrows the raw string; the note + ledger name it.
      const refusal: RemediateResult = {
        outcome: 'refused',
        note,
        ledger: `## dxkit remediate: ${taskId}\n\noutcome: **refused**\n\n${note}\n`,
      };
      return finalizeTaskRun(cwd, taskId, { result: refusal, landed: false, clean: false });
    }
  }

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
      // A guardrail-red draft is never a resume anchor (design F): its
      // blocking set rides the order prompts as a negative constraint.
      ...(!resume.resumed && resume.blockingContext
        ? { priorBlocking: resume.blockingContext }
        : {}),
      ...(extras.explicitDispatch ? { explicitDispatch: true } : {}),
    });
  } finally {
    reporter.stop();
  }

  // The scheduler's memory (rethink 3F): project this run's per-order
  // records into order-outcome ledger rows. Timestamps are stamped HERE by
  // the runner layer (the delivery-ledger convention; the planner only
  // reads). Rows exist only for landing-intent runs: a local `--land none`
  // run leaves the tree and the remote untouched.
  const orderRows =
    land === 'pr'
      ? orderOutcomeRows(result, taskId, {
          timestamp: new Date().toISOString(),
          stamp: remediateStamp(cwd),
        })
      : [];
  // Two-phase landing (4.4.7): when the lane workflow signals deferred
  // landing, this executor performs NO pushes: an App installation token
  // is hard-capped at one hour and the verify phases scale with repo size,
  // so every push moves to the workflow's post-task `remediate land` step,
  // which runs under a FRESHLY minted token. Local/inline runs (no signal)
  // keep the immediate landing below, through the same landRemediateHead.
  const deferred = land === 'pr' && deferredLandingRequested(seams.env ?? process.env);
  // Non-landing durability: a frame-authored metadata commit on the
  // standing branch (the resume-marker channel) — without it, the circuit
  // breaker is blind to exactly the failures it exists to remember. Under
  // deferred landing the commit's PUSH rides the landing record instead.
  const publishRows = (): void => {
    if (deferred) {
      deferPublishRows(cwd, taskId, result.outcome, orderRows);
      return;
    }
    if (orderRows.length === 0) return;
    const pub = (seams.publishOrderRows ?? publishOrderRows)(cwd, taskId, orderRows);
    if (!pub.published && pub.note) logger.warn(`order ledger: ${pub.note}`);
  };

  const draftSalvage = result.outcome === 'budget-exhausted' && salvage === 'draft-pr';
  // Guardrail-red under draft-pr salvage: the BLOCKED attempt is pushed as a
  // RED draft — its own required guardrail check keeps it unmergeable, so
  // "nothing merges" holds while the work + blocking findings survive the
  // ephemeral runner and the next run can RESUME from them (guardrail-red
  // was the outcome where the most valuable partial work died). Only a
  // RAN-and-blocked verdict qualifies; an unrunnable guardrail never pushes.
  // Only a guardrail that actually RAN and blocked earns a red draft: an
  // unrunnable verification must never produce a draft PR claiming a
  // guardrail block that never happened (review fix 5).
  const blockedSalvage =
    result.outcome === 'guardrail-red' && salvage === 'draft-pr' && result.guardrailRan === true;
  // Per-order landing (4.4.6): the kept orders of a partially-landed run
  // are verified work and land as a normal PR; the run stays non-clean so
  // the dropped orders (named in the ledger) are never read as done.
  const partialLanding = result.outcome === 'partially-landed';
  const landEligible =
    result.outcome === 'verified' || partialLanding || draftSalvage || blockedSalvage;
  if (land !== 'pr' || !landEligible) {
    publishRows();
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
    publishRows();
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
    ...(draftSalvage || blockedSalvage || partialLanding ? { partial: true } : {}),
    ...(blockedSalvage ? { blocked: true } : {}),
    ...(result.envelope?.costUsd !== undefined ? { costUsd: result.envelope.costUsd } : {}),
    ...(result.envelope?.resolvedModelId
      ? { resolvedModelId: result.envelope.resolvedModelId }
      : {}),
    ...(result.envelope ? { driver: result.envelope.driver } : {}),
  });
  const prTitle =
    `dxkit remediate: ${taskId}` +
    (blockedSalvage
      ? ' (blocked: guardrail-red — do not merge)'
      : draftSalvage
        ? ' (partial, budget-bounded)'
        : partialLanding
          ? ' (partial: some orders dropped, see the ledger)'
          : '');
  // The ONE lane PR-body assembler (#288): a generated, labeled
  // diff-scoped narrative on top; the ledger VERBATIM below (the
  // contractual record, never paraphrased). Fail-open to ledger-only.
  // The narrative range is the ATTEMPT's own commits (baseHead..HEAD) —
  // the lane advances the checked-out default branch, so a
  // defaultBranch..HEAD range would be empty by construction.
  const prBody = assembleLanePrBody({
    cwd,
    ledger: result.ledger,
    base: result.baseHead ?? defaultBranch,
  });
  const draft = draftSalvage || blockedSalvage;

  if (deferred) {
    // Everything up to and including verification + PR-body assembly ran;
    // the pushes now ride the landing record for the workflow's
    // fresh-credential `remediate land` step (`./defer`).
    const outcome = deferLanding(cwd, {
      taskId,
      result,
      defaultBranch,
      prTitle,
      prBody,
      draft,
      ledgerPath,
      orderRows,
    });
    if (!outcome.deferred) {
      return finalizeTaskRun(cwd, taskId, {
        result,
        landed: false,
        clean: false,
        landingBlocked: outcome.landingBlocked,
      });
    }
    return finalizeTaskRun(cwd, taskId, {
      result,
      landed: false,
      clean: result.outcome === 'verified' || draftSalvage,
      landingDeferred: outcome.landingDeferred,
    });
  }

  // The order-outcome rows ride the SAME landing commit (composed with any
  // unmerged standing-branch rows first, so a force-push never erases the
  // failure history a prior non-landing run recorded). Called even with no
  // rows of this run's own: the branch's rows (a resume-attempt count) must
  // still be carried across the force-push.
  const orderLedgerRel = (seams.writeOrderLedger ?? writeLocalOrderLedger)(cwd, taskId, orderRows);
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
      prTitle,
      prBody,
      draft,
      ledgerPath,
      ...(orderLedgerRel ? { orderLedgerPath: orderLedgerRel } : {}),
    });
  } catch (err) {
    // The landing failed; the outcome rows still matter to next week's
    // breaker — try the metadata channel before disclosing the failure.
    publishRows();
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
  if (run.landingDeferred) {
    logger.info(run.landingDeferred);
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
