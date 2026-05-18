import { describe, it, expect } from 'vitest';
import {
  LARGE_FILE_THRESHOLD_LINES,
  largeFilesToBaselineEntries,
} from '../../../src/baseline/producers/health';
import { identityFor } from '../../../src/baseline/finding-identity';
import type { HealthMetrics } from '../../../src/analyzers/types';

function emptyMetrics(over: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    sourceFiles: 0,
    testFiles: 0,
    totalLines: 0,
    testsPass: null,
    testsPassing: 0,
    testsFailing: 0,
    coverageConfigExists: false,
    typeErrors: null,
    filesOver500Lines: 0,
    largestFileLines: 0,
    largestFilePath: '',
    largestFiles: [],
    consoleLogCount: 0,
    anyTypeCount: 0,
    readmeExists: false,
    readmeLines: 0,
    docCommentFiles: 0,
    apiDocsExist: false,
    architectureDocsExist: false,
    contributingExists: false,
    changelogExists: false,
    evalCount: 0,
    privateKeyFiles: 0,
    envFilesInGit: 0,
    tlsDisabledCount: 0,
    todoCount: 0,
    fixmeCount: 0,
    hackCount: 0,
    staleFiles: 0,
    mixedLanguages: false,
    commentRatio: null,
    controllers: 0,
    models: 0,
    routeHandlerFiles: 0,
    directories: 0,
    languages: [],
    nodeEngineVersion: null,
    ciConfigCount: 0,
    dockerConfigCount: 0,
    precommitConfigCount: 0,
    makefileExists: false,
    envExampleExists: false,
    npmScriptsCount: 0,
    toolsUsed: [],
    toolsUnavailable: [],
    clocLanguages: null,
    ...over,
  } as HealthMetrics;
}

describe('largeFilesToBaselineEntries', () => {
  it('emits nothing when no files are reported', () => {
    expect(largeFilesToBaselineEntries(emptyMetrics())).toEqual([]);
  });

  it('emits one entry per file strictly over the threshold', () => {
    const entries = largeFilesToBaselineEntries(
      emptyMetrics({
        largestFiles: [
          { path: 'src/huge.ts', lines: LARGE_FILE_THRESHOLD_LINES + 1 },
          { path: 'src/tiny.ts', lines: 50 },
          { path: 'src/border.ts', lines: LARGE_FILE_THRESHOLD_LINES },
        ],
      }),
    );
    expect(entries).toHaveLength(1);
    const e = entries[0];
    if (e.kind !== 'large-file') throw new Error('shape');
    expect(e.file).toBe('src/huge.ts');
    expect(e.id).toBe(identityFor({ kind: 'large-file', file: 'src/huge.ts' }));
  });

  it('threshold is 500 lines (canonical maintainability constant)', () => {
    expect(LARGE_FILE_THRESHOLD_LINES).toBe(500);
  });
});
