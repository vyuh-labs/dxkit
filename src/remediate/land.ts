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
 * holds a VERIFIED landing a human has not merged yet (or nothing readable
 * says what it holds) and this run is a salvage (#372). A worse outcome
 * must never overwrite a better one whose only copy is the branch, and an
 * unknown is never force-pushed over, so the salvage goes to the task's
 * attempt branch as a draft and the standing branch is left exactly as
 * reviewed. What the branches hold is read through the ONE reader resume
 * and the ledger also consult (`standing-branch.ts`): the landing marker
 * this module commits into the order ledger at every landing, with the
 * open PR's body as corroboration.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BOT_IDENTITY,
  makeExec,
  openOrUpdateStandingPr,
  type Exec,
  type LandRefreshResult,
} from '../land-refresh';
import { internalGitPushArgs } from '../git-internal-push';
import * as logger from '../logger';
import { landingRow, orderLedgerPath, serializeOrderRows } from '../lanes/order-ledger';
import { remediateStamp } from './work-orders/breaker';
import {
  branchHolding,
  readOpenStandingPr,
  readRemediateBranchStates,
  type LaneBranchState,
  type StandingPrState,
} from './standing-branch';
import { isSalvageLanding, type RemediateOutcome, type RemediateResult } from './outcome';

// The branch names live in the ONE leaf home the delivery prober also
// reads (`lanes/branches.ts`); re-exported for consumers.
import { remediateBranchesFor, type RemediateBranches } from '../lanes/branches';
export {
  remediateAttemptBranchFor,
  remediateBranchFor,
  remediateBranchesFor,
} from '../lanes/branches';

export interface LandRemediateOptions {
  readonly cwd: string;
  readonly taskId: string;
  readonly defaultBranch: string;
  /** This run's outcome: the fact the landing-target decision turns on
   *  (with what the standing branch already holds). Required so no landing
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
   *  rethink 3F), committed in the same path-scoped bookkeeping commit.
   *  The landing marker is appended to it here (or to a fresh file when
   *  the run composed none). */
  readonly orderLedgerPath?: string;
  /** Repo-relative FULL run ledger (`runLedgerPath`, #374): every order
   *  line, committed in the same bookkeeping commit; the PR body carries
   *  the summary and names this file, and the size guard's marker points
   *  at it when even the summary must be cut. */
  readonly runLedgerPath?: string;
  readonly exec?: Exec;
}

/**
 * The ONE derivation of "does this run land, and as what" (Rule 2.30),
 * shared by the executor and the parity test: `draft` is exactly "a
 * land-eligible SALVAGE" (`isSalvageLanding`), never a second table of
 * outcome words. A guardrail-red salvage lands only when the guardrail
 * actually RAN and blocked (an unrunnable verification must never produce
 * a draft claiming a block that never happened) and containment left a
 * tree some verification saw (a failed restore stays local).
 */
export interface LandingEligibility {
  readonly landEligible: boolean;
  readonly draft: boolean;
  readonly partialLanding: boolean;
  readonly draftSalvage: boolean;
  readonly blockedSalvage: boolean;
}

export function landingEligibility(
  result: Pick<RemediateResult, 'outcome' | 'guardrailRan' | 'containment'>,
  salvage: 'discard' | 'draft-pr',
): LandingEligibility {
  const draftSalvage = result.outcome === 'budget-exhausted' && salvage === 'draft-pr';
  const blockedSalvage =
    result.outcome === 'guardrail-red' &&
    salvage === 'draft-pr' &&
    result.guardrailRan === true &&
    result.containment?.restoreFailed !== true;
  const partialLanding = result.outcome === 'partially-landed';
  const landEligible =
    result.outcome === 'verified' || partialLanding || draftSalvage || blockedSalvage;
  return {
    landEligible,
    draft: landEligible && isSalvageLanding(result.outcome),
    partialLanding,
    draftSalvage,
    blockedSalvage,
  };
}

/** A standing branch this run left untouched (#372): the disclosure every
 *  surface carries (console, attempt record JSON, the attempt PR body). */
export interface PreservedStandingPr {
  readonly standingBranch: string;
  /** The open standing PR, when one was readable. */
  readonly prUrl?: string;
  /** The landing the standing branch holds (`verified`, `partially-landed`),
   *  or `unknown` when nothing readable said what it holds. */
  readonly standingOutcome: string;
  /** Where the fact came from (the ledger at the tip, the PR body, or why
   *  it could not be read). */
  readonly evidence: string;
  readonly attemptBranch: string;
  /** This run's outcome, the salvage that went to the attempt branch. */
  readonly attemptOutcome: RemediateOutcome;
}

export interface LandRemediateResult extends LandRefreshResult {
  /** The branch HEAD was actually pushed to. */
  readonly branch: string;
  readonly preserved?: PreservedStandingPr;
  /** An open attempt PR this standing rebuild closed as superseded. */
  readonly supersededAttemptPr?: string;
}

