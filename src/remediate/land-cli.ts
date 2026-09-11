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
import { appendStepSummary } from '../lanes/step-summary';
import { landingDisclosure, landingNotes, landRemediateHead, type LandingDisclosure } from './land';
import { publishOrderRows, writeLocalOrderLedger } from './order-outcomes';
import {
  currentHead,
  describeLandingFailure,
  describePendingPreservation,
  describePreflightFailure,
  landingRecordFields,
} from './attempt-record';
import { isOwnBookkeepingCommit } from './bookkeeping-commit';
import {
  clearLandingRecord,
  landingRecordPath,
  readLandingRecord,
  writeLandingRecord,
  type LandingRecord,
} from './landing-record';
import { deletePendingRef, landingArtifactName } from './pending-ref';

export interface LandCliSeams {
  readonly landHead?: typeof landRemediateHead;
  readonly publishRows?: typeof publishOrderRows;
  readonly writeOrderLedger?: typeof writeLocalOrderLedger;
  readonly head?: (cwd: string) => string | null;
  /** Injected for tests: the pending-ref deleter (#375). */
  readonly deletePendingRef?: typeof deletePendingRef;
}

/**
 * The workflow's land step ran its credential preflight (a bounded,
 * backed-off `ls-remote`) and every attempt failed (#375): the step hands
 * the count and the last error here so the landing is DISCLOSED (one
 * phrasing, `describePreflightFailure`) and recorded, and nothing pushes.
 */
export interface PreflightFailure {
  readonly attempts: number;
  readonly lastError: string;
}

/**
 * Where un-landed verified work survives, phrased once for every failure
 * path: the pending ref when the task step pushed it, else the run
 * artifact the workflow uploads the record as (14 days).
 */
function preservationNote(taskId: string, record: LandingRecord, why: string): string {
  if (record.action !== 'land') return '';
  if (record.pendingRef) return `\n${describePendingPreservation(record.pendingRef, why)}`;
  return (
    `\nthe verified work was NOT preserved on a pending ref (the task step's push failed or ` +
    `was skipped): it survives only in the run artifact '${landingArtifactName(taskId)}' and ` +
    `the attempt patch (14 days)`
  );
}

export type RemediateLandOutcome =
  /** No record: nothing was deferred (already landed, or the task had
   *  nothing to deliver). A disclosed no-op, exit 0. */
  | { readonly outcome: 'no-record'; readonly note: string }
  /** The record failed validation: refused, record kept for inspection. */
  | { readonly outcome: 'invalid-record'; readonly error: string }
  /** HEAD no longer matches the verified head: refused, never pushed. */
  | { readonly outcome: 'stale-head'; readonly error: string }
  /** Landed: the branch reached plus every disclosure the landing left
   *  (a preserved standing branch, a draft flip, a superseded attempt PR). */
  | ({ readonly outcome: 'landed' } & LandingDisclosure)
  /** The branch was pushed but NO PR could be opened (#374): the work is
   *  on the branch where no one will see it. Not "landed": the helper's
   *  note (usual cause + manual remedy) is the error, exit non-zero, and
   *  the attempt record reads `landed: false` with `prMissing` set. The
   *  record is cleared (the push happened; the remedy is manual). */
  | ({ readonly outcome: 'branch-pushed-no-pr'; readonly note: string } & LandingDisclosure)
  | { readonly outcome: 'rows-published' }
  /** Bookkeeping publish failed: disclosed warning, record kept for a
   *  manual retry; never fails the lane (parity with the inline path). */
  | { readonly outcome: 'rows-publish-failed'; readonly note: string }
  /** The push/PR failed: disclosed cause + remedy, record kept (retry). */
  | { readonly outcome: 'landing-failed'; readonly error: string }
  /** The credential preflight failed before any push (#375): disclosed,
   *  nothing pushed, record kept; the pending ref (or the artifact) holds
   *  the work for the next run's plan step. */
  | { readonly outcome: 'landing-blocked'; readonly error: string };

