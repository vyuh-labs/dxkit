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
  // Pack-driven activation (Phase 10i.0-LP.7). Each pack uses its
  // `versionKey` (or falls back to `id`) as the lookup key into the
  // `flags` object. Adding a 6th pack with its versionKey already
  // declared works without editing this function — provided the
  // `DetectedStack.languages` interface gains a matching field
  // (item #14, deferred to 10f.4).
  //
  // The cast through `Record<string, boolean>` is the bridge: the
  // typed `DetectedStack.languages` shape pre-10f.4 only knows about
  // {python, go, node, nextjs, rust, csharp}, but lookup-by-pack-key
  // is the architecturally correct iteration. When 10f.4 refactors to
  // `Record<LanguageId, boolean>`, the cast goes away.
  const flagsByKey = flags as unknown as Record<string, boolean>;
  return LANGUAGES.filter((l) => {
    const key = l.versionKey ?? l.id;
    // Special-case: typescript pack maps to `node`, but `nextjs` ALSO
    // activates it (nextjs is a framework signal layered on top of
    // Node, not a separate pack — see project_yaml + generator).
    if (key === 'node') return flagsByKey.node || flagsByKey.nextjs;
    return flagsByKey[key] ?? false;
  });
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
