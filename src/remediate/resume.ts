/**
 * Resume-from-salvage (opt-in, `remediate.resume: true`): when a prior
 * budget-bounded attempt landed as a DRAFT PR (salvage: draft-pr), the next
 * run for that task CONTINUES from the salvage branch instead of starting
 * over — the 90%-done problem's real fix.
 *
 * The attribution law that makes this safe: the ENTRY floor snapshot is
 * always captured on the PRISTINE default tree BEFORE the salvage branch is
 * checked out. A partial attempt that broke something must read as NET-NEW
 * against that entry and stay blocked — resuming may never let an attempt
 * grandfather its own breakage.
 *
 * Mechanics per resume:
 *   - eligibility: knob on, salvage policy is draft-pr, an OPEN PR exists
 *     on one of the task's branch pair (the standing branch, or the
 *     attempt branch a salvage takes while the standing branch holds
 *     verified work, #372), read through the ONE pair reader
 *     (`standing-branch.ts`: the committed landing marker first, the PR
 *     body as corroboration; gh failing is fail-open to "no");
 *   - the anchor's head is checked out DETACHED (the landing guard's CI
 *     shape; the lander force-pushes cumulative HEAD back to a branch);
 *   - a resume-attempt ROW in the order ledger (`src/lanes/order-ledger.ts`)
 *     stamps the attempt, so attempts are countable from the scheduler's
 *     one durable memory; at MAX_RESUME_ATTEMPTS the task falls back to a
 *     fresh run (a doomed branch must not burn budget forever; the cap
 *     and the fallback are both disclosed). The row rides the metadata
 *     channel onto the branch that may carry bookkeeping: never onto a
 *     standing branch that holds verified work awaiting merge. A marker
 *     COMMIT on the branch was the previous counter; every landing
 *     force-pushes the branch from the default head and erased it, so a
 *     guardrail-red chain (fresh run, red draft landed, repeat) never
 *     reached the cap. Both ledger channels compose the pair's rows before
 *     writing, so a landing carries the count forward.
 */
import { makeExec, type Exec } from '../land-refresh';
import {
  countResumeAttempts,
  orderHistory,
  orderLedgerPath,
  resumeAttemptRow,
} from '../lanes/order-ledger';
import { remediateStamp } from './work-orders/breaker';
import { publishOrderRows } from './order-outcomes';
import { remediateBranchesFor } from './land';
import {
  metadataTargetBranch,
  readRemediateBranchStates,
  type LaneBranchState,
} from './standing-branch';
import type { RemediateConfig } from './config';

// The ledger facts of a lane branch come from the ONE reader the lander
// also consults (`standing-branch.ts`, #372); re-exported so consumers
// keep one import surface.
export { extractBlockingContext, extractLedgerOutcome } from './standing-branch';

/** Resumes allowed per salvage branch before falling back to a fresh run. */
export const MAX_RESUME_ATTEMPTS = 2;

/** The ONE machine git-exec shape (`land-refresh.ts:makeExec`), shared with
 *  the order ledger so the count and the record use one plumbing seam. */
export type ResumeExec = Exec;

function realExec(cwd: string): ResumeExec {
  return makeExec(cwd);
}

/** Record one attempt against the task through the ledger's non-landing
 *  channel, on the branch that may carry it. Returns a `; ...` note when
 *  the record could not be published (the cap may not engage), else ''. */
function recordAttempt(cwd: string, taskId: string, exec: ResumeExec, branch: string): string {
  const stamp = remediateStamp(cwd);
  const row = resumeAttemptRow(taskId, { timestamp: new Date().toISOString(), ...stamp });
  const pub = publishOrderRows(cwd, taskId, [row], exec, { branch });
  if (pub.published) return '';
  return (
    `; the attempt counter could not advance (${pub.note ?? 'ledger row not published'}), so ` +
    `the ${MAX_RESUME_ATTEMPTS}-attempt escalation may not engage`
  );
}

