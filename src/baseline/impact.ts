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
 *      marked `removed`. The classifier itself excludes the unattributable
 *      causes in both directions (`not_observed` when the check never ran,
 *      `tooling_drift` when the tool moved, including a matcher-removed
 *      pair on a recall-drifted kind); this module consumes those verdicts
 *      through a TOTAL status partition, never a raw set diff. And when the
 *      run as a whole refused to gate (attribution gaps, missing required
 *      observations), `attributable` is false and no surface may render a
 *      resolved claim at all.
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
import type { ScoreProjection } from './impact-projection';
import { formatTrendContext, type TrendContext } from '../reports/trend';

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
  /**
   * False when the run as a whole REFUSED to gate (attribution gaps on
   * block-rule kinds, or required checks not observed: the `CANNOT GATE`
   * tier). A refused run cannot back a resolved claim any more than a
   * clean one, so no renderer may print the headline or the quiet line
   * over it; every surface renders the not-attributable one-liner instead
   * (`formatImpactNotAttributable`) and defers to the gap disclosures.
   * The counts below are still carried (data, plainly flagged), never
   * fabricated to zero.
   */
  readonly attributable: boolean;
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
   *  check never re-verified them) and `tooling_drift` (either direction:
   *  the tool moved, not the code) are the common entries. Unchanged debt
   *  (`persisted` / `relocated`) is not a delta and is not listed. Empty
   *  when every delta pair was attributable. */
  readonly excluded: ReadonlyArray<{ readonly status: FindingStatus; readonly count: number }>;
  /** Cap-aware explanations, one per capped dimension among the score
   *  results the surface supplied. Empty when no score result was present
   *  (the section then carries the finding delta alone) or nothing is
   *  capped. */
  readonly capNotes: ReadonlyArray<ImpactCapNote>;
  /**
   * The score projection (impact surface P2), when the surface computed one:
   * projected dimension deltas against the latest snapshot, or the disclosed
   * reason none was made (`not-comparable` / `unavailable` / `disabled`).
   * Additive optional: pre-P2 payloads and surfaces without a projection
   * simply omit it. Never a claim of fact: every rendered form carries the
   * word "projected" (see `formatScoreProjection`).
   */
  readonly projection?: ScoreProjection;
  /**
   * The since-install trend context (impact P3), when the surface read the
   * snapshot history this run (the projection gather's one fetch). A
   * statement about the repo's PUBLISHED record, not about this change, so
   * it is carried even on a refused run (data, plainly labeled); the
   * renderers still print its line only inside an attributable Impact
   * section. Additive optional, like `projection`.
   */
  readonly trend?: TrendContext;
}

/**
 * The TOTAL status partition (the `KIND_OBSERVATION_SCOPE` discipline): every
 * `FindingStatus` declares which side of the impact delta it belongs to, so a
 * future status fails to COMPILE here instead of silently dropping out of
 * both the tally and the disclosure.
 *
 *   - `resolved`: counts toward the resolved headline. `fixed` is the
 *     reserved policy-positive spelling of `removed`; the classifier never
 *     emits it today, and `verdictCounts` counts only `removed`; if the
 *     classifier ever starts emitting `fixed`, the resolved-parity pin in
 *     `test/baseline/impact.test.ts` fails loudly and forces the two tallies
 *     to be reconciled in one deliberate change.
 *   - `added`: counts toward the attributable added tally.
 *   - `excluded`: an unattributable delta (Rule 19 causes 2 through 6),
 *     disclosed and never counted.
 *   - `neutral`: unchanged debt, not a delta at all.
 */
const STATUS_PARTITION: Readonly<
  Record<FindingStatus, 'resolved' | 'added' | 'excluded' | 'neutral'>
> = {
  removed: 'resolved',
  fixed: 'resolved',
  added: 'added',
  persisted: 'neutral',
  relocated: 'neutral',
  not_observed: 'excluded',
  tooling_drift: 'excluded',
  config_drift: 'excluded',
  newly_detected: 'excluded',
  newly_published_advisory: 'excluded',
  probable_existing: 'excluded',
  uncertain: 'excluded',
};

