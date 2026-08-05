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

/** The floor verification block: pass/fail led by NET-NEW attribution, with
 *  pre-existing debt and unattributed checks disclosed, never weaponized. */
export function renderFloorVerification(
  floor: CorrectnessFloorResult | undefined,
  attribution: readonly AttributedFloorFailure[] | undefined,
  entryLabel: string,
): string[] {
  if (!floor) return ['Correctness floor: not run (dry run).', ''];
  // A floor WITHOUT an attribution pass is the ENTRY snapshot (the run
  // exited before any change existed to attribute — a no-op, a failed
  // agent). Say what it is: rendering the attributed headline here once
  // printed "not run (dry run)" for a floor that HAD run, and would print
  // "passed" over a red entry floor. Pre-existing debt is disclosed as
  // exactly that — it belongs to the repo, not to this run.
  if (!attribution) {
    const checks = floor.checks.map((c) => `- ${c.pack}/${c.label}: ${c.status}`).join('\n');
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
  const checks = floor.checks.map((c) => `- ${c.pack}/${c.label}: ${c.status}`).join('\n');
  const lines = [
    `Correctness floor (full scope, attributed vs ${entryLabel}): ` +
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

/** The guardrail verdict line (omitted when the check did not run). */
export function renderGuardrailVerdict(verdict: string | undefined): string[] {
  return verdict ? [`Guardrail: **${verdict}**`, ''] : [];
}
