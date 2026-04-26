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
  const flags: Record<LanguageId, boolean> = {
    typescript: stack.languages.node || stack.languages.nextjs,
    python: stack.languages.python,
    go: stack.languages.go,
    rust: stack.languages.rust,
    csharp: stack.languages.csharp,
  };
  return LANGUAGES.filter((l) => flags[l.id]);
}
