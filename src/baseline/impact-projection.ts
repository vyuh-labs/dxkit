/**
 * The score projection (impact surface P2): "if merged: security 40 -> 46
 * (projected)" on the guardrail PR surfaces.
 *
 * Honesty constraints, implemented as code, not prose:
 *
 *   - **No second score computation path (Rule 2).** The current side is
 *     `scoreAndFormatHealth` over the SAME shared `AnalysisResult` the
 *     guardrail run already gathered (`peekAnalysisResult`, a probe that
 *     never builds), mapped through the snapshot publisher's own
 *     `scoresFromReport`. When no full shared envelope exists (a ref-based
 *     run's trimmed gather), the projection declines with a disclosed
 *     reason; it never re-gathers (measured 80+ seconds on a large tree)
 *     and never approximates from a partial gather.
 *   - **The base is the number the org has seen.** It comes from the latest
 *     `report-history.jsonl` snapshot on the reports anchor ref, never a
 *     local recomputation of the base tree.
 *   - **Methodology identity (constraint 4).** Both sides must carry the
 *     same `SCORING_METHODOLOGY_VERSION`; a mismatch, including a
 *     pre-stamping snapshot with no version at all, is disclosed as "not
 *     comparable this PR", mirroring the Rule 19 recall discipline (absent
 *     evidence is not comparable evidence).
 *   - **A projection is labeled projected**, every dimension delta comes
 *     from the ONE delta computation (`scoreDeltas` in reports/history),
 *     and zero movement is reported as zero, never omitted.
 *
 * The hidden markdown marker written beside a projected line is the
 * calibration hand-off: the post-merge landed update (reports lane) parses
 * it back to render "actual; projection was P". Writer and parser live here
 * together so the codec cannot fork.
 */

import { peekAnalysisResult } from '../analyzers/cache';
import { scoreAndFormatHealth } from '../analyzers/health';
import type { HealthReport } from '../analyzers/types';
import { SCORING_METHODOLOGY_VERSION } from '../scoring/methodology';
import {
  SCORE_KEYS,
  scoreDeltas,
  type ReportHistoryEntry,
  type ReportScores,
  type ScoreDelta,
} from '../reports/history';
import { readReportHistory, scoresFromReport } from '../reports/snapshot';
import type { ImpactScoreInput } from './impact';
import type { ReportsPolicy } from './policy';

// ─── The projection model ─────────────────────────────────────────────────

/**
 * One projection outcome, total over the four honest states. Rides the
 * guardrail JSON (`impact.projection`, additive optional) so every surface
 * and embedder sees the same claim with the same disclosure.
 *
 *   - `projected`: both sides comparable; `deltas` carries every dimension
 *     (zero as zero, unmeasured as null: the ONE `ScoreDelta` shape).
 *   - `not-comparable`: a base snapshot exists but under a different (or
 *     absent) scoring methodology; nothing is diffed.
 *   - `unavailable`: no base snapshot, or no full shared analysis to score
 *     the current side from. The reason says which.
 *   - `disabled`: the repo turned the projection off
 *     (`impact.projectScores: false`); carried so JSON consumers can tell
 *     "off by choice" from "could not".
 */
export type ScoreProjection =
  | {
      readonly status: 'projected';
      /** Per-dimension movement base -> current, from the one delta
       *  computation (`scoreDeltas`). Includes `overall`. */
      readonly deltas: ReadonlyArray<ScoreDelta>;
      readonly methodology: string;
      /** The snapshot the base side came from. */
      readonly base: { readonly sha: string; readonly date: string };
    }
  | { readonly status: 'not-comparable'; readonly reason: string }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'disabled'; readonly reason: string };

/** The projection plus the same-run score inputs for the cap-aware line
 *  (I1's `impactScores` slot). `scoreInputs` is present whenever the shared
 *  envelope could be scored, independent of whether a base snapshot made a
 *  projection possible (the cap explanation needs no history). */
export interface ScoreProjectionGather {
  readonly projection: ScoreProjection;
  readonly scoreInputs?: ReadonlyArray<ImpactScoreInput>;
}

// ─── Pure core ────────────────────────────────────────────────────────────

/**
 * Compare the current side against the latest snapshot, methodology-guarded.
 * Pure; the IO wrapper below feeds it.
 */
