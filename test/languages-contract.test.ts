import { describe, it, expect } from 'vitest';
import { LANGUAGES, getLanguage, detectActiveLanguages } from '../src/languages';
import type { LanguageId, LanguageSupport } from '../src/languages';
import { TOOL_DEFS } from '../src/analyzers/tools/tool-registry';

const REQUIRED_IDS: LanguageId[] = ['typescript', 'python', 'go', 'rust', 'csharp'];

describe('language registry', () => {
  it('exposes an array (empty until Phase 10d.1.6 migrations land)', () => {
    expect(Array.isArray(LANGUAGES)).toBe(true);
  });

  it('getLanguage returns undefined for unregistered ids', () => {
    for (const id of REQUIRED_IDS) {
      if (!LANGUAGES.some((l) => l.id === id)) {
        expect(getLanguage(id)).toBeUndefined();
      }
    }
  });

  it('detectActiveLanguages returns an array without throwing', () => {
    expect(Array.isArray(detectActiveLanguages(process.cwd()))).toBe(true);
  });
});

describe.each(LANGUAGES as LanguageSupport[])('language contract: $id', (lang) => {
  it('has a displayName', () => {
    expect(typeof lang.displayName).toBe('string');
    expect(lang.displayName.length).toBeGreaterThan(0);
  });

  it('declares at least one source extension', () => {
    expect(lang.sourceExtensions.length).toBeGreaterThan(0);
    for (const ext of lang.sourceExtensions) {
      expect(ext.startsWith('.')).toBe(true);
    }
  });

  it('declares at least one test file pattern', () => {
    expect(lang.testFilePatterns.length).toBeGreaterThan(0);
  });

  it('detect() returns a boolean', () => {
    expect(typeof lang.detect(process.cwd())).toBe('boolean');
  });

  it('tools and semgrepRulesets are arrays', () => {
    expect(Array.isArray(lang.tools)).toBe(true);
    expect(Array.isArray(lang.semgrepRulesets)).toBe(true);
  });

  it('every tool ID references a valid TOOL_DEFS key', () => {
    const validKeys = Object.keys(TOOL_DEFS);
    for (const toolId of lang.tools) {
      expect(validKeys, `${lang.id} references unknown tool "${toolId}"`).toContain(toolId);
    }
  });
});
