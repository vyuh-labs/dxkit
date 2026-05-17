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
import { ratingFromScore } from '../scoring';
import { DimensionScore, ScoreInput } from './types';

// `ScoreInput` was previously declared here; canonical home moved to
// `./types` so it survives the eventual deletion of this file as
// dimension scorers migrate to declarative specs in `src/scoring/`.

function clamp(value: number, min = 0, max = 100): number {
  return Math.round(Math.max(min, Math.min(max, value)));
}

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

/** Developer Experience: 0-100 */
export function scoreDeveloperExperience(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  let score = 0;

  if (m.ciConfigCount > 0) score += 20;
  if (m.dockerConfigCount > 0) score += 15;
  if (m.precommitConfigCount > 0) score += 10;
  if (m.makefileExists) score += 10;
  if (m.envExampleExists) score += 10;

  if (m.npmScriptsCount >= 8) score += 15;
  else if (m.npmScriptsCount >= 4) score += 10;
  else if (m.npmScriptsCount >= 1) score += 5;

  if (m.contributingExists) score += 10;
  if (m.readmeLines > 50) score += 5;
  if (m.changelogExists) score += 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    rating: ratingFromScore(score),
    metrics: {
      ciConfigCount: m.ciConfigCount,
      dockerConfigCount: m.dockerConfigCount,
      precommitConfigCount: m.precommitConfigCount,
      makefileExists: m.makefileExists,
      envExampleExists: m.envExampleExists,
      npmScriptsCount: m.npmScriptsCount,
      contributingExists: m.contributingExists,
      changelogExists: m.changelogExists,
    },
    details:
      `CI configs: ${m.ciConfigCount}` +
      `. Docker: ${m.dockerConfigCount > 0 ? 'yes' : 'no'}` +
      `. Pre-commit hooks: ${m.precommitConfigCount > 0 ? 'yes' : 'no'}` +
      `. Makefile: ${m.makefileExists ? 'yes' : 'no'}` +
      `. .env.example: ${m.envExampleExists ? 'yes' : 'no'}` +
      `. npm scripts: ${m.npmScriptsCount}` +
      '.',
  };
}

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