/** Where a run's HEAD lands. */
export type LandingTarget =
  | { readonly kind: 'standing'; readonly branch: string }
  | { readonly kind: 'attempt'; readonly branch: string; readonly preserved: PreservedStandingPr };

/**
 * The landing-target policy, pure over its inputs (the ONE decision both
 * landing moments route through):
 *
 *   - a verified landing (`verified`, `partially-landed`) always rebuilds
 *     the standing branch: it supersedes whatever was there;
 *   - a salvage rebuilds it only when it is REPLACEABLE: absent, or holding
 *     a salvage. It holds verified work, or nothing readable says what it
 *     holds (an existing branch, no marker, an unreadable PR): the salvage
 *     goes to the attempt branch, and the standing branch is left alone.
 */
export function decideLandingTarget(
  taskId: string,
  outcome: RemediateOutcome,
  standing: LaneBranchState | undefined,
): LandingTarget {
  const branches = remediateBranchesFor(taskId);
  if (!isSalvageLanding(outcome) || standing === undefined) {
    return { kind: 'standing', branch: branches.standing };
  }
  const holding = branchHolding(standing);
  if (holding.kind !== 'verified' && holding.kind !== 'unknown') {
    return { kind: 'standing', branch: branches.standing };
  }
  return {
    kind: 'attempt',
    branch: branches.attempt,
    preserved: {
      standingBranch: branches.standing,
      ...(standing.pr?.url ? { prUrl: standing.pr.url } : {}),
      standingOutcome: holding.kind === 'verified' ? holding.outcome : 'unknown',
      evidence: holding.evidence,
      attemptBranch: branches.attempt,
      attemptOutcome: outcome,
    },
  };
}

/** The ONE phrasing of a preserved standing branch, shared by the console,
 *  the attempt record and the attempt PR body. */
export function describePreservedStandingPr(p: PreservedStandingPr): string {
  const tail =
    `this '${p.attemptOutcome}' attempt was pushed to '${p.attemptBranch}' as a draft ` +
    'instead of replacing it.';
  if (p.standingOutcome === 'unknown') {
    return (
      `standing branch '${p.standingBranch}' could not be shown to be replaceable ` +
      `(${p.evidence}) and was left untouched; ${tail}`
    );
  }
  const subject = p.prUrl ? `standing PR ${p.prUrl}` : `standing branch '${p.standingBranch}'`;
  return (
    `${subject} holds a verified landing (outcome '${p.standingOutcome}'; ${p.evidence}) ` +
    `awaiting merge and was left untouched; ${tail}`
  );
}

/** What a landing left behind, for the run's record and log: ONE
 *  projection of the lander result (the executor, `remediate land` and the
 *  attempt record all spread this, never their own copy). */
export interface LandingDisclosure {
  readonly landedBranch: string;
  readonly prUrl?: string;
  readonly standingPreserved?: string;
  readonly draftFlipped?: string;
  readonly supersededAttemptPr?: string;
  /** The branch was pushed but NO PR could be opened (#374): the helper's
   *  note, naming the usual cause and the manual remedy. A landing that
   *  carries this is not "landed": no one will see the work, so every
   *  consumer reports it as a failure (non-zero exit, `landed: false`). */
  readonly prMissing?: string;
  /** The body handed to gh was cut to GitHub's size cap (#374). */
  readonly bodyTruncated?: string;
}

export function landingDisclosure(r: LandRemediateResult): LandingDisclosure {
  return {
    landedBranch: r.branch,
    ...(r.prUrl ? { prUrl: r.prUrl } : {}),
    ...(r.preserved ? { standingPreserved: describePreservedStandingPr(r.preserved) } : {}),
    ...(r.draftFlipped ? { draftFlipped: r.draftFlipped } : {}),
    ...(r.supersededAttemptPr ? { supersededAttemptPr: r.supersededAttemptPr } : {}),
    ...(r.outcome === 'branch-pushed-no-pr'
      ? { prMissing: r.note ?? `pushed '${r.branch}' but could not open the PR` }
      : {}),
    ...(r.bodyTruncated ? { bodyTruncated: r.bodyTruncated } : {}),
  };
}

/** The lines a consumer prints for a disclosure (none on a plain landing).
 *  `prMissing` is deliberately NOT here: it is a failure, printed by each
 *  consumer as one, never as a note under a success line. */
export function landingNotes(d: LandingDisclosure): string[] {
  return [
    ...(d.standingPreserved ? [d.standingPreserved] : []),
    ...(d.draftFlipped ? [d.draftFlipped] : []),
    ...(d.bodyTruncated ? [d.bodyTruncated] : []),
    ...(d.supersededAttemptPr
      ? [
          `attempt PR ${d.supersededAttemptPr} was closed as superseded by this landing on the ` +
            'standing branch (its branch is kept for the ledger history).',
        ]
      : []),
  ];
}

