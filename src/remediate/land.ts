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
 *
 * WHERE the push goes is decided here, once, for both landing moments (the
 * inline landing in `execute.ts` and the deferred `remediate land` step):
 * the standing branch is rebuilt per run, never a pile, EXCEPT when it
 * holds a VERIFIED landing a human has not merged yet and this run is a
 * salvage (#372). A worse outcome must never overwrite a better one whose
 * only copy is the branch, so the salvage goes to the task's attempt branch
 * as a draft and the standing PR is left exactly as reviewed. What the
 * standing PR holds is read through the ONE reader resume also consults
 * (`standing-pr.ts`), never a second parse.
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
import { readOpenStandingPr, type StandingPrState } from './standing-pr';
import type { RemediateOutcome } from './outcome';

// The standing-branch names live in the ONE leaf home the delivery
// prober also reads (`lanes/branches.ts`); re-exported for consumers.
import { remediateAttemptBranchFor, remediateBranchFor } from '../lanes/branches';
export { remediateAttemptBranchFor, remediateBranchFor } from '../lanes/branches';

export interface LandRemediateOptions {
  readonly cwd: string;
  readonly taskId: string;
  readonly defaultBranch: string;
  /** This run's outcome: the fact the landing-target decision turns on
   *  (with what the standing PR already holds). Required so no landing
   *  moment can skip the decision. */
  readonly outcome: RemediateOutcome;
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

/** A standing PR whose verified landing this run left untouched (#372):
 *  the disclosure every surface carries (console, attempt record JSON,
 *  the attempt PR's own body). */
export interface PreservedStandingPr {
  readonly standingBranch: string;
  readonly prUrl: string;
  /** The ledger outcome the standing PR records (`verified` or
   *  `partially-landed`). */
  readonly standingOutcome: string;
  readonly attemptBranch: string;
  /** This run's outcome, the salvage that went to the attempt branch. */
  readonly attemptOutcome: RemediateOutcome;
}

export interface LandRemediateResult extends LandRefreshResult {
  /** Present when HEAD went to the attempt branch instead of the standing
   *  one (`preserved.attemptBranch` names it); absent on a rebuild. */
  readonly preserved?: PreservedStandingPr;
}

/** Where a run's HEAD lands. */
export type LandingTarget =
  | { readonly kind: 'standing'; readonly branch: string }
  | { readonly kind: 'attempt'; readonly branch: string; readonly preserved: PreservedStandingPr };

/** Outcomes whose landing is verified, gate-passing work: worth keeping on
 *  the standing branch until a human decides on it. */
const VERIFIED_LANDINGS: ReadonlySet<string> = new Set(['verified', 'partially-landed']);
/** Outcomes that land only as a salvage draft: never allowed to replace a
 *  verified landing. */
const SALVAGE_LANDINGS: ReadonlySet<string> = new Set(['guardrail-red', 'budget-exhausted']);

/**
 * The landing-target policy, pure over its inputs (the ONE decision both
 * landing moments route through):
 *
 *   - standing PR absent, or recording a salvage / unknown outcome: the
 *     standing branch is rebuilt (a fresh attempt replacing an older fresh
 *     attempt; the pre-#372 behavior);
 *   - standing PR recording a VERIFIED landing: a new verified landing
 *     supersedes it (rebuild); a salvage does NOT touch it and goes to the
 *     attempt branch, disclosed.
 */
export function decideLandingTarget(
  taskId: string,
  outcome: RemediateOutcome,
  standing: StandingPrState | null,
): LandingTarget {
  const standingBranch = remediateBranchFor(taskId);
  const held = standing?.outcome;
  if (
    standing &&
    held !== undefined &&
    VERIFIED_LANDINGS.has(held) &&
    SALVAGE_LANDINGS.has(outcome)
  ) {
    const attemptBranch = remediateAttemptBranchFor(taskId);
    return {
      kind: 'attempt',
      branch: attemptBranch,
      preserved: {
        standingBranch,
        prUrl: standing.url,
        standingOutcome: held,
        attemptBranch,
        attemptOutcome: outcome,
      },
    };
  }
  return { kind: 'standing', branch: standingBranch };
}

/** The ONE phrasing of a preserved standing PR, shared by the console, the
 *  attempt record and the attempt PR body. */
export function describePreservedStandingPr(p: PreservedStandingPr): string {
  return (
    `standing PR ${p.prUrl} holds a verified landing (outcome '${p.standingOutcome}') awaiting ` +
    `merge and was left untouched; this '${p.attemptOutcome}' attempt was pushed to ` +
    `'${p.attemptBranch}' as a draft instead of replacing it.`
  );
}

export function landRemediateHead(opts: LandRemediateOptions): LandRemediateResult {
  const exec = opts.exec ?? makeExec(opts.cwd);
  // What the standing PR holds, read BEFORE anything is pushed. A failed
  // read is disclosed and falls back to the rebuild (the pre-#372
  // behavior): the lander never invents a verified landing to protect.
  let standing: StandingPrState | null = null;
  try {
    standing = readOpenStandingPr(exec, remediateBranchFor(opts.taskId));
  } catch (err) {
    logger.warn(
      `could not read the standing PR for '${remediateBranchFor(opts.taskId)}' ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}); rebuilding the ` +
        'standing branch as before',
    );
  }
  const target = decideLandingTarget(opts.taskId, opts.outcome, standing);
  const branch = target.branch;
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
  // Internal machine push, force: the target branch is rebuilt per run,
  // never a pile; --no-verify so the repo's own pre-push hook does not fire
  // against a bot push (gh #156 class).
  exec('git', internalGitPushArgs(`HEAD:refs/heads/${branch}`, { force: true }));
  const preserved = target.kind === 'attempt' ? target.preserved : undefined;
  // The attempt PR's body opens with the disclosure: the ledger below is
  // this attempt's, and a reader must not mistake it for the standing PR.
  const prBody = preserved
    ? `> ${describePreservedStandingPr(preserved)}\n\n${opts.prBody}`
    : opts.prBody;
  const pr = openOrUpdateStandingPr(exec, {
    branchName: branch,
    defaultBranch: opts.defaultBranch,
    prTitle: opts.prTitle,
    prBody,
    // A salvage on the attempt branch is always a draft (the standing PR is
    // the one a human may merge); otherwise as the caller decided.
    ...(preserved ? { draft: true } : opts.draft !== undefined ? { draft: opts.draft } : {}),
  });
  return { ...pr, ...(preserved ? { preserved } : {}) };
}
