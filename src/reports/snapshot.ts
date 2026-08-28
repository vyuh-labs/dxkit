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
  type ReportHistoryEntry,
  type ReportScores,
  type ReportFindingCounts,
} from './history';
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
    Record<
      | 'testing'
      | 'quality'
      | 'documentation'
      | 'security'
      | 'maintainability'
      | 'developerExperience',
      { readonly score: number | null } | undefined
    >
  >;
  readonly findings?: ReportFindingCounts;
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
  return {
    overall: typeof src.summary.overallScore === 'number' ? src.summary.overallScore : null,
    security: dimScore(src, 'security'),
    quality: dimScore(src, 'quality'),
    tests: dimScore(src, 'testing'),
    documentation: dimScore(src, 'documentation'),
    maintainability: dimScore(src, 'maintainability'),
    developerExperience: dimScore(src, 'developerExperience'),
  };
}

/** Pure map from a scored report to the durable history entry. Stamps the
 *  scoring-methodology identity so later score comparisons can verify they
 *  compare like with like (impact P2 honesty constraint 4). */
export function reportToHistoryEntry(src: SnapshotSource, meta: SnapshotMeta): ReportHistoryEntry {
  return {
    sha: meta.sha,
    date: meta.date,
    dxkitVersion: meta.dxkitVersion,
    ...(meta.branch ? { branch: meta.branch } : {}),
    methodology: SCORING_METHODOLOGY_VERSION,
    scores: scoresFromReport(src),
    ...(src.findings ? { findings: src.findings } : {}),
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
