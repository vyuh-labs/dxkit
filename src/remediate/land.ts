/**
 * Landing a verified remediation — the agent's COMMITS (base..HEAD on the
 * current checkout) pushed to the one standing branch per task
 * (`dxkit/remediate-<task>`), with the verification ledger as the PR body.
 *
 * Unlike the refresh lander (which commits a path set from the working
 * tree), the remediate lane's work is already committed — the agent commits
 * per its ground rules and the runner's sweep catches leftovers — so the
 * landing is a force-push of HEAD plus the shared standing-PR mechanics
 * (`openOrUpdateStandingPr`, Rule 2). A budget-exhausted salvage under the
 * `draft-pr` policy lands as a DRAFT; `discard` never reaches this module.
 */
import {
  BOT_IDENTITY,
  makeExec,
  openOrUpdateStandingPr,
  type Exec,
  type LandRefreshResult,
} from '../land-refresh';
import { internalGitPushArgs } from '../git-internal-push';
import * as logger from '../logger';

// The standing-branch name lives in the ONE leaf home the delivery
// prober also reads (`lanes/branches.ts`); re-exported for consumers.
import { remediateBranchFor } from '../lanes/branches';
export { remediateBranchFor } from '../lanes/branches';

export interface LandRemediateOptions {
  readonly cwd: string;
  readonly taskId: string;
  readonly defaultBranch: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly draft?: boolean;
  /** Repo-relative delivery-ledger file to commit ON TOP of the agent's
   *  work before the push — the event then rides the PR's own diff, so
   *  "delivered" means MERGED (design §10). */
  readonly ledgerPath?: string;
  /** Repo-relative order-outcome ledger file (the scheduler's memory,
   *  rethink 3F), committed in the same path-scoped bookkeeping commit. */
  readonly orderLedgerPath?: string;
  readonly exec?: Exec;
}

export function landRemediateHead(opts: LandRemediateOptions): LandRefreshResult {
  const exec = opts.exec ?? makeExec(opts.cwd);
  const branch = remediateBranchFor(opts.taskId);
  const ledgerPaths = [
    ...(opts.ledgerPath ? [opts.ledgerPath] : []),
    ...(opts.orderLedgerPath ? [opts.orderLedgerPath] : []),
  ];
  if (ledgerPaths.length > 0) {
    exec('git', ['add', ...ledgerPaths]);
    // Explicit bot identity: a CI runner has none ambient, and a machine
    // commit should carry machine provenance locally too.
    exec(
      'git',
      [
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        'commit',
        '-m',
        'chore: record the remediation delivery (dxkit lane ledger)',
        // PATH-SCOPED, load-bearing: a bare `git commit` takes whatever else
        // is staged. The runner's leftover sweep stages with `git add -A`
        // before it commits, so a sweep whose commit failed leaves that
        // content in the index — an unscoped ledger commit would bundle it
        // and force-push unreviewed agent working state under a message that
        // reads as bookkeeping.
        '--',
        ...ledgerPaths,
      ],
      { allowFail: true },
    );
    // A bookkeeping failure must not block landing verified work, but a
    // silently lost event undercounts Delivered — say so (X-3).
    const dirty = exec('git', ['status', '--porcelain', '--', ...ledgerPaths], {
      allowFail: true,
    }).trim();
    if (dirty !== '') {
      logger.warn(
        'the delivery-ledger event could not be committed — this landing will be missing ' +
          "from `vyuh-dxkit metrics`' Delivered count",
      );
    }
  }
  // Internal machine push, force: the standing branch is rebuilt per run,
  // never a pile; --no-verify so the repo's own pre-push hook does not fire
  // against a bot push (gh #156 class).
  exec('git', internalGitPushArgs(`HEAD:refs/heads/${branch}`, { force: true }));
  return openOrUpdateStandingPr(exec, {
    branchName: branch,
    defaultBranch: opts.defaultBranch,
    prTitle: opts.prTitle,
    prBody: opts.prBody,
    ...(opts.draft !== undefined ? { draft: opts.draft } : {}),
  });
}
