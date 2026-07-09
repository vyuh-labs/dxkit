/**
 * Code Quality dimension — declarative scoring spec.
 *
 * Methodology: ISO/IEC 25010 maintainability sub-characteristics
 * (modularity, reusability, analysability, modifiability, testability)
 * combined with industry-conventional thresholds for density-based
 * code-smell signals (lint, console statements, `any` types, type
 * errors, duplication, comment ratio, hygiene markers).
 *
 * Penalty rules cover signal classes that scale with repo size
 * (density-based) and absolute thresholds (file-size, structural
 * complexity, duplication, hygiene). Each rule surfaces a discrete
 * Deduction with a human-readable reason on the resulting
 * ScoreResult.
 *
 * Cap rules encode the Label Contract: an unmeasured dimension
 * can't honestly claim a top-tier rating regardless of how clean
 * the grep-derived signals look.
 *
 *   unmeasured (35)            all 3 signal-source tools unmeasured
 *                              (lint + duplication + structural)
 *   partial-uncertainty (75)   at least one signal-source tool
 *                              unmeasured but not all three
 *
 * Both caps key off `lintAvailable`, `duplicationAvailable`, and
 * `structuralAvailable` flags carried on the input — adapters set
 * these from each capability's presence.
 *
 * Adapters that build `QualityScoreInput` from their domain data:
 *
 *   - Health side: `src/analyzers/quality/shallow.ts:toQualityScoreInput`
 *     reads from `ScoreInput { metrics, capabilities }`.
 *   - Standalone side: `src/analyzers/quality/index.ts:qualityMetricsToScoreInput`
 *     reads from the assembled `QualityMetrics`.
 *
 * Both adapters land on this same input shape; both dispatch through
 * the same spec; both observe identical scores. The cache builder
 * shares the underlying counts across the two paths so the density
 * denominators are byte-identical.
 */

import type { DimensionScoringSpec } from '../spec';

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

  /** Critical + high lint errors. Density-penalized. */
  lintErrors: number;
  /** True when at least one lint tool ran cleanly on this repo.
   *  Drives the honesty cap — a repo where eslint/ruff didn't run
   *  can't honestly claim a top-tier Quality score. */
  lintAvailable: boolean;

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

  /** Files exceeding the large-file threshold. Step-penalized at 5 and 20. */
  filesOver500Lines: number;
  /** The resolved large-file threshold (lines) `filesOver500Lines` was counted
   *  against — the canonical 500 default or a policy override. Carried so the
   *  penalty prose names the actual bar, not a hardcoded 500. */
  largeFileThreshold: number;
  /** Largest single source file by line count. Step-penalized at
   *  5K and 10K — the 5K threshold is the "should have been split"
   *  bar; the 10K threshold is "this is a god-file." */
  largestFileLines: number;

  /** `any` type annotations across source. Density-penalized. */
  anyTypeCount: number;
  /** TypeScript compile errors when typecheck ran; null when no
   *  typecheck signal was available (no `tsc` config, non-TS repo,
   *  or typecheck not invoked). Density-penalized when present. */
  typeErrors: number | null;

  /** Percentage of source covered by duplicated blocks; null when
   *  jscpd didn't run. Step-penalized at 5% and 15%. */
  duplicationPercentage: number | null;
  /** True when jscpd produced data. Drives the honesty cap. */
  duplicationAvailable: boolean;

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

  /** Comment-line ratio across source (0.0–1.0). Step-penalized at
   *  0.4 and 0.5 — beyond ~40% of source being comment, the file is
   *  doing more documenting than coding, which usually signals dead
   *  code that hasn't been deleted. Null when cloc didn't run. */
  commentRatio: number | null;
}

/** Count unmeasured signal-source tools. 0 = all three ran. */
function unmeasuredCount(i: QualityScoreInput): number {
  return [!i.lintAvailable, !i.duplicationAvailable, !i.structuralAvailable].filter(Boolean).length;
}

