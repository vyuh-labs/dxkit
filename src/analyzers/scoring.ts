/**
 * Deterministic scoring formulas.
 *
 * Every score is computed from `ScoreInput` (metrics + capabilities) via
 * fixed formulas — same input, same score, every time.
 *
 * Each scorer pulls capability-owned fields (lint counts, dep-vuln
 * counts, coverage percent, test framework, structural stats, secret
 * findings) from `input.capabilities`; filesystem-derived fields
 * (`sourceFiles`, `readmeLines`, `filesOver500Lines`, …) come from
 * `input.metrics`. The `DimensionScore.metrics` sub-object returned
 * here mirrors only the metrics-owned slice — consumers read the
 * capability envelopes directly from `report.capabilities.*`.
 */
import { DimensionScore } from './types';

// All six dimension scorers (Testing, Quality, Documentation, Security,
// Maintainability, Developer Experience) have moved to declarative
// specs in `src/scoring/dimensions/`. This file now retains only the
// overall-weighted-rollup helper used by the health audit; that
// helper migrates in the next sub-commit, at which point this file
// is deleted entirely.

// The Testing dimension scorer used to live here; the canonical formula
// is now owned by `src/scoring/dimensions/testing.ts` as a declarative
// spec. The adapter at `src/analyzers/tests/shallow.ts` builds the
// per-dimension input and dispatches through `evaluateSpec`.

// The Code Quality dimension scorer used to live here; the canonical
// formula is now owned by `src/scoring/dimensions/quality.ts` as a
// declarative spec, consumed by both the health audit (via
// `quality/shallow.ts`) and the standalone quality report.

// The Documentation dimension scorer used to live here; the canonical
// formula is now owned by `src/scoring/dimensions/documentation.ts` as
// a declarative spec. The adapter at `src/analyzers/docs/shallow.ts`
// builds the per-dimension input and dispatches through `evaluateSpec`.

// The Security dimension scorer used to live here; the canonical
// formula is now owned by `src/scoring/dimensions/security.ts` as a
// declarative spec, consumed by both health-side
// (`security/shallow.ts:scoreSecurityDimension`) and the standalone
// vuln scan (`security/detailed.ts`).

// The Maintainability dimension scorer used to live here; the canonical
// formula is now owned by `src/scoring/dimensions/maintainability.ts` as
// a declarative spec. The adapter at `src/analyzers/maintainability/
// shallow.ts` builds the per-dimension input and dispatches through
// `evaluateSpec`.

// The Developer Experience dimension scorer used to live here; the
// canonical formula is now owned by `src/scoring/dimensions/dx.ts` as
// a declarative spec. The adapter at `src/analyzers/dx/shallow.ts`
// builds the per-dimension input and dispatches through `evaluateSpec`.

/** Compute overall weighted score and grade. */
export function computeOverall(dimensions: {
  testing: DimensionScore;
  quality: DimensionScore;
  documentation: DimensionScore;
  security: DimensionScore;
  maintainability: DimensionScore;
  developerExperience: DimensionScore;
}): { overallScore: number; grade: 'A' | 'B' | 'C' | 'D' | 'F' } {
  const weights = {
    testing: 0.25,
    quality: 0.2,
    documentation: 0.1,
    security: 0.2,
    maintainability: 0.1,
    developerExperience: 0.15,
  };

  const overallScore = Math.round(
    dimensions.testing.score * weights.testing +
      dimensions.quality.score * weights.quality +
      dimensions.documentation.score * weights.documentation +
      dimensions.security.score * weights.security +
      dimensions.maintainability.score * weights.maintainability +
      dimensions.developerExperience.score * weights.developerExperience,
  );

  let grade: 'A' | 'B' | 'C' | 'D' | 'F';
  if (overallScore >= 80) grade = 'A';
  else if (overallScore >= 60) grade = 'B';
  else if (overallScore >= 40) grade = 'C';
  else if (overallScore >= 20) grade = 'D';
  else grade = 'F';

  return { overallScore, grade };
}