export interface ResumeDecision {
  /** True when the working tree now sits on the salvage head (detached). */
  readonly resumed: boolean;
  /** 1-based resume attempt number (recorded attempt rows + 1). */
  readonly attempt?: number;
  /** The branch resumed from (the standing branch, or the attempt sibling). */
  readonly branch?: string;
  /** The prior attempt's blocking findings (extracted from the open draft
   *  PR's ledger body, bounded). On a resume: carried into the resumed
   *  prompt so attempt N+1 starts from "close these findings". On a
   *  NON-resume caused by a guardrail-red draft: returned so the caller
   *  renders it into the next run's order prompts as a NEGATIVE constraint
   *  (a blocked diff is never a resume anchor — design F). */
  readonly blockingContext?: string;
  /** Why no resume happened, when the knob is ON but nothing resumed —
   *  disclosed by the caller, never silent. Absent when the knob is off. */
  readonly note?: string;
}

/** What a branch's open PR holds: the committed landing marker first, the
 *  PR body's ledger outcome as corroboration (the ONE precedence, shared
 *  with the lander's guard). */
function heldOutcome(state: LaneBranchState): string | undefined {
  return state.landed?.outcome ?? state.pr?.outcome;
}

/**
 * Decide + prepare a resume for one task. On success the working tree is
 * left DETACHED on the salvage head with the attempt recorded; on any
 * failure or ineligibility the tree is untouched. Fail-open by design: a
 * broken gh, a missing branch, a fetch error all mean "fresh run".
 */
export function prepareResume(
  cwd: string,
  taskId: string,
  config: Pick<RemediateConfig, 'resume' | 'salvage'>,
  exec?: ResumeExec,
): ResumeDecision {
  if (!config.resume) return { resumed: false };
  if (config.salvage !== 'draft-pr') {
    return {
      resumed: false,
      note: 'resume is on but salvage is "discard" — nothing lands to resume from; set remediate.salvage: "draft-pr"',
    };
  }
  const run = exec ?? realExec(cwd);
  const branches = remediateBranchesFor(taskId);
  try {
    // The pair, through the ONE reader. An OPEN PR on a branch is the
    // resume anchor; a merged or closed one means the work was decided
    // on; start fresh. The body is the prior attempt's ledger: its
    // "Blocking findings" list (a guardrail-red salvage) is carried into
    // the resumed prompt so attempt N+1 starts from "close these
    // findings", not from scratch.
    const states = readRemediateBranchStates(taskId, run);
    const unreadable = states.standing.prUnreadable ?? states.attempt.prUnreadable;
    if (unreadable !== undefined) {
      return { resumed: false, note: `resume unavailable (${unreadable}); fresh run` };
    }
    const candidates = [states.standing, states.attempt].filter((s) => s.pr);
    if (candidates.length === 0) {
      return {
        resumed: false,
        note: `no open draft PR for '${branches.standing}' (or its attempt branch); fresh run`,
      };
    }
    const red = candidates.find(
      (s) => heldOutcome(s) === 'guardrail-red' && s.pr?.blockingContext !== undefined,
    );
    const blockingContext = red?.pr?.blockingContext;
    const redContext = blockingContext ? { blockingContext } : {};
    // Attempt accounting happens for ANY open draft, resume or fresh start:
    // the cap is the human-escalation tripwire, and a guardrail-red chain
    // that never counted its attempts would re-spend a full budget on the
    // same unfixable finding forever (the cap unreachable by construction).
    // The count comes from the order ledger (the ONE reader, both channels,
    // both branches of the pair): a marker commit on the branch was erased
    // by every landing force-push from the default head, so a guardrail-red
    // chain never reached the cap.
    const file = orderLedgerPath('remediate', taskId);
    const history = orderHistory(cwd, {
      branches: [
        { branch: branches.standing, file },
        { branch: branches.attempt, file },
      ],
      exec: run,
    });
    const prior = countResumeAttempts(history.rows, taskId);
    const historyNote = history.disclosures.length > 0 ? `; ${history.disclosures[0]}` : '';
    // The attempt row rides the branch that may carry bookkeeping (never a
    // standing branch holding verified work awaiting merge, #372).
    const rowsBranch = metadataTargetBranch(states);
    const seen = candidates
      .map((s) => `'${s.branch}' (outcome '${heldOutcome(s) ?? 'unknown'}')`)
      .join(' and ');
    if (prior >= MAX_RESUME_ATTEMPTS) {
      return {
        resumed: false,
        note:
          `the open PR on ${seen} has consumed ${prior} attempt(s) ` +
          `(cap ${MAX_RESUME_ATTEMPTS}); a human must review or close it before ` +
          'the lane spends more on this work; falling back to a fresh run',
        ...redContext,
      };
    }
    // Resume policy (design F): only a budget-exhausted VERIFIED partial is
    // a resume anchor: its work passed the gate and was only cut short.
    // The standing branch is tried first, then the attempt sibling (a
    // budget-cut partial diverted there while the standing branch held
    // verified work is an anchor too). A guardrail-red draft is NOT
    // resumed: continuing a blocked diff anchors the next attempt on work
    // the gate rejected. Its blocking set instead becomes a NEGATIVE
    // constraint the next run's order prompts carry ("do not reintroduce
    // these"). Any other (or unreadable) outcome conservatively starts
    // fresh, disclosed. The attempt counter STILL advances (a ledger row on
    // the non-landing channel: the working tree is never touched, and the
    // push carries zero agent content), so a repeating non-resumable chain
    // reaches the cap above.
    const anchor = candidates.find((s) => heldOutcome(s) === 'budget-exhausted');
    if (!anchor) {
      const counterNote = recordAttempt(cwd, taskId, run, rowsBranch);
      return {
        resumed: false,
        attempt: prior + 1,
        note:
          `open PR on ${seen}; resume only continues budget-exhausted verified partials; ` +
          `starting fresh (attempt ${prior + 1} of ${MAX_RESUME_ATTEMPTS} against this work)` +
          (blockingContext ? ', carrying its blocking findings as a negative constraint' : '') +
          historyNote +
          counterNote,
        ...redContext,
      };
    }
    // Record the attempt BEFORE the checkout: the counter must advance even
    // when this attempt lands nothing (a doomed branch whose resumes kept
    // no-oping counted "attempt #1" forever, observed live across three
    // runs), and the ledger channel touches neither tree nor index.
    const counterNote = recordAttempt(cwd, taskId, run, rowsBranch);
    run('git', ['fetch', 'origin', anchor.branch]);
    run('git', ['checkout', '--detach', 'FETCH_HEAD']);
    const anchorContext = anchor.pr?.blockingContext;
    const note = `${historyNote}${counterNote}`.replace(/^; /, '');
    return {
      resumed: true,
      attempt: prior + 1,
      branch: anchor.branch,
      ...(anchorContext ? { blockingContext: anchorContext } : {}),
      ...(note ? { note } : {}),
    };
  } catch (e) {
    return {
      resumed: false,
      note: `resume unavailable (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); fresh run`,
    };
  }
}

