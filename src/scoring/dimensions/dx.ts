/**
 * Developer Experience dimension — declarative scoring spec.
 *
 * Methodology: additive checklist over operational-readiness signals
 * — CI configuration, container build, pre-commit hooks, Makefile or
 * task-runner equivalent, .env.example, automation entry-points
 * (npm scripts), CONTRIBUTING guide, substantial README, CHANGELOG.
 *
 * Shape mirrors OpenSSF Scorecard's weighted-checks model: each
 * artifact / signal contributes a fixed point value sized by its
 * importance to onboarding speed and contributor friction. dxkit's
 * specific point allocations are documented in
 * `src/scoring/STANDARDS.md` Layer 3 (no single Layer-1 standard
 * prescribes DevEx checklists; these values are dxkit's own choice
 * weighted to favor CI + .env.example + Docker + automation scripts
 * — the artifacts most directly tied to repository onboarding).
 *
 * No caps in this spec. The additive baseline (0) means a repo
 * without any operational scaffolding lands at 0 by construction;
 * the formula's natural ceiling enforces the rating contract
 * without an external cap.
 *
 * Caveat for additive specs: ScoreResult.deductions records rules
 * that fired (positive deltas — bonuses earned). Actionable
 * next-moves are rules that did NOT fire — the renderer migration
 * (sub-commit 9) computes this inverse for additive specs uniformly.
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
  /** Line count of the discovered README. Adds a small bonus when
   *  the README is substantial enough to onboard a new contributor. */
  readmeLines: number;
  /** CHANGELOG.md present. */
  changelogExists: boolean;
}

export const DX_SCORING_SPEC: DimensionScoringSpec<DxScoreInput> = {
  dimension: 'dx',
  methodology: 'openssf-scorecard-shape',
  baseline: 0,
  penalties: [
    {
      id: 'ci-configured',
      describe: (i) => `${i.ciConfigCount} CI workflow file(s) configured`,
      applies: (i) => i.ciConfigCount > 0,
      delta: () => 20,
    },
    {
      id: 'docker-configured',
      describe: () => `container build configured (Dockerfile / compose)`,
      applies: (i) => i.dockerConfigCount > 0,
      delta: () => 15,
    },
    {
      id: 'precommit-hooks',
      describe: () => `pre-commit hooks configured`,
      applies: (i) => i.precommitConfigCount > 0,
      delta: () => 10,
    },
    {
      id: 'makefile-present',
      describe: () => `Makefile present (task-runner entry-point)`,
      applies: (i) => i.makefileExists,
      delta: () => 10,
    },
    {
      id: 'env-example-present',
      describe: () => `.env.example present (env-var onboarding hint)`,
      applies: (i) => i.envExampleExists,
      delta: () => 10,
    },
    {
      id: 'automation-scripts',
      describe: (i) => `${i.npmScriptsCount} npm-script entry-point(s)`,
      applies: (i) => i.npmScriptsCount >= 1,
      delta: (i) => (i.npmScriptsCount >= 8 ? 15 : i.npmScriptsCount >= 4 ? 10 : 5),
    },
    {
      id: 'contributing-guide',
      describe: () => `CONTRIBUTING.md present`,
      applies: (i) => i.contributingExists,
      delta: () => 10,
    },
    {
      id: 'readme-substantial-for-onboarding',
      describe: (i) => `README is substantial (${i.readmeLines} lines, > 50)`,
      applies: (i) => i.readmeLines > 50,
      delta: () => 5,
    },
    {
      id: 'changelog-present',
      describe: () => `CHANGELOG.md present`,
      applies: (i) => i.changelogExists,
      delta: () => 5,
    },
  ],
  caps: [],
};
