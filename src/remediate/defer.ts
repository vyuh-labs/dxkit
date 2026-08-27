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
} from './landing-record';
import type { RemediateResult } from './outcome';

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
    readonly orderRows: readonly OrderOutcomeRow[];
  },
): DeferLandingOutcome {
  try {
    writeLandingRecord(cwd, {
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
      orderRows: args.orderRows,
    });
  } catch (err) {
    return {
      deferred: false,
      landingBlocked:
        'the landing record could not be written, so the deferred landing step has nothing ' +
        `to push, and the verified work did NOT land ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    };
  }
  return {
    deferred: true,
    landingDeferred:
      `landing deferred: the verified work is recorded at ${landingRecordPath(args.taskId)} ` +
      "for the workflow's `remediate land` step, which pushes under a freshly minted credential.",
  };
}
