/**
 * Code Quality dimension — health-side adapter over the canonical
 * quality scorer.
 *
 * Translates `ScoreInput { metrics, capabilities }` into the
 * `QualityScoreInput` partition consumed by `scoreQualityFromInput`,
 * then wraps the resulting score in a full `DimensionScore` (status +
 * details + metrics envelope) for the health audit rollup.
 *
 * D123 closure: this file used to delegate to a separate
 * `scoreQuality` in `analyzers/scoring.ts` while the standalone
 * quality report computed `computeSlopScore` from a different signal
 * set. Same repo could surface as health.CodeQuality 22/100 and
 * quality-review.SlopScore 45/100 — customer-visible contradiction.
 * The canonical formula now lives in `quality/scoring.ts`; both
 * surfaces compute the same number from the same partitioned inputs.
 */
import { DimensionScore } from '../types';
import { ScoreInput } from '../scoring';
import { scoreQualityFromInput, type QualityScoreInput } from './scoring';

function status(score: number): DimensionScore['status'] {
  if (score >= 80) return 'excellent';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  if (score >= 20) return 'poor';
  return 'critical';
}

/**
 * Build the canonical `QualityScoreInput` from the health-side
 * `ScoreInput`. Each field maps to its data source:
 *
 *   - Lint counts ← `capabilities.lint.counts`
 *     (critical + high → errors). Availability is "did any pack
 *     produce a `LintResult`" — i.e. `c.lint !== undefined`.
 *   - File-size + grep-derived hygiene + filesystem-walked
 *     metrics ← `metrics.*`.
 *   - Duplication, structural ← `capabilities.{duplication,
 *     structural}`. Availability is "did the capability dispatch
 *     return an envelope" — same shape as lint.
 *   - Comment ratio is filesystem-derived via cloc and not
 *     currently surfaced through ScoreInput on the health path.
 *     Carried as `null` here so the unified formula treats it as
 *     "no signal" — health-side never had a comment-ratio penalty
 *     in the legacy formula either. If health later wants to
 *     surface this signal, plumb it through HealthMetrics.
 *   - Hygiene markers (TODO / FIXME / HACK / staleFiles /
 *     mixedLanguages) are populated by the standalone Quality
 *     report's own gather; the health path doesn't emit these
 *     today. Carried as zero / false so the unified formula
 *     treats them as "no signal."
 */
export function toQualityScoreInput(input: ScoreInput): QualityScoreInput {
  const m = input.metrics;
  const c = input.capabilities;

  const lintErrors = (c.lint?.counts.critical ?? 0) + (c.lint?.counts.high ?? 0);

  return {
    sourceFiles: m.sourceFiles,

    lintErrors,
    lintAvailable: c.lint !== undefined,

    consoleLogCount: m.consoleLogCount,
    todoCount: 0,
    fixmeCount: 0,
    hackCount: 0,
    staleFiles: 0,
    mixedLanguages: false,

    filesOver500Lines: m.filesOver500Lines,
    largestFileLines: m.largestFileLines,

    anyTypeCount: m.anyTypeCount,
    typeErrors: m.typeErrors,

    duplicationPercentage: c.duplication?.percentage ?? null,
    duplicationAvailable: c.duplication !== undefined,

    maxFunctionsInFile: c.structural?.maxFunctionsInFile ?? null,
    deadImportCount: c.structural?.deadImportCount ?? null,
    orphanModuleCount: c.structural?.orphanModuleCount ?? null,
    structuralAvailable: c.structural !== undefined,

    commentRatio: null,
  };
}

/**
 * Score-only adapter for action ranking. The health remediation
 * planner builds `RemediationAction<ScoreInput>` patches and calls
 * `rank()` with a per-dimension scorer that maps `ScoreInput` to
 * `{ score }`. Mirrors the `scoreSecurityFromScoreInput` shim so
 * `health/actions.ts` stays symmetric across dimensions.
 */
export function scoreQualityFromScoreInput(input: ScoreInput): { score: number } {
  return scoreQualityFromInput(toQualityScoreInput(input));
}

/**
 * Health audit's Code Quality dimension entry point. Produces the
 * `DimensionScore` consumed by `health.ts:analyzeHealthInternal` for
 * the dimension rollup, the dashboard summary, and the agent report.
 */
export function scoreQualityDimension(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;
  const scoreInput = toQualityScoreInput(input);
  const { score } = scoreQualityFromInput(scoreInput);

  const lintTool = c.lint?.tool ?? null;
  const lintWarnings = (c.lint?.counts.medium ?? 0) + (c.lint?.counts.low ?? 0);

  return {
    score,
    maxScore: 100,
    status: status(score),
    // Schema v11: `metrics` surfaces only the non-capability signals.
    // Lint counts + tool live in `report.capabilities.lint`; god-file +
    // dead-import stats live in `report.capabilities.structural`.
    metrics: {
      filesOver500Lines: m.filesOver500Lines,
      largestFileLines: m.largestFileLines,
      largestFilePath: m.largestFilePath,
      consoleLogCount: m.consoleLogCount,
      anyTypeCount: m.anyTypeCount,
      typeErrors: m.typeErrors,
    },
    details:
      // Split the lint label into its successful-run name plus a separate
      // "Linter coverage gap" sentence when packs were attempted but
      // returned null silently. The parenthetical "(ruff (not run: ts))"
      // shape was easy to miss in the rendered prose.
      (() => {
        if (!lintTool) return `${scoreInput.lintErrors} lint errors, ${lintWarnings} warnings`;
        const notRunMatch = /\(not run: ([^)]+)\)/.exec(lintTool);
        if (!notRunMatch) {
          return `${scoreInput.lintErrors} lint errors, ${lintWarnings} warnings (${lintTool})`;
        }
        const cleanTool = lintTool.replace(/\s*\(not run: [^)]+\)/, '').trim();
        return (
          `${scoreInput.lintErrors} lint errors, ${lintWarnings} warnings (${cleanTool})` +
          `. ⚠ Linter coverage gap: ${notRunMatch[1]} not run`
        );
      })() +
      `. ${m.filesOver500Lines} files exceed 500 lines` +
      `. Largest file: ${m.largestFilePath} (${m.largestFileLines} lines)` +
      `. ${m.consoleLogCount} console/debug statements` +
      (m.anyTypeCount > 0 ? `. ${m.anyTypeCount} loose type annotations` : '') +
      (scoreInput.maxFunctionsInFile !== null
        ? `. Densest file: ${scoreInput.maxFunctionsInFile} functions`
        : '') +
      '.',
  };
}
