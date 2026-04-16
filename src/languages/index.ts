import type { LanguageId, LanguageSupport } from './types';
import { python } from './python';

export type { LanguageId, LanguageSupport, LintSeverity } from './types';

export const LANGUAGES: readonly LanguageSupport[] = [python];

export function getLanguage(id: LanguageId): LanguageSupport | undefined {
  return LANGUAGES.find((l) => l.id === id);
}

export function detectActiveLanguages(cwd: string): LanguageSupport[] {
  return LANGUAGES.filter((l) => l.detect(cwd));
}
