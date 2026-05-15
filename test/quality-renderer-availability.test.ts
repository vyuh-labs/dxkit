import { describe, expect, it } from 'vitest';
import { formatQualityReport } from '../src/analyzers/quality';
import type { QualityReport } from '../src/analyzers/quality/types';

function baseReport(): QualityReport {
  return {
    repo: 'fixture',
    analyzedAt: '2026-05-14T00:00:00.000Z',
    commitSha: 'abcdef',
    branch: 'main',
    slopScore: 50,
    toolsUsed: ['grep', 'find'],
    toolsUnavailable: [],
    metrics: {
      lintErrors: 0,
      lintWarnings: 0,
      lintTool: null,
      duplication: null,
      maxFunctionsInFile: null,
      maxFunctionsFilePath: null,
      avgCohesion: null,
      communityCount: null,
      functionCount: null,
      deadImportCount: null,
      orphanModuleCount: null,
      todoCount: 0,
      fixmeCount: 0,
      hackCount: 0,
      consoleLogCount: 0,
      commentRatio: null,
      staleFiles: [],
      mixedLanguages: false,
      slopScore: 50,
    },
  };
}

describe('formatQualityReport — unavailable propagation', () => {
  it('always renders the Duplication summary row, with an explicit unavailable label when jscpd did not run', () => {
    const md = formatQualityReport(baseReport(), '1.0');
    expect(md).toMatch(/\| Duplication \| .*unavailable.*\|/);
    expect(md).toContain('install `jscpd`');
  });

  it('renders the Duplication summary row with the computed values when jscpd produced output', () => {
    const r = baseReport();
    r.metrics.duplication = {
      totalLines: 1000,
      duplicatedLines: 150,
      percentage: 15,
      cloneCount: 4,
    };
    const md = formatQualityReport(r, '1.0');
    expect(md).toMatch(/\| Duplication \| 15% \(4 clones, 150 lines\) \|/);
    expect(md).not.toContain('unavailable — install `jscpd`');
  });

  it('always renders the Duplication H2 section, with an unavailable banner when jscpd did not run', () => {
    const md = formatQualityReport(baseReport(), '1.0');
    expect(md).toContain('## Duplication');
    expect(md).toContain('Duplication unavailable');
    expect(md).toContain('Install jscpd');
  });

  it('always renders the Structural Complexity H2 section, with an unavailable banner when graphify did not run', () => {
    const md = formatQualityReport(baseReport(), '1.0');
    expect(md).toContain('## Structural Complexity');
    expect(md).toContain('Structural complexity unavailable');
    expect(md).toContain('Install graphify');
  });

  it('renders the Comment Ratio hygiene line with an unavailable annotation when cloc did not run', () => {
    const md = formatQualityReport(baseReport(), '1.0');
    expect(md).toMatch(/Comment ratio:.*unavailable.*cloc/);
  });

  it('renders concrete values for every Summary metric when every capability succeeded', () => {
    const r = baseReport();
    r.metrics.duplication = {
      totalLines: 1000,
      duplicatedLines: 100,
      percentage: 10,
      cloneCount: 3,
    };
    r.metrics.commentRatio = 0.12;
    r.metrics.functionCount = 200;
    r.metrics.maxFunctionsInFile = 40;
    r.metrics.maxFunctionsFilePath = 'src/big.ts';
    r.metrics.communityCount = 8;
    r.metrics.avgCohesion = 0.7;
    r.metrics.deadImportCount = 0;
    r.metrics.orphanModuleCount = 0;
    const md = formatQualityReport(r, '1.0');
    expect(md).not.toContain('unavailable — install');
    expect(md).not.toContain('unavailable (`cloc`');
    expect(md).toMatch(/\| Functions \| 200 total/);
    expect(md).toMatch(/\| Dead Imports \| 0 \|/);
    expect(md).toMatch(/\| Orphan Modules \| 0 \|/);
  });
});
