/**
 * The PR impact model, phase 1 (finding deltas, cap-aware).
 *
 * Derives "what did this change do to the repo's debt" from the EXISTING
 * guardrail pair classifications: findings resolved (by kind and severity),
 * findings added, and the net delta. Zero new computation: every number here
 * is a projection of data the check already produced.
 *
 * The honesty constraints (the product's soul, from the impact-surface
 * design) are implemented as code, not prose:
 *
 *   1. Findings are the headline. This module carries no score movement at
 *      all in phase 1; a score enters only as the cap-aware EXPLANATION of
 *      why clearing debt did not move a capped dimension.
 *   2. Attribution first (CLAUDE.md Rule 19): "you fixed N findings" is a
 *      cause claim, so the resolved tally counts ONLY pairs the classifier
 *      marked `removed`. A `not_observed` pair (the check never ran on the
 *      current side) and a `tooling_drift` pair (the tool changed what it
 *      can see) are EXCLUDED from both directions and disclosed in
 *      `excluded`, never re-derived from a raw set diff.
 *   3. Cap-aware, always: when a score result is present in the same run
 *      and its dimension is capped, the impact carries the cap and the
 *      unlock, with numbers read straight off the spec engine's output
 *      (`CapApplied.upliftIfRemoved`, `TopAction.upliftIfFixed`), never
 *      recomputed here.
 *   4. Zero is reported as zero: `deriveImpact` always returns a complete
 *      summary; the renderers decide section-vs-quiet-line, and the JSON
 *      payload always carries the field.
 *
 * One phrasing for every surface: the format helpers below are the ONLY
 * place the impact prose lives. The guardrail's three renderers and the
 * lane PR ledgers compose these; none writes its own delta sentence.
 */

import type { ClassifiedPair } from '../gate/result';
import type { BaselineEntry, FindingSeverity, FindingStatus } from './types';
import type { CapApplied, TopAction } from '../scoring/result';

/** Severity display order, most severe first. */
const SEVERITY_ORDER: ReadonlyArray<FindingSeverity> = ['critical', 'high', 'medium', 'low'];

/**
 * One finding kind's resolved slice, with a severity breakdown. Severity is
 * display metadata: for a resolved pair it comes from the PRIOR entry's
 * captured severity where the baseline recorded one (4.2), falling back to
 * the pair's kind-default severity. Never identity, never a verdict input.
 */
export interface ImpactKindDelta {
  readonly kind: BaselineEntry['kind'];
  readonly count: number;
  /** Non-zero severities only, ordered most severe first. */
  readonly bySeverity: ReadonlyArray<{
    readonly severity: FindingSeverity;
    readonly count: number;
  }>;
}

/**
 * The cap-aware explanation for one capped dimension (honesty constraint 3):
 * debt cleared but the score cannot move while the binding cap holds. Every
 * number is the spec engine's own output, carried verbatim.
 */
export interface ImpactCapNote {
  readonly dimension: string;
  /** The dimension's current (capped) score. */
  readonly score: number;
  /** The binding cap's ceiling. */
  readonly ceiling: number;
  /** The cap's own reason text (`CapApplied.reason`). */
  readonly reason: string;
  /** Where the score can go when the cap clears: `score + upliftIfRemoved`,
   *  both terms from the spec engine. */
  readonly unlocksUpTo: number;
  /** The highest-uplift next action (`topActions[0]`), when one exists with
   *  a positive uplift. */
  readonly largestUplift?: { readonly reason: string; readonly uplift: number };
}

/**
 * The minimum a surface must hold to feed the cap-aware explanation. Both
 * canonical shapes satisfy it structurally: a `ScoreResult`
 * (`src/scoring/result.ts`) directly, and a health `DimensionScore` plus its
 * dimension name. No scoring computation happens here (Rule 7: the spec
 * engine is the one evaluator); this is a read-only projection.
 */
export interface ImpactScoreInput {
  readonly dimension: string;
  readonly score: number;
  readonly capsApplied?: ReadonlyArray<CapApplied>;
  readonly topActions?: ReadonlyArray<TopAction>;
}

/**
 * The finding-delta impact of one guardrail check. JSON-embeddable (rides
 * the check payload as an additive field).
 */
