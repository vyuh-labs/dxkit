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
  SCORE_KEY_TO_DIMENSION,
  scoreDeltas,
  type ReportHistoryEntry,
  type ReportScores,
  type ScoreDelta,
  type ScoreDimensionKey,
} from '../reports/history';
import {
  describeScoreInputsDrift,
  readReportHistory,
  scoresFromReport,
  scoreToolInputs,
} from '../reports/snapshot';
import { computeTrendContext, type TrendContext } from '../reports/trend';
import type { ImpactScoreInput } from './impact';
import type { ReportsPolicy } from './policy';
import type { BaselineMode } from './modes';

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
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      /**
       * True when the state is structural to the run's MODE (ref-based mode
       * gathers a trimmed analysis on every run, so no run of this surface
       * can ever project): the disclosure lives in the JSON, and the human
       * line is suppressed instead of repeating a permanent, non-actionable
       * sentence on every PR. Absent for actionable cases.
       */
      readonly quiet?: true;
    }
  | { readonly status: 'disabled'; readonly reason: string };

/** The projection plus the same-run score inputs for the cap-aware line
 *  (I1's `impactScores` slot). `scoreInputs` is present whenever the shared
 *  envelope could be scored, independent of whether a base snapshot made a
 *  projection possible (the cap explanation needs no history). */
export interface ScoreProjectionGather {
  readonly projection: ScoreProjection;
  readonly scoreInputs?: ReadonlyArray<ImpactScoreInput>;
  /**
   * The trend context (impact P3), computed from the SAME
   * history read the projection uses (one fetch per run, Rule 2). Present
   * whenever the history was read and non-empty, independent of whether a
   * projection was possible: the trend line describes snapshots the org has
   * already seen, so a ref-based run (whose projection is structurally
   * unavailable) still carries it. Absent when the repo disabled score
   * surfaces (`impact.projectScores: false`, which drops the snapshot read
   * entirely) or when there is no history yet.
   */
  readonly trend?: TrendContext;
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
  /** The current side's score-relevant tool inputs (`scoreToolInputs`).
   *  Compared against the base snapshot's stamp: drift (a degraded scanner,
   *  an untrusted-mode skip) is disclosed as not comparable, never diffed
   *  (Rule 19 cause 5 applied to scores). */
  readonly inputs?: ReadonlyArray<string>;
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
  const inputsDrift = describeScoreInputsDrift(base.scoreInputs, args.inputs);
  if (inputsDrift !== null) {
    return {
      status: 'not-comparable',
      reason: `${inputsDrift}, so this run's scores cannot be diffed against the snapshot's; the next merge snapshot realigns`,
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
 * reads the snapshot history ONCE (it feeds both the projection base and the
 * trend context), probes the shared analysis envelope (never builds), scores
 * it through the one evaluator path, and compares against the latest
 * snapshot. Every non-projected outcome carries its reason; nothing here can
 * throw into the check (a projection failure must never fail a gate).
 */
export async function gatherScoreProjection(
  cwd: string,
  policy: {
    readonly impact?: { readonly projectScores?: boolean };
    readonly reports?: ReportsPolicy;
  },
  seams?: ScoreProjectionSeams,
  mode?: BaselineMode,
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
    // ONE history read per run (Rule 2): the projection's base AND the
    // trend context (impact P3) both come from this fetch; no path reads
    // the anchor twice. The trend describes snapshots the org has already
    // seen, so it is computed BEFORE the paths that cannot project (a
    // ref-based run, a run with no shared envelope) return.
    const readHistory = seams?.readHistory ?? readReportHistory;
    const history = readHistory(cwd, policy.reports?.anchorRef);
    const trend = computeTrendContext(history);
    const withTrend = (projection: ScoreProjection): ScoreProjectionGather => ({
      projection,
      ...(trend !== null ? { trend } : {}),
    });
    if (mode === 'ref-based') {
      // Structural to the mode, quiet by design: ref-based mode trims the
      // gather on EVERY run, so a per-PR sentence would repeat forever with
      // nothing the PR author can do. The JSON keeps the disclosure; the
      // off-switch (impact.projectScores: false) silences even that.
      return withTrend({
        status: 'unavailable',
        reason:
          'ref-based mode gathers a trimmed analysis each run, so dimension scores are not ' +
          'recomputed on this surface (committed baseline modes project; ' +
          'impact.projectScores: false turns the projection off entirely)',
        quiet: true,
      });
    }
    const peek =
      seams?.peek ??
      (async (dir: string) => {
        const envelope = await peekAnalysisResult(dir);
        return envelope ? { report: scoreAndFormatHealth(envelope) } : null;
      });
    const scored = await peek(cwd);
    if (!scored) {
      return withTrend({
        status: 'unavailable',
        reason:
          'this run held no full shared analysis to score (a trimmed or partial gather), ' +
          'so dimension scores were not recomputed',
      });
    }
    const scoreInputs = impactScoreInputsFromReport(scored.report);
    const projection = computeScoreProjection({
      current: scoresFromReport(scored.report),
      methodology: SCORING_METHODOLOGY_VERSION,
      inputs: scoreToolInputs(scored.report),
      history,
    });
    return { ...withTrend(projection), scoreInputs };
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
  const out: ImpactScoreInput[] = [];
  for (const name of Object.keys(SCORE_KEY_TO_DIMENSION) as ScoreDimensionKey[]) {
    const d = report.dimensions[SCORE_KEY_TO_DIMENSION[name]];
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
  if (projection.status === 'unavailable') {
    return projection.quiet ? null : `scores not projected: ${projection.reason}`;
  }
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
