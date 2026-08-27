/**
 * `vyuh-dxkit remediate land --task <t>`: phase two of two-phase landing.
 *
 * Runs as a dedicated workflow step AFTER the task step, under a FRESHLY
 * minted App token (the task's verify phases can outlive the one-hour
 * installation-token cap; this step's credential starts its hour at
 * delivery time). It reads the task's landing record (`landing-record.ts`),
 * validates it, then performs every push the task step deferred:
 *
 *   - action 'land': verify the checkout's HEAD still IS the verified head
 *     the record expects (a mismatch refuses with the remedy named; this
 *     step never pushes stale or foreign commits), write the composed
 *     order-outcome ledger (the standing-branch read happens HERE, where
 *     the credential is fresh), then push + open/update the standing PR
 *     through the SAME `landRemediateHead` the inline path uses (Rule 2);
 *   - action 'publish-rows': push only the order-outcome metadata commit
 *     (`publishOrderRows`), the circuit breaker's memory of a non-landing
 *     run.
 *
 * Idempotent: a successful landing clears the record, so a re-run is a
 * disclosed no-op. A failed push KEEPS the record (retryable) and exits
 * non-zero with the disclosed cause.
 *
 * SECURITY: this command executes NOTHING from the tree: no agent, no
 * repo scripts, no policy commands. It only replays recorded push/PR state
 * through git/gh, and every value read from the record is validated first
 * (`readLandingRecord`); the standing-branch name is recomputed from the
 * task id, never trusted from disk.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as logger from '../logger';
import { landRemediateHead } from './land';
import { publishOrderRows, writeLocalOrderLedger } from './order-outcomes';
import { currentHead } from './attempt-record';
import { describeLandingFailure } from './execute';
import {
  clearLandingRecord,
  landingRecordPath,
  readLandingRecord,
  writeLandingRecord,
  type LandingRecord,
} from './landing-record';

export interface LandCliSeams {
  readonly landHead?: typeof landRemediateHead;
  readonly publishRows?: typeof publishOrderRows;
  readonly writeOrderLedger?: typeof writeLocalOrderLedger;
  readonly head?: (cwd: string) => string | null;
}

export type RemediateLandOutcome =
  /** No record: nothing was deferred (already landed, or the task had
   *  nothing to deliver). A disclosed no-op, exit 0. */
  | { readonly outcome: 'no-record'; readonly note: string }
  /** The record failed validation: refused, record kept for inspection. */
  | { readonly outcome: 'invalid-record'; readonly error: string }
  /** HEAD no longer matches the verified head: refused, never pushed. */
  | { readonly outcome: 'stale-head'; readonly error: string }
  | { readonly outcome: 'landed'; readonly prUrl?: string }
  | { readonly outcome: 'rows-published' }
  /** Bookkeeping publish failed: disclosed warning, record kept for a
   *  manual retry; never fails the lane (parity with the inline path). */
  | { readonly outcome: 'rows-publish-failed'; readonly note: string }
  /** The push/PR failed: disclosed cause + remedy, record kept (retry). */
  | { readonly outcome: 'landing-failed'; readonly error: string };

/** Exit-code truth for the CLI wrapper: refusals and push failures are
 *  non-zero; no-ops and bookkeeping warnings are zero. */
export function landExitClean(result: RemediateLandOutcome): boolean {
  return (
    result.outcome === 'no-record' ||
    result.outcome === 'landed' ||
    result.outcome === 'rows-published' ||
    result.outcome === 'rows-publish-failed'
  );
}

/** Best-effort patch of the task's attempt record after the deferred
 *  landing resolves, so the workflow's evidence step (which uploads the
 *  attempt diff only when nothing landed) sees the truth. */
function patchAttemptRecord(cwd: string, taskId: string, patch: Record<string, unknown>): void {
  try {
    const abs = path.join(cwd, '.dxkit', 'cache', `remediate-${taskId}.json`);
    const parsed = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>;
    fs.writeFileSync(abs, JSON.stringify({ ...parsed, ...patch }, null, 2) + '\n', 'utf8');
  } catch {
    // evidence plumbing, never a failure
  }
}

