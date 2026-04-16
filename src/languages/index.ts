import type { LanguageId, LanguageSupport } from './types';

export type { LanguageId, LanguageSupport, LintSeverity } from './types';

export const LANGUAGES: readonly LanguageSupport[] = [];

export function getLanguage(id: LanguageId): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

export function detectActiveLanguages(cwd: string): LanguageSupport[] {
  return LANGUAGES.filter((l) => l.detect(cwd));
}
