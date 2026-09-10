/**
 * The guardrail's verdict on a CANDIDATE dep-vuln finding (4.4.8, #371):
 * "if this change introduced a dependency advisory with these signals, would
 * THIS repo's guardrail policy block it as `added`?"
 *
 * One concept, one code path (CLAUDE.md Rule 2.30). The remediation recipes'
 * OSV pre-checks (override-pin, declare-dependency) ask this before touching
 * the tree, so a pin the frame's guardrail would go red on is refused, or
 * raised past, at $0. The shipped class: the pre-check consulted
 * `newAdvisories.blockSeverities`, the tier for advisories PUBLISHED AFTER
 * CAPTURE, while the guardrail arbitrating the run blocks an `added` dep-vuln
 * through the generic `block` list plus the armed block rules. A repo that set
 * the tier to `[]` disarmed the pre-check entirely, and every scheduled run
 * pinned a package from one advisory straight into the next.
 *
 * So there is NO severity table here. The verdict IS `classify`, fed the
 * synthetic pair + context the guardrail builds for a finding the change
 * introduced on a package whose manifest line the change touched: an `added`
 * pair, `fileChangedInDiff` (a coincident policy edit cannot demote it), no
 * manifest-untouched demotion (the pin edits the package's own manifest
 * line), no recall drift (the same scanners run before and after). A policy
 * change, a preset switch, or a new block rule reaches the pre-check by
 * construction, never by a second table.
 */
import { classify, type ClassifyContext, type ClassifyResult } from './classify';
import type { BrownfieldPolicy } from './policy';
import type { FindingSeverity, MatchPair } from './types';

/** The signals a candidate advisory carries. Every one is optional: an
 *  absent severity is UNKNOWN (the classifier treats it conservatively),
 *  never low; an absent `reachable` / `malicious` means "not known here". */
export interface CandidateDepVuln {
  readonly severity?: FindingSeverity;
  readonly reachable?: boolean;
  readonly malicious?: boolean;
}

/** The guardrail's full classification of the candidate (verdict + the
 *  reason chain a ledger can render). */
export function addedDepVulnVerdict(
  policy: BrownfieldPolicy,
  candidate: CandidateDepVuln,
): ClassifyResult {
  const pair: MatchPair = { status: 'added', confidence: 1, reasons: [] };
  const context: ClassifyContext = {
    kind: 'dep-vuln',
    fileChangedInDiff: true,
    ...(candidate.severity !== undefined ? { severity: candidate.severity } : {}),
    ...(candidate.reachable === true ? { reachable: true } : {}),
    ...(candidate.malicious === true ? { malicious: true } : {}),
  };
  return classify(pair, policy, context);
}

/** Would the guardrail BLOCK on this candidate? The pre-checks' predicate. */
export function wouldBlockAddedDepVuln(
  policy: BrownfieldPolicy,
  candidate: CandidateDepVuln,
): boolean {
  return addedDepVulnVerdict(policy, candidate).blocks;
}
