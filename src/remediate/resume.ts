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
 *     for the task's standing branch (checked via gh, fail-open to "no");
 *   - the branch head is checked out DETACHED (the landing guard's CI shape;
 *     the lander force-pushes cumulative HEAD back to the branch);
 *   - an empty MARKER commit stamps the attempt, so attempts are countable
 *     from git history alone; at MAX_RESUME_ATTEMPTS the task falls back to
 *     a fresh run (a doomed branch must not burn budget forever — the cap
 *     and the fallback are both disclosed).
 */
import { execFileSync } from 'child_process';
import { BOT_IDENTITY } from '../land-refresh';
import { remediateBranchFor } from './land';
import type { RemediateConfig } from './config';

/** Resumes allowed per salvage branch before falling back to a fresh run. */
export const MAX_RESUME_ATTEMPTS = 2;

/** Marker-commit subject (greppable; the attempt counter). */
export const RESUME_MARKER = 'chore(dxkit): resume budget-bounded attempt';

export type ResumeExec = (bin: string, args: readonly string[]) => string;

function realExec(cwd: string): ResumeExec {
  return (bin, args) =>
    execFileSync(bin, [...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    }).toString();
}

export interface ResumeDecision {
  /** True when the working tree now sits on the salvage head (detached). */
  readonly resumed: boolean;
  /** 1-based resume attempt number (marker commits + 1). */
  readonly attempt?: number;
  /** The prior attempt's blocking findings (extracted from the open draft
   *  PR's ledger body, bounded) — carried into the resumed prompt so
   *  attempt N+1 starts from "close these findings", not from scratch. */
  readonly blockingContext?: string;
  /** Why no resume happened, when the knob is ON but nothing resumed —
   *  disclosed by the caller, never silent. Absent when the knob is off. */
  readonly note?: string;
}

/** Extract the ledger's "Blocking findings" list from a PR body, bounded —
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
 * Decide + prepare a resume for one task. On success the working tree is
 * left DETACHED on the salvage head with a fresh marker commit; on any
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
  const branch = remediateBranchFor(taskId);
  try {
    // An OPEN PR for the standing branch is the resume anchor — a merged or
    // closed one means the work was decided on; start fresh. The body is the
    // prior attempt's ledger: its "Blocking findings" list (a guardrail-red
    // salvage) is carried into the resumed prompt so attempt N+1 starts from
    // "close these findings", not from scratch.
    const prJson = run('gh', [
      'pr',
      'list',
      '--head',
      branch,
      '--state',
      'open',
      '--json',
      'url,body',
    ]);
    const open = JSON.parse(prJson || '[]') as Array<{ body?: string }>;
    if (!Array.isArray(open) || open.length === 0) {
      return { resumed: false, note: `no open draft PR for '${branch}' — fresh run` };
    }
    const blockingContext = extractBlockingContext(open[0]?.body);
    run('git', ['fetch', 'origin', branch]);
    // Count prior resume markers on the salvage head (bounded to the branch's
    // own history vs the current default tree).
    const markers = run('git', [
      'rev-list',
      '--count',
      `--grep=${RESUME_MARKER}`,
      'HEAD..FETCH_HEAD',
    ]).trim();
    const prior = Number(markers) || 0;
    if (prior >= MAX_RESUME_ATTEMPTS) {
      return {
        resumed: false,
        note:
          `salvage branch '${branch}' already resumed ${prior}x (cap ${MAX_RESUME_ATTEMPTS}) — ` +
          'falling back to a fresh run; review or close the draft PR',
      };
    }
    run('git', ['checkout', '--detach', 'FETCH_HEAD']);
    run('git', [
      '-c',
      `user.name=${BOT_IDENTITY.name}`,
      '-c',
      `user.email=${BOT_IDENTITY.email}`,
      'commit',
      '--allow-empty',
      '-q',
      '-m',
      `${RESUME_MARKER} [skip ci]`,
    ]);
    // Push the marker IMMEDIATELY — the attempt counter must advance even
    // when this attempt lands nothing. The counter previously lived only in
    // commits the lander force-pushed on success, so a doomed branch whose
    // resumes kept no-oping counted "attempt #1" forever and re-spent its
    // budget every scheduled firing (MAX_RESUME_ATTEMPTS was unreachable —
    // observed live across three runs). At this point HEAD is provably
    // FETCH_HEAD + one empty marker commit, so the push carries ZERO agent
    // content — the never-push-unverified law is untouched.
    let note: string | undefined;
    try {
      run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
    } catch (e) {
      note =
        `attempt marker could not be pushed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — ` +
        `the ${MAX_RESUME_ATTEMPTS}-attempt cap may not engage across runs until a landing pushes`;
    }
    return {
      resumed: true,
      attempt: prior + 1,
      ...(blockingContext ? { blockingContext } : {}),
      ...(note ? { note } : {}),
    };
  } catch (e) {
    return {
      resumed: false,
      note: `resume unavailable (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — fresh run`,
    };
  }
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