export interface ImpactSummary {
  /** Findings this change resolved, counted ONLY from pairs the classifier
   *  marked `removed` (the same predicate the one verdict derivation's
   *  `resolved` tally uses; pinned by parity test). */
  readonly resolved: number;
  readonly resolvedByKind: ReadonlyArray<ImpactKindDelta>;
  /** Findings ATTRIBUTABLE to this change: pairs classified `added`,
   *  including allowlist-suppressed ones (accepted is still added). Demoted
   *  statuses (`tooling_drift`, `newly_published_advisory`, ...) are not the
   *  change's doing and land in `excluded` instead. */
  readonly added: number;
  /** Net debt reduction: `resolved - added`. Positive means the repo ends
   *  with less attributable debt than it started. */
  readonly net: number;
  /** Pairs excluded from the attributable delta (Rule 19), per
   *  classification status. `not_observed` (the resolved direction: the
   *  check never re-verified them) and `tooling_drift` (the added
   *  direction: the tool moved, not the code) are the common entries.
   *  Unchanged debt (`persisted` / `relocated`) is not a delta and is not
   *  listed. Empty when every delta pair was attributable. */
  readonly excluded: ReadonlyArray<{ readonly status: FindingStatus; readonly count: number }>;
  /** Cap-aware explanations, one per capped dimension among the score
   *  results the surface supplied. Empty when no score result was present
   *  (the section then carries the finding delta alone) or nothing is
   *  capped. */
  readonly capNotes: ReadonlyArray<ImpactCapNote>;
}

/** Delta statuses that may NOT be attributed to the change (Rule 19's
 *  causes 2 through 6). Everything here is excluded from `resolved` and
 *  `added` and disclosed in `excluded`. */
const UNATTRIBUTABLE_DELTA_STATUSES: ReadonlyArray<FindingStatus> = [
  'not_observed',
  'tooling_drift',
  'config_drift',
  'newly_detected',
  'newly_published_advisory',
  'probable_existing',
  'uncertain',
];

/**
 * Derive the impact summary from an existing check result. Pure; accepts
 * the structural subset of `GuardrailCheckResult` it reads, so the lane
 * surfaces (which hold the full result) and tests (which build fixtures)
 * share one entry point.
 */
export function deriveImpact(
  result: {
    readonly pairs: ReadonlyArray<ClassifiedPair>;
    readonly baseline: { readonly findings: ReadonlyArray<BaselineEntry> };
  },
  scores?: ReadonlyArray<ImpactScoreInput>,
): ImpactSummary {
  const priorById = new Map(result.baseline.findings.map((e) => [e.id, e] as const));

  // Resolved: the classifier's `removed` status ONLY. `not_observed` pairs
  // are matcher-removed too, but the classifier already re-labeled them
  // (Rule 19's removed direction), so consuming the classification here is
  // what keeps this a claim the run can back. Matches the `resolved` tally
  // in `verdictCounts` by construction (parity-pinned; if the classifier
  // ever emits the reserved `fixed` status, both tallies move together).
  const resolvedPairs = result.pairs.filter((p) => p.classification.status === 'removed');

  const byKind = new Map<BaselineEntry['kind'], Map<FindingSeverity, number>>();
  for (const p of resolvedPairs) {
    // Display severity for a resolved finding: the prior entry's captured
    // severity when the baseline recorded one (4.2), else the pair's
    // kind-default. Display only; never fed back into any verdict.
    const prior = p.pair.priorId !== undefined ? priorById.get(p.pair.priorId) : undefined;
    const captured =
      prior !== undefined && 'severity' in prior ? (prior.severity as FindingSeverity) : undefined;
    const severity = captured ?? p.severity;
    const sevMap = byKind.get(p.kind) ?? new Map<FindingSeverity, number>();
    if (severity !== undefined) sevMap.set(severity, (sevMap.get(severity) ?? 0) + 1);
    byKind.set(p.kind, sevMap);
  }
  const resolvedByKind: ImpactKindDelta[] = [...byKind.entries()]
    .map(([kind, sevMap]) => ({
      kind,
      count: [...sevMap.values()].reduce((a, b) => a + b, 0),
      bySeverity: SEVERITY_ORDER.filter((s) => (sevMap.get(s) ?? 0) > 0).map((s) => ({
        severity: s,
        count: sevMap.get(s)!,
      })),
    }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));

  const added = result.pairs.filter((p) => p.classification.status === 'added').length;

  const excludedCounts = new Map<FindingStatus, number>();
  for (const p of result.pairs) {
    if (UNATTRIBUTABLE_DELTA_STATUSES.includes(p.classification.status)) {
      excludedCounts.set(
        p.classification.status,
        (excludedCounts.get(p.classification.status) ?? 0) + 1,
      );
    }
  }
  const excluded = UNATTRIBUTABLE_DELTA_STATUSES.filter(
    (s) => (excludedCounts.get(s) ?? 0) > 0,
  ).map((s) => ({ status: s, count: excludedCounts.get(s)! }));

  const capNotes: ImpactCapNote[] = [];
  for (const s of scores ?? []) {
    const cap = s.capsApplied?.[0];
    if (!cap) continue; // Uncapped dimension: nothing to explain in phase 1.
    const top = s.topActions?.[0];
    capNotes.push({
      dimension: s.dimension,
      score: s.score,
      ceiling: cap.ceiling,
      reason: cap.reason,
      unlocksUpTo: s.score + cap.upliftIfRemoved,
      ...(top !== undefined && top.upliftIfFixed > 0
        ? { largestUplift: { reason: top.reason, uplift: top.upliftIfFixed } }
        : {}),
    });
  }

  const resolved = resolvedPairs.length;
  return { resolved, resolvedByKind, added, net: resolved - added, excluded, capNotes };
}

