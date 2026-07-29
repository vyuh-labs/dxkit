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
  makeExec,
  openOrUpdateStandingPr,
  type Exec,
  type LandRefreshResult,
} from '../land-refresh';
import { internalGitPushArgs } from '../git-internal-push';

export function remediateBranchFor(taskId: string): string {
  return `dxkit/remediate-${taskId}`;
}

export interface LandRemediateOptions {
  readonly cwd: string;
  readonly taskId: string;
  readonly defaultBranch: string;
  readonly prTitle: string;
  readonly prBody: string;
  readonly draft?: boolean;
  readonly exec?: Exec;
}

export function landRemediateHead(opts: LandRemediateOptions): LandRefreshResult {
  const exec = opts.exec ?? makeExec(opts.cwd);
  const branch = remediateBranchFor(opts.taskId);
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
