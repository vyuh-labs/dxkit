/**
 * Documentation dimension — declarative scoring spec.
 *
 * Methodology: additive checklist over documentation artifacts
 * (README, doc-comment density, API docs, architecture docs,
 * CONTRIBUTING, CHANGELOG). Each artifact present contributes a
 * fixed point value sized by its importance to repository
 * understandability.
 *
 * No Layer-1 standard prescribes specific point allocations for
 * dxkit's set of artifacts; the values are dxkit's own choice
 * (documented in `src/scoring/STANDARDS.md` Layer 3) calibrated
 * to weight README + API docs heaviest (foundational artifacts
 * a customer reads first) and minor artifacts like CHANGELOG
 * lightest.
 *
 * No caps in this spec. The additive baseline (0) means a repo
 * with no documentation lands at 0 by construction; no Label
 * Contract cap is needed because the formula's natural ceiling
 * already enforces the rating contract (max possible without
 * README is 75, already capped below A by the math).
 *
 * Caveat for additive specs: penalty deltas are positive (bonuses
 * earned, not deductions). The ScoreResult.deductions array
 * surfaces the rules that fired with their positive deltas — these
 * are bonuses already-earned, not actions-to-take. Renderers
 * surfacing actionable-next-moves for additive specs should
 * compute the inverse (rules that did NOT fire are the opportunities
 * to add). See `src/scoring/STANDARDS.md` Layer 3 for the convention.
 */

import type { DimensionScoringSpec } from '../spec';

/**
 * Partition of every signal the Documentation scorer reads. The
 * adapter builds this shape; the spec stays consumer-agnostic.
 */
export interface DocumentationScoreInput {
  /** Total source files; denominator for `docCommentFiles` density. */
  sourceFiles: number;
  /** Does the repo have a README.md (or README.rst / README.txt)? */
  readmeExists: boolean;
  /** Line count of the discovered README. Tier-bonused at 20/50/100. */
  readmeLines: number;
  /** Count of source files with documentation comments
   *  (JSDoc / docstrings / Rustdoc / etc.). Density-bonused. */
  docCommentFiles: number;
  /** API documentation directory present (docs/api/, openapi.{yaml,json},
   *  Swagger UI, etc.). */
  apiDocsExist: boolean;
  /** Architecture documentation present (docs/architecture/, ARCHITECTURE.md). */
  architectureDocsExist: boolean;
  /** CONTRIBUTING.md present. */
  contributingExists: boolean;
  /** CHANGELOG.md present. */
  changelogExists: boolean;
}

export const DOCUMENTATION_SCORING_SPEC: DimensionScoringSpec<DocumentationScoreInput> = {
  dimension: 'documentation',
  methodology: 'dxkit-documentation-checklist',
  baseline: 0,
  penalties: [
    {
      id: 'readme-substance',
      describe: (i) =>
        i.readmeLines > 100
          ? `README is substantial (${i.readmeLines} lines)`
          : i.readmeLines > 50
            ? `README is moderate (${i.readmeLines} lines)`
            : i.readmeLines > 20
              ? `README is light (${i.readmeLines} lines)`
              : `README exists but is minimal (${i.readmeLines} lines)`,
      applies: (i) => i.readmeExists,
      delta: (i) =>
        i.readmeLines > 100 ? 25 : i.readmeLines > 50 ? 20 : i.readmeLines > 20 ? 15 : 5,
    },
    {
      id: 'doc-comment-density',
      describe: (i) => {
        const ratio = i.docCommentFiles / Math.max(i.sourceFiles, 1);
        return `${i.docCommentFiles}/${i.sourceFiles} files carry doc comments (${(ratio * 100).toFixed(1)}%)`;
      },
      applies: (i) => i.docCommentFiles / Math.max(i.sourceFiles, 1) > 0.05,
      delta: (i) => {
        const ratio = i.docCommentFiles / Math.max(i.sourceFiles, 1);
        return ratio > 0.5 ? 25 : ratio > 0.2 ? 15 : 5;
      },
    },
    {
      id: 'api-docs-present',
      describe: () => `API documentation directory or spec present`,
      applies: (i) => i.apiDocsExist,
      delta: () => 20,
    },
    {
      id: 'architecture-docs-present',
      describe: () => `Architecture documentation present`,
      applies: (i) => i.architectureDocsExist,
      delta: () => 15,
    },
    {
      id: 'contributing-present',
      describe: () => `CONTRIBUTING.md present`,
      applies: (i) => i.contributingExists,
      delta: () => 10,
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