/** The excluded statuses in stable disclosure order (partition insertion
 *  order), derived from the one partition, never a second list. */
const EXCLUDED_STATUS_ORDER: ReadonlyArray<FindingStatus> = (
  Object.keys(STATUS_PARTITION) as FindingStatus[]
).filter((s) => STATUS_PARTITION[s] === 'excluded');

/**
 * Derive the impact summary from an existing check result. Pure; accepts
 * the structural subset of `GuardrailCheckResult` it reads, so the lane
 * surfaces (which hold the full result) and tests (which build fixtures)
 * share one entry point. The refusal fields (`attributionGaps`,
 * `requiredNotObserved`) are optional structurally so fixtures stay small;
 * a full `GuardrailCheckResult` always carries them, so every real caller
 * gets the `attributable` answer for free.
 */
export function deriveImpact(
  result: {
    readonly pairs: ReadonlyArray<ClassifiedPair>;
    readonly baseline: { readonly findings: ReadonlyArray<BaselineEntry> };
    readonly attributionGaps?: ReadonlyArray<unknown>;
    readonly requiredNotObserved?: ReadonlyArray<unknown>;
  },
  scores?: ReadonlyArray<ImpactScoreInput>,
  projection?: ScoreProjection,
  trend?: TrendContext,
): ImpactSummary {
  const priorById = new Map(result.baseline.findings.map((e) => [e.id, e] as const));

  // The whole-run refusal signal (the CANNOT GATE tier): while a gap exists,
  // the run can neither certify "no net-new" nor back "you fixed N": the
  // same evidence is missing for both claims.
  const attributable =
    (result.attributionGaps?.length ?? 0) === 0 && (result.requiredNotObserved?.length ?? 0) === 0;

  // Resolved: the statuses the partition declares resolved (today `removed`;
  // `not_observed` and removed-direction `tooling_drift` pairs were already
  // re-labeled by the ONE classifier (Rule 19's removed direction), so
  // consuming the classification here is what keeps this a claim the run
  // can back). Matches the `resolved` tally in `verdictCounts` (pinned by
  // the parity test; see the partition note on `fixed`).
  const resolvedPairs = result.pairs.filter(
    (p) => STATUS_PARTITION[p.classification.status] === 'resolved',
  );

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

  const added = result.pairs.filter(
    (p) => STATUS_PARTITION[p.classification.status] === 'added',
  ).length;

  const excludedCounts = new Map<FindingStatus, number>();
  for (const p of result.pairs) {
    if (STATUS_PARTITION[p.classification.status] === 'excluded') {
      excludedCounts.set(
        p.classification.status,
        (excludedCounts.get(p.classification.status) ?? 0) + 1,
      );
    }
  }
  const excluded = EXCLUDED_STATUS_ORDER.filter((s) => (excludedCounts.get(s) ?? 0) > 0).map(
    (s) => ({ status: s, count: excludedCounts.get(s)! }),
  );

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

  // A refused run (CANNOT GATE) may not carry a projected score claim any
  // more than a resolved count: the renderers already suppress the line, but
  // the JSON field would still hand an embedder 'projected' deltas to render
  // on their own. Neutralize it to a disclosed unavailable instead.
  const effectiveProjection: ScoreProjection | undefined =
    projection !== undefined && !attributable
      ? {
          status: 'unavailable',
          reason:
            'the run could not attribute changes (CANNOT GATE), so no score movement can be claimed',
        }
      : projection;

  const resolved = resolvedPairs.length;
  return {
    attributable,
    resolved,
    resolvedByKind,
    added,
    net: resolved - added,
    excluded,
    capNotes,
    ...(effectiveProjection !== undefined ? { projection: effectiveProjection } : {}),
    ...(trend !== undefined ? { trend } : {}),
  };
}

// ─── One phrasing, every surface ──────────────────────────────────────────

/** Human labels for the excluded statuses (lowercase, sentence-embeddable
 *  after a count). */
