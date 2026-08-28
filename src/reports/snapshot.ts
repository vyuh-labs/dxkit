/**
 * Report-snapshot publisher — the ONE entry point that turns a scored health
 * report into a `dxkit-reports` anchor publish: it maps the report to a
 * `ReportHistoryEntry`, folds it into the history read off the anchor, and
 * publishes the appended JSONL + the `latest/` artifacts through the shared
 * `publishFilesToAnchorRef` (CLAUDE.md Rule 2 — no bespoke push). The CLI + the
 * on-merge workflow both call `publishReportSnapshot`; the pure
 * `reportToHistoryEntry` is unit-testable without git.
 */
import {
  parseHistory,
  serializeHistory,
  foldEntry,
  SCORE_KEY_TO_DIMENSION,
  type DebtSeverity,
  type ReportDebtCounts,
  type ReportHistoryEntry,
  type ReportScores,
  type ReportFindingCounts,
  type ScoreDimensionKey,
  type ReportDimensionName,
} from './history';
import { renderImpactReportMarkdown, IMPACT_REPORT_PATH } from './impact-report';
import {
  readFromAnchorRef,
  publishFilesToAnchorRef,
  type PublishResult,
} from '../baseline/anchor-publish';
import { SCORING_METHODOLOGY_VERSION } from '../scoring/methodology';

/** Default side ref for report snapshots (kept distinct from the baseline anchor
 *  `dxkit-baselines` so report churn/retention never touches the baseline). */
export const DEFAULT_REPORTS_REF = 'dxkit-reports';
export const REPORT_HISTORY_PATH = 'report-history.jsonl';

/** Minimal structural view of a scored health report — the fields the snapshot
 *  reads. Kept structural (not an import of the full HealthReport) so this stays
 *  decoupled + testable, and tolerant of a dimension being absent/unmeasured. */
export interface SnapshotSource {
  readonly summary: { readonly overallScore: number | null };
  readonly dimensions: Partial<
    Record<ReportDimensionName, { readonly score: number | null } | undefined>
  >;
  readonly findings?: ReportFindingCounts;
  /** Tools that ran for this report (mirrors `HealthReport.toolsUsed`). */
  readonly toolsUsed?: ReadonlyArray<string>;
  /** Tools attempted but unavailable (`HealthReport.toolsUnavailable`);
   *  entries may carry a machine-phrased reason suffix that is stripped
   *  before stamping. */
  readonly toolsUnavailable?: ReadonlyArray<string>;
  /** The run's canonical security aggregate severity buckets (G_v4_8 read
   *  discipline: consumed by bucket NAME, never recomputed). Structural
   *  subset of `SecurityAggregate`; `HealthReport.capabilities` satisfies
   *  it. Feeds the debt-over-time series stamp. */
  readonly capabilities?: {
    readonly securityAggregate?: {
      readonly secretsBySeverity: SeverityBuckets;
      readonly codeBySeverity: SeverityBuckets;
      readonly depBySeverity: SeverityBuckets;
      /** The per-source run-state (the aggregate's own provenance). REQUIRED
       *  alongside the buckets: a bucket without its provenance cannot say
       *  whether {0,0,0,0} means "scanned clean" or "scanner never ran", and
       *  the debt stamp must never chart the latter as zero. */
      readonly provenance: {
        readonly secrets: { readonly ran: boolean };
        readonly codePatterns: { readonly ran: boolean };
        readonly depVulns: { readonly available: boolean };
      };
    };
  };
}

