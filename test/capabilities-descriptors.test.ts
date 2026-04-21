import { describe, expect, it } from 'vitest';
import {
  COVERAGE,
  DEP_VULNS,
  IMPORTS,
  LINT,
  TEST_FRAMEWORK,
} from '../src/languages/capabilities/descriptors';
import type {
  CoverageResult,
  DepVulnResult,
  ImportsResult,
  LintResult,
  TestFrameworkResult,
} from '../src/languages/capabilities/types';

describe('DEP_VULNS descriptor', () => {
  it('id is "depVulns"', () => {
    expect(DEP_VULNS.id).toBe('depVulns');
  });

  it('aggregates a single result identically to its input shape', () => {
    const single: DepVulnResult = {
      schemaVersion: 1,
      tool: 'pip-audit',
      enrichment: 'osv.dev',
      counts: { critical: 1, high: 2, medium: 3, low: 4 },
    };
    const out = DEP_VULNS.aggregate([single]);
    expect(out.schemaVersion).toBe(1);
    expect(out.tool).toBe('pip-audit');
    expect(out.enrichment).toBe('osv.dev');
    expect(out.counts).toEqual(single.counts);
    expect(out.findings).toBeUndefined();
  });

  it('sums counts across providers', () => {
    const a: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical: 1, high: 1, medium: 1, low: 1 },
    };
    const b: DepVulnResult = {
      schemaVersion: 1,
      tool: 'pip-audit',
      enrichment: 'osv.dev',
      counts: { critical: 2, high: 4, medium: 6, low: 8 },
    };
    const out = DEP_VULNS.aggregate([a, b]);
    expect(out.counts).toEqual({ critical: 3, high: 5, medium: 7, low: 9 });
  });

  it('joins tool names without duplicates', () => {
    const a: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    const b: DepVulnResult = { ...a, tool: 'pip-audit' };
    const c: DepVulnResult = { ...a, tool: 'npm-audit' };
    expect(DEP_VULNS.aggregate([a, b, c]).tool).toBe('npm-audit, pip-audit');
  });

  it('preserves any provider that did osv enrichment', () => {
    const plain: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    const enriched: DepVulnResult = { ...plain, tool: 'pip-audit', enrichment: 'osv.dev' };
    expect(DEP_VULNS.aggregate([plain, enriched]).enrichment).toBe('osv.dev');
    expect(DEP_VULNS.aggregate([enriched, plain]).enrichment).toBe('osv.dev');
  });

  it('concatenates per-provider findings', () => {
    const a: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical: 1, high: 0, medium: 0, low: 0 },
      findings: [
        {
          id: 'CVE-2024-0001',
          package: 'pkg-a',
          severity: 'critical',
          source: 'tool-reported',
        },
      ],
    };
    const b: DepVulnResult = {
      schemaVersion: 1,
      tool: 'pip-audit',
      enrichment: 'osv.dev',
      counts: { critical: 0, high: 1, medium: 0, low: 0 },
      findings: [
        {
          id: 'GHSA-xxxx',
          package: 'pkg-b',
          severity: 'high',
          source: 'osv.dev',
        },
      ],
    };
    expect(DEP_VULNS.aggregate([a, b]).findings).toHaveLength(2);
  });

  it('omits findings field when no provider supplies any', () => {
    const a: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    expect(DEP_VULNS.aggregate([a, a]).findings).toBeUndefined();
  });
});

describe('LINT descriptor', () => {
  it('id is "lint"', () => {
    expect(LINT.id).toBe('lint');
  });

  it('sums counts across providers', () => {
    const a: LintResult = {
      schemaVersion: 1,
      tool: 'eslint',
      counts: { critical: 0, high: 5, medium: 10, low: 0 },
    };
    const b: LintResult = {
      schemaVersion: 1,
      tool: 'ruff',
      counts: { critical: 1, high: 2, medium: 0, low: 7 },
    };
    const out = LINT.aggregate([a, b]);
    expect(out.counts).toEqual({ critical: 1, high: 7, medium: 10, low: 7 });
    expect(out.tool).toBe('eslint, ruff');
  });
});

