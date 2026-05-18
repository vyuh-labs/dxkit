import { describe, it, expect } from 'vitest';
import { testGapsToBaselineEntries } from '../../../src/baseline/producers/tests';
import { identityFor } from '../../../src/baseline/finding-identity';
import type { TestGapsReport } from '../../../src/analyzers/tests/types';

function report(over: Partial<TestGapsReport> = {}): TestGapsReport {
  return {
    repo: 'fixture',
    analyzedAt: '2026-05-18T00:00:00Z',
    commitSha: 'abc',
    branch: 'main',
    summary: {
      testFiles: 0,
      activeTestFiles: 0,
      commentedOutFiles: 0,
      effectiveCoverage: 0,
      coverageSource: 'filename-match',
      coverageFidelity: 'filename-match',
      sourceFiles: 0,
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
    },
    testFiles: [],
    gaps: [],
    toolsUsed: [],
    toolsUnavailable: [],
    ...over,
  };
}

describe('testGapsToBaselineEntries', () => {
  it('emits nothing on an empty report', () => {
    expect(testGapsToBaselineEntries(report())).toEqual([]);
  });

  it('emits test-gap entries for each untested source file with its risk tier', () => {
    const entries = testGapsToBaselineEntries(
      report({
        gaps: [
          {
            path: 'src/critical.ts',
            lines: 100,
            type: 'service',
            risk: 'critical',
            hasMatchingTest: false,
          },
          {
            path: 'src/low.ts',
            lines: 20,
            type: 'util',
            risk: 'low',
            hasMatchingTest: false,
          },
        ],
      }),
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.kind)).toEqual(['test-gap', 'test-gap']);
    const first = entries[0];
    if (first.kind !== 'test-gap') throw new Error('shape');
    expect(first.risk).toBe('critical');
    expect(first.id).toBe(
      identityFor({ kind: 'test-gap', file: 'src/critical.ts', risk: 'critical' }),
    );
  });

  it('skips gaps that report hasMatchingTest=true (defensive)', () => {
    const entries = testGapsToBaselineEntries(
      report({
        gaps: [
          {
            path: 'src/tested.ts',
            lines: 10,
            type: 'service',
            risk: 'high',
            hasMatchingTest: true,
          },
        ],
      }),
    );
    expect(entries).toEqual([]);
  });

  it('emits test-file-degradation entries for non-active test files', () => {
    const entries = testGapsToBaselineEntries(
      report({
        testFiles: [
          { path: 't/a.test.ts', status: 'commented-out', framework: 'vitest' },
          { path: 't/b.test.ts', status: 'empty', framework: 'vitest' },
          { path: 't/c.test.ts', status: 'schema-only', framework: 'vitest' },
          { path: 't/d.test.ts', status: 'active', framework: 'vitest' },
        ],
      }),
    );
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.kind)).toEqual([
      'test-file-degradation',
      'test-file-degradation',
      'test-file-degradation',
    ]);
    const first = entries[0];
    if (first.kind !== 'test-file-degradation') throw new Error('shape');
    expect(first.status).toBe('commented-out');
  });

  it('produces a different identity when the same file changes risk tier', () => {
    const a = testGapsToBaselineEntries(
      report({
        gaps: [
          { path: 'src/x.ts', lines: 10, type: 'service', risk: 'medium', hasMatchingTest: false },
        ],
      }),
    );
    const b = testGapsToBaselineEntries(
      report({
        gaps: [
          {
            path: 'src/x.ts',
            lines: 10,
            type: 'service',
            risk: 'critical',
            hasMatchingTest: false,
          },
        ],
      }),
    );
    expect(a[0].id).not.toBe(b[0].id);
  });
});
