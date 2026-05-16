/**
 * Canonical quality scoring — the single source of truth for the
 * 0-100 quality score used by BOTH the health audit's Code Quality
 * dimension and the standalone quality / slop-score report.
 *
 * Pre-2.4.7: the health side and the standalone quality report each
 * had their own scoring formula reading different inputs. Same repo,
 * two different numbers, same label. The platform repo audit
 * surfaced 22/100 (health) vs 45/100 (standalone) on the same SHA —
 * customer-visible contradiction. Same architectural shape the
 * security dimension closed when it unified scoreSecurity into
 * scoreSecurityFromInput.
 *
 * `QualityScoreInput` is a clean partition of every signal either
 * pre-2.4.7 formula penalized — file size, lint density, console
 * statements, any-type density, type errors, structural complexity,
 * dead imports, orphan modules, duplication percentage, comment
 * ratio, hygiene markers (TODO/FIXME/HACK), stale files, mixed
 * JS/TS — plus honesty inputs (which signal-source tools were
 * available). Both adapters land on this same shape; both call
 * `scoreQualityFromInput`; both get identical scores.
 *
 * Adapters live with their data sources:
 *   - Health side: `quality/shallow.ts:toQualityScoreInput` reads
 *     from `ScoreInput { metrics, capabilities }`. Treats
 *     `capabilities.{lint, duplication, structural}` presence as
 *     the availability signal.
 *   - Standalone side: `quality/index.ts:qualityMetricsToScoreInput`
 *     reads from the assembled `QualityMetrics`. Treats
 *     `metrics.{lintTool, duplication, maxFunctionsInFile}`
 *     non-null-ness as the availability signal.
 *
 * The unified formula penalizes signals from BOTH pre-2.4.7
 * formulas — health-side gains the duplication / comment ratio /
 * orphan modules / stale files / hygiene-markers / mixed-JS-TS
 * penalties; standalone-side gains the file-size / any-type density
 * / type-error penalties + the honesty cap. Scores shift on both
 * surfaces vs the pre-unification numbers; documented in the 2.4.7
 * CHANGELOG.
 */

/**
 * Score ceiling applied when ALL three Quality signal-source tools
 * (lint, duplication via jscpd, structural via graphify) are
 * unmeasured. A repo with no measured Quality signals can't honestly
 * claim better than "C grade" regardless of how clean the
 * grep-derived signals look — an unmeasured codebase may be
 * genuinely clean or hide every problem behind unscanned signals,
 * and there's no way to tell from the score alone.
 *
 * Mirrors the security dimension's DEP_VULNS_UNAVAILABLE_CAP (65)
 * and the testing dimension's coverage-null cap (35). 35 here
 * matches the testing cap because the situations are analogous —
 * the dimension has effectively zero signal.
 */
export const QUALITY_ALL_UNMEASURED_CAP = 35;

/**
 * Score ceiling applied when AT LEAST ONE (but not all) of the
 * three Quality signal-source tools is unmeasured. The dimension
 * still has signal but cannot honestly claim "Excellent" (≥ 80)
 * when one of its measurement legs is missing.
 *
 * 75 lets a partially-measured repo land in the "Good" tier (60-79)
 * but caps it just below "Excellent." A customer reading this knows
 * the score reflects "what we could measure" rather than "the whole
 * picture."
 */
export const QUALITY_PARTIAL_CAP = 75;

/**
 * Clean partition of every signal the unified Quality formula
 * penalizes. Adapters at each consumer side build this shape from
 * their respective data sources; the formula is consumer-agnostic.
 */
export interface QualityScoreInput {
  /** Total source-file count, used as the denominator for every
   *  density-based penalty. The adapters MUST pass the same
   *  source-file count the rest of the report cites — drift here
   *  would let two consumers compute different densities from the
   *  same raw counts. */
  sourceFiles: number;

  // ─── Lint ────────────────────────────────────────────────────────
  /** Critical + high lint errors. Density-penalized. */
  lintErrors: number;
  /** True when at least one lint tool ran cleanly on this repo.
   *  Drives the honesty cap — a repo where eslint/ruff didn't run
   *  can't honestly claim a top-tier Quality score. */
  lintAvailable: boolean;

  // ─── Hygiene markers (grep) ──────────────────────────────────────
  /** Console / debugger statement count. Density-penalized — a
   *  repo of 10K files with 200 such statements is much cleaner
   *  than a repo of 100 files with the same 200. */
  consoleLogCount: number;
  /** TODO / FIXME / HACK comments (sum penalized as one signal). */
  todoCount: number;
  fixmeCount: number;
  hackCount: number;
  /** Stale files committed to git (.swp, .bak, .orig, temp files). */
  staleFiles: number;
  /** Whether `.js` files appear alongside `.ts` files in the same
   *  source directory (suggests in-progress migration that's stalled). */
  mixedLanguages: boolean;

  // ─── File-size signals (filesystem) ──────────────────────────────
  /** Files exceeding 500 lines. Step-penalized at 5 and 20. */
  filesOver500Lines: number;
  /** Largest single source file by line count. Step-penalized at
   *  5K and 10K — the 5K threshold is the "should have been split"
   *  bar; the 10K threshold is "this is a god-file." */
  largestFileLines: number;

  // ─── Type signals (TS-specific) ──────────────────────────────────
  /** `any` type annotations across source. Density-penalized. */
  anyTypeCount: number;
  /** TypeScript compile errors when typecheck ran; null when no
   *  typecheck signal was available (no `tsc` config, non-TS repo,
   *  or typecheck not invoked). Density-penalized when present. */
  typeErrors: number | null;

