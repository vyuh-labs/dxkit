/**
 * RE-LANDING pending work (#375): the next run's plan step, before it
 * plans new work, looks for each configured task's pending ref (the
 * durable copy `pending-ref.ts` pushed), validates what it finds, and
 * lands it through the SAME `remediate land` path the workflow's land
 * step uses (Rule 2: one lander, one record shape, one validator).
 *
 * What "validates" means, all three before any push:
 *   - the record at the ref's tip parses through the ONE validator
 *     (`parseLandingRecord`) and is a landing record for THIS task;
 *   - the tip is exactly one bookkeeping commit atop the recorded verified
 *     head, touching only the record + the record's ledger paths (the ONE
 *     proof, `isOwnBookkeepingCommit`): a ref someone piled commits onto,
 *     or whose record names a head it does not sit on, is skipped with
 *     the reason and left in place for a human;
 *   - `runRemediateLand`'s own head gate then sees the verified head as
 *     the checkout's HEAD (this module detaches there and restores the
 *     ledger files from the tip so the lander commits exactly what the
 *     task step wrote).
 *
 * The checkout is returned to where it was afterwards, so the plan that
 * follows reads the default branch it was given. A shallow CI checkout
 * fetches only the tip and its parent (`--depth=2`); a full clone fetches
 * normally (a depth-limited fetch would shallow it).
 *
 * Fail-open, never silent: an unprobeable remote, a skipped ref and a
 * failed re-land each come back as a disclosed outcome the plan prints
 * (console and `--json`); the ref stays for the next run. Only runs under
 * `remediate plan --reland-pending` (the workflow's plan step); a local
 * `remediate plan` never fetches or pushes.
 */
import { makeExec, type Exec } from '../land-refresh';
import { remediateBranchesFor } from '../lanes/branches';
import { existingRemoteBranches } from '../lanes/order-ledger';
import { describePendingPreservation } from './attempt-record';
import { isOwnBookkeepingCommit } from './bookkeeping-commit';
import { runRemediateLand, type LandCliSeams } from './land-cli';
import {
  clearLandingRecord,
  parseLandingRecord,
  pendingLandingRecordPath,
  writeLandingRecord,
} from './landing-record';
import { recordLedgerPaths } from './pending-ref';

export interface RelandSeams extends LandCliSeams {
  /** Injected for tests: the git exec (production spawns real git). */
  readonly exec?: Exec;
}

export type PendingRelandOutcome =
  /** The ref held a valid record and landed through `remediate land`. */
  | {
      readonly task: string;
      readonly ref: string;
      readonly outcome: 'relanded';
      readonly landedBranch: string;
      readonly prUrl?: string;
    }
  /** The ref exists but could not be validated: left in place, reason named. */
  | {
      readonly task: string;
      readonly ref: string;
      readonly outcome: 'skipped';
      readonly reason: string;
    }
  /** The re-land ran and the landing failed again: the ref stays. */
  | {
      readonly task: string;
      readonly ref: string;
      readonly outcome: 'failed';
      readonly reason: string;
    }
  /** The remote could not be listed, so nothing is known about the ref. */
  | {
      readonly task: string;
      readonly ref: string;
      readonly outcome: 'unprobeable';
      readonly reason: string;
    };

/** One phrasing per outcome, for the console and the workflow annotation. */
export function describePendingReland(o: PendingRelandOutcome): string {
  switch (o.outcome) {
    case 'relanded':
      return (
        `pending work for '${o.task}' re-landed from '${o.ref}' onto '${o.landedBranch}'` +
        (o.prUrl ? ` (${o.prUrl})` : '') +
        '; the pending ref was deleted'
      );
    case 'skipped':
      return `pending ref '${o.ref}' was NOT re-landed (${o.reason}); it is left in place for inspection`;
    case 'failed':
      return `pending ref '${o.ref}' could not be re-landed (${o.reason}); it stays for the next run`;
    case 'unprobeable':
      return `pending ref '${o.ref}' could not be checked (${o.reason})`;
  }
}

/**
 * Re-land every configured task's pending ref that exists and validates.
 * Returns one outcome per ref that exists (or per task when the remote
 * could not be listed); an absent ref is silence, the common case.
 */
export function relandPendingWork(
  cwd: string,
  taskIds: readonly string[],
  seams: RelandSeams = {},
): PendingRelandOutcome[] {
  const exec = seams.exec ?? makeExec(cwd);
  const refs = taskIds.map((task) => ({ task, ref: remediateBranchesFor(task).pending }));
  const present = existingRemoteBranches(
    refs.map((r) => r.ref),
    exec,
  );
  if (present === null) {
    return refs.map((r) => ({
      ...r,
      outcome: 'unprobeable',
      reason: 'the remote refs could not be listed (ls-remote failed)',
    }));
  }
  return refs
    .filter((r) => present.has(r.ref))
    .map((r) => relandOne(cwd, r.task, r.ref, exec, seams));
}