export const QUALITY_SCORING_SPEC: DimensionScoringSpec<QualityScoreInput> = {
  dimension: 'quality',
  methodology: 'iso-iec-25010-maintainability',
  baseline: 100,
  penalties: [
    {
      id: 'lint-errors',
      describe: (i) => `${i.lintErrors} lint error(s) (density across ${i.sourceFiles} files)`,
      applies: (i) => i.lintErrors > 0,
      delta: (i) => {
        const ratio = i.lintErrors / Math.max(i.sourceFiles, 1);
        return -Math.min(ratio * 100, 40);
      },
    },
    {
      id: 'files-over-500-lines',
      describe: (i) => `${i.filesOver500Lines} file(s) over ${i.largeFileThreshold} lines`,
      applies: (i) => i.filesOver500Lines > 5,
      delta: (i) => (i.filesOver500Lines > 20 ? -20 : -10),
    },
    {
      id: 'largest-file-size',
      describe: (i) => `largest file is ${i.largestFileLines} lines`,
      applies: (i) => i.largestFileLines > 5000,
      delta: (i) => (i.largestFileLines > 10000 ? -20 : -10),
    },
    {
      id: 'console-statements',
      describe: (i) => `${i.consoleLogCount} console/debug statement(s)`,
      applies: (i) => i.consoleLogCount / Math.max(i.sourceFiles, 1) > 0.3,
      delta: (i) => {
        const d = i.consoleLogCount / Math.max(i.sourceFiles, 1);
        return d > 3 ? -15 : d > 1 ? -10 : -5;
      },
    },
    {
      id: 'any-type-annotations',
      describe: (i) => `${i.anyTypeCount} \`any\` type annotation(s)`,
      applies: (i) => i.anyTypeCount / Math.max(i.sourceFiles, 1) > 1,
      delta: (i) => {
        const d = i.anyTypeCount / Math.max(i.sourceFiles, 1);
        return d > 10 ? -15 : d > 5 ? -10 : -5;
      },
    },
    {
      id: 'type-errors',
      describe: (i) => `${i.typeErrors} TypeScript compile error(s)`,
      applies: (i) => i.typeErrors !== null && i.typeErrors > 0,
      delta: (i) => {
        const d = (i.typeErrors ?? 0) / Math.max(i.sourceFiles, 1);
        return -Math.min(d * 50, 15);
      },
    },
    {
      id: 'max-functions-per-file',
      describe: (i) => `densest file has ${i.maxFunctionsInFile} functions`,
      applies: (i) => i.maxFunctionsInFile !== null && i.maxFunctionsInFile > 50,
      delta: () => -10,
    },
    {
      id: 'dead-imports',
      describe: (i) => `${i.deadImportCount} dead import(s)`,
      applies: (i) => i.deadImportCount !== null && i.deadImportCount > 20,
      delta: () => -10,
    },
    {
      id: 'orphan-modules',
      describe: (i) => `${i.orphanModuleCount} orphan module(s)`,
      applies: (i) => i.orphanModuleCount !== null && i.orphanModuleCount > 30,
      delta: () => -5,
    },
    {
      id: 'duplication',
      describe: (i) => `${i.duplicationPercentage?.toFixed(1)}% duplicated code`,
      applies: (i) => i.duplicationPercentage !== null && i.duplicationPercentage > 5,
      delta: (i) => ((i.duplicationPercentage ?? 0) > 15 ? -20 : -10),
    },
    {
      id: 'comment-ratio',
      describe: (i) => `${((i.commentRatio ?? 0) * 100).toFixed(0)}% of source is comments`,
      applies: (i) => i.commentRatio !== null && i.commentRatio > 0.4,
      delta: (i) => ((i.commentRatio ?? 0) > 0.5 ? -15 : -10),
    },
    {
      id: 'hygiene-markers',
      describe: (i) => `${i.todoCount + i.fixmeCount + i.hackCount} TODO/FIXME/HACK marker(s)`,
      applies: (i) => i.todoCount + i.fixmeCount + i.hackCount > 20,
      delta: (i) => (i.todoCount + i.fixmeCount + i.hackCount > 50 ? -10 : -5),
    },
    {
      id: 'stale-files-in-git',
      describe: (i) => `${i.staleFiles} stale file(s) committed to git`,
      applies: (i) => i.staleFiles > 0,
      delta: (i) => (i.staleFiles > 3 ? -5 : -2),
    },
    {
      id: 'mixed-languages',
      describe: () => `.js files alongside .ts in source directories`,
      applies: (i) => i.mixedLanguages,
      delta: () => -5,
    },
  ],
  caps: [
    {
      id: 'all-quality-tools-unmeasured',
      tier: 'unmeasured',
      describe: () =>
        `no Quality signal-source tool ran (lint + duplication + structural all missing)`,
      applies: (i) => unmeasuredCount(i) === 3,
    },
    {
      id: 'partial-quality-tools-unmeasured',
      tier: 'partial-uncertainty',
      describe: (i) => {
        const missing: string[] = [];
        if (!i.lintAvailable) missing.push('lint');
        if (!i.duplicationAvailable) missing.push('duplication');
        if (!i.structuralAvailable) missing.push('structural');
        return `${missing.length} signal-source tool(s) did not run: ${missing.join(', ')}`;
      },
      applies: (i) => unmeasuredCount(i) >= 1,
    },
  ],
};