  // ─── Duplication (jscpd) ─────────────────────────────────────────
  /** Percentage of source covered by duplicated blocks; null when
   *  jscpd didn't run. Step-penalized at 5% and 15%. */
  duplicationPercentage: number | null;
  /** True when jscpd produced data. Drives the honesty cap. */
  duplicationAvailable: boolean;

  // ─── Structural (graphify) ───────────────────────────────────────
  /** Maximum functions in a single source file; null when graphify
   *  didn't run. Penalized at > 50. */
  maxFunctionsInFile: number | null;
  /** Imports that are declared but never resolved to a project
   *  source file. Penalized at > 20. Null when graphify didn't run. */
  deadImportCount: number | null;
  /** Source files with no inbound imports. Penalized at > 30. Null
   *  when graphify didn't run. */
  orphanModuleCount: number | null;
  /** True when graphify produced data. Drives the honesty cap. */
  structuralAvailable: boolean;

  // ─── Comment hygiene (cloc) ──────────────────────────────────────
  /** Comment-line ratio across source (0.0–1.0). Step-penalized at
   *  0.4 and 0.5 — beyond ~40% of source being comment, the file is
   *  doing more documenting than coding, which usually signals dead
   *  code that hasn't been deleted. Null when cloc didn't run. */
  commentRatio: number | null;
}

/**
 * Compute the 0-100 quality score from the canonical input shape.
 * Same formula, same inputs, same output — applied by both the
 * health dimension rollup and the standalone quality report.
 *
 * Penalty curves: density-based for signals that scale with repo
 * size (lint, console, anyType, typeErrors); absolute thresholds
 * for signals that don't (file-size, structural complexity,
 * duplication, comment ratio, hygiene markers, stale files).
 *
 * The honesty cap is applied AFTER all penalties so it acts as a
 * ceiling, not a floor — a repo with all measurement tools
 * unavailable AND multiple critical lint findings still scores
 * below the cap. Penalties + cap compose monotonically.
 */
export function scoreQualityFromInput(input: QualityScoreInput): { score: number } {
  let score = 100;
  const sourceCount = Math.max(input.sourceFiles, 1);

  // Lint errors — density-based.
  if (input.lintErrors > 0) {
    const errorRatio = input.lintErrors / sourceCount;
    score -= Math.min(errorRatio * 100, 40);
  }

  // File-size penalties.
  if (input.filesOver500Lines > 5) score -= 10;
  if (input.filesOver500Lines > 20) score -= 10;
  if (input.largestFileLines > 5000) score -= 10;
  if (input.largestFileLines > 10000) score -= 10;

  // Console statements — density-based.
  const consoleDensity = input.consoleLogCount / sourceCount;
  if (consoleDensity > 3) score -= 15;
  else if (consoleDensity > 1) score -= 10;
  else if (consoleDensity > 0.3) score -= 5;

  // `any` annotations — density-based.
  const anyDensity = input.anyTypeCount / sourceCount;
  if (anyDensity > 10) score -= 15;
  else if (anyDensity > 5) score -= 10;
  else if (anyDensity > 1) score -= 5;

  // Type errors — density-based, capped contribution.
  if (input.typeErrors !== null && input.typeErrors > 0) {
    score -= Math.min((input.typeErrors / sourceCount) * 50, 15);
  }

  // Structural complexity (graphify).
  if (input.maxFunctionsInFile !== null && input.maxFunctionsInFile > 50) score -= 10;
  if (input.deadImportCount !== null && input.deadImportCount > 20) score -= 10;
  if (input.orphanModuleCount !== null && input.orphanModuleCount > 30) score -= 5;

  // Duplication (jscpd).
  if (input.duplicationPercentage !== null) {
    if (input.duplicationPercentage > 15) score -= 20;
    else if (input.duplicationPercentage > 5) score -= 10;
  }

  // Comment-line ratio (cloc).
  if (input.commentRatio !== null) {
    if (input.commentRatio > 0.5) score -= 15;
    else if (input.commentRatio > 0.4) score -= 10;
  }

  // Hygiene markers (TODO + FIXME + HACK summed).
  const hygieneTotal = input.todoCount + input.fixmeCount + input.hackCount;
  if (hygieneTotal > 50) score -= 10;
  else if (hygieneTotal > 20) score -= 5;

  // Stale files committed to git.
  if (input.staleFiles > 3) score -= 5;
  else if (input.staleFiles > 0) score -= 2;

  // Mixed JS/TS in source dirs.
  if (input.mixedLanguages) score -= 5;

  // Apply honesty cap as a ceiling. Counts how many signal-source
  // tools were unmeasured (lint, duplication via jscpd, structural
  // via graphify); 1+ unmeasured → 75 ceiling; all 3 unmeasured →
  // 35 ceiling.
  let final = Math.max(0, Math.min(100, Math.round(score)));
  const unmeasured = [
    !input.lintAvailable,
    !input.duplicationAvailable,
    !input.structuralAvailable,
  ].filter(Boolean).length;
  if (unmeasured === 3 && final > QUALITY_ALL_UNMEASURED_CAP) {
    final = QUALITY_ALL_UNMEASURED_CAP;
  } else if (unmeasured >= 1 && final > QUALITY_PARTIAL_CAP) {
    final = QUALITY_PARTIAL_CAP;
  }
  return { score: final };
}