const EXCLUDED_LABEL: Partial<Record<FindingStatus, string>> = {
  not_observed: 'not re-verified this run',
  tooling_drift: 'demoted to tooling drift',
  config_drift: 'demoted to config drift',
  newly_detected: 'newly detected by a changed scanner',
  newly_published_advisory: 'from advisories published after baseline capture',
  probable_existing: 'probably pre-existing',
  uncertain: 'uncertain matches',
};

/** Per-status excluded clauses ("2 demoted to tooling drift"), shared by the
 *  exclusion disclosure and the quiet line so the wording cannot fork. */
function excludedParts(impact: ImpactSummary): string[] {
  return impact.excluded.map(
    (e) => `${e.count} ${EXCLUDED_LABEL[e.status] ?? e.status.replace(/_/g, ' ')}`,
  );
}

function excludedTotal(impact: ImpactSummary): number {
  return impact.excluded.reduce((n, e) => n + e.count, 0);
}

function severityClause(delta: ImpactKindDelta): string {
  return delta.bySeverity.map((s) => `${s.count} ${s.severity}`).join(', ');
}

/**
 * The headline finding delta, findings first (honesty constraint 1):
 * `-5 findings resolved (dep-vuln: 2 high, 3 medium) · +0 added by this change`.
 * Only meaningful when `impact.attributable` and `impact.resolved > 0`; the
 * quiet line and the not-attributable line below cover the rest.
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
  return `Not counted (cannot attribute to this change): ${excludedParts(impact).join(', ')}.`;
}

/**
 * The one-liner every surface renders INSTEAD of the section or the quiet
 * line when the run refused to gate (`attributable === false`): a run that
 * cannot attribute its delta may not claim any of it, in either direction.
 */
export function formatImpactNotAttributable(): string {
  return (
    'Impact not attributable this run: the guardrail refused to gate, so no resolved or ' +
    'added claim is made; see the attribution-gap disclosures.'
  );
}

/**
 * The quiet line for an attributable change with nothing resolved (UX call
 * 1: neutral changes get one line, never a section). Three honest shapes:
 *
 *   - the change ADDS findings: say so and defer to the existing
 *     blocking/warning surfaces (Impact never duplicates the regression
 *     report; one concept, one section);
 *   - nothing attributable moved but delta pairs were EXCLUDED (an advisory
 *     wave, a tooling-drift demotion): "no debt impact" would over-claim,
 *     so the line says no ATTRIBUTABLE impact and names what could not be
 *     attributed;
 *   - genuinely nothing: plain zero, reported as zero.
 */
export function formatImpactQuietLine(impact: ImpactSummary): string {
  const excludedN = excludedTotal(impact);
  if (impact.added > 0) {
    const base =
      `No findings resolved by this change; the +${impact.added} it adds ` +
      `are reported with the guardrail findings.`;
    return excludedN > 0 ? `${base} ${formatImpactExclusions(impact)!}` : base;
  }
  if (excludedN > 0) {
    return (
      `No attributable debt impact; ${excludedN} finding${excludedN === 1 ? '' : 's'} could ` +
      `not be attributed to this change (${excludedParts(impact).join(', ')}).`
    );
  }
  return 'No debt impact: this change neither resolves nor adds findings.';
}

/**
 * The trend context line (impact P3), composed from the summary's own
 * fields: the one trend phrasing (`formatTrendContext`) plus the projected
 * OVERALL movement when this run projected one (it feeds the conditional
 * "this PR would be the first improvement on record" claim). Null when the
 * surface read no history. Rendered only inside an attributable Impact
 * section, like the projection line.
 */
export function formatImpactTrendLine(impact: ImpactSummary): string | null {
  if (impact.trend === undefined) return null;
  const overallDelta =
    impact.projection !== undefined && impact.projection.status === 'projected'
      ? (impact.projection.deltas.find((d) => d.key === 'overall')?.delta ?? null)
      : null;
  return formatTrendContext(impact.trend, { projectedOverallDelta: overallDelta });
}