export function runRemediateLand(
  cwd: string,
  taskId: string,
  seams: LandCliSeams = {},
): RemediateLandOutcome {
  const read = readLandingRecord(cwd, taskId);
  if (read === null) {
    return {
      outcome: 'no-record',
      note:
        `no landing record for '${taskId}' (${landingRecordPath(taskId)}), nothing to land: ` +
        'the task step either landed inline, already landed on a previous run of this ' +
        'command, or produced nothing to deliver.',
    };
  }
  if ('error' in read) return { outcome: 'invalid-record', error: read.error };
  const record = read.record;

  if (record.action === 'publish-rows') {
    const pub = (seams.publishRows ?? publishOrderRows)(cwd, taskId, record.orderRows);
    if (!pub.published) {
      return {
        outcome: 'rows-publish-failed',
        note:
          `${pub.note ?? 'order-outcome rows could not be published'}. The record is kept at ` +
          `${landingRecordPath(taskId)}; re-run \`remediate land --task ${taskId}\` to retry.`,
      };
    }
    clearLandingRecord(cwd, taskId);
    return { outcome: 'rows-published' };
  }

  // action 'land': the head gate. The record's head was validated as hex;
  // the checkout must still be exactly the verified commit; anything else
  // (a stray commit, a different checkout, a tampered record) is refused.
  const head = (seams.head ?? currentHead)(cwd);
  if (head === null || head !== record.head) {
    return {
      outcome: 'stale-head',
      error:
        `refusing to land '${taskId}': the checkout's HEAD (${head ?? 'unreadable'}) is not the ` +
        `verified head this record expects (${record.head ?? 'none recorded'}). The tree moved ` +
        'after verification, so pushing it would deliver unverified commits. Remedy: re-run the ' +
        'task (a fresh run re-verifies and writes a fresh record); do not push by hand.',
    };
  }

  // The order-ledger compose (standing-branch read) happens HERE, under
  // the fresh credential; the task step only recorded this run's rows.
  const orderLedgerRel = (seams.writeOrderLedger ?? writeLocalOrderLedger)(
    cwd,
    taskId,
    record.orderRows,
  );

  try {
    const landResult = (seams.landHead ?? landRemediateHead)({
      cwd,
      taskId,
      defaultBranch: record.defaultBranch ?? '',
      prTitle: record.prTitle ?? '',
      prBody: record.prBody ?? '',
      ...(record.draft !== undefined ? { draft: record.draft } : {}),
      ...(record.ledgerPath ? { ledgerPath: record.ledgerPath } : {}),
      ...(orderLedgerRel ? { orderLedgerPath: orderLedgerRel } : {}),
    });
    patchAttemptRecord(cwd, taskId, {
      landed: true,
      ...(landResult.prUrl ? { prUrl: landResult.prUrl } : {}),
    });
    clearLandingRecord(cwd, taskId);
    return { outcome: 'landed', ...(landResult.prUrl ? { prUrl: landResult.prUrl } : {}) };
  } catch (err) {
    // The lander commits its bookkeeping (delivery + order ledgers) BEFORE
    // the push, so a push failure can leave HEAD one dxkit-authored commit
    // past the recorded head. Advance the record to the head we observed
    // ourselves (disclosed), so a retry is not falsely refused as stale.
    const observed = (seams.head ?? currentHead)(cwd);
    const failure = describeLandingFailure(err);
    if (observed !== null && observed !== record.head) {
      const advanced: LandingRecord = {
        ...record,
        head: observed,
        headAdvancedNote:
          'a prior land attempt created its bookkeeping commit before the push failed; the ' +
          'expected head was advanced to the observed post-commit head for retry',
      };
      try {
        writeLandingRecord(cwd, advanced);
      } catch {
        // retry convenience only; the failure below is the real disclosure
      }
    }
    patchAttemptRecord(cwd, taskId, { landingBlocked: failure });
    return {
      outcome: 'landing-failed',
      error:
        `${failure}\nThe landing record is kept at ${landingRecordPath(taskId)}; ` +
        `re-run \`remediate land --task ${taskId}\` to retry once the cause is fixed.`,
    };
  }
}

/** The CLI wrapper: report + truthful exit code. */
export function runRemediateLandCli(cwd: string, taskId: string): void {
  logger.header(`dxkit remediate land: ${taskId}`);
  const result = runRemediateLand(cwd, taskId);
  switch (result.outcome) {
    case 'no-record':
      logger.info(result.note);
      break;
    case 'landed':
      if (result.prUrl) logger.success(`standing PR: ${result.prUrl}`);
      else logger.success('landed: branch pushed, standing PR updated');
      break;
    case 'rows-published':
      logger.info('order-outcome rows published to the standing branch');
      break;
    case 'rows-publish-failed':
      logger.warn(result.note);
      break;
    case 'invalid-record':
    case 'stale-head':
    case 'landing-failed':
      logger.fail(result.error);
      break;
  }
  if (!landExitClean(result)) process.exitCode = 1;
}