function firstLine(err: unknown): string {
  const e = err as { message?: string; stderr?: string | Buffer };
  const stderr = (e.stderr ?? '').toString().trim().split('\n')[0];
  const message = (e.message ?? String(err)).split('\n')[0];
  return stderr ? `${message}: ${stderr}` : message;
}

function relandOne(
  cwd: string,
  task: string,
  ref: string,
  exec: Exec,
  seams: RelandSeams,
): PendingRelandOutcome {
  const skipped = (reason: string): PendingRelandOutcome => ({
    task,
    ref,
    outcome: 'skipped',
    reason,
  });
  const recordPath = pendingLandingRecordPath(task);
  let tip: string;
  try {
    const shallow =
      exec('git', ['rev-parse', '--is-shallow-repository'], { allowFail: true }).trim() === 'true';
    exec('git', [
      'fetch',
      '--no-tags',
      ...(shallow ? ['--depth=2'] : []),
      'origin',
      `+refs/heads/${ref}:refs/remotes/origin/${ref}`,
    ]);
    tip = exec('git', ['rev-parse', `refs/remotes/origin/${ref}`]).trim();
  } catch (err) {
    return skipped(`the ref could not be fetched: ${firstLine(err)}`);
  }
  let raw: string;
  try {
    raw = exec('git', ['show', `${tip}:${recordPath}`]);
  } catch {
    return skipped(`the ref's tip ${tip.slice(0, 12)} carries no landing record at ${recordPath}`);
  }
  const parsed = parseLandingRecord(raw, task, `${ref}:${recordPath}`);
  if ('error' in parsed) return skipped(parsed.error);
  const record = parsed.record;
  if (record.action !== 'land' || record.head === null) {
    return skipped('the record is not a landing record (nothing to re-land)');
  }
  // The tip must be exactly the record commit the task step built over the
  // verified head (the ONE bookkeeping proof); anything else is not ours.
  const ledgerPaths = recordLedgerPaths(record);
  if (!isOwnBookkeepingCommit(cwd, tip, record.head, [recordPath, ...ledgerPaths])) {
    return skipped(
      `the ref's tip ${tip.slice(0, 12)} is not one record commit atop the verified head ` +
        `${record.head.slice(0, 12)} the record names`,
    );
  }
  // Where the checkout was, restored in the finally below.
  const priorName = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const prior = priorName === 'HEAD' ? exec('git', ['rev-parse', 'HEAD']).trim() : priorName;
  try {
    exec('git', ['checkout', '-q', '--detach', record.head]);
    // The run's ledger files, as the task step wrote them, back into the
    // tree so the lander commits them exactly as an in-run landing would.
    const carried = ledgerPaths.filter((p) => {
      try {
        exec('git', ['cat-file', '-e', `${tip}:${p}`]);
        return true;
      } catch {
        return false;
      }
    });
    if (carried.length > 0) exec('git', ['checkout', '-q', tip, '--', ...carried]);
    const preserved = describePendingPreservation(
      ref,
      'the run that verified this work' +
        (record.runUrl ? ` (${record.runUrl})` : '') +
        ' did not complete its landing',
    );
    writeLandingRecord(cwd, {
      ...record,
      pendingRef: ref,
      prBody: `> ${preserved} This run re-landed it before planning new work.\n\n${record.prBody ?? ''}`,
    });
    const result = runRemediateLand(cwd, task, seams);
    if (result.outcome === 'landed') {
      return {
        task,
        ref,
        outcome: 'relanded',
        landedBranch: result.landedBranch,
        ...(result.prUrl ? { prUrl: result.prUrl } : {}),
      };
    }
    const reason =
      'error' in result ? result.error : 'note' in result ? result.note : result.outcome;
    return { task, ref, outcome: 'failed', reason: reason.split('\n')[0] };
  } catch (err) {
    return { task, ref, outcome: 'failed', reason: firstLine(err) };
  } finally {
    // The ref is the retry's source of truth, so the runtime copy a failed
    // landing keeps for a same-checkout retry is cleared here: a later
    // `remediate land` on this checkout must not find a record whose head
    // is not HEAD. Then the checkout goes back to where it was.
    clearLandingRecord(cwd, task);
    exec('git', ['checkout', '-q', '-f', prior], { allowFail: true });
  }
}
