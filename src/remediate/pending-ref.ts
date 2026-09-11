/**
 * The PENDING REF (#375): un-landed verified work survives the runner.
 *
 * The live class: the task step verified its work and wrote the landing
 * record, then the fresh-credential land step's `ls-remote` proof answered
 * "Repository not found" (transient; the sibling jobs landed minutes later
 * with the same App) and the step died before `remediate land` ran. The
 * record and the verified commits lived only on the ephemeral runner; the
 * next scheduled run started fresh and never re-landed them.
 *
 * The durable home is a machine-owned ref, `dxkit/remediate-<task>-pending`
 * (the ONE branch home, `lanes/branches.ts`). Right after the task step
 * writes the landing record, `pushPendingRef` builds ONE bookkeeping
 * commit over the verified head, carrying the record itself (at
 * `pendingLandingRecordPath`, under `.dxkit/lanes/` since `.dxkit/cache/`
 * is gitignored) plus the run's ledger files as they sit uncommitted in
 * the working tree, and force-pushes it with the task-step credential it
 * already holds. It is built with plumbing against a throwaway index, so
 * the checkout's HEAD never moves: the land step's head gate must still
 * see the verified head.
 *
 * Lifecycle, one deleter: a successful `remediate land` (the same run's
 * land step, or the next run's plan-step re-land in `pending-reland.ts`)
 * deletes the ref the record names (`deletePendingRef`), keeping the
 * remote clean; the standing branch then holds the work and its ledger
 * carries the history. A landing that does not complete leaves the ref
 * in place, disclosed, for the next run's plan step to re-land first.
 * Both push and delete are best-effort and DISCLOSED: a failed push costs
 * the durable copy (the run artifact remains, 14 days), never the landing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BOT_IDENTITY, makeExec, type Exec } from '../land-refresh';
import { internalGitPushArgs } from '../git-internal-push';
import { remediateBranchesFor } from '../lanes/branches';
import { pendingLandingRecordPath, type LandingRecord } from './landing-record';

/**
 * The run artifact the workflow uploads an UN-LANDED landing record as
 * (the human-inspectable copy, 14-day retention; `gh run download -n
 * <name>` reads it). ONE name: the template renders it from here and the
 * disclosures name it from here.
 */
export function landingArtifactName(taskId: string): string {
  return `remediate-${taskId}-landing`;
}

/** The record's ledger files the task step wrote into the working tree,
 *  in record order: the paths the pending commit carries and the re-land
 *  restores before the lander commits them. */
export function recordLedgerPaths(record: Pick<LandingRecord, 'ledgerPath' | 'runLedgerPath'>) {
  return [record.ledgerPath, record.runLedgerPath].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
}

export type PendingPushResult =
  | { readonly pushed: true; readonly ref: string; readonly tip: string }
  | { readonly pushed: false; readonly ref: string; readonly note: string };

function firstLine(err: unknown): string {
  const e = err as { message?: string; stderr?: string | Buffer };
  const stderr = (e.stderr ?? '').toString().trim().split('\n')[0];
  const message = (e.message ?? String(err)).split('\n')[0];
  return stderr ? `${message}: ${stderr}` : message;
}

/**
 * Push the verified head plus one bookkeeping commit (the record and the
 * run's ledger files) to the task's pending ref. See the module doc.
 */
export function pushPendingRef(
  cwd: string,
  record: LandingRecord,
  exec: Exec = makeExec(cwd),
): PendingPushResult {
  const ref = remediateBranchesFor(record.task).pending;
  if (record.action !== 'land' || record.head === null) {
    return { pushed: false, ref, note: 'no verified head to preserve (not a landing record)' };
  }
  const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-pending-ref-'));
  try {
    const env = { GIT_INDEX_FILE: path.join(indexDir, 'index') };
    // Start from the verified head's tree; layer the record and each
    // ledger file that exists in the working tree on top.
    exec('git', ['read-tree', record.head], { env });
    const entries: Array<[string, string]> = [
      [pendingLandingRecordPath(record.task), JSON.stringify(record, null, 2) + '\n'],
    ];
    for (const rel of recordLedgerPaths(record)) {
      const abs = path.join(cwd, rel);
      if (fs.existsSync(abs)) entries.push([rel, fs.readFileSync(abs, 'utf8')]);
    }
    for (const [rel, content] of entries) {
      const blob = exec('git', ['hash-object', '-w', '--stdin'], { input: content }).trim();
      exec('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], { env });
    }
    const tree = exec('git', ['write-tree'], { env }).trim();
    const tip = exec('git', [
      '-c',
      `user.name=${BOT_IDENTITY.name}`,
      '-c',
      `user.email=${BOT_IDENTITY.email}`,
      'commit-tree',
      tree,
      '-p',
      record.head,
      '-m',
      `chore(dxkit): pending landing record for ${record.task} [skip ci]`,
    ]).trim();
    // Force: machine-owned, rebuilt per run, never a pile.
    exec('git', internalGitPushArgs(`${tip}:refs/heads/${ref}`, { force: true }));
    return { pushed: true, ref, tip };
  } catch (err) {
    return { pushed: false, ref, note: firstLine(err) };
  } finally {
    fs.rmSync(indexDir, { recursive: true, force: true });
  }
}

/** Delete the pending ref after a successful landing (the ONE deleter's
 *  primitive). Best-effort: a leftover ref is re-read by the next run's
 *  plan step, whose stale-tip check then skips it, disclosed. */
export function deletePendingRef(cwd: string, ref: string, exec: Exec = makeExec(cwd)): boolean {
  try {
    exec('git', internalGitPushArgs(`:refs/heads/${ref}`));
    return true;
  } catch {
    return false;
  }
}