/** Exit-code truth for the CLI wrapper: refusals, push failures and a
 *  pushed branch with no PR are non-zero; no-ops and bookkeeping warnings
 *  are zero. */
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
  preflightFailure?: PreflightFailure,
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

  if (preflightFailure) {
    // Nothing pushes: the credential never proved itself. Disclose where
    // the work survives and keep the record (a persistent checkout can
    // retry; under Actions the next run's plan step re-lands the ref).
    const why = describePreflightFailure(preflightFailure.attempts, preflightFailure.lastError);
    const rows =
      record.action === 'publish-rows'
        ? '\nthe order-outcome rows were not recorded; the circuit breaker will not see this run ' +
          '(the job summary remains the evidence)'
        : '';
    const error =
      `${why}${preservationNote(taskId, record, why)}${rows}\nThe landing record is kept at ` +
      `${landingRecordPath(taskId)}; re-run \`remediate land --task ${taskId}\` to retry once ` +
      'the cause is fixed.';
    patchAttemptRecord(cwd, taskId, { landed: false, landingBlocked: error });
    return { outcome: 'landing-blocked', error };
  }

  if (record.action === 'publish-rows') {
    const pub = (seams.publishRows ?? publishOrderRows)(cwd, taskId, record.orderRows);
    if (!pub.published) {
      // Honest phrasing for the common (ephemeral-runner) case: the rows
      // are lost for this run and the next run's plan re-derives from the
      // repo state; the job summary remains the evidence. The record is
      // kept only because on a persistent checkout it makes a manual
      // retry possible.
      return {
        outcome: 'rows-publish-failed',
        note:
          `${pub.note ?? 'order-outcome rows could not be published'}. The circuit breaker ` +
          `will not see this run: the rows are lost with this runner (the job summary remains ` +
          `the evidence, and the next run's plan re-derives from the repo state). The record ` +
          `is kept at ${landingRecordPath(taskId)} in case this checkout persists for a retry.`,
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
      outcome: record.outcome,
      prTitle: record.prTitle ?? '',
      prBody: record.prBody ?? '',
      ...(record.draft !== undefined ? { draft: record.draft } : {}),
      ...(record.ledgerPath ? { ledgerPath: record.ledgerPath } : {}),
      ...(orderLedgerRel ? { orderLedgerPath: orderLedgerRel } : {}),
      ...(record.runLedgerPath ? { runLedgerPath: record.runLedgerPath } : {}),
    });
    // The same projection the inline path spreads (#372): the attempt
    // record (JSON) and this command's outcome carry every disclosure.
    const disclosure = landingDisclosure(landResult);
    clearLandingRecord(cwd, taskId);
    // The ONE deleter (#375): the work now lives on the branch the lander
    // pushed, so the pending copy is retired. A pushed-without-PR landing
    // also pushed, so the copy is retired there too. Best-effort: a
    // leftover ref is skipped by the next plan step with the reason.
    if (
      record.pendingRef &&
      !(seams.deletePendingRef ?? deletePendingRef)(cwd, record.pendingRef)
    ) {
      logger.warn(
        `the pending ref '${record.pendingRef}' could not be deleted after landing; the next ` +
          "run's plan step will skip it as already landed (its tip no longer matches a record " +
          'it could re-land)',
      );
    }
    if (disclosure.prMissing) {
      // Pushed, no PR (#374): the same shape the inline executor writes
      // (`landed: false`, the note as `landingBlocked`), so the workflow's
      // evidence step still uploads the attempt diff and nothing reads
      // this run as a delivery.
      patchAttemptRecord(cwd, taskId, {
        landed: false,
        landingBlocked: disclosure.prMissing,
        ...landingRecordFields(disclosure),
      });
      return { outcome: 'branch-pushed-no-pr', note: disclosure.prMissing, ...disclosure };
    }
    patchAttemptRecord(cwd, taskId, { landed: true, ...landingRecordFields(disclosure) });
    return { outcome: 'landed', ...disclosure };
  } catch (err) {
    const failure = describeLandingFailure(err);
    // Inline parity (the executor's landHead catch calls publishRows): a
    // refused landing must not blind the circuit breaker, so this run's
    // recorded rows still try the metadata-commit channel. Disclosed
    // either way; the A1 failure classes are exactly the runs whose rows
    // the breaker most needs.
    let rowsDisclosure = '';
    if (record.orderRows.length > 0) {
      const pub = (seams.publishRows ?? publishOrderRows)(cwd, taskId, record.orderRows);
      rowsDisclosure = pub.published
        ? '\nThe order-outcome rows were still recorded on the standing branch (the metadata ' +
          'channel), so the circuit breaker sees this run.'
        : `\nThe order-outcome rows also could not be recorded` +
          `${pub.note ? ` (${pub.note})` : ''}; the job summary remains the evidence.`;
    }
    // The lander commits its bookkeeping (delivery + order ledgers) BEFORE
    // the push, so a push failure can leave HEAD one dxkit-authored commit
    // past the recorded head. Advance the record ONLY when git proves the
    // delta is that bookkeeping commit: exactly one commit atop the
    // recorded head, touching nothing beyond the ledger paths this step
    // itself handed the lander. Anything else leaves the record unchanged,
    // so the retry refuses as stale instead of blessing a foreign commit.
    const observed = (seams.head ?? currentHead)(cwd);
    if (observed !== null && observed !== record.head && record.head !== null) {
      const allowedPaths = [record.ledgerPath, orderLedgerRel, record.runLedgerPath].filter(
        (p): p is string => typeof p === 'string' && p.length > 0,
      );
      if (isOwnBookkeepingCommit(cwd, observed, record.head, allowedPaths)) {
        const advanced: LandingRecord = {
          ...record,
          head: observed,
          headAdvancedNote:
            'a prior land attempt created its bookkeeping commit before the push failed; the ' +
            'expected head was advanced to the verified post-commit head for retry',
        };
        try {
          writeLandingRecord(cwd, advanced);
        } catch {
          // retry convenience only; the failure below is the real disclosure
        }
      }
    }
    const preserved = preservationNote(taskId, record, failure);
    patchAttemptRecord(cwd, taskId, { landingBlocked: `${failure}${preserved}` });
    return {
      outcome: 'landing-failed',
      error:
        `${failure}${rowsDisclosure}${preserved}\nThe landing record is kept at ` +
        `${landingRecordPath(taskId)}; re-run \`remediate land --task ${taskId}\` to retry once ` +
        'the cause is fixed.',
    };
  }
}

