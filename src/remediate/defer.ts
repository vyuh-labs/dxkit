/**
 * The executor's DEFERRAL layer for two-phase landing (4.4.7), split from
 * `execute.ts` at the module-size bar (the plan-cli / attempt-record
 * precedent). When the lane workflow signals deferred landing, the
 * executor routes its two push moments here instead of pushing:
 *
 *   - `deferPublishRows`: a non-landing outcome's order-outcome rows ride
 *     a 'publish-rows' landing record instead of the metadata-commit push;
 *   - `deferLanding`: a land-eligible outcome's push + standing PR ride a
 *     'land' record carrying the assembled PR title/body, the verified
 *     head, and this run's rows.
 *
 * Both are consumed only by `executeTask`; the record is consumed by
 * `remediate land` (`land-cli.ts`). Disclosed in output, never silent.
 */
import * as logger from '../logger';
import { remediateBranchFor } from '../lanes/branches';
import type { OrderOutcomeRow } from '../lanes/order-ledger';
import { currentHead } from './attempt-record';
import {
  clearLandingRecord,
  landingRecordPath,
  writeLandingRecord,
  LANDING_RECORD_SCHEMA,
  type LandingRecord,
} from './landing-record';
import type { RemediateResult } from './outcome';
import { landingArtifactName, pushPendingRef } from './pending-ref';

/** The Actions run URL from the ambient environment, or undefined (a
 *  local deferred run). Carried on the record so a later re-land can name
 *  where the verification evidence lives. */
export function runUrlFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const server = env.GITHUB_SERVER_URL;
  const repo = env.GITHUB_REPOSITORY;
  const run = env.GITHUB_RUN_ID;
  if (!server || !repo || !run || !/^https:\/\/\S+$/.test(server)) return undefined;
  return `${server}/${repo}/actions/runs/${run}`;
}

/** Injection seams for `deferLanding` (tests only; production passes
 *  nothing). */
export interface DeferSeams {
  readonly pushPending?: typeof pushPendingRef;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Defer a non-landing run's order-outcome rows: the circuit breaker's
 * evidence must survive, but the metadata-commit push would ride a
 * possibly-expired task credential, so the rows ride the record for the
 * fresh-credential land step. No rows clears any stale record so the land
 * step's existence guard stays truthful.
 */
export function deferPublishRows(
  cwd: string,
  taskId: string,
  outcome: RemediateResult['outcome'],
  orderRows: readonly OrderOutcomeRow[],
): void {
  if (orderRows.length === 0) {
    clearLandingRecord(cwd, taskId);
    return;
  }
  try {
    writeLandingRecord(cwd, {
      schema: LANDING_RECORD_SCHEMA,
      task: taskId,
      action: 'publish-rows',
      branch: remediateBranchFor(taskId),
      head: currentHead(cwd),
      outcome,
      orderRows,
    });
    logger.info(`order-outcome rows deferred to the landing step (${landingRecordPath(taskId)})`);
  } catch (err) {
    logger.warn(
      `order ledger: the landing record could not be written ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}), so the ` +
        'circuit breaker will not see this run; the job summary remains the evidence',
    );
  }
}

/** What `deferLanding` hands back for the executor's TaskRun: either the
 *  deferral disclosure, or the disclosed failure to defer. */
export type DeferLandingOutcome =
  | { readonly deferred: true; readonly landingDeferred: string }
  | { readonly deferred: false; readonly landingBlocked: string };

/**
 * Defer a land-eligible run: everything up to and including verification
 * and PR-body assembly already ran; the pushes now ride the landing
 * record. The order-ledger COMPOSE (which reads the standing branch) also
 * moves to land time, since a compose here could run against an
 * already-expired credential and silently drop the branch's prior rows.
 */
export function deferLanding(
  cwd: string,
  args: {
    readonly taskId: string;
    readonly result: RemediateResult;
    readonly defaultBranch: string;
    readonly prTitle: string;
    readonly prBody: string;
    readonly draft: boolean;
    readonly ledgerPath: string;
    /** The full run-ledger file (#374), when it could be written. */
    readonly runLedgerPath: string | null;
    readonly orderRows: readonly OrderOutcomeRow[];
  },
  seams: DeferSeams = {},
): DeferLandingOutcome {
  const runUrl = runUrlFromEnv(seams.env ?? process.env);
  const record: LandingRecord = {
    schema: LANDING_RECORD_SCHEMA,
    task: args.taskId,
    action: 'land',
    branch: remediateBranchFor(args.taskId),
    head: currentHead(cwd) ?? args.result.head ?? null,
    outcome: args.result.outcome,
    ...(args.result.baseHead ? { baseHead: args.result.baseHead } : {}),
    defaultBranch: args.defaultBranch,
    prTitle: args.prTitle,
    prBody: args.prBody,
    draft: args.draft,
    ledgerPath: args.ledgerPath,
    ...(args.runLedgerPath ? { runLedgerPath: args.runLedgerPath } : {}),
    orderRows: args.orderRows,
    ...(runUrl ? { runUrl } : {}),
  };
  try {
    writeLandingRecord(cwd, record);
  } catch (err) {
    return {
      deferred: false,
      landingBlocked:
        'the landing record could not be written, so the deferred landing step has nothing ' +
        `to push, and the verified work did NOT land ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    };
  }
  // Durability (#375): the verified head + the record ride the task's
  // pending ref under the credential this step already holds, BEFORE the
  // land step runs, so a landing that never completes leaves the work on
  // the remote. The record then names the ref a successful landing deletes.
  // Best-effort and disclosed either way: a failed push costs the durable
  // copy (the run artifact remains), never the landing.
  const push = (seams.pushPending ?? pushPendingRef)(cwd, record);
  if (push.pushed) {
    try {
      writeLandingRecord(cwd, { ...record, pendingRef: push.ref });
    } catch {
      // the record on disk still validates; only the delete-after-landing
      // convenience is lost, and the next plan step skips a landed tip
    }
  }
  const preserved = push.pushed
    ? `A copy of the verified work is preserved on '${push.ref}': if this landing is blocked, ` +
      'the next run re-lands it.'
    : `The verified work could NOT be preserved on '${push.ref}' (${push.note}): if this ` +
      `landing is blocked, it survives only in the run artifact ` +
      `'${landingArtifactName(args.taskId)}' (14 days).`;
  return {
    deferred: true,
    landingDeferred:
      `landing deferred: the verified work is recorded at ${landingRecordPath(args.taskId)} ` +
      "for the workflow's `remediate land` step, which pushes under a freshly minted " +
      `credential. ${preserved}`,
  };
}
