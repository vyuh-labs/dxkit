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
  /** Why no resume happened, when the knob is ON but nothing resumed —
   *  disclosed by the caller, never silent. Absent when the knob is off. */
  readonly note?: string;
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
    // closed one means the work was decided on; start fresh.
    const prJson = run('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url']);
    const open = JSON.parse(prJson || '[]') as unknown[];
    if (!Array.isArray(open) || open.length === 0) {
      return { resumed: false, note: `no open draft PR for '${branch}' — fresh run` };
    }
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
    return { resumed: true, attempt: prior + 1 };
  } catch (e) {
    return {
      resumed: false,
      note: `resume unavailable (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — fresh run`,
    };
  }
}

/** The continuation instruction appended to the task prompt on a resume. */
export function resumePromptNote(attempt: number): string {
  return (
    `\nRESUMED ATTEMPT #${attempt}: a previous budget-bounded run already committed real ` +
    `work on this branch. Read docs/DXKIT-REMEDIATION-NOTES.md and the recent git log ` +
    `FIRST, then CONTINUE from where it stopped — do not redo or rewrite completed work.`
  );
}