/** The CLI wrapper: report + truthful exit code. `seams` are test-only
 *  (production passes nothing), the same injection `runRemediateLand`
 *  takes, so the report + exit-code layer is pinned end to end. */
export function runRemediateLandCli(
  cwd: string,
  taskId: string,
  seams: LandCliSeams = {},
  preflightFailure?: PreflightFailure,
): void {
  logger.header(`dxkit remediate land: ${taskId}`);
  const result = runRemediateLand(cwd, taskId, seams, preflightFailure);
  switch (result.outcome) {
    case 'no-record':
      logger.info(result.note);
      break;
    case 'landed':
      for (const note of landingNotes(result)) logger.warn(note);
      if (result.prUrl) logger.success(`PR on ${result.landedBranch}: ${result.prUrl}`);
      else logger.success(`landed: ${result.landedBranch} pushed, PR updated`);
      break;
    case 'branch-pushed-no-pr':
      // Not a success line (#374): the branch exists, the PR does not, and
      // the note names the usual cause and the manual remedy.
      for (const note of landingNotes(result)) logger.warn(note);
      logger.fail(`not landed: ${result.note}`);
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
    case 'landing-blocked':
      logger.fail(result.error);
      break;
  }
  if (!landExitClean(result)) {
    // A landing that did not complete is visible from the run page and the
    // run summary, never only in the step log (#375): the annotation and
    // the summary carry the same text the console printed.
    const text = 'error' in result ? result.error : 'note' in result ? result.note : result.outcome;
    logger.ciAnnotate('error', `remediate ${taskId} did not land: ${text.split('\n')[0]}`);
    appendStepSummary(`## dxkit remediate: ${taskId} did not land\n\n${text}`);
    process.exitCode = 1;
  }
}