export function computeScoreProjection(args: {
  readonly current: ReportScores;
  /** The methodology the current side was computed under (the running
   *  dxkit's `SCORING_METHODOLOGY_VERSION`). */
  readonly methodology: string;
  readonly history: ReadonlyArray<ReportHistoryEntry>;
}): ScoreProjection {
  const base = args.history[args.history.length - 1];
  if (!base) {
    return {
      status: 'unavailable',
      reason:
        'no score history on the reports ref yet (enable reports.onMerge to publish ' +
        'per-merge snapshots; the first snapshot starts the trend)',
    };
  }
  if (base.methodology === undefined) {
    return {
      status: 'not-comparable',
      reason:
        `the latest snapshot (${base.sha.slice(0, 12)}) predates scoring-methodology ` +
        'stamping, so its scores cannot be verified comparable; the next merge snapshot realigns',
    };
  }
  if (base.methodology !== args.methodology) {
    return {
      status: 'not-comparable',
      reason:
        `the latest snapshot was scored under methodology '${base.methodology}' but this run ` +
        `scores under '${args.methodology}'; the next merge snapshot realigns`,
    };
  }
  return {
    status: 'projected',
    deltas: scoreDeltas(base.scores, args.current),
    methodology: args.methodology,
    base: { sha: base.sha, date: base.date },
  };
}

// ─── IO wrapper (the guardrail CLI's entry point) ─────────────────────────

/** Injectable seams for tests; production callers omit them. */
export interface ScoreProjectionSeams {
  readonly peek?: (cwd: string) => Promise<{ report: HealthReport } | null>;
  readonly readHistory?: (cwd: string, anchorRef?: string) => ReportHistoryEntry[];
}

/**
 * Gather the projection for a guardrail run at `cwd`. Reads the policy knob,
 * probes the shared analysis envelope (never builds), scores it through the
 * one evaluator path, and compares against the latest snapshot. Every
 * non-projected outcome carries its reason; nothing here can throw into the
 * check (a projection failure must never fail a gate).
 */
export async function gatherScoreProjection(
  cwd: string,
  policy: {
    readonly impact?: { readonly projectScores?: boolean };
    readonly reports?: ReportsPolicy;
  },
  seams?: ScoreProjectionSeams,
): Promise<ScoreProjectionGather> {
  if (policy.impact?.projectScores === false) {
    return {
      projection: {
        status: 'disabled',
        reason: 'score projection is off for this repo (impact.projectScores: false)',
      },
    };
  }
  try {
    const peek =
      seams?.peek ??
      (async (dir: string) => {
        const envelope = await peekAnalysisResult(dir);
        return envelope ? { report: scoreAndFormatHealth(envelope) } : null;
      });
    const scored = await peek(cwd);
    if (!scored) {
      return {
        projection: {
          status: 'unavailable',
          reason:
            'this run gathered a trimmed analysis (no full shared envelope to score), ' +
            'so dimension scores were not recomputed',
        },
      };
    }
    const scoreInputs = impactScoreInputsFromReport(scored.report);
    const readHistory = seams?.readHistory ?? readReportHistory;
    const history = readHistory(cwd, policy.reports?.anchorRef);
    const projection = computeScoreProjection({
      current: scoresFromReport(scored.report),
      methodology: SCORING_METHODOLOGY_VERSION,
      history,
    });
    return { projection, scoreInputs };
  } catch (err) {
    // Fail open, never silent (the GateFailure discipline): a projection
    // error degrades to a disclosed unavailable, and the gate is untouched.
    return {
      projection: {
        status: 'unavailable',
        reason: `score projection failed: ${(err as Error).message}`,
      },
    };
  }
}

/**
 * Map a scored report's dimensions to the impact model's score slots
 * (`ImpactScoreInput`) so the cap-aware line renders from the same-run spec
 * output (I1 honesty constraint 3). Dimension names use the durable
 * `ReportScores` keys, the same vocabulary the projection line and the
 * history surface speak.
 */
export function impactScoreInputsFromReport(report: HealthReport): ReadonlyArray<ImpactScoreInput> {
  const dims: ReadonlyArray<
    readonly [Exclude<keyof ReportScores, 'overall'>, keyof HealthReport['dimensions']]
  > = [
    ['security', 'security'],
    ['quality', 'quality'],
    ['tests', 'testing'],
    ['documentation', 'documentation'],
    ['maintainability', 'maintainability'],
    ['developerExperience', 'developerExperience'],
  ];
  const out: ImpactScoreInput[] = [];
  for (const [name, dim] of dims) {
    const d = report.dimensions[dim];
    if (!d) continue;
    out.push({
      dimension: name,
      score: d.score,
      ...(d.capsApplied !== undefined ? { capsApplied: d.capsApplied } : {}),
      ...(d.topActions !== undefined ? { topActions: d.topActions } : {}),
    });
  }
  return out;
}

