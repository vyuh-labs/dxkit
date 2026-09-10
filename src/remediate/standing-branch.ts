/**
 * What a task's lane BRANCHES hold: the ONE reader (Rule 2.30) of the
 * standing branch and its attempt sibling, consumed by the lander ("may
 * this run REPLACE the standing branch?"), by resume ("may the next run
 * continue from one of them?"), by the order ledger's compose and metadata
 * channel ("which branch may carry bookkeeping?") and by the preflight.
 *
 * The evidence is BRANCH-SIDE first: the landing marker the lander commits
 * into the order ledger at every landing (`landingRow`, read at the branch
 * tip through the same `readBranchOrderRows` the breaker and resume use).
 * The open PR's body (the run ledger verbatim) is corroboration only, for
 * branches landed before the marker existed. #372 shipped because the
 * landing side read nothing; a PR-only read would still fall through to a
 * force-push whenever gh failed, the PR was closed, or its body was stale,
 * so an unreadable PR over an existing branch with no marker reads as
 * UNKNOWN, and an unknown is never force-pushed over.
 *
 * Leaf module by design: nothing here imports the lander, resume, or the
 * order-outcomes writer, so all of them can import it.
 */
import type { Exec } from '../land-refresh';
import { remediateBranchesFor, type RemediateBranches } from '../lanes/branches';
import {
  existingRemoteBranches,
  latestLanding,
  orderLedgerPath,
  readBranchOrderRows,
  type OrderOutcomeRow,
} from '../lanes/order-ledger';
import { isRemediateOutcome, isSalvageLanding } from './outcome';

/** The open PR on a lane branch and the ledger facts read from its body. */
export interface StandingPrState {
  readonly url: string;
  /** The ledger's outcome word (`verified`, `guardrail-red`, ...), or
   *  undefined when the body carries no ledger outcome line. */
  readonly outcome?: string;
  /** The ledger's "Blocking findings" list, bounded (a guardrail-red
   *  salvage's record of WHY it was blocked). */
  readonly blockingContext?: string;
  /** GitHub's draft flag, when the read carried it. */
  readonly isDraft?: boolean;
}

/** Extract the ledger's outcome word from a PR body. Anchored to the
 *  ledger's own emitted line shapes (the runner's `Task: **<task>** ...
 *  outcome: **<word>**` header, or the executor's bare `outcome: **<word>**`
 *  refusal line), never a prose mention of the word elsewhere in the body.
 *  Undefined when no ledger outcome line exists. */
export function extractLedgerOutcome(body: string | undefined): string | undefined {
  if (!body) return undefined;
  return (
    body.match(/^Task: \*\*[^\n]*outcome: \*\*([a-z-]+)\*\*/m)?.[1] ??
    body.match(/^outcome: \*\*([a-z-]+)\*\*/m)?.[1]
  );
}

/** Extract the ledger's "Blocking findings" list from a PR body, bounded:
 *  the durable record of WHY the prior attempt was blocked. */
export function extractBlockingContext(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const idx = body.indexOf('Blocking findings:');
  if (idx === -1) return undefined;
  const section = body
    .slice(idx)
    .split('\n')
    .slice(1)
    .filter((l) => l.trim().startsWith('- '));
  if (section.length === 0) return undefined;
  return section.join('\n').slice(0, 1500);
}

/**
 * Read the OPEN PR for a lane branch, with the ledger facts its body
 * records. Null when no open PR exists (a merged or closed one means the
 * work was decided on). THROWS when gh itself fails: the caller decides
 * what an unreadable PR means and discloses it, so a silent "no PR" can
 * never stand in for an unreadable one.
 */
export function readOpenStandingPr(exec: Exec, branch: string): StandingPrState | null {
  const prJson = exec('gh', [
    'pr',
    'list',
    '--head',
    branch,
    '--state',
    'open',
    '--json',
    'url,body,isDraft',
  ]);
  const open = JSON.parse(prJson || '[]') as Array<{
    url?: string;
    body?: string;
    isDraft?: boolean;
  }>;
  if (!Array.isArray(open) || open.length === 0) return null;
  const first = open[0] ?? {};
  const outcome = extractLedgerOutcome(first.body);
  const blockingContext = extractBlockingContext(first.body);
  return {
    url: first.url ?? '',
    ...(outcome !== undefined ? { outcome } : {}),
    ...(blockingContext !== undefined ? { blockingContext } : {}),
    ...(typeof first.isDraft === 'boolean' ? { isDraft: first.isDraft } : {}),
  };
}

/** One lane branch, as read from origin. */
export interface LaneBranchState {
  readonly branch: string;
  /** Does the branch exist on origin? Null = the probe itself failed. */
  readonly exists: boolean | null;
  /** The branch tip's order-ledger rows and foreign lines (empty when the
   *  branch is absent or unreadable). */
  readonly rows: readonly OrderOutcomeRow[];
  readonly foreign: readonly string[];
  readonly head?: string;
  readonly ledger: 'read' | 'absent' | 'unreachable';
  /** The newest landing marker for THIS branch at its tip. */
  readonly landed?: { readonly outcome: string; readonly timestamp: string };
  /** The open PR: null = none. Undefined = not read (the caller asked for
   *  ledger only) or unreadable (then `prUnreadable` says why). */
  readonly pr?: StandingPrState | null;
  readonly prUnreadable?: string;
}

