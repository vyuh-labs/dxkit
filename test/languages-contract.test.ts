import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { LANGUAGES, getLanguage, detectActiveLanguages } from '../src/languages';
import type { LanguageId, LanguageSupport } from '../src/languages';
import { TOOL_DEFS } from '../src/analyzers/tools/tool-registry';

const REQUIRED_IDS: LanguageId[] = ['typescript', 'python', 'go', 'rust', 'csharp'];

describe('language registry', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(LANGUAGES)).toBe(true);
    expect(LANGUAGES.length).toBeGreaterThan(0);
  });

  it('covers all 5 required language IDs', () => {
    const registered = LANGUAGES.map((l) => l.id);
    for (const id of REQUIRED_IDS) {
      expect(registered, `missing language: ${id}`).toContain(id);
    }
  });

  it('has no duplicate IDs', () => {
    const ids = LANGUAGES.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('getLanguage returns the correct pack for each registered ID', () => {
    for (const lang of LANGUAGES) {
      expect(getLanguage(lang.id)).toBe(lang);
    }
  });

  it('getLanguage returns undefined for unknown IDs', () => {
    expect(getLanguage('typescript')).toBeDefined();
    // Cast to bypass type narrowing — tests should cover runtime safety.
    expect(getLanguage('brainfuck' as LanguageId)).toBeUndefined();
  });

  it('detectActiveLanguages returns an array without throwing', () => {
    const result = detectActiveLanguages(process.cwd());
    expect(Array.isArray(result)).toBe(true);
    // dxkit is a TypeScript project — should detect at least typescript.
    expect(result.some((l) => l.id === 'typescript')).toBe(true);
  });
});

describe.each(LANGUAGES as LanguageSupport[])('language contract: $id', (lang) => {
  it('has a non-empty displayName', () => {
    expect(typeof lang.displayName).toBe('string');
    expect(lang.displayName.length).toBeGreaterThan(0);
  });

  it('declares at least one source extension starting with "."', () => {
    expect(lang.sourceExtensions.length).toBeGreaterThan(0);
    for (const ext of lang.sourceExtensions) {
      expect(ext.startsWith('.'), `invalid extension "${ext}"`).toBe(true);
    }
  });

  it('declares at least one test file pattern containing a wildcard', () => {
    expect(lang.testFilePatterns.length).toBeGreaterThan(0);
    for (const pat of lang.testFilePatterns) {
      expect(pat.includes('*') || pat.includes('?'), `pattern "${pat}" has no wildcard`).toBe(true);
    }
  });

  it('detect() returns a boolean and is idempotent', () => {
    const first = lang.detect(process.cwd());
    const second = lang.detect(process.cwd());
    expect(typeof first).toBe('boolean');
    expect(first).toBe(second);
  });

  it('tools and semgrepRulesets are arrays of strings', () => {
    expect(Array.isArray(lang.tools)).toBe(true);
    expect(Array.isArray(lang.semgrepRulesets)).toBe(true);
    for (const t of lang.tools) {
      expect(typeof t).toBe('string');
    }
    for (const r of lang.semgrepRulesets) {
      expect(typeof r).toBe('string');
    }
  });

  it('every tool ID references a valid TOOL_DEFS key', () => {
    const validKeys = Object.keys(TOOL_DEFS);
    for (const toolId of lang.tools) {
      expect(validKeys, `${lang.id} references unknown tool "${toolId}"`).toContain(toolId);
    }
  });

  it('every tool invoked via findTool(TOOL_DEFS.X) is declared in tools[]', () => {
    // Scan the pack's source file for TOOL_DEFS.X / TOOL_DEFS['X'] patterns.
    // Every X found must appear in lang.tools — otherwise a new tool call
    // slipped in without being declared as a dependency.
    //
    // The reverse direction (every declared tool is invoked) is intentionally
    // NOT checked: some tools are "artifact-generating" — the user runs them
    // externally to produce files dxkit reads (e.g. coverage-py → coverage.json,
    // cargo-llvm-cov → lcov.info). Those are legitimately declared so
    // `vyuh-dxkit tools install` can set them up, even though gatherMetrics
    // never invokes them as CLI binaries.
    const srcPath = path.resolve(__dirname, '..', 'src', 'languages', `${lang.id}.ts`);
    const src = fs.readFileSync(srcPath, 'utf-8');
    const invokedToolIds = new Set<string>();
    const dotRe = /\bTOOL_DEFS\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    const bracketRe = /\bTOOL_DEFS\[\s*['"]([^'"]+)['"]\s*\]/g;
    let m: RegExpExecArray | null;
    while ((m = dotRe.exec(src)) !== null) invokedToolIds.add(m[1]);
    while ((m = bracketRe.exec(src)) !== null) invokedToolIds.add(m[1]);

    const declared = new Set(lang.tools);
    for (const id of invokedToolIds) {
      expect(
        declared,
        `${lang.id}: "${id}" invoked via TOOL_DEFS but missing from tools[]`,
      ).toContain(id);
    }
  });

  it('extraExcludes is an array of strings when defined', () => {
    if (lang.extraExcludes) {
      expect(Array.isArray(lang.extraExcludes)).toBe(true);
      for (const e of lang.extraExcludes) {
        expect(typeof e).toBe('string');
      }
    }
  });

  it('optional methods have correct types when present', () => {
    if (lang.gatherMetrics) expect(typeof lang.gatherMetrics).toBe('function');
    if (lang.mapLintSeverity) expect(typeof lang.mapLintSeverity).toBe('function');
  });
});