// ─── One phrasing, every surface ──────────────────────────────────────────

/** Human labels for the excluded statuses (lowercase, sentence-embeddable). */
const EXCLUDED_LABEL: Partial<Record<FindingStatus, string>> = {
  not_observed: 'not re-verified this run',
  tooling_drift: 'tooling drift',
  config_drift: 'config drift',
  newly_detected: 'newly detected by a changed scanner',
  newly_published_advisory: 'advisories published after baseline capture',
  probable_existing: 'probably pre-existing',
  uncertain: 'uncertain match',
};

function severityClause(delta: ImpactKindDelta): string {
  return delta.bySeverity.map((s) => `${s.count} ${s.severity}`).join(', ');
}

/**
 * The headline finding delta, findings first (honesty constraint 1):
 * `-5 findings resolved (dep-vuln: 2 high, 3 medium) · +0 added by this change`.
 * Only meaningful when `impact.resolved > 0`; the quiet line below covers
 * the rest.
 */
export function formatImpactHeadline(impact: ImpactSummary): string {
  const kinds = impact.resolvedByKind
    .map((d) => `${d.kind}: ${severityClause(d) || d.count}`)
    .join('; ');
  return (
    `-${impact.resolved} finding${impact.resolved === 1 ? '' : 's'} resolved` +
    (kinds ? ` (${kinds})` : '') +
    ` · +${impact.added} added by this change`
  );
}

/**
 * The cap-aware line (honesty constraint 3): the score does not move while
 * the cap binds, so say the cap and the unlock instead of letting "fixing
 * did not help" stand.
 */
export function formatImpactCapNote(note: ImpactCapNote): string {
  return (
    `${note.dimension} stays ${note.score}, capped by ${note.reason} ` +
    `(clearing that unlocks up to ${note.unlocksUpTo})` +
    (note.largestUplift !== undefined
      ? `. Largest available uplift: ${note.largestUplift.reason} (+${note.largestUplift.uplift})`
      : '')
  );
}

/** The Rule 19 exclusion disclosure, or null when nothing was excluded. */
export function formatImpactExclusions(impact: ImpactSummary): string | null {
  if (impact.excluded.length === 0) return null;
  const parts = impact.excluded.map(
    (e) => `${e.count} ${EXCLUDED_LABEL[e.status] ?? e.status.replace(/_/g, ' ')}`,
  );
  return `Not counted (cannot attribute to this change): ${parts.join(', ')}.`;
}

/**
 * The quiet line for a change with nothing resolved (UX call 1: neutral
 * changes get one line, never a section). When the change ADDS findings,
 * the line says so and defers to the existing blocking/warning surfaces:
 * Impact never duplicates the regression report (one concept, one section).
 */
export function formatImpactQuietLine(impact: ImpactSummary): string {
  if (impact.added > 0) {
    return (
      `No findings resolved by this change; the +${impact.added} it adds ` +
      `are reported with the guardrail findings.`
    );
  }
  return 'No debt impact: this change neither resolves nor adds findings.';
}
