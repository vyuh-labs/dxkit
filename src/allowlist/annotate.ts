/**
 * Annotate security findings with their active-allowlist status
 * for REPORTING (not gating).
 *
 * The guardrail already consults the allowlist to decide whether a
 * net-new finding blocks a push (`src/baseline/check.ts`). But the
 * vulnerability-scan report and dashboard rendered raw counts with no
 * indication that some findings are reviewed-and-accepted — a repo that
 * has correctly allowlisted, say, its unit-test fixtures still showed
 * them as headline criticals with no visual distinction, which reads as
 * "the score is lying."
 *
 * This module marks each finding whose fingerprint matches an ACTIVE
 * (unexpired) allowlist entry so renderers can show "(N allowlisted)"
 * beside the subtotal. It does NOT change raw counts and does NOT change
 * the score — dxkit's raw-truth model is preserved; only the
 * presentation gains an honesty annotation.
 *
 * Identity contract (CLAUDE.md Rule 9): this module never computes a
 * fingerprint. It matches against the fingerprint the aggregator
 * already stamped on each code/secret/config finding (plus the
 * `absorbedFingerprints` recorded when cross-tool dedup collapsed
 * contributors — same robust-match set the guardrail uses). Dependency
 * findings are keyed by `(package, version, id)` through a producer and
 * carry no inline fingerprint, so they are out of scope here.
 */
import { type AllowlistFile, findEntry, isEntryActive } from './file';
import type { AllowlistCategory } from './categories';
import type { FindingCategory } from '../analyzers/security/types';
import type { IdentityKind } from '../baseline/producers';

/**
 * The minimal finding shape this module reads + writes. The runtime
 * objects are richer (`CodeFinding` carries `fingerprint` +
 * `absorbedFingerprints`); we accept the structural subset so callers
 * pass their findings directly without a cast.
 */
export interface AnnotatableFinding {
  readonly category: FindingCategory;
  readonly fingerprint?: string;
  readonly absorbedFingerprints?: readonly string[];
  allowlisted?: boolean;
  allowlistCategory?: AllowlistCategory;
}

/**
 * Map a report `FindingCategory` to the canonical `IdentityKind` used
 * by allowlist entries. Only the three fingerprint-bearing categories
 * resolve; `dependency` returns null (out of scope — see module doc).
 */
function kindForCategory(category: FindingCategory): IdentityKind | null {
  switch (category) {
    case 'secret':
      return 'secret';
    case 'code':
      return 'code';
    case 'config':
      return 'config';
    case 'dependency':
      return null;
  }
}

/**
 * Whether an active allowlist entry of this category should LIFT the
 * finding from the dimension score (penalties + caps), not just from
 * the guardrail.
 *
 * `false-positive` and `test-fixture` declare the finding is "not a real
 * finding" — a misfire or throwaway test data — so a properly-triaged
 * repo shouldn't carry a score penalty for it (the failure mode where a
 * repo stays capped at the trust-broken tier despite having reviewed and
 * accepted every flagged secret). `accepted-risk` and `deferred`, by
 * contrast, accept a REAL risk: the guardrail stops blocking on them,
 * but the score must still reflect the residual exposure — you can't
 * `accepted-risk` your way to an A. `mitigated-externally` counts too:
 * the risk is real, just handled outside dxkit.
 */
export function allowlistLiftsScore(category: AllowlistCategory | undefined): boolean {
  return category === 'false-positive' || category === 'test-fixture';
}

/**
 * Mutate `findings` in place, setting `allowlisted` + `allowlistCategory`
 * on each finding matched by an active allowlist entry. Returns the count
 * of findings annotated, so callers can short-circuit rendering when zero.
 *
 * A finding matches when ANY of its candidate fingerprints (its own
 * `fingerprint`, then any `absorbedFingerprints`) resolves to an
 * allowlist entry whose `kind` equals the finding's kind and which is
 * active at `now`. The kind guard rules out a cross-kind hash collision
 * waiving the wrong finding — mirrors `allowlistSuppressionFor`.
 */
export function annotateFindingsWithAllowlist(
  findings: AnnotatableFinding[],
  allowlist: AllowlistFile | null,
  now: Date = new Date(),
): number {
  if (!allowlist || allowlist.entries.length === 0) return 0;

  let annotated = 0;
  for (const f of findings) {
    const kind = kindForCategory(f.category);
    if (!kind) continue;

    const candidates: string[] = [];
    if (f.fingerprint) candidates.push(f.fingerprint);
    if (f.absorbedFingerprints) candidates.push(...f.absorbedFingerprints);

    for (const fp of candidates) {
      const entry = findEntry(allowlist, fp);
      if (!entry || entry.kind !== kind) continue;
      if (!isEntryActive(entry, now)) continue;
      f.allowlisted = true;
      f.allowlistCategory = entry.category;
      annotated++;
      break;
    }
  }
  return annotated;
}
