/**
 * The shared verification PRIMITIVES of the scheduled lanes (Rule 2) — the
 * two blocks that were duplicated verbatim between the dep-bump lane and the
 * remediate runner, extracted to one home:
 *
 *   - `toFloorBaseChecks`: project an entry floor run into the attribution
 *     comparator's base shape (both lanes attribute post-change failures
 *     against a pre-change entry snapshot through the ONE comparator);
 *   - `guardrailVerdictFor`: run the guardrail and fold its outcome into a
 *     verdict string PLUS an explicit gate answer. The gate answer is what
 *     the agent lane enforces (W-11): `passesGate` is true only when the
 *     check RAN and its exit-code derivation is clean — BLOCKED and the
 *     CANNOT-GATE refusal tier both fail it.
 *
 * The one declared policy difference between the lanes lives at the
 * CONSUMER, stated where it applies: the deterministic bump lane treats an
 * unrunnable guardrail as fail-open (its diff is manifest+lockfile; the
 * PR's own required check is the backstop — the 4.2.1 shipped shape), while
 * the agent lane treats it as fail-CLOSED (an agent-authored diff must not
 * land unverified — the sweep can carry anything the agent wrote).
 */
import type { AnalysisTrustContext } from '../analysis-trust';
import type { CorrectnessFloorResult } from '../analyzers/correctness/run';
import type { FloorBaseCheck } from '../analyzers/correctness/attribution';

/** Entry-floor run → the attribution comparator's base-check shape. */
export function toFloorBaseChecks(floor: CorrectnessFloorResult): FloorBaseCheck[] {
  return floor.checks.map((c) => ({
    pack: c.pack,
    label: c.label,
    status: c.status === 'pass' ? 'pass' : c.status === 'fail' ? 'fail' : 'skipped',
    ...(c.findings !== undefined ? { findings: c.findings } : {}),
  }));
}

export interface GuardrailGateResult {
  /** The one verdict word (PASSED / BLOCKED / CANNOT GATE / unavailable…). */
  readonly verdict: string;
  /** Did the check actually run? False on infrastructure failure. */
  readonly ran: boolean;
  /** True only when the check ran and its canonical exit derivation is
   *  clean — the enforcement answer, never re-derived from the word. */
  readonly passesGate: boolean;
  /** Compact descriptions of the findings that blocked (capped) — evidence
   *  for a lane whose work will not land, so a BLOCKED attempt on an
   *  ephemeral runner is inspectable from the ledger alone (the
   *  uninspectable-attempt defect). Absent when nothing blocked. */
  readonly blocking?: readonly string[];
}

/** Cap on the per-lane blocking-finding list — evidence, not a full report. */
const BLOCKING_SUMMARY_CAP = 10;

/**
 * Run the guardrail for a lane. Late-imports the check module (heavy; the
 * lanes' dry-run paths must not pay for it). An infrastructure failure
 * yields `ran: false` with the reason in the verdict — the caller decides
 * fail-open vs fail-closed per its own threat model.
 */
export async function guardrailVerdictFor(
  cwd: string,
  trust: AnalysisTrustContext,
): Promise<GuardrailGateResult> {
  try {
    const { runGuardrailCheck } = await import('../baseline/check');
    const { verdictCounts } = await import('../baseline/check-renderers');
    const result = await runGuardrailCheck({ cwd, trust });
    const counts = verdictCounts(result);
    // Name what blocked (capped): a lane's BLOCKED verdict must be
    // inspectable from its ledger — "the guardrail did not pass" with no
    // findings is a diagnosability black hole on an ephemeral runner.
    const blockingPairs = result.pairs.filter(
      (p) => p.classification.blocks && p.suppressedByAllowlist === undefined,
    );
    const blocking = blockingPairs
      .slice(0, BLOCKING_SUMMARY_CAP)
      .map((p) => `[${p.kind}] ${p.locator ?? p.file ?? '(no locator)'}`);
    if (blockingPairs.length > BLOCKING_SUMMARY_CAP) {
      blocking.push(`… and ${blockingPairs.length - BLOCKING_SUMMARY_CAP} more`);
    }
    return {
      verdict: counts.verdict,
      ran: true,
      passesGate: counts.exitCode === 0,
      ...(blocking.length > 0 ? { blocking } : {}),
    };
  } catch (e) {
    return {
      verdict: `unavailable (${e instanceof Error ? e.message : String(e)})`,
      ran: false,
      passesGate: false,
    };
  }
}
