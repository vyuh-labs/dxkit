/**
 * Documentation dimension — declarative scoring spec.
 *
 * Methodology: subtractive checklist over documentation artifacts
 * (README, doc-comment density, API docs, architecture docs,
 * CONTRIBUTING, CHANGELOG). Baseline 100; each missing or
 * substandard artifact deducts points sized by the artifact's
 * importance to repository understandability. README + doc-comment
 * density weigh heaviest (foundational artifacts a customer reads
 * first), CHANGELOG lightest.
 *
 * No Layer-1 standard prescribes specific point allocations for
 * dxkit's set of artifacts; the values are dxkit's own choice
 * documented in `src/scoring/STANDARDS.md` Layer 3.
 *
 * The "subtractive over checklist" framing (rather than the
 * additive-from-zero shape used pre-2.4.7) means
 * `ScoreResult.deductions` reads as missing items the customer can
 * fix — uniform actionable semantics across all six dimensions.
 * The numeric score is unchanged from the pre-inversion additive
 * form (baseline 100 minus penalties is mathematically equivalent
 * to baseline 0 plus bonuses, with the same per-rule values).
 *
 * No caps in this spec. The baseline + penalty distribution enforce
 * the rating contract by construction.
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
  /** Line count of the discovered README. Tier-penalized at 20/50/100. */
  readmeLines: number;
  /** Count of source files with documentation comments
   *  (JSDoc / docstrings / Rustdoc / etc.). Density-penalized. */
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

/** README-substance penalty: how far short the README is of "substantial". */
function readmePenalty(i: DocumentationScoreInput): number {
  if (!i.readmeExists) return -25;
  if (i.readmeLines <= 20) return -20;
  if (i.readmeLines <= 50) return -10;
  if (i.readmeLines <= 100) return -5;
  return 0;
}

/** Doc-comment density penalty: lower density = larger penalty. */
function docCommentPenalty(i: DocumentationScoreInput): number {
  const ratio = i.docCommentFiles / Math.max(i.sourceFiles, 1);
  if (ratio > 0.5) return 0;
  if (ratio > 0.2) return -10;
  if (ratio > 0.05) return -20;
  return -25;
}

export const DOCUMENTATION_SCORING_SPEC: DimensionScoringSpec<DocumentationScoreInput> = {
  dimension: 'documentation',
  methodology: 'dxkit-documentation-checklist',
  baseline: 100,
  penalties: [
    {
      id: 'readme-substance',
      describe: (i) =>
        !i.readmeExists
          ? `README missing`
          : i.readmeLines <= 20
            ? `README is minimal (${i.readmeLines} lines; substantial = > 100)`
            : i.readmeLines <= 50
              ? `README is light (${i.readmeLines} lines; substantial = > 100)`
              : `README is moderate (${i.readmeLines} lines; substantial = > 100)`,
      applies: (i) => readmePenalty(i) < 0,
      delta: readmePenalty,
    },
    {
      id: 'doc-comment-density',
      describe: (i) => {
        const ratio = i.docCommentFiles / Math.max(i.sourceFiles, 1);
        return `${i.docCommentFiles}/${i.sourceFiles} files carry doc comments (${(ratio * 100).toFixed(1)}%; ≥ 50% = full marks)`;
      },
      applies: (i) => docCommentPenalty(i) < 0,
      delta: docCommentPenalty,
    },
    {
      id: 'api-docs-missing',
      describe: () => `API documentation directory or spec missing`,
      applies: (i) => !i.apiDocsExist,
      delta: () => -20,
    },
    {
      id: 'architecture-docs-missing',
      describe: () => `Architecture documentation missing`,
      applies: (i) => !i.architectureDocsExist,
      delta: () => -15,
    },
    {
      id: 'contributing-missing',
      describe: () => `CONTRIBUTING.md missing`,
      applies: (i) => !i.contributingExists,
      delta: () => -10,
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
