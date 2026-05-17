import { describe, expect, it } from 'vitest';
import { formatQualityReport } from '../src/analyzers/quality';
import { scoreQualityDimension } from '../src/analyzers/quality/shallow';
import { withInput, lintCapability } from './fixtures/score-input';
import type { QualityReport } from '../src/analyzers/quality/types';

function reportWithLintTool(tool: string | null, errors = 0, warnings = 1): QualityReport {
  return {
    repo: 'fixture',
    analyzedAt: '2026-05-14T00:00:00.000Z',
    commitSha: 'abcdef',
    branch: 'main',
    slopScore: 50,
    toolsUsed: ['grep', 'find'],
    toolsUnavailable: [],
    metrics: {
      sourceFiles: 100,
      filesOver500Lines: 0,
      largestFileLines: 0,
      anyTypeCount: 0,
      typeErrors: null,
      lintErrors: errors,
      lintWarnings: warnings,
      lintTool: tool,
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

describe('quality renderer — Lint coverage gap callout', () => {
  it('renders the Lint Errors row without a coverage gap when every attempted provider succeeded', () => {
    const md = formatQualityReport(reportWithLintTool('ruff'), '1.0');
    expect(md).toMatch(/\| Lint Errors \| 0 errors, 1 warnings \(ruff\) \|/);
    expect(md).not.toContain('Lint coverage gap');
  });

  it('separates the not-run packs into a visible callout row', () => {
    const md = formatQualityReport(reportWithLintTool('ruff (not run: typescript)', 35, 1), '1.0');
    // The Lint Errors row shows only the tool that actually ran.
    expect(md).toMatch(/\| Lint Errors \| 35 errors, 1 warnings \(ruff\) \|/);
    // The coverage gap surfaces as its own row with an explicit
    // configure-the-linter hint.
    expect(md).toMatch(/Lint coverage gap.*typescript.*configure/);
    // The buried-parenthetical form must no longer appear.
    expect(md).not.toContain('(ruff (not run: typescript))');
  });

  it('handles multiple skipped packs in the gap callout', () => {
    const md = formatQualityReport(
      reportWithLintTool('ruff (not run: typescript, go)', 0, 0),
      '1.0',
    );
    expect(md).toMatch(/Lint coverage gap.*typescript, go/);
  });
});

describe('Code Quality dimension prose — Lint coverage gap', () => {
  it('appends a coverage-gap sentence when one or more packs returned null silently', () => {
    const input = withInput({
      metrics: { sourceFiles: 100 },
      capabilities: {
        lint: lintCapability(0, 0, 1, 0, 'ruff (not run: typescript)'),
      },
    });
    const r = scoreQualityDimension(input);
    expect(r.details).toMatch(/0 lint errors, 1 warnings \(ruff\)/);
    expect(r.details).toMatch(/Linter coverage gap: typescript not run/);
    expect(r.details).not.toContain('(ruff (not run: typescript))');
  });

  it('does not append the coverage-gap sentence when every attempted provider succeeded', () => {
    const input = withInput({
      metrics: { sourceFiles: 100 },
      capabilities: {
        lint: lintCapability(0, 0, 1, 0, 'ruff'),
      },
    });
    const r = scoreQualityDimension(input);
    expect(r.details).not.toContain('coverage gap');
  });
});
