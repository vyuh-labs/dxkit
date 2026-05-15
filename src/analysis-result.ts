/**
 * AnalysisResult — the canonical cross-process aggregate that every
 * dxkit subcommand reads from instead of independently re-running the
 * tool gather.
 *
 * Architectural posture:
 *
 *   - **One gather per repo+SHA.** `vyuh-dxkit health`, `vulnerabilities`,
 *     `test-gaps`, `quality`, `dev-report`, `licenses`, `bom`, `dashboard`,
 *     and `coverage` all build OR read this same struct. When two
 *     subcommands run minutes apart on the same commit, they see byte-
 *     identical inputs — multi-consumer drift on shared metrics becomes
 *     structurally impossible.
 *
 *   - **Provenance is part of the type.** `commitSha` + `dxkitVersion`
 *     + `schemaVersion` + `ignoreFileMtime` form the cache invalidation
 *     key. Any of them changing means the cached file is stale and the
 *     gather must rerun.
 *
 *   - **Dirty trees never persist.** When the working tree has
 *     uncommitted changes, `workingTreeDirty` is true. The cache module
 *     refuses to read or write the on-disk file in that state; in-
 *     process callers can still share a single rebuild via the in-
 *     memory cache, but nothing reaches `.dxkit/cache/` on disk.
 *
 *   - **`capabilities` + `metrics` are the canonical aggregates** —
 *     identical to what the health analyzer's internal gather produces,
 *     just persisted between processes. `CapabilityReport` already
 *     carries the canonical security aggregate (one severity-bucket
 *     source for every consumer). This envelope generalizes the same
 *     "one aggregate, many consumers" template up one architectural
 *     level: one `AnalysisResult` across the process boundary.
 *
 *   - **`derived` is for lazily-materialized per-analyzer outputs**
 *     (LicensesReport, BomReport, DevReport, …). Empty at first;
 *     consumers widen the union as each analyzer migrates so a
 *     subcommand can fetch its pre-rendered report by name. Keeping
 *     it optional lets every consumer choose between "render from
 *     `capabilities` + `metrics`" and "read the cached derived report"
 *     without forcing a single answer up front.
 */

import type { DetectedStack } from './types';
import type { CapabilityReport, HealthMetrics } from './analyzers/types';

/**
 * Bump whenever the shape of `AnalysisResult` or any of its nested
 * types changes in a way that makes an older cached JSON file
 * incompatible. The cache module treats any mismatch as a hard miss
 * and rebuilds from scratch.
 */
export const ANALYSIS_RESULT_SCHEMA_VERSION = 1 as const;
export type AnalysisResultSchemaVersion = typeof ANALYSIS_RESULT_SCHEMA_VERSION;

/**
 * Reserved for lazily-materialized per-analyzer outputs. Empty at
 * present; each analyzer that migrates onto the cache adds its
 * rendered report under a named key here. Keeping the type optional
 * and extensible lets analyzers migrate one at a time without forcing
 * a single decision on which ones cache their derived output (vs
 * render fresh on every call from `capabilities` + `metrics`).
 */
// Intentionally empty. The placeholder is named so the analysis-result
// type can refer to it stably; the type widens (in source, with each
// migrating analyzer adding its named field) without breaking call
// sites. Future shape:
//   licenses?: LicensesReport;
//   bom?: BomReport;
//   devActivity?: DevReport;
//   testGaps?: TestGapsReport;
//   quality?: QualityReport;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface AnalysisResultDerived {}

/**
 * The non-provenance content of an `AnalysisResult` — what the
 * gather pipeline actually produces. `cache.ts` accepts a builder
 * function returning this shape and stamps the surrounding provenance
 * itself, so callers don't have to hand-roll SHA / mtime / version
 * detection.
 */
export interface AnalysisResultBody {
  stack: DetectedStack;
  capabilities: CapabilityReport;
  metrics: HealthMetrics;
  derived?: AnalysisResultDerived;
}

/**
 * The full cached envelope. Provenance fields up front, body fields
 * follow. Serialized to JSON when persisted; the schema-version field
 * makes future migrations explicit rather than relying on shape
 * detection.
 */
export interface AnalysisResult extends AnalysisResultBody {
  /** Short SHA (`git rev-parse --short HEAD`). Empty when not in a git repo. */
  commitSha: string;

  /** Current branch name. Empty when not in a git repo. */
  branch: string;

  /** Absolute repo path the gather ran against. Disambiguates two
   *  worktrees of the same repo persisting independent caches. */
  cwd: string;

  /** ISO timestamp of when the result was built (NOT when it was last
   *  read from cache). Useful for "report is X minutes old" surfacing
   *  in the CLI and for distinguishing a fresh rebuild from a hit. */
  builtAt: string;

  /** Version of dxkit that produced the result. Different versions can
   *  produce different metrics (new tools added, scoring formulas
   *  changed); a version delta invalidates the cache. */
  dxkitVersion: string;

  /** Schema version of THIS envelope shape. See
   *  `ANALYSIS_RESULT_SCHEMA_VERSION`. */
  schemaVersion: AnalysisResultSchemaVersion;

  /** `.dxkit-ignore` mtime in ms (from `fs.statSync(...).mtimeMs`).
   *  `null` when the file doesn't exist. Differences invalidate the
   *  cache — ignore-rule changes alter what gets scanned, so cached
   *  metrics computed against the old ruleset are stale. */
  ignoreFileMtime: number | null;

  /** True when `git status --porcelain` reports any change. Dirty-tree
   *  results NEVER persist to disk and are not read back from disk
   *  (their commit SHA doesn't reflect the on-disk state). The flag
   *  surfaces in JSON-mode output so consumers know they're looking at
   *  an in-process-only result. */
  workingTreeDirty: boolean;
}
