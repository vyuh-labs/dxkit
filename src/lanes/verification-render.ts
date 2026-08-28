/**
 * The shared verification-ledger sections (Rule 2 — one concept, one code
 * path): how a scheduled lane's PR body reports the entry-attributed
 * correctness floor and the guardrail verdict. BOTH lanes render through
 * these — the deterministic dep-bump lane and the agentic remediate lane —
 * so a reviewer reads the same evidence grammar regardless of which robot
 * opened the PR, and a fix to the disclosure wording lands in both at once.
 */
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import type { AttributedFloorFailure } from '../analyzers/correctness/attribution';
import { describeFloorSkip, type FloorSkip } from './verify-tree';
import {
  formatImpactCapNote,
  formatImpactExclusions,
  formatImpactHeadline,
  formatImpactNotAttributable,
  formatImpactQuietLine,
  type ImpactSummary,
} from '../baseline/impact';

/** One check line. A pass that carries a disclosure (a tolerated condition,
 *  4.4.5) shows it inline: a reader must never mistake "passed under a
 *  condition" for a plain pass. */
function renderCheckLine(c: CorrectnessFloorResult['checks'][number]): string {
  return `- ${c.pack}/${c.label}: ${c.status}${c.note ? ` (${c.note})` : ''}`;
}

/** The floor verification block: pass/fail led by NET-NEW attribution, with
 *  pre-existing debt and unattributed checks disclosed, never weaponized. */
export function renderFloorVerification(
  floor: CorrectnessFloorResult | undefined,
  attribution: readonly AttributedFloorFailure[] | undefined,
  entryLabel: string,
  skipped?: FloorSkip,
): string[] {
  // A deliberately skipped floor (an unprovisioned worktree) says WHY it did
  // not run; only a floor that never had a reason to run is a dry run.
  const skip = describeFloorSkip(skipped);
  if (skip) return [skip, ''];
  if (!floor) return ['Correctness floor: not run (dry run).', ''];
  // A floor WITHOUT an attribution pass is the ENTRY snapshot (the run
  // exited before any change existed to attribute — a no-op, a failed
  // agent). Say what it is: rendering the attributed headline here once
  // printed "not run (dry run)" for a floor that HAD run, and would print
  // "passed" over a red entry floor. Pre-existing debt is disclosed as
  // exactly that — it belongs to the repo, not to this run.
  if (!attribution) {
    const checks = floor.checks.map(renderCheckLine).join('\n');
    return [
      `Correctness floor (entry snapshot — no change to attribute): ` +
        `**${floor.blocks ? 'red (pre-existing debt, not caused by this run)' : 'green'}**`,
      checks,
      '',
    ];
  }
  const attributed = attribution;
  const netNew = attributed.filter((a) => a.attribution === 'net-new');
  const preExisting = attributed.filter((a) => a.attribution === 'pre-existing');
  const unattributed = attributed.filter((a) => a.attribution === 'unattributed');
  const checks = floor.checks.map(renderCheckLine).join('\n');
  const lines = [
    // The ACTUAL scope the run executed at — the verification floor runs
    // `affected` (escalating on manifests); hardcoding "full" here misstated
    // what was verified. Older snapshots without the field were full-scope.
    `Correctness floor (${floor.scope ?? 'full'} scope, attributed vs ${entryLabel}): ` +
      `**${netNew.length > 0 ? 'FAILED — net-new failures' : 'passed'}**`,
    checks,
    '',
  ];
  if (preExisting.length > 0) {
    lines.push(
      `Pre-existing floor debt (failing BEFORE the change too — disclosed, not blocking): ` +
        preExisting.map((a) => `${a.check.pack}/${a.check.label}`).join(', '),
      '',
    );
  }
  if (unattributed.length > 0) {
    lines.push(
      `Unattributed floor failures (the entry run could not observe these checks): ` +
        unattributed.map((a) => `${a.check.pack}/${a.check.label}`).join(', '),
      '',
    );
  }
  return lines;
}

/**
 * The guardrail verdict line (omitted when the check did not run), plus the
 * finding-delta Impact line when the run computed one (impact surface phase
 * 1). Non-zero only: a run that resolved findings names them (kind and
 * severity, attribution-honest: the summary comes from the classifier's
 * pair statuses, never a raw diff); a run that resolved nothing gets the one
 * quiet line. Both lanes (dep-bump and remediate) render through here, so
 * the impact grammar cannot fork between robots.
 */
export function renderGuardrailVerdict(
  verdict: string | undefined,
  impact?: ImpactSummary,
): string[] {
  if (!verdict) return [];
  const lines = [`Guardrail: **${verdict}**`, ''];
  if (impact) {
    if (!impact.attributable) {
      // A refused run (CANNOT GATE) cannot back a resolved claim: the
      // one-liner replaces both the headline and the quiet line.
      lines.push(`Impact: ${formatImpactNotAttributable()}`);
      lines.push('');
      return lines;
    }
    if (impact.resolved > 0) {
      lines.push(`Impact: ${formatImpactHeadline(impact)}`);
      for (const note of impact.capNotes) lines.push(`- ${formatImpactCapNote(note)}`);
      const exclusions = formatImpactExclusions(impact);
      if (exclusions) lines.push(`- ${exclusions}`);
    } else {
      lines.push(`Impact: ${formatImpactQuietLine(impact)}`);
    }
    lines.push('');
  }
  return lines;
}