/** Structural view of the aggregator's `SeverityCounts`. */
export interface SeverityBuckets {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface SnapshotMeta {
  readonly sha: string;
  readonly date: string;
  readonly dxkitVersion: string;
  readonly branch?: string;
}

function dimScore(src: SnapshotSource, key: keyof SnapshotSource['dimensions']): number | null {
  const v = src.dimensions[key]?.score;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The ONE map from a scored report's dimensions to the durable `ReportScores`
 * shape (the `tests` field reads the report's `testing` dimension; the entry
 * field stays `tests` for brevity + JSON stability). Both the snapshot
 * publisher and the guardrail's score projection (impact surface P2) read
 * through this, so "the number the org has seen" and "the number a PR
 * projects" can never come from two different mappings.
 */
export function scoresFromReport(src: SnapshotSource): ReportScores {
  const out = {
    overall: typeof src.summary.overallScore === 'number' ? src.summary.overallScore : null,
  } as Record<keyof ReportScores, number | null>;
  for (const key of Object.keys(SCORE_KEY_TO_DIMENSION) as ScoreDimensionKey[]) {
    out[key] = dimScore(src, SCORE_KEY_TO_DIMENSION[key]);
  }
  return out as ReportScores;
}

/**
 * The score-relevant tool inputs of a report, in the ONE normalized shape
 * both comparability guards read (`computeScoreProjection` pre-merge,
 * `renderLandedSection` / the landed skip post-merge): sorted unique tool
 * names that ran, plus `!name` for a tool attempted but unavailable (the
 * reason suffix is stripped: it can phrase machine specifics, and Rule 19
 * bans machine-specific values in comparability inputs). Deterministic per
 * environment; a difference between two environments is exactly the drift
 * the guards must disclose.
 */
export function scoreToolInputs(src: {
  readonly toolsUsed?: ReadonlyArray<string>;
  readonly toolsUnavailable?: ReadonlyArray<string>;
}): string[] {
  const names = new Set<string>();
  for (const tool of src.toolsUsed ?? []) {
    const name = tool.trim();
    if (name) names.add(name);
  }
  for (const tool of src.toolsUnavailable ?? []) {
    const name = tool.split(' (')[0]!.trim();
    if (name) names.add(`!${name}`);
  }
  return [...names].sort();
}

// `describeScoreInputsDrift` (the ONE score-input comparability comparator)
// lives beside the entry codec in history.ts (it compares entry STAMPS, and
// keeping it there keeps the trend module free of a snapshot->trend import
// cycle); re-exported here so every existing consumer keeps its import path.
export { describeScoreInputsDrift } from './history';

/**
 * The debt-over-time stamp: kind x severity counts read straight off the
 * run's canonical `SecurityAggregate` buckets (Rule 2: no new gather, no
 * recount; the ONE aggregator already computed them). Keys are the durable
 * `IdentityKind` names. Raw buckets, deliberately (what exists, before any
 * allowlist adjustment) so the series charts the debt itself.
 *
 * Provenance-gated, per kind (Rule 19 applied to the stamp): a kind whose
 * source the aggregate's provenance says did NOT observe this run (gitleaks
 * missing, OSV offline) is OMITTED, so the published series charts a gap
 * there, never a fabricated "debt cleared to zero". A kind that RAN stamps
 * all four severities with zero as zero: a cleared kind must chart as 0,
 * distinguishable from unmeasured. Counts only, never per-finding data (the
 * reports ref is a shareable surface).
 */
export function debtFromAggregate(aggregate: {
  readonly secretsBySeverity: SeverityBuckets;
  readonly codeBySeverity: SeverityBuckets;
  readonly depBySeverity: SeverityBuckets;
  readonly provenance: {
    readonly secrets: { readonly ran: boolean };
    readonly codePatterns: { readonly ran: boolean };
    readonly depVulns: { readonly available: boolean };
  };
}): ReportDebtCounts {
  const cell = (b: SeverityBuckets): Readonly<Record<DebtSeverity, number>> => ({
    critical: b.critical,
    high: b.high,
    medium: b.medium,
    low: b.low,
  });
  return {
    ...(aggregate.provenance.secrets.ran ? { secret: cell(aggregate.secretsBySeverity) } : {}),
    ...(aggregate.provenance.codePatterns.ran ? { code: cell(aggregate.codeBySeverity) } : {}),
    ...(aggregate.provenance.depVulns.available
      ? { 'dep-vuln': cell(aggregate.depBySeverity) }
      : {}),
  };
}

/** Pure map from a scored report to the durable history entry. Stamps the
 *  scoring-methodology identity AND the score-input list so later score
 *  comparisons can verify they compare like with like (impact P2 honesty
 *  constraint 4 + Rule 19 cause 5), plus the debt-over-time counts when the
 *  run built the canonical security aggregate (absent means unmeasured). */
export function reportToHistoryEntry(src: SnapshotSource, meta: SnapshotMeta): ReportHistoryEntry {
  const aggregate = src.capabilities?.securityAggregate;
  const debt = aggregate !== undefined ? debtFromAggregate(aggregate) : undefined;
  return {
    sha: meta.sha,
    date: meta.date,
    dxkitVersion: meta.dxkitVersion,
    ...(meta.branch ? { branch: meta.branch } : {}),
    methodology: SCORING_METHODOLOGY_VERSION,
    scoreInputs: scoreToolInputs(src),
    scores: scoresFromReport(src),
    ...(src.findings ? { findings: src.findings } : {}),
    // Stamp only when at least one kind was observed: an all-unobserved run
    // reads as unmeasured, never as an empty measurement.
    ...(debt !== undefined && Object.keys(debt).length > 0 ? { debt } : {}),
  };
}

/** A `latest/` artifact to publish alongside the history (dashboard HTML, health
 *  markdown, …). `path` is relative to the ref root; snapshot places these under
 *  `latest/`. */
export interface SnapshotArtifact {
  readonly path: string;
  readonly content: string;
}

export interface PublishSnapshotOptions {
  readonly cwd: string;
  readonly anchorRef?: string;
  readonly entry: ReportHistoryEntry;
  /** Rendered `latest/` files (dashboard.html, health.md, …). */
  readonly artifacts?: readonly SnapshotArtifact[];
  /** Retain the most recent N history entries (<= 0 keeps all). */
  readonly retainHistory?: number;
  readonly identity?: { readonly name: string; readonly email: string };
  readonly timeoutMs?: number;
}

export interface PublishSnapshotResult {
  readonly publish: PublishResult;
  /** History length after the fold (what was written). */
  readonly historyCount: number;
  readonly anchorRef: string;
  /**
   * The most recent PRIOR entry (a different sha than the one just folded):
   * the base the org had already seen before this snapshot. The post-merge
   * landed-comment update diffs the new entry against exactly this.
   * Undefined on the first-ever snapshot.
   */
  readonly previousEntry?: ReportHistoryEntry;
}

/**
 * Read the current `report-history.jsonl` off the anchor, fold `entry` in (with
 * retention), and publish the appended JSONL + the `latest/` artifacts to the
 * anchor via the shared writer. Accumulate transport: unchanged `latest/` files
 * that aren't re-supplied persist; the writer no-ops when nothing changed.
 */
export function publishReportSnapshot(opts: PublishSnapshotOptions): PublishSnapshotResult {
  const anchorRef = opts.anchorRef ?? DEFAULT_REPORTS_REF;
  const existing = parseHistory(readFromAnchorRef(opts.cwd, anchorRef, REPORT_HISTORY_PATH));
  const previousEntry = [...existing].reverse().find((e) => e.sha !== opts.entry.sha);
  const folded = foldEntry(existing, opts.entry, opts.retainHistory ?? 0);

  const files = [
    { path: REPORT_HISTORY_PATH, content: serializeHistory(folded) },
    // The published impact report (4.4.7): rendered HERE, from the folded
    // history this publish is writing, so it can never go stale relative to
    // the series beside it, and the one anchor read feeds both. It cannot
    // ride `collectArtifacts` (which picks up pre-rendered analyzer files):
    // its input IS the folded history, which only exists at this point.
    // Deterministic for identical input; counts and scores only.
    { path: IMPACT_REPORT_PATH, content: renderImpactReportMarkdown(folded) },
    ...(opts.artifacts ?? []).map((a) => ({ path: `latest/${a.path}`, content: a.content })),
  ];

  const publish = publishFilesToAnchorRef({
    cwd: opts.cwd,
    anchorRef,
    files,
    message: `chore(reports): snapshot ${opts.entry.sha.slice(0, 12)} (overall ${opts.entry.scores.overall ?? '—'})`,
    ...(opts.identity ? { identity: opts.identity } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    publish,
    historyCount: folded.length,
    anchorRef,
    ...(previousEntry ? { previousEntry } : {}),
  };
}

/** Read the full history back off the anchor (the `report history` consumer). */
export function readReportHistory(cwd: string, anchorRef?: string): ReportHistoryEntry[] {
  return parseHistory(
    readFromAnchorRef(cwd, anchorRef ?? DEFAULT_REPORTS_REF, REPORT_HISTORY_PATH),
  );
}
