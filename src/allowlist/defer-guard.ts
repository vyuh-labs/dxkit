/**
 * The creation-time guard on a deferral — the advisories a caller sees at the
 * moment they time-box a finding, decided ONCE for both front-ends.
 *
 * # Why this exists
 *
 * A deferral is a promise: "we will fix this before <date>." The expiry is the
 * forcing function, and it works — a lapsed entry stops suppressing and the
 * finding returns. What the product never said is whether the promise was
 * KEEPABLE. On the repo that produced this class, an engineer deferred 21
 * dependency advisories for six days with no remediation lane enabled: nothing
 * in that repo was ever going to fix 9 packages in six days, and every one of
 * the 21 came back on the same morning and blocked every open PR.
 *
 * None of that needed predicting. All of it was knowable at the keystroke: how
 * many findings, how long the window, whether any lane exists that could close
 * them, and the fact that one shared expiry means the whole batch returns
 * together. So the guard states those facts when they matter and stays quiet
 * when they don't.
 *
 * # What it deliberately is NOT
 *
 * It never blocks a deferral and never adjusts the window. Time-boxing a
 * finding is a legitimate engineering decision and the human making it knows
 * things dxkit does not (a fix already in review, a vendor patch landing
 * Thursday). The guard's job is to make the decision INFORMED, not to overrule
 * it — so every advisory is a fact plus its consequence, never a veto and never
 * a nag. The one hard refusal lives in the core, not here: an expiry already in
 * the past creates an entry that suppresses NOTHING, which silently fails the
 * caller's actual intent.
 *
 * Both front-ends render these (Rule 2): `allowlist defer` prints them, and the
 * `/dxkit defer` PR reply carries them into the thread where the reviewers who
 * will live with the deferral can read them. The guard is consulted from the ONE
 * defer core, so a third front-end inherits it for free.
 */

import { depBumpEnabled, remediateEnabled } from '../ship-installers';
import { daysUntilDate } from './file';
import { DEFER_ADVISORY_EXPIRY_DAYS } from './categories';

export interface DeferGuardInput {
  /** How many findings this deferral covers. */
  readonly count: number;
  /** The shared ISO `YYYY-MM-DD` expiry being written. */
  readonly expiresAt: string;
  readonly now: Date;
}

/**
 * Whether this repo has any automated lane that could close a deferred
 * dependency finding before its window shuts. Both probes are read from their
 * declared homes rather than re-reading policy here — `doctor` recommends these
 * same lanes, and a second policy read is how the two surfaces start
 * disagreeing about whether a repo is covered.
 *
 * Both probes swallow a read failure and answer `false`, so an unreadable policy
 * reads as "no lane". That is the conservative direction for this advisory: a
 * lane dxkit cannot see is a lane that will not run on its behalf, and the
 * advice (plan the work, or check the lane config) is right either way.
 */
function laneCoverage(cwd: string): { readonly depBump: boolean; readonly remediate: boolean } {
  return { depBump: depBumpEnabled(cwd), remediate: remediateEnabled(cwd) };
}

/**
 * The advisories for a deferral about to be written. Empty when there is
 * nothing worth saying. Ordered most-consequential first.
 */
export function deferAdvisories(cwd: string, input: DeferGuardInput): string[] {
  const windowDays = daysUntilDate(input.expiresAt, input.now);
  const out: string[] = [];

  // The batch-lapse property. One shared expiry is the whole point of a bulk
  // defer, and also the thing that makes the return a wall rather than a
  // trickle — say so while the window is still being chosen.
  if (input.count > 1) {
    out.push(
      `All ${input.count} findings share one expiry, so they return together on ` +
        `${input.expiresAt} — not spread out.`,
    );
  }

  if (windowDays === 0) {
    out.push(
      'The window closes TODAY: the expiry is inclusive, so these are suppressed ' +
        'for the rest of today and re-block tomorrow. Pass `--expires +Nd` for a ' +
        'window you can actually work in.',
    );
  }

  const lanes = laneCoverage(cwd);
  if (!lanes.depBump && !lanes.remediate) {
    out.push(
      `No automated remediation lane is enabled in this repo, so nothing here will ` +
        `close ${input.count === 1 ? 'this' : 'these'} before ${input.expiresAt} — ` +
        `whoever opens a PR that day inherits ${input.count === 1 ? 'it' : 'them'}. ` +
        `Either plan the work now, or enable a lane: \`depBump.enabled\` for the ` +
        `deterministic version-bump lane (fixable dependency findings, no agent), ` +
        `\`remediate.enabled\` for the agentic one.`,
    );
  } else if (lanes.depBump && !lanes.remediate && windowDays < DEFER_ADVISORY_EXPIRY_DAYS) {
    // The bump lane is scheduled weekly by its managed workflow, so a window
    // shorter than its cadence may shut before the lane has run even once.
    out.push(
      `The dep-bump lane runs weekly, so a ${windowDays}-day window may close before ` +
        `its next run. Give it at least one cycle (\`--expires +${DEFER_ADVISORY_EXPIRY_DAYS}d\`) ` +
        `or expect to renew.`,
    );
  }

  return out;
}
