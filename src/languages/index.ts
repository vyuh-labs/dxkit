import type { DetectedStack } from '../types';
import type { LanguageId, LanguageSupport } from './types';
import { csharp } from './csharp';
import { go } from './go';
import { python } from './python';
import { rust } from './rust';
import { typescript } from './typescript';

export type { LanguageId, LanguageSupport, LintSeverity, ProjectYamlContext } from './types';

export const LANGUAGES: readonly LanguageSupport[] = [python, typescript, csharp, go, rust];

export function getLanguage(id: LanguageId): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

export function detectActiveLanguages(cwd: string): LanguageSupport[] {
  return LANGUAGES.filter((l) => l.detect(cwd));
}

/**
 * Map a `DetectedStack` (or `ResolvedConfig`, which extends it) to the
 * set of `LanguageSupport` packs that are active for the project.
 *
 * Bridges the legacy `DetectedStack.languages.{python, go, node, nextjs,
 * rust, csharp}` shape (a remnant of the pre-pack era — D009/D010
 * territory, refactor tracked in 10f.4) to the canonical pack registry.
 *
 * Note: `node` and `nextjs` both activate the `typescript` pack. There
 * is no separate Node-only or Next-only pack today; nextjs is treated
 * as a framework signal (consumed by `generator.ts` for `nextjs.md`
 * rule-file scaffolding) rather than a distinct language.
 */
export function activeLanguagesFromStack(stack: DetectedStack): LanguageSupport[] {
  return activeLanguagesFromFlags(stack.languages);
}

/**
 * Same mapping as `activeLanguagesFromStack`, but for callers who only
 * have the `languages` sub-shape (e.g. `tool-registry.ts:buildRequiredTools`
 * receives `DetectedStack['languages']`, not the full stack).
 */
export function activeLanguagesFromFlags(flags: DetectedStack['languages']): LanguageSupport[] {
  const idFlags: Record<LanguageId, boolean> = {
    typescript: flags.node || flags.nextjs,
    python: flags.python,
    go: flags.go,
    rust: flags.rust,
    csharp: flags.csharp,
  };
  return LANGUAGES.filter((l) => idFlags[l.id]);
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
