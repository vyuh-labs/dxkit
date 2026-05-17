/**
 * Maintainability dimension — declarative scoring spec.
 *
 * Methodology: ISO/IEC 25010 maintainability sub-characteristics
 * (modularity, modifiability, analysability) combined with the
 * SQALE method (Letouzey 2012) for the "technical debt produces
 * downgraded rating" mental model. Step-style penalty thresholds
 * are calibrated so a single major violation drops the rating one
 * tier — matching SQALE rating-band semantics on typical repos
 * without requiring a dynamic per-repo debt-ratio computation.
 *
 * Penalty rules cover the canonical Maintainability violation
 * classes: god files (single largest file), file-size sprawl
 * (count of files past the recommended-extraction line), runtime
 * console/debug residue, outdated language runtimes, AST-derived
 * god-classes (graphify), and low architectural cohesion.
 *
 * No caps in this spec. The full-marks-minus-violations baseline
 * (100, subtractive) plus the calibrated penalty values produce
 * the rating contract by construction: a fully clean repo lands
 * at A, a repo with one major violation lands at B, a deeply
 * troubled repo lands at D or E. The Label Contract emerges from
 * the math; no cap is needed to enforce it externally.
 *
 * Behavior change from pre-2.4.7: the legacy scorer baseline was
 * 70 (with a "small-repo bonus" of +5/+10 to compensate). The new
 * baseline is 100 with no special-case bonus — small-repo bonus
 * was an overfit, removed. Customers with healthy codebases
 * will see Maintainability scores rise by ~30 points; documented
 * in the 2.4.7 CHANGELOG.
 */

import type { DimensionScoringSpec } from '../spec';

export interface MaintainabilityScoreInput {
  /** Total source-file count. Denominator for `godNodeCount` density. */
  sourceFiles: number;
  /** Largest single source file by line count (the "god file" probe). */
  largestFileLines: number;
  /** Count of source files exceeding 500 lines. */
  filesOver500Lines: number;
  /** Console / debugger statement count across source. */
  consoleLogCount: number;
  /** `engines.node` field from package.json, e.g. ">=14.0.0", or null
   *  for non-Node projects. */
  nodeEngineVersion: string | null;
  /** From graphify: count of "god" AST nodes (classes / files with
   *  ≥ N functions or methods). Null when graphify didn't run. */
  godNodeCount: number | null;
  /** From graphify: average inter-module cohesion (0.0–1.0). Null when
   *  graphify didn't run. */
  avgCohesion: number | null;
}

/** Parse the major node-engine version from a semver-range string. */
function nodeEngineMajor(engine: string | null): number | null {
  if (!engine) return null;
  const match = engine.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

export const MAINTAINABILITY_SCORING_SPEC: DimensionScoringSpec<MaintainabilityScoreInput> = {
  dimension: 'maintainability',
  methodology: 'iso-iec-25010-maintainability + sqale-inspired-thresholds',
  baseline: 100,
  penalties: [
    {
      id: 'largest-file-size',
      describe: (i) => `largest source file is ${i.largestFileLines} lines`,
      applies: (i) => i.largestFileLines > 1000,
      delta: (i) =>
        i.largestFileLines > 10000
          ? -25
          : i.largestFileLines > 5000
            ? -15
            : i.largestFileLines > 2000
              ? -10
              : -5,
    },
    {
      id: 'files-over-500-density',
      describe: (i) => `${i.filesOver500Lines} files over 500 lines (extraction recommended)`,
      applies: (i) => i.filesOver500Lines > 5,
      delta: (i) => (i.filesOver500Lines > 30 ? -15 : i.filesOver500Lines > 15 ? -10 : -5),
    },
    {
      id: 'console-statements',
      describe: (i) => `${i.consoleLogCount} console/debug statements in source`,
      applies: (i) => i.consoleLogCount > 100,
      delta: (i) => (i.consoleLogCount > 500 ? -10 : -5),
    },
    {
      id: 'outdated-node-engine',
      describe: (i) => `Node.js engine ${i.nodeEngineVersion} predates current LTS`,
      applies: (i) => {
        const major = nodeEngineMajor(i.nodeEngineVersion);
        return major !== null && major < 18;
      },
      delta: (i) => {
        const major = nodeEngineMajor(i.nodeEngineVersion);
        return major !== null && major < 16 ? -10 : -5;
      },
    },
    {
      id: 'god-node-density',
      describe: (i) => `${i.godNodeCount} god classes / files (high function-count concentration)`,
      applies: (i) => i.godNodeCount !== null && i.godNodeCount / Math.max(i.sourceFiles, 1) > 0.05,
      delta: (i) => {
        const ratio = (i.godNodeCount ?? 0) / Math.max(i.sourceFiles, 1);
        return ratio > 0.1 ? -10 : -5;
      },
    },
    {
      id: 'low-architectural-cohesion',
      describe: (i) =>
        `average inter-module cohesion ${i.avgCohesion?.toFixed(2)} (below 0.15 threshold)`,
      applies: (i) => i.avgCohesion !== null && i.avgCohesion < 0.15,
      delta: () => -5,
    },
  ],
  caps: [],
};
