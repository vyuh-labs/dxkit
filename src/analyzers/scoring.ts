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

/** Documentation: 0-100 */
export function scoreDocumentation(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const sourceCount = Math.max(m.sourceFiles, 1);
  let score = 0;

  if (m.readmeExists) {
    if (m.readmeLines > 100) score += 25;
    else if (m.readmeLines > 50) score += 20;
    else if (m.readmeLines > 20) score += 15;
    else score += 5;
  }

  const docRatio = m.docCommentFiles / sourceCount;
  if (docRatio > 0.5) score += 25;
  else if (docRatio > 0.2) score += 15;
  else if (docRatio > 0.05) score += 5;

  if (m.apiDocsExist) score += 20;
  if (m.architectureDocsExist) score += 15;
  if (m.contributingExists) score += 10;
  if (m.changelogExists) score += 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    rating: ratingFromScore(score),
    metrics: {
      readmeExists: m.readmeExists,
      readmeLines: m.readmeLines,
      docCommentFiles: m.docCommentFiles,
      docRatio: Math.round(docRatio * 100) / 100,
      apiDocsExist: m.apiDocsExist,
      architectureDocsExist: m.architectureDocsExist,
      contributingExists: m.contributingExists,
      changelogExists: m.changelogExists,
    },
    details:
      `README: ${m.readmeExists ? `${m.readmeLines} lines` : 'missing'}` +
      `. ${m.docCommentFiles}/${m.sourceFiles} files have doc comments (${(docRatio * 100).toFixed(1)}%)` +
      `. API docs: ${m.apiDocsExist ? 'yes' : 'no'}` +
      `. Architecture docs: ${m.architectureDocsExist ? 'yes' : 'no'}` +
      `. Contributing: ${m.contributingExists ? 'yes' : 'no'}` +
      '.',
  };
}

// The Security dimension scorer used to live here; as of 2.4.7 the
// canonical formula is owned by `security/scoring.ts` and consumed by
// both health-side (`security/shallow.ts:scoreSecurityDimension`) and
// the standalone vuln scan (`security/detailed.ts`). See D023 closure
// notes in `security/scoring.ts` for the unification rationale.

/** Maintainability: 0-100 */
export function scoreMaintainability(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;

  const godNodeCount = c.structural?.godNodeCount ?? null;
  const communityCount = c.structural?.communityCount ?? null;
  const avgCohesion = c.structural?.avgCohesion ?? null;

  let score = 70;

  if (m.largestFileLines > 10000) score -= 25;
  else if (m.largestFileLines > 5000) score -= 15;
  else if (m.largestFileLines > 2000) score -= 10;
  else if (m.largestFileLines > 1000) score -= 5;

  if (m.filesOver500Lines > 30) score -= 15;
  else if (m.filesOver500Lines > 15) score -= 10;
  else if (m.filesOver500Lines > 5) score -= 5;

  if (m.consoleLogCount > 500) score -= 10;
  else if (m.consoleLogCount > 100) score -= 5;

  if (m.nodeEngineVersion) {
    const majorMatch = m.nodeEngineVersion.match(/(\d+)/);
    if (majorMatch) {
      const major = parseInt(majorMatch[1]);
      if (major < 16) score -= 10;
      else if (major < 18) score -= 5;
    }
  }

  if (m.sourceFiles < 50) score += 10;
  if (m.sourceFiles < 20) score += 5;

  if (godNodeCount !== null) {
    const godRatio = godNodeCount / Math.max(m.sourceFiles, 1);
    if (godRatio > 0.1) score -= 10;
    else if (godRatio > 0.05) score -= 5;
  }
  if (avgCohesion !== null && avgCohesion < 0.15) score -= 5;

  score = clamp(score);
  return {
    score,
    maxScore: 100,
    rating: ratingFromScore(score),
    // Schema v11: `metrics` surfaces only the non-capability signals.
    // AST-derived stats (god-node / community / cohesion / orphan module
    // counts) live in `report.capabilities.structural`.
    metrics: {
      sourceFiles: m.sourceFiles,
      controllers: m.controllers,
      models: m.models,
      directories: m.directories,
      largestFileLines: m.largestFileLines,
      filesOver500Lines: m.filesOver500Lines,
      nodeEngineVersion: m.nodeEngineVersion,
    },
    details:
      `${m.sourceFiles} source files across ${m.directories} directories` +
      `. ${m.controllers} controllers/handlers, ${m.models} models` +
      `. Largest file: ${m.largestFileLines} lines` +
      `. ${m.filesOver500Lines} files over 500 lines` +
      (m.nodeEngineVersion ? `. Node engine: ${m.nodeEngineVersion}` : '') +
      (communityCount !== null ? `. ${communityCount} architectural communities` : '') +
      (avgCohesion !== null ? `. Avg cohesion: ${avgCohesion.toFixed(2)}` : '') +
      '.',
  };
}

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
