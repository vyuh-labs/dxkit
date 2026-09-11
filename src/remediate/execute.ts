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
import { landingDisclosure, landingEligibility, landingNotes, landRemediateHead } from './land';
import { landingPreflightRefusal, type LandingPreflightSeams } from './landing-preflight';
import { appendLaneEvent, LANE_LEDGER_SCHEMA_VERSION, writeRunLedger } from '../lanes/ledger';
import { renderRemediatePrBody } from './ledger-render';
import { orderOutcomeRows, publishOrderRows, writeLocalOrderLedger } from './order-outcomes';
import { remediateStamp } from './work-orders/breaker';
import {
  currentHead,
  describeLandingFailure,
  finalizeTaskRun,
  writeAttemptRecord,
  writeProvisionalRecord,
} from './attempt-record';
import { deferredLandingRequested } from './landing-record';
import { deferLanding, deferPublishRows, type DeferSeams } from './defer';

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
  /** What the landing left behind (`landingDisclosure`, #372): the branch
   *  HEAD actually reached, a preserved standing branch, a draft flip, a
   *  superseded attempt PR. Never silent. */
  readonly landedBranch?: string;
  readonly standingPreserved?: string;
  readonly draftFlipped?: string;
  readonly supersededAttemptPr?: string;
  /** The branch was pushed but no PR could be opened (#374): the note.
   *  Always paired with `landed: false` and `landingBlocked`. */
  readonly prMissing?: string;
  /** The PR body was cut to GitHub's size cap (#374): the disclosure. */
  readonly bodyTruncated?: string;
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

/** Injection seams for the executor — tests only; production callers pass
 *  nothing (see the module doc for why they exist). */
export interface ExecutorSeams extends LandingPreflightSeams {
  readonly runTask?: typeof runRemediateTask;
  readonly landHead?: typeof landRemediateHead;
  readonly branch?: (cwd: string) => string;
  readonly defaultBranch?: (cwd: string) => string;
  /** Injected for tests: the order-outcome ledger writers (3F). */
  readonly writeOrderLedger?: typeof writeLocalOrderLedger;
  readonly publishOrderRows?: typeof publishOrderRows;
  /** Injected for tests: the environment the deferred-landing signal is
   *  read from (production reads process.env). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests: the pending-ref push a deferred landing makes
   *  (#375; production pushes through real git). */
  readonly pushPending?: DeferSeams['pushPending'];
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
  // The $0 landing preflight (#286, `landing-preflight.ts`): when this run
  // intends to LAND, probe the branch pair's delivery preconditions BEFORE
  // any agent spawns; only positive refusal evidence refuses.
  if (land === 'pr') {
    const refusal = landingPreflightRefusal(cwd, taskId, seams);
    if (refusal) {
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

  // The ONE derivation of "does this run land, and as what" (the lander's
  // `landingEligibility`, pinned by the outcome parity test): a guardrail-
  // red salvage under draft-pr lands as a RED draft (its own guardrail
  // check keeps it unmergeable while the work + blocking findings survive
  // the runner), but only when the guardrail actually RAN and blocked and
  // containment left a tree some verification saw; the kept orders of a
  // partially-landed run land as a normal PR, non-clean, so the dropped
  // orders (named in the ledger) are never read as done.
  const { landEligible, draft, partialLanding, draftSalvage, blockedSalvage } = landingEligibility(
    result,
    salvage,
  );
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
  // The FULL ledger is committed on the branch beside the delivery ledger
  // (#374): every order line lives there, the PR body carries the summary
  // and names the file. Best-effort: with no file, the body names the job
  // step summary (which always carries the full ledger).
  const runLedgerRel = writeRunLedger(cwd, 'remediate', taskId, result.ledger);
  // The ONE lane PR-body assembler (#288): a generated, labeled
  // diff-scoped narrative on top; the ledger SUMMARY below (the
  // contractual record, never paraphrased: the summary collapses only what
  // the committed ledger lists in full, and is the ledger verbatim when
  // nothing collapsed). Fail-open to ledger-only. The byte cap is applied
  // once more downstream, at the gh boundary (`openOrUpdateStandingPr`).
  // The narrative range is the ATTEMPT's own commits (baseHead..HEAD) —
  // the lane advances the checked-out default branch, so a
  // defaultBranch..HEAD range would be empty by construction.
  const prBody = assembleLanePrBody({
    cwd,
    ledger: renderRemediatePrBody(result, { ledgerFile: runLedgerRel }),
    base: result.baseHead ?? defaultBranch,
  });
  if (deferred) {
    // Everything up to and including verification + PR-body assembly ran;
    // the pushes now ride the landing record for the workflow's
    // fresh-credential `remediate land` step (`./defer`).
    const outcome = deferLanding(
      cwd,
      {
        taskId,
        result,
        defaultBranch,
        prTitle,
        prBody,
        draft,
        ledgerPath,
        runLedgerPath: runLedgerRel,
        orderRows,
      },
      {
        ...(seams.pushPending ? { pushPending: seams.pushPending } : {}),
        ...(seams.env ? { env: seams.env } : {}),
      },
    );
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
      outcome: result.outcome,
      prTitle,
      prBody,
      draft,
      ledgerPath,
      ...(orderLedgerRel ? { orderLedgerPath: orderLedgerRel } : {}),
      ...(runLedgerRel ? { runLedgerPath: runLedgerRel } : {}),
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
  // What the landing left behind (#372) is disclosed on every surface: the
  // log here, the attempt record (the JSON) through the run, and the
  // attempt PR's own body (the lander). ONE projection, spread as is.
  const disclosure = landingDisclosure(landResult);
  for (const note of landingNotes(disclosure)) logger.warn(note);
  if (disclosure.prMissing) {
    // Pushed, no PR (#374): the work is on the branch where no one will
    // see it, so this is a DISCLOSED landing failure, never a success
    // (the class that shipped: "standing PR updated", exit 0, no PR). The
    // delivery-ledger event already rides the branch; it reaches the
    // default branch, and the Delivered count, only if a human opens the
    // PR by hand and merges it, which is then a real delivery.
    return finalizeTaskRun(cwd, taskId, {
      result,
      ...disclosure,
      landed: false,
      clean: false,
      landingBlocked: disclosure.prMissing,
    });
  }
  return finalizeTaskRun(cwd, taskId, {
    result,
    ...disclosure,
    landed: true,
    // A blocked salvage is NOT clean: the draft exists for inspection and
    // resume, but the task did not end well — the job stays red.
    clean: result.outcome === 'verified' || draftSalvage,
  });
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
