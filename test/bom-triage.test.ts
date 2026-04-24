import { describe, it, expect } from 'vitest';
import { buildTriageRows } from '../src/analyzers/bom';
import type { BomReport, BomEntry } from '../src/analyzers/bom/types';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

function mkReport(entries: BomEntry[]): BomReport {
  return {
    repo: 'test',
    analyzedAt: '2026-04-24T00:00:00.000Z',
    commitSha: 'abcdef',
    branch: 'main',
    schemaVersion: '1',
    summary: {
      totalPackages: entries.length,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      vulnerablePackages: 0,
      actionableVulns: 0,
      totalAdvisories: 0,
      vulnOnlyPackages: 0,
      byTopLevelDep: {},
      filter: 'all',
      unfilteredTotalPackages: entries.length,
      projectRoots: ['.'],
      fingerprints: [],
    },
    entries,
    toolsUsed: [],
    toolsUnavailable: [],
  };
}

function mkEntry(pkg: string, version: string, vulns: DepVulnFinding[]): BomEntry {
  return {
    package: pkg,
    version,
    licenseType: 'MIT',
    vulns,
    maxSeverity: vulns.length > 0 ? vulns[0].severity : null,
    upgradeAdvice: 'PROPOSAL: Upgrade',
    joinedFromBoth: true,
  };
}

function vuln(
  id: string,
  pkg: string,
  risk: number,
  extras: Partial<DepVulnFinding> = {},
): DepVulnFinding {
  return {
    id,
    package: pkg,
    tool: 't',
    severity: 'high',
    riskScore: risk,
    ...extras,
  };
}

describe('buildTriageRows', () => {
  it('sorts by riskScore desc', () => {
    const rows = buildTriageRows(
      mkReport([
        mkEntry('a', '1.0.0', [vuln('CVE-LOW', 'a', 20)]),
        mkEntry('b', '1.0.0', [vuln('CVE-HIGH', 'b', 90)]),
      ]),
      10,
      15,
    );
    expect(rows.map((r) => r.id)).toEqual(['CVE-HIGH', 'CVE-LOW']);
  });

  it('filters findings below minRisk', () => {
    const rows = buildTriageRows(
      mkReport([
        mkEntry('a', '1.0.0', [vuln('LOW', 'a', 10)]),
        mkEntry('b', '1.0.0', [vuln('HIGH', 'b', 50)]),
      ]),
      10,
      15,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('HIGH');
  });

  it('skips findings without riskScore', () => {
    const rows = buildTriageRows(
      mkReport([
        mkEntry('a', '1.0.0', [vuln('RATED', 'a', 70)]),
        mkEntry('b', '1.0.0', [{ id: 'UNRATED', package: 'b', tool: 't', severity: 'critical' }]),
      ]),
      10,
      15,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('RATED');
  });

  it('respects the limit', () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      mkEntry(`pkg${i}`, '1.0.0', [vuln(`CVE-${i}`, `pkg${i}`, 50 + i)]),
    );
    const rows = buildTriageRows(mkReport(entries), 3, 15);
    expect(rows).toHaveLength(3);
  });

  it('builds rationale from signals (KEV → reachable → CVSS → EPSS)', () => {
    const rows = buildTriageRows(
      mkReport([
        mkEntry('a', '1.0.0', [
          vuln('ALL', 'a', 90, {
            kev: true,
            reachable: true,
            cvssScore: 9.8,
            epssScore: 0.12,
          }),
        ]),
      ]),
      10,
      15,
    );
    expect(rows[0].rationale).toBe('KEV, reachable, CVSS 9.8, EPSS 12.0%');
  });

  it('omits EPSS below 1% as noise', () => {
    const rows = buildTriageRows(
      mkReport([
        mkEntry('a', '1.0.0', [vuln('X', 'a', 50, { cvssScore: 5.0, epssScore: 0.0001 })]),
      ]),
      10,
      15,
    );
    expect(rows[0].rationale).toBe('CVSS 5.0');
  });

  it('strips PROPOSAL: prefix from fix column', () => {
    const rows = buildTriageRows(
      mkReport([
        mkEntry('a', '1.0.0', [
          vuln('X', 'a', 50, {
            upgradeAdvice: 'PROPOSAL: Upgrade to 1.7.0 (resolves 1 vuln)',
          }),
        ]),
      ]),
      10,
      15,
    );
    expect(rows[0].fix).toBe('Upgrade to 1.7.0 (resolves 1 vuln)');
  });

  it('returns empty list when nothing crosses threshold', () => {
    const rows = buildTriageRows(mkReport([mkEntry('a', '1.0.0', [vuln('LOW', 'a', 5)])]), 10, 15);
    expect(rows).toHaveLength(0);
  });
});