/**
 * Append the landing marker (`landingRow`) to the order ledger file the
 * landing commits: the branch-side evidence of what the pushed branch now
 * holds. Returns the repo-relative path to commit, or null when the file
 * could not be written (disclosed: the next salvage then falls back to
 * the PR body for this branch).
 */
function appendLandingMarker(
  cwd: string,
  taskId: string,
  branch: string,
  outcome: RemediateOutcome,
): string | null {
  const rel = orderLedgerPath('remediate', taskId);
  try {
    const row = landingRow(taskId, {
      timestamp: new Date().toISOString(),
      outcome,
      branch,
      ...remediateStamp(cwd),
    });
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, serializeOrderRows([row]), 'utf8');
    return rel;
  } catch (err) {
    logger.warn(
      `the landing marker could not be written to ${rel} ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)}); a later salvage ` +
        `will read what '${branch}' holds from its PR body only`,
    );
    return null;
  }
}

/**
 * A standing rebuild supersedes any open attempt PR for the task: close it
 * with the pointer, keep its branch (the ledger history lives there).
 * Best-effort, like every gh step of a landing.
 */
function supersedeAttemptPr(
  exec: Exec,
  branches: RemediateBranches,
  standingPrUrl: string | undefined,
  known: StandingPrState | null | undefined,
): string | undefined {
  if (!standingPrUrl) return undefined;
  let attemptPr = known;
  if (attemptPr === undefined) {
    try {
      attemptPr = readOpenStandingPr(exec, branches.attempt);
    } catch {
      return undefined;
    }
  }
  if (!attemptPr) return undefined;
  exec('gh', ['pr', 'close', branches.attempt, '--comment', `superseded by ${standingPrUrl}`], {
    allowFail: true,
  });
  return attemptPr.url;
}

export function landRemediateHead(opts: LandRemediateOptions): LandRemediateResult {
  const exec = opts.exec ?? makeExec(opts.cwd);
  const branches = remediateBranchesFor(opts.taskId);
  // Only a salvage can be refused the standing branch, so only a salvage
  // pays the read (one remote probe, the ledger tips, the two PRs). Read
  // BEFORE anything is pushed; every degraded read is on the state.
  const states = isSalvageLanding(opts.outcome)
    ? readRemediateBranchStates(opts.taskId, exec)
    : undefined;
  const target = decideLandingTarget(opts.taskId, opts.outcome, states?.standing);
  const marker = appendLandingMarker(opts.cwd, opts.taskId, target.branch, opts.outcome);
  const ledgerPaths = [
    ...new Set([
      ...(opts.ledgerPath ? [opts.ledgerPath] : []),
      ...(opts.orderLedgerPath ? [opts.orderLedgerPath] : []),
      ...(opts.runLedgerPath ? [opts.runLedgerPath] : []),
      ...(marker ? [marker] : []),
    ]),
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
  exec('git', internalGitPushArgs(`HEAD:refs/heads/${target.branch}`, { force: true }));
  const preserved = target.kind === 'attempt' ? target.preserved : undefined;
  // The attempt PR's body opens with the disclosure: the ledger below is
  // this attempt's, and a reader must not mistake it for the standing PR.
  const prBody = preserved
    ? `> ${describePreservedStandingPr(preserved)}\n\n${opts.prBody}`
    : opts.prBody;
  // The target's open PR was already read with the state (one list per
  // landing); undefined = not read here, the PR mechanics list it.
  const targetState = states
    ? target.kind === 'attempt'
      ? states.attempt
      : states.standing
    : undefined;
  const pr = openOrUpdateStandingPr(exec, {
    branchName: target.branch,
    defaultBranch: opts.defaultBranch,
    prTitle: opts.prTitle,
    prBody,
    // A salvage on the attempt branch is always a draft (the standing PR is
    // the one a human may merge); otherwise as the caller decided.
    ...(preserved ? { draft: true } : opts.draft !== undefined ? { draft: opts.draft } : {}),
    ...(targetState?.pr !== undefined ? { existing: targetState.pr } : {}),
    // Where the size guard's marker sends a reader when the body is cut
    // (#374): the full ledger this landing commits on the target branch.
    ...(opts.runLedgerPath
      ? { fullRecord: `the committed ledger \`${opts.runLedgerPath}\` on '${target.branch}'` }
      : {}),
  });
  const supersededAttemptPr =
    target.kind === 'standing'
      ? supersedeAttemptPr(exec, branches, pr.prUrl, states?.attempt.pr)
      : undefined;
  return {
    ...pr,
    branch: target.branch,
    ...(preserved ? { preserved } : {}),
    ...(supersededAttemptPr ? { supersededAttemptPr } : {}),
  };
}
