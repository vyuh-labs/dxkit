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
 * fingerprint. It matches against the fingerprint the aggregator already
 * stamped on each finding (plus the `absorbedFingerprints` recorded when
 * cross-tool dedup collapsed contributors — same robust-match set the
 * guardrail uses). This covers code/secret/config findings AND dependency
 * findings: a `DepVulnFinding` carries a stamped `fingerprint` hashing
 * `(package, installedVersion, id)`, so it matches a `dep-vuln` allowlist
 * entry through the same core — closing the gap where an allowlisted
 * dep-vuln still dragged the Security score and was suggested as a fix.
 */
import { type AllowlistFile, findEntry, isEntryActive } from './file';
import type { AllowlistCategory } from './categories';
import type { FindingCategory } from '../analyzers/security/types';
import type { IdentityKind } from '../baseline/producers';

/**
 * The minimal finding shape this module reads + writes. The runtime
 * objects are richer (`CodeFinding` carries `fingerprint` +
 * `absorbedFingerprints`; `DepVulnFinding` carries a stamped
 * `fingerprint`); we accept the structural subset so callers pass their
 * findings directly without a cast.
 */
export interface AnnotatableFinding {
  readonly fingerprint?: string;
  readonly absorbedFingerprints?: readonly string[];
  allowlisted?: boolean;
  allowlistCategory?: AllowlistCategory;
}

/** A code-side finding additionally carries its report category. */
export type CategorizedFinding = AnnotatableFinding & { readonly category: FindingCategory };

/**
 * Map a report `FindingCategory` to the canonical `IdentityKind` used
 * by allowlist entries. All four categories resolve: the three
 * code-side categories plus `dependency` → `dep-vuln` (dep findings now
 * carry a stamped fingerprint, so they are annotatable — see the dep
 * wrapper below).
 */
function kindForCategory(category: FindingCategory): IdentityKind {
  switch (category) {
    case 'secret':
      return 'secret';
    case 'code':
      return 'code';
    case 'config':
      return 'config';
    case 'dependency':
      return 'dep-vuln';
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
function annotateByKind(
  findings: AnnotatableFinding[],
  allowlist: AllowlistFile | null,
  kindOf: (f: AnnotatableFinding) => IdentityKind,
  now: Date,
): number {
  if (!allowlist || allowlist.entries.length === 0) return 0;

  let annotated = 0;
  for (const f of findings) {
    const kind = kindOf(f);

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

/**
 * Annotate code-side findings (secret / code / config), each mapped to its
 * `IdentityKind` by its report category.
 */
export function annotateFindingsWithAllowlist(
  findings: CategorizedFinding[],
  allowlist: AllowlistFile | null,
  now: Date = new Date(),
): number {
  return annotateByKind(
    findings,
    allowlist,
    (f) => kindForCategory((f as CategorizedFinding).category),
    now,
  );
}

/**
 * Annotate dependency findings (kind `dep-vuln`) by their stamped
 * fingerprint. Split from the code-side path because `DepVulnFinding`
 * carries no `category` field — its kind is constant — but it shares the
 * one matching core so the score-lift and the report split stay consistent
 * with code/secret/config (one concept, one code path).
 */
export function annotateDepFindingsWithAllowlist(
  findings: AnnotatableFinding[],
  allowlist: AllowlistFile | null,
  now: Date = new Date(),
): number {
  return annotateByKind(findings, allowlist, () => 'dep-vuln', now);
}

/** The live-vs-allowlisted split for one axis of findings, for renderers. */
export interface AllowlistSplit {
  /** Findings with no active allowlist match. */
  live: number;
  /** Findings an active allowlist entry covers. */
  allowlisted: number;
  /** Allowlisted breakdown by category, e.g. `{ 'test-fixture': 3 }`. */
  byCategory: Partial<Record<AllowlistCategory, number>>;
}

/**
 * Summarize a set of already-annotated findings into a live/allowlisted
 * split for a report headline. The ONE partition every security-bearing
 * renderer (vuln-scan, health, BoM, dashboard) reads, so the "(N
 * allowlisted)" story is rendered identically everywhere.
 */
export function summarizeAllowlist(findings: readonly AnnotatableFinding[]): AllowlistSplit {
  let live = 0;
  let allowlisted = 0;
  const byCategory: Partial<Record<AllowlistCategory, number>> = {};
  for (const f of findings) {
    if (f.allowlisted) {
      allowlisted++;
      if (f.allowlistCategory) {
        byCategory[f.allowlistCategory] = (byCategory[f.allowlistCategory] ?? 0) + 1;
      }
    } else {
      live++;
    }
  }
  return { live, allowlisted, byCategory };
}

/** Render an `AllowlistSplit` as a compact ` · N allowlisted (cat, cat)` suffix, or '' when none. */
export function renderAllowlistSuffix(split: AllowlistSplit): string {
  if (split.allowlisted === 0) return '';
  const cats = Object.entries(split.byCategory)
    .map(([cat, n]) => (n && n > 0 ? `${cat}` : ''))
    .filter(Boolean)
    .join(', ');
  return ` · ${split.allowlisted} allowlisted${cats ? ` (${cats})` : ''}`;
}