/** The NEGATIVE-constraint paragraph an order prompt carries when a prior
 *  attempt was guardrail-BLOCKED (and therefore not resumed): the blocked
 *  diff was discarded, and this run must not reintroduce its findings. */
export function priorBlockingNote(blockingContext: string): string {
  return (
    `\nNEGATIVE CONSTRAINT from a prior BLOCKED attempt (its diff was discarded, not ` +
    `resumed): the guardrail blocked that attempt on exactly these findings. Do not ` +
    `reintroduce any of them:\n${blockingContext}`
  );
}

/** The continuation instruction appended to the task prompt on a resume.
 *  When the prior attempt was BLOCKED, its findings ride along so this
 *  attempt starts from "close these", not from scratch. */
export function resumePromptNote(attempt: number, blockingContext?: string): string {
  return (
    `\nRESUMED ATTEMPT #${attempt}: a previous budget-bounded run already committed real ` +
    `work on this branch. Read docs/DXKIT-REMEDIATION-NOTES.md and the recent git log ` +
    `FIRST, then CONTINUE from where it stopped — do not redo or rewrite completed work.` +
    (blockingContext
      ? `\nThe previous attempt was BLOCKED by the guardrail on exactly these findings — ` +
        `resolving them is this attempt's FIRST priority:\n${blockingContext}`
      : '')
  );
}
