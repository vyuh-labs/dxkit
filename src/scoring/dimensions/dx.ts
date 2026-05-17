/**
 * Developer Experience dimension — declarative scoring spec.
 *
 * Methodology: subtractive checklist over operational-readiness
 * signals — CI configuration, container build, pre-commit hooks,
 * Makefile or task-runner equivalent, .env.example, automation
 * entry-points (npm scripts), CONTRIBUTING guide, substantial
 * README, CHANGELOG. Baseline 100; each missing or substandard
 * artifact deducts points sized by its importance to onboarding
 * speed and contributor friction.
 *
 * Shape mirrors OpenSSF Scorecard's weighted-checks model. dxkit's
 * specific point allocations are documented in
 * `src/scoring/STANDARDS.md` Layer 3 (no single Layer-1 standard
 * prescribes DevEx checklists; these values are dxkit's own choice
 * weighted to favor CI + Docker + .env.example + automation scripts
 * — the artifacts most directly tied to repository onboarding).
 *
 * The "subtractive over checklist" framing (rather than the
 * additive-from-zero shape used pre-2.4.7) means
 * `ScoreResult.deductions` reads as missing items the customer can
 * fix — uniform actionable semantics across all six dimensions.
 * Numeric scores are unchanged from the pre-inversion additive form.
 *
 * No caps in this spec. The baseline + penalty distribution enforce
 * the rating contract by construction.
 */

import type { DimensionScoringSpec } from '../spec';

export interface DxScoreInput {
  /** Count of CI workflow files discovered (e.g. .github/workflows/*,
   *  .circleci/config.yml, .gitlab-ci.yml). */
  ciConfigCount: number;
  /** Count of Dockerfile / compose / Containerfile artifacts. */
  dockerConfigCount: number;
  /** Count of pre-commit hook configs (.husky, .pre-commit-config.yaml). */
  precommitConfigCount: number;
  /** Top-level Makefile or task-runner equivalent. */
  makefileExists: boolean;
  /** `.env.example` (or `.env.sample`) present — onboarding hint
   *  about required env vars without leaking real values. */
  envExampleExists: boolean;
  /** Count of npm scripts (or equivalent task entry-points). */
  npmScriptsCount: number;
  /** CONTRIBUTING.md present. */
  contributingExists: boolean;
  /** Line count of the discovered README. Adds a small penalty when
   *  the README is too thin to onboard a new contributor. */
  readmeLines: number;
  /** CHANGELOG.md present. */
  changelogExists: boolean;
}

/** Automation-scripts penalty: tiered shortfall from the recommended 8+. */
function automationPenalty(i: DxScoreInput): number {
  if (i.npmScriptsCount >= 8) return 0;
  if (i.npmScriptsCount >= 4) return -5;
  if (i.npmScriptsCount >= 1) return -10;
  return -15;
}

export const DX_SCORING_SPEC: DimensionScoringSpec<DxScoreInput> = {
  dimension: 'dx',
  methodology: 'openssf-scorecard-shape',
  baseline: 100,
  penalties: [
    {
      id: 'ci-missing',
      describe: () => `no CI workflow files configured`,
      applies: (i) => i.ciConfigCount === 0,
      delta: () => -20,
    },
    {
      id: 'docker-missing',
      describe: () => `no container build configured (Dockerfile / compose)`,
      applies: (i) => i.dockerConfigCount === 0,
      delta: () => -15,
    },
    {
      id: 'precommit-hooks-missing',
      describe: () => `no pre-commit hooks configured`,
      applies: (i) => i.precommitConfigCount === 0,
      delta: () => -10,
    },
    {
      id: 'makefile-missing',
      describe: () => `no Makefile (task-runner entry-point)`,
      applies: (i) => !i.makefileExists,
      delta: () => -10,
    },
    {
      id: 'env-example-missing',
      describe: () => `.env.example missing (env-var onboarding hint)`,
      applies: (i) => !i.envExampleExists,
      delta: () => -10,
    },
    {
      id: 'automation-scripts-short',
      describe: (i) =>
        i.npmScriptsCount === 0
          ? `no npm-script entry-points (recommended ≥ 8)`
          : `${i.npmScriptsCount} npm-script entry-point(s); recommended ≥ 8`,
      applies: (i) => automationPenalty(i) < 0,
      delta: automationPenalty,
    },
    {
      id: 'contributing-missing',
      describe: () => `CONTRIBUTING.md missing`,
      applies: (i) => !i.contributingExists,
      delta: () => -10,
    },
    {
      id: 'readme-thin-for-onboarding',
      describe: (i) => `README is thin (${i.readmeLines} lines; recommended > 50 for onboarding)`,
      applies: (i) => i.readmeLines <= 50,
      delta: () => -5,
    },
    {
      id: 'changelog-missing',
      describe: () => `CHANGELOG.md missing`,
      applies: (i) => !i.changelogExists,
      delta: () => -5,
    },
  ],
  caps: [],
};
