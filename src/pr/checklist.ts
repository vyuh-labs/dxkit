/**
 * The reviewer-checklist engine for `vyuh-dxkit pr`: a registry of pure
 * fact → row rules. Each rule inspects the diff facts and, when it applies,
 * contributes one checklist row targeted at what THIS change actually touched —
 * a migration row only when a migration moved, a supply-chain row only when a
 * dependency manifest moved. A generic checklist is noise; a diff-derived one
 * guides the review.
 *
 * `deriveFacts` is pure (structured diff inputs → `DiffFacts`), so the whole
 * checklist is testable without git. The rows are stable and deterministic.
 */
import type { LanguageSupport } from '../languages/types';
import { changedFilesTouchDependencyManifest } from '../languages/index';
import { isTestSourceFile } from '../analyzers/tools/walk-source-files';

/** Structured, git-free inputs the facts are derived from. */
export interface DiffInputs {
  /** Repo-relative paths changed in `base..HEAD`. */
  readonly changedFiles: readonly string[];
  /** Lines ADDED by the diff (the `+` side, prefix stripped) — scanned for
   *  intrinsic markers (an inline allowlist annotation, an `export`). Kept small
   *  by the caller (added lines only, not the whole file). */
  readonly addedLines: readonly string[];
  /** Active language packs (for pack-driven dependency-manifest matching). */
  readonly packs: readonly LanguageSupport[];
}

/** The boolean facts the checklist rules switch on. */
export interface DiffFacts {
  readonly allowlistTouched: boolean;
  readonly dependencyTouched: boolean;
  readonly migrationTouched: boolean;
  readonly publicApiChanged: boolean;
  readonly sourceChanged: boolean;
  readonly testChanged: boolean;
  readonly ciOrHookTouched: boolean;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|cs|kt|java|rb)$/;
const MIGRATION = /(^|\/)(migrations?|db\/migrate)\//i;
const SCHEMA_FILE = /(schema\.prisma|\.sql|schema\.rb|\/schema\/)/i;
const CI_OR_HOOK = /(^|\/)(\.github\/workflows\/|\.githooks\/|\.husky\/)/;
const ALLOWLIST_FILE = /(^|\/)\.dxkit\/allowlist/;
const INLINE_ALLOW = /dxkit-allow[:=]/;
// A public-surface signal: an added or removed top-level `export` (JS/TS),
// `func`/`pub fn`/`public` export shapes are covered coarsely by the language
// packs elsewhere; here we key on the most common exported-symbol markers.
const EXPORTED_SYMBOL = /\bexport\b|\bpublic\s|\bpub\s+(fn|struct|enum|trait)\b/;

/** Derive the boolean diff facts. Pure. */
export function deriveFacts(input: DiffInputs): DiffFacts {
  const { changedFiles, addedLines, packs } = input;
  const isSource = (f: string): boolean => SOURCE_EXT.test(f);

  const sourceFiles = changedFiles.filter((f) => isSource(f) && !isTestSourceFile(f));
  const testFiles = changedFiles.filter((f) => isTestSourceFile(f));

  return {
    allowlistTouched:
      changedFiles.some((f) => ALLOWLIST_FILE.test(f)) ||
      addedLines.some((l) => INLINE_ALLOW.test(l)),
    dependencyTouched: packs.length > 0 && changedFilesTouchDependencyManifest(changedFiles, packs),
    migrationTouched: changedFiles.some((f) => MIGRATION.test(f) || SCHEMA_FILE.test(f)),
    publicApiChanged: sourceFiles.length > 0 && addedLines.some((l) => EXPORTED_SYMBOL.test(l)),
    sourceChanged: sourceFiles.length > 0,
    testChanged: testFiles.length > 0,
    ciOrHookTouched: changedFiles.some((f) => CI_OR_HOOK.test(f)),
  };
}

interface ChecklistRule {
  readonly id: string;
  readonly when: (f: DiffFacts) => boolean;
  readonly row: string;
}

/**
 * The rule registry. Always-on rows (scope, secrets) anchor every review; the
 * rest are fact-gated so they appear only when the change touches that surface.
 * Order here is the render order.
 */
export const CHECKLIST_RULES: readonly ChecklistRule[] = [
  {
    id: 'scope',
    when: () => true,
    row: 'Change matches the description; scope is not broader than stated',
  },
  {
    id: 'allowlist',
    when: (f) => f.allowlistTouched,
    row: 'Each allowlist suppression is justified (category + reason + expiry) — the highest-trust thing to approve',
  },
  {
    id: 'dependency',
    when: (f) => f.dependencyTouched,
    row: 'Supply chain: review added/updated dependencies (new packages, version bumps, lockfile churn)',
  },
  {
    id: 'migration',
    when: (f) => f.migrationTouched,
    row: 'Data-model / migration change is reversible and backward-compatible with in-flight data',
  },
  {
    id: 'public-api',
    when: (f) => f.publicApiChanged,
    row: 'Exported/public API change preserves backward compatibility (callers updated, or the break is intended + noted)',
  },
  {
    id: 'tests',
    when: (f) => f.sourceChanged && !f.testChanged,
    row: 'Source changed without a matching test change — add tests or note why the gap is acceptable',
  },
  {
    id: 'ci-security',
    when: (f) => f.ciOrHookTouched,
    row: 'CI workflow / git-hook change reviewed with pipeline-level scrutiny (it runs with repository privileges)',
  },
  {
    id: 'secrets',
    when: () => true,
    row: 'No secrets, keys, or tokens in the diff',
  },
];

/** The checklist rows that apply to this diff, in registry order. */
export function buildChecklist(facts: DiffFacts): string[] {
  return CHECKLIST_RULES.filter((r) => r.when(facts)).map((r) => r.row);
}