describe('COVERAGE descriptor', () => {
  it('id is "coverage"', () => {
    expect(COVERAGE.id).toBe('coverage');
  });

  it('returns last result (last-wins) until proper merge lands', () => {
    const a: CoverageResult = {
      schemaVersion: 1,
      tool: 'vitest',
      coverage: {
        source: 'istanbul-summary',
        sourceFile: 'coverage/coverage-summary.json',
        linePercent: 50,
        files: new Map(),
      },
    };
    const b: CoverageResult = {
      schemaVersion: 1,
      tool: 'coverage-py',
      coverage: {
        source: 'coverage-py',
        sourceFile: 'coverage.json',
        linePercent: 80,
        files: new Map(),
      },
    };
    expect(COVERAGE.aggregate([a, b])).toBe(b);
    expect(COVERAGE.aggregate([b, a])).toBe(a);
  });
});

describe('TEST_FRAMEWORK descriptor', () => {
  it('id is "testFramework"', () => {
    expect(TEST_FRAMEWORK.id).toBe('testFramework');
  });

  it('returns last result (last-wins)', () => {
    const a: TestFrameworkResult = { schemaVersion: 1, tool: 'typescript', name: 'vitest' };
    const b: TestFrameworkResult = { schemaVersion: 1, tool: 'python', name: 'pytest' };
    expect(TEST_FRAMEWORK.aggregate([a, b])).toBe(b);
  });
});

describe('IMPORTS descriptor', () => {
  it('id is "imports"', () => {
    expect(IMPORTS.id).toBe('imports');
  });

  it('unions sourceExtensions across packs without duplicates', () => {
    const ts: ImportsResult = {
      schemaVersion: 1,
      tool: 'ts-imports',
      sourceExtensions: ['.ts', '.tsx'],
      extracted: new Map(),
      edges: new Map(),
    };
    const py: ImportsResult = {
      schemaVersion: 1,
      tool: 'python-imports',
      sourceExtensions: ['.py'],
      extracted: new Map(),
      edges: new Map(),
    };
    const out = IMPORTS.aggregate([ts, py]);
    expect([...out.sourceExtensions].sort()).toEqual(['.py', '.ts', '.tsx']);
    expect(out.tool).toBe('ts-imports, python-imports');
  });

  it('unions extracted and edges across packs', () => {
    const ts: ImportsResult = {
      schemaVersion: 1,
      tool: 'ts-imports',
      sourceExtensions: ['.ts'],
      extracted: new Map([['src/a.ts', ['./b']]]),
      edges: new Map([['src/a.ts', new Set(['src/b.ts'])]]),
    };
    const py: ImportsResult = {
      schemaVersion: 1,
      tool: 'python-imports',
      sourceExtensions: ['.py'],
      extracted: new Map([['app/main.py', ['.helpers']]]),
      edges: new Map([['app/main.py', new Set(['app/helpers.py'])]]),
    };
    const out = IMPORTS.aggregate([ts, py]);
    expect(out.extracted.get('src/a.ts')).toEqual(['./b']);
    expect(out.extracted.get('app/main.py')).toEqual(['.helpers']);
    expect(out.edges.get('src/a.ts')).toEqual(new Set(['src/b.ts']));
    expect(out.edges.get('app/main.py')).toEqual(new Set(['app/helpers.py']));
  });

  it('handles a pack with empty edges (Rust/C# style) without error', () => {
    const rust: ImportsResult = {
      schemaVersion: 1,
      tool: 'rust-imports',
      sourceExtensions: ['.rs'],
      extracted: new Map([['src/lib.rs', ['crate::util']]]),
      edges: new Map(),
    };
    const out = IMPORTS.aggregate([rust]);
    expect(out.edges.size).toBe(0);
    expect(out.extracted.get('src/lib.rs')).toEqual(['crate::util']);
  });
});
