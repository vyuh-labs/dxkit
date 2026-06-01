import { describe, it, expect } from 'vitest';
import { coverageFromToolStatuses, missingScanners, diffCoverage } from '../src/baseline/coverage';
import type { ToolStatus } from '../src/analyzers/tools/tool-registry';

function status(name: string, source: ToolStatus['source']): ToolStatus {
  return {
    name,
    available: source !== 'missing' && source !== 'n/a',
    path: source === 'missing' || source === 'n/a' ? null : `/bin/${name}`,
    version: null,
    source,
    // The requirement shape isn't read by the coverage helpers.
    requirement: { name } as ToolStatus['requirement'],
  };
}

describe('coverageFromToolStatuses', () => {
  it('records each scanner with its source, sorted by name', () => {
    const cov = coverageFromToolStatuses([
      status('semgrep', 'path'),
      status('gitleaks', 'missing'),
      status('jscpd', 'npm-g'),
    ]);
    expect(cov.scanners.map((s) => s.tool)).toEqual(['gitleaks', 'jscpd', 'semgrep']);
    expect(cov.scanners.find((s) => s.tool === 'gitleaks')).toMatchObject({
      available: false,
      source: 'missing',
    });
  });
});

describe('missingScanners', () => {
  it('returns only source==="missing" (excludes n/a and available)', () => {
    const cov = coverageFromToolStatuses([
      status('gitleaks', 'missing'),
      status('vitest-coverage', 'n/a'),
      status('semgrep', 'path'),
    ]);
    expect(missingScanners(cov).map((s) => s.tool)).toEqual(['gitleaks']);
  });

  it('is empty when everything is present or n/a', () => {
    const cov = coverageFromToolStatuses([status('semgrep', 'path'), status('foo', 'n/a')]);
    expect(missingScanners(cov)).toEqual([]);
  });
});

describe('diffCoverage', () => {
  const present = coverageFromToolStatuses([status('gitleaks', 'path')]);
  const missing = coverageFromToolStatuses([status('gitleaks', 'missing')]);

  it('flags a scanner that was missing at baseline but is present now', () => {
    const drift = diffCoverage(missing, present);
    expect(drift).toEqual([{ tool: 'gitleaks', baselineAvailable: false, currentAvailable: true }]);
  });

  it('flags a scanner that was present at baseline but is missing now', () => {
    const drift = diffCoverage(present, missing);
    expect(drift).toEqual([{ tool: 'gitleaks', baselineAvailable: true, currentAvailable: false }]);
  });

  it('reports no drift when availability agrees', () => {
    expect(diffCoverage(present, present)).toEqual([]);
  });

  it('returns no drift when the baseline predates the coverage record', () => {
    expect(diffCoverage(undefined, present)).toEqual([]);
  });

  it('ignores tools not present in the baseline coverage set', () => {
    const baselineOnlyGit = coverageFromToolStatuses([status('gitleaks', 'path')]);
    const currentWithNew = coverageFromToolStatuses([
      status('gitleaks', 'path'),
      status('semgrep', 'missing'),
    ]);
    // semgrep wasn't in the baseline coverage, so it isn't drift.
    expect(diffCoverage(baselineOnlyGit, currentWithNew)).toEqual([]);
  });
});
