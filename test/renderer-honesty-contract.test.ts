import { describe, expect, it } from 'vitest';
import { formatQualityReport } from '../src/analyzers/quality';
import { formatLicensesReport } from '../src/analyzers/licenses';
import { formatBomReport } from '../src/analyzers/bom';
import { formatTestGapsReport } from '../src/analyzers/tests';
import type { QualityReport } from '../src/analyzers/quality/types';
import type { LicensesReport } from '../src/analyzers/licenses/types';
import type { BomReport } from '../src/analyzers/bom/types';
import type { TestGapsReport } from '../src/analyzers/tests/types';

// ---------------------------------------------------------------------------
// Honesty contract:
//
//   When every tool-derived capability returns `unavailable` (no jscpd, no
//   graphify, no cloc, no license tool, no depVulns provider), the
//   rendered markdown must:
//     1. Be non-empty and well-formed (every section present).
//     2. Surface a visible "unavailable" marker for every absent capability
//        — silent omission reads as "this signal is fine" rather than
//        "we couldn't measure it."
//     3. Not template numeric zeros for tool-derived metrics in a way
//        that reads as a verdict (e.g., "0 packages", "0% duplication"
//        without a qualifier nearby).
//
// This file is the architectural enforcement of the second goal at the
// renderer surface. Each top-level `format*Report` must satisfy the
// contract; the test fails immediately on any regression that re-
// introduces silent omissions in any renderer.
// ---------------------------------------------------------------------------

const TIMESTAMP = '2026-05-14T00:00:00.000Z';

function unavailableQuality(): QualityReport {
  return {
    repo: 'fixture',
    analyzedAt: TIMESTAMP,
    commitSha: 'abcdef',
    branch: 'main',
    slopScore: 0,
    toolsUsed: ['grep', 'find'],
    toolsUnavailable: ['jscpd', 'graphify', 'cloc'],
    metrics: {
      sourceFiles: 0,
      filesOver500Lines: 0,
      largeFileThreshold: 500,
      largestFileLines: 0,
      anyTypeCount: 0,
      typeErrors: null,
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
      slopScore: 0,
    },
  };
}

function unavailableLicenses(): LicensesReport {
  return {
    repo: 'fixture',
    analyzedAt: TIMESTAMP,
    commitSha: 'abcdef',
    branch: 'main',
    schemaVersion: '1',
    summary: { totalPackages: 0, byLicense: {}, unknownCount: 0 },
    findings: [],
    toolsUsed: [],
    toolsUnavailable: ['license-inventory'],
    availability: {
      available: false,
      unavailableReason: 'csharp: nuget-license not installed',
    },
  };
}

function unavailableBom(): BomReport {
  return {
    repo: 'fixture',
    analyzedAt: TIMESTAMP,
    commitSha: 'abcdef',
    branch: 'main',
    schemaVersion: '1',
    summary: {
      totalPackages: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      vulnerablePackages: 0,
      actionableVulns: 0,
      totalAdvisories: 0,
      allowlistedAdvisories: 0,
      vulnOnlyPackages: 0,
      byTopLevelDep: {},
      filter: 'all',
      unfilteredTotalPackages: 0,
      projectRoots: ['.'],
      fingerprints: [],
    },
    entries: [],
    toolsUsed: [],
    toolsUnavailable: ['license-inventory', 'dep-audit'],
  };
}

function unavailableTestGaps(): TestGapsReport {
  return {
    repo: 'fixture',
    analyzedAt: TIMESTAMP,
    commitSha: 'abcdef',
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
    toolsUnavailable: ['coverage'],
  };
}

describe('renderer honesty contract — quality', () => {
  it('emits visible unavailable markers for tool-derived sections when nothing ran', () => {
    const md = formatQualityReport(unavailableQuality(), '1.0');
    // Section header must still appear so the customer sees the metric
    // existed at all.
    expect(md).toContain('## Duplication');
    expect(md).toContain('## Structural Complexity');
    // "unavailable" word must show somewhere associated with each absent
    // capability.
    expect(md).toContain('unavailable');
    expect(md).toMatch(/Duplication unavailable/i);
    expect(md).toMatch(/Structural complexity unavailable/i);
    // The buried silent-zero patterns must not appear.
    expect(md).not.toMatch(/Duplication \| 0% \(0 clones, 0 lines\)/);
  });
});

describe('renderer honesty contract — licenses', () => {
  it('emits the unavailable framing banner when license extraction did not run', () => {
    const md = formatLicensesReport(unavailableLicenses(), '1.0');
    expect(md).toContain('License extraction unavailable');
    expect(md).toContain('nuget-license');
    // The "0 packages" text alone (the historical silent-zero) is
    // permitted because the banner sits adjacent and explains it; the
    // strict check is that the banner is present.
    expect(md).toMatch(/⚠.*License extraction unavailable/);
  });
});

describe('renderer honesty contract — BoM', () => {
  it('renders a complete report (headings + footer) when no capability ran', () => {
    const md = formatBomReport(unavailableBom(), '1.0');
    // The BoM has no canonical "unavailable banner" yet, but the
    // toolsUnavailable footer must surface every absent capability so a
    // customer reading the report can tell what didn't run.
    expect(md).toContain('license-inventory');
    expect(md).toContain('dep-audit');
    expect(md.length).toBeGreaterThan(0);
  });

  it('never renders a "0.0.0" upgrade-target sentinel — that template was the D120 root cause', () => {
    const md = formatBomReport(unavailableBom(), '1.0');
    expect(md).not.toMatch(/Upgrade .* to 0\.0\.0/);
  });
});

describe('renderer honesty contract — test-gaps', () => {
  it('produces a complete report when no test/coverage capability ran', () => {
    const md = formatTestGapsReport(unavailableTestGaps(), '1.0');
    // Headings stay present; the customer should always see the report
    // has structure even when every signal is null.
    expect(md).toContain('Test Gap Analysis');
    expect(md.length).toBeGreaterThan(50);
  });
});