// ─── One phrasing, every surface ──────────────────────────────────────────

/**
 * The projection line (one phrasing; the three check renderers compose it):
 *
 *   - movement: `security 40 -> 46 (projected) · other dimensions unchanged`
 *   - all flat:  `scores unchanged (projected)` (zero reported as zero)
 *   - unmeasured dimensions are named, never silently dropped
 *   - not-comparable / unavailable: the disclosure, prefixed
 *   - disabled: null, the repo chose no line
 */
export function formatScoreProjection(projection: ScoreProjection): string | null {
  if (projection.status === 'disabled') return null;
  if (projection.status === 'unavailable') return `scores not projected: ${projection.reason}`;
  if (projection.status === 'not-comparable') {
    return `scores not comparable this PR: ${projection.reason}`;
  }
  const dims = projection.deltas.filter((d) => d.key !== 'overall');
  const moved = dims.filter((d) => d.delta !== null && d.delta !== 0);
  const unmeasured = dims.filter((d) => d.delta === null);
  const parts: string[] = moved.map((d) => `${d.key} ${d.from} -> ${d.to} (projected)`);
  if (moved.length === 0) parts.push('scores unchanged (projected)');
  else if (moved.length < dims.length - unmeasured.length) parts.push('other dimensions unchanged');
  if (unmeasured.length > 0) {
    parts.push(`${unmeasured.map((d) => d.key).join(', ')} not projected (unmeasured)`);
  }
  return parts.join(' · ');
}

// ─── The projection marker codec (pre-merge writer + post-merge reader) ──

/** The marker prefix. The whole marker is one HTML comment on its own line
 *  inside the guardrail PR comment; invisible to readers, parsed back by the
 *  post-merge landed update. */
export const IMPACT_PROJECTION_MARKER_PREFIX = '<!-- dxkit-impact-projection ';

/** What the marker carries: per-dimension projected from/to (measured
 *  dimensions only) plus the methodology they were projected under. */
export interface ImpactProjectionRecord {
  readonly methodology: string;
  readonly scores: Readonly<Record<string, { readonly from: number; readonly to: number }>>;
}

/** Render the hidden marker for a projected outcome; null otherwise. */
export function impactProjectionMarker(projection: ScoreProjection): string | null {
  if (projection.status !== 'projected') return null;
  const scores: Record<string, { from: number; to: number }> = {};
  for (const d of projection.deltas) {
    if (d.key === 'overall') continue;
    if (typeof d.from === 'number' && typeof d.to === 'number') {
      scores[d.key] = { from: d.from, to: d.to };
    }
  }
  const record: ImpactProjectionRecord = { methodology: projection.methodology, scores };
  return `${IMPACT_PROJECTION_MARKER_PREFIX}${JSON.stringify(record)} -->`;
}

/** Parse the marker back out of a PR comment body. Tolerant: a missing or
 *  malformed marker reads as "no projection was made" (null), never a throw;
 *  the landed update then renders actual-only. */
export function parseImpactProjectionMarker(body: string): ImpactProjectionRecord | null {
  const start = body.indexOf(IMPACT_PROJECTION_MARKER_PREFIX);
  if (start === -1) return null;
  const rest = body.slice(start + IMPACT_PROJECTION_MARKER_PREFIX.length);
  const end = rest.indexOf(' -->');
  if (end === -1) return null;
  try {
    const parsed: unknown = JSON.parse(rest.slice(0, end));
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.methodology !== 'string' || !o.scores || typeof o.scores !== 'object') {
      return null;
    }
    const scores: Record<string, { from: number; to: number }> = {};
    for (const [key, value] of Object.entries(o.scores as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      if (typeof v.from === 'number' && typeof v.to === 'number') {
        scores[key] = { from: v.from, to: v.to };
      }
    }
    return { methodology: o.methodology, scores };
  } catch {
    return null;
  }
}

/** Stable dimension order for landed/projection rendering, derived from the
 *  ONE key list, never a second ordering. */
export const PROJECTION_DIMENSION_KEYS: ReadonlyArray<keyof ReportScores> = SCORE_KEYS.filter(
  (k) => k !== 'overall',
);
