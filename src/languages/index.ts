import type { DetectedStack } from '../types';
import type { LanguageId, LanguageSupport } from './types';
import { csharp } from './csharp';
import { go } from './go';
import { python } from './python';
import { rust } from './rust';
import { typescript } from './typescript';
import { kotlin } from './kotlin';

export type { LanguageId, LanguageSupport, LintSeverity, ProjectYamlContext } from './types';

export const LANGUAGES: readonly LanguageSupport[] = [python, typescript, csharp, go, rust, kotlin];

export function getLanguage(id: LanguageId): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

export function detectActiveLanguages(cwd: string): LanguageSupport[] {
  return LANGUAGES.filter((l) => l.detect(cwd));
}

/**
 * Map a `DetectedStack` (or `ResolvedConfig`, which extends it) to the
 * set of `LanguageSupport` packs that are active for the project.
 * Pack-driven via `DetectedStack.languages` keyed on `LanguageId` —
 * adding a pack means extending `LanguageId` + registering in
 * `LANGUAGES`; this function never changes.
 */
export function activeLanguagesFromStack(stack: DetectedStack): LanguageSupport[] {
  return activeLanguagesFromFlags(stack.languages);
}

/**
 * Same as `activeLanguagesFromStack`, but for callers who only have
 * the `languages` sub-shape (e.g. `tool-registry.ts:buildRequiredTools`
 * receives `DetectedStack['languages']`, not the full stack).
 */
export function activeLanguagesFromFlags(flags: DetectedStack['languages']): LanguageSupport[] {
  return LANGUAGES.filter((l) => flags[l.id] ?? false);
}

/**
 * All source-file extensions across every registered pack, deduplicated.
 * The pack-driven analog of the pre-LP.3 hardcoded
 * `'.ts .tsx .js .jsx .py .go .rs .cs'` constant in `generic.ts` —
 * grows automatically as new packs land.
 */
export function allSourceExtensions(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.sourceExtensions))];
}

/**
 * All test-file patterns across every registered pack, deduplicated.
 * Patterns without a slash are basename-style (matched by find `-name`);
 * patterns containing a slash are path-anchored (e.g. Rust's
 * tests-directory glob for integration tests) and need find
 * `-path` semantics — see `splitTestFilePatterns()`.
 */
export function allTestFilePatterns(): string[] {
  return [...new Set(LANGUAGES.flatMap((l) => l.testFilePatterns))];
}

/**
 * Split test-file patterns into the two shapes find treats differently:
 * basename patterns (matched via `-name`) and path-anchored patterns
 * (matched via `-path`). Pre-LP.3, generic.ts used only `-name` and
 * silently missed Rust's integration tests under the tests directory
 * because that pattern doesn't match a basename.
 */
export function splitTestFilePatterns(patterns: string[] = allTestFilePatterns()): {
  nameOnly: string[];
  pathAnchored: string[];
} {
  return {
    nameOnly: patterns.filter((p) => !p.includes('/')),
    pathAnchored: patterns.filter((p) => p.includes('/')),
  };
}
