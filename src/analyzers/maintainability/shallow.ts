/**
 * Maintainability dimension — health-side adapter over the
 * declarative maintainability scoring spec.
 *
 * Builds `MaintainabilityScoreInput` from the health-side
 * `ScoreInput` (HealthMetrics + CapabilityReport) and dispatches
 * through `evaluateSpec`. The resulting `DimensionScore` carries
 * the score, rating, provenance, and the dimension-specific
 * metrics + details surfaced in the health audit's markdown.
 */
import {
  MAINTAINABILITY_SCORING_SPEC,
  type MaintainabilityScoreInput,
  evaluateSpec,
  ratingFromScore,
} from '../../scoring';
import { dominantVocabulary } from '../../languages';
import { DimensionScore, ScoreInput } from '../types';

export function toMaintainabilityScoreInput(input: ScoreInput): MaintainabilityScoreInput {
  const m = input.metrics;
  const c = input.capabilities;
  return {
    sourceFiles: m.sourceFiles,
    largestFileLines: m.largestFileLines,
    filesOver500Lines: m.filesOver500Lines,
    consoleLogCount: m.consoleLogCount,
    nodeEngineVersion: m.nodeEngineVersion,
    godNodeCount: c.structural?.godNodeCount ?? null,
    avgCohesion: c.structural?.avgCohesion ?? null,
  };
}

/**
 * Score-only adapter for the health remediation planner. Mirrors the
 * other dimensions' `score*FromScoreInput` shims.
 */
export function scoreMaintainabilityFromScoreInput(input: ScoreInput): { score: number } {
  return evaluateSpec(MAINTAINABILITY_SCORING_SPEC, toMaintainabilityScoreInput(input));
}

export function scoreMaintainabilityDimension(input: ScoreInput): DimensionScore {
  const m = input.metrics;
  const c = input.capabilities;
  const scoreInput = toMaintainabilityScoreInput(input);
  const result = evaluateSpec(MAINTAINABILITY_SCORING_SPEC, scoreInput);
  const score = result.score;

  const communityCount = c.structural?.communityCount ?? null;
  const avgCohesion = c.structural?.avgCohesion ?? null;

  // Pick prose vocabulary from the dominant active pack — weighted
  // by cloc source-line counts so the pack the code is *written* in
  // wins, not just the first registered active pack. A C# WinForms
  // project reads as "Forms/Services"; a Spring Boot project as
  // "controllers/services"; a pure React app as "controllers/components"
  // (typescript pack's declared label). When no active pack supplies
  // vocabulary the generic words apply — the legacy "controllers,
  // models" prose stays for unknown-stack repos.
  const vocab = dominantVocabulary(input.languageFlags ?? ({} as never), m.languages);
  const componentsLabel = vocab?.components ?? 'components';
  const modelsLabel = vocab?.models ?? 'models';

  return {
    score,
    maxScore: 100,
    rating: ratingFromScore(score),
    rawScore: result.rawScore,
    rawPenalty: result.rawPenalty,
    methodology: result.methodology,
    deductions: result.deductions,
    capsApplied: result.capsApplied,
    topActions: result.topActions,
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
      `. ${m.controllers} ${componentsLabel}, ${m.models} ${modelsLabel}` +
      `. Largest file: ${m.largestFileLines} lines` +
      `. ${m.filesOver500Lines} files over 500 lines` +
      (m.nodeEngineVersion ? `. Node engine: ${m.nodeEngineVersion}` : '') +
      (communityCount !== null ? `. ${communityCount} architectural communities` : '') +
      (avgCohesion !== null ? `. Avg cohesion: ${avgCohesion.toFixed(2)}` : '') +
      '.',
  };
}