export interface RemediateBranchStates {
  readonly branches: RemediateBranches;
  readonly standing: LaneBranchState;
  readonly attempt: LaneBranchState;
}

function readOne(
  task: string,
  branch: string,
  present: Set<string> | null,
  exec: Exec,
  readPr: boolean,
): LaneBranchState {
  const exists = present === null ? null : present.has(branch);
  let ledgerState: Pick<LaneBranchState, 'rows' | 'foreign' | 'head' | 'ledger' | 'landed'> = {
    rows: [],
    foreign: [],
    ledger: exists === false ? 'absent' : 'unreachable',
  };
  if (exists !== false) {
    const read = readBranchOrderRows({ branch, file: orderLedgerPath('remediate', task) }, exec);
    if (read !== null) {
      const landed = latestLanding(read.rows, task, branch);
      ledgerState = {
        rows: read.rows,
        foreign: read.foreign,
        head: read.head,
        ledger: 'read',
        ...(landed ? { landed } : {}),
      };
    }
  }
  if (!readPr) return { branch, exists, ...ledgerState };
  try {
    return { branch, exists, ...ledgerState, pr: readOpenStandingPr(exec, branch) };
  } catch (err) {
    return {
      branch,
      exists,
      ...ledgerState,
      prUnreadable: err instanceof Error ? err.message.split('\n')[0] : String(err),
    };
  }
}

/**
 * Read the task's branch pair: ONE remote probe for both, each present
 * branch's ledger tip, and (unless `pr: false`) each branch's open PR.
 * Fail-open per source: every degraded read is recorded on the state
 * (`exists: null`, `ledger: 'unreachable'`, `prUnreadable`), never thrown,
 * so the consumer decides what it means and says so.
 */
export function readRemediateBranchStates(
  taskId: string,
  exec: Exec,
  opts: { readonly pr?: boolean } = {},
): RemediateBranchStates {
  const branches = remediateBranchesFor(taskId);
  const present = existingRemoteBranches([branches.standing, branches.attempt], exec);
  const readPr = opts.pr !== false;
  return {
    branches,
    standing: readOne(taskId, branches.standing, present, exec, readPr),
    attempt: readOne(taskId, branches.attempt, present, exec, readPr),
  };
}

/** What a branch HOLDS, for the guard and resume. */
export type BranchHolding =
  /** Verified, gate-passing work (a non-salvage landing): protected. */
  | { readonly kind: 'verified'; readonly outcome: string; readonly evidence: string }
  /** A salvage draft (guardrail-red / budget-exhausted): replaceable. */
  | { readonly kind: 'salvage'; readonly outcome: string; readonly evidence: string }
  /** The branch may exist but nothing readable says what it holds: never
   *  force-pushed over. */
  | { readonly kind: 'unknown'; readonly evidence: string }
  /** Nothing to protect: absent, or no landing on record. */
  | { readonly kind: 'free'; readonly evidence: string };

/**
 * Ledger FIRST (the marker at the tip is what the branch actually holds),
 * the open PR's body as corroboration when no marker exists. Reads no
 * network: pure over a state already read.
 */
export function branchHolding(state: LaneBranchState): BranchHolding {
  const fromLedger = state.landed?.outcome;
  const fromPr = state.pr?.outcome;
  const held = fromLedger ?? fromPr;
  if (held !== undefined && isRemediateOutcome(held)) {
    const evidence =
      fromLedger !== undefined
        ? `the ledger at the tip of '${state.branch}' records a '${held}' landing`
        : `the open PR on '${state.branch}' records outcome '${held}'`;
    return isSalvageLanding(held)
      ? { kind: 'salvage', outcome: held, evidence }
      : { kind: 'verified', outcome: held, evidence };
  }
  if (state.prUnreadable !== undefined && state.exists !== false) {
    return {
      kind: 'unknown',
      evidence:
        `'${state.branch}' ${state.exists === null ? 'may exist' : 'exists'} on origin, its ` +
        `ledger carries no landing marker, and its PR could not be read (${state.prUnreadable})`,
    };
  }
  return {
    kind: 'free',
    evidence:
      state.exists === false
        ? `'${state.branch}' does not exist on origin`
        : `no landing is recorded for '${state.branch}' (no marker at its tip, no open PR ledger)`,
  };
}

/** May the standing branch be REBUILT (force-pushed) by a non-verified
 *  push? False when it holds verified work or an unknown. */
export function standingReplaceable(standing: LaneBranchState): boolean {
  const kind = branchHolding(standing).kind;
  return kind !== 'verified' && kind !== 'unknown';
}

/** Which branch may carry a task's NON-landing bookkeeping commit (the
 *  metadata channel): the attempt branch while the standing branch HOLDS
 *  verified work (a preserved branch is never pushed to), else standing.
 *  An unknown is not diverted here: the metadata commit parents on the
 *  branch head and destroys nothing (only a force-push must never land on
 *  an unknown, see `standingReplaceable`). */
export function metadataTargetBranch(states: RemediateBranchStates): string {
  return branchHolding(states.standing).kind === 'verified'
    ? states.branches.attempt
    : states.branches.standing;
}
