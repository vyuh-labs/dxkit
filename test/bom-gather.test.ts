import { describe, it, expect } from 'vitest';
import {
  buildByTopLevelDep,
  compareSemver,
  deriveTier1Resolution,
  maxSemver,
} from '../src/analyzers/bom/gather';
import type { DepVulnFinding } from '../src/languages/capabilities/types';
import type { BomEntry } from '../src/analyzers/bom/types';

describe('compareSemver', () => {
  it('orders by major.minor.patch numerically', () => {
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('2.0.0', '1.99.99')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('strips a leading "v" (Go-pack convention)', () => {
    expect(compareSemver('v1.23.10', 'v1.23.9')).toBeGreaterThan(0);
    expect(compareSemver('v1.0.0', '1.0.0')).toBe(0);
  });

  it('treats missing components as zero', () => {
    expect(compareSemver('1.0', '1.0.0')).toBe(0);
    expect(compareSemver('1', '1.0.1')).toBeLessThan(0);
  });

  it('falls back to lexicographic for non-semver inputs', () => {
    // "0.10.55+echo.1" has a non-numeric suffix → falls back
    expect(compareSemver('0.10.55+echo.1', '0.10.55')).toBeGreaterThan(0);
  });
});

describe('maxSemver', () => {
  it('returns the highest version', () => {
    expect(maxSemver(['1.0.0', '2.5.1', '1.99.0'])).toBe('2.5.1');
  });

  it('handles a single-element array', () => {
    expect(maxSemver(['3.0.0'])).toBe('3.0.0');
  });

  it('returns empty string on empty input', () => {
    expect(maxSemver([])).toBe('');
  });
});

describe('deriveTier1Resolution', () => {
  function vuln(id: string, fixedVersion?: string): DepVulnFinding {
    return {
      id,
      package: 'p',
      tool: 'test',
      severity: 'high',
      ...(fixedVersion !== undefined ? { fixedVersion } : {}),
    };
  }

  it('returns empty string when there are no vulns', () => {
    expect(deriveTier1Resolution([])).toBe('');
  });

  it('proposes the max fixed version when every vuln has one', () => {
    const result = deriveTier1Resolution([
      vuln('CVE-1', '2.0.0'),
      vuln('CVE-2', '2.5.1'),
      vuln('CVE-3', '1.9.0'),
    ]);
    expect(result).toBe('PROPOSAL: Upgrade to 2.5.1 (resolves 3 vulns)');
  });

  it('uses singular "vuln" when there is exactly one', () => {
    expect(deriveTier1Resolution([vuln('CVE-X', '1.2.3')])).toBe(
      'PROPOSAL: Upgrade to 1.2.3 (resolves 1 vuln)',
    );
  });

  it('says "No fix available" when any vuln lacks fixedVersion', () => {
    const result = deriveTier1Resolution([vuln('CVE-1', '2.0.0'), vuln('CVE-2')]);
    expect(result).toBe('No fix available — evaluate replacement');
  });

  it('handles Go-style v-prefixed versions', () => {
    const result = deriveTier1Resolution([vuln('GO-1', 'v1.23.9'), vuln('GO-2', 'v1.23.12')]);
    expect(result).toBe('PROPOSAL: Upgrade to v1.23.12 (resolves 2 vulns)');
  });
});

describe('buildByTopLevelDep', () => {
  function entry(pkg: string, vulns: DepVulnFinding[]): BomEntry {
    return {
      package: pkg,
      version: '1.0.0',
      licenseType: 'MIT',
      vulns,
      maxSeverity: vulns.length > 0 ? vulns[0].severity : null,
      upgradeAdvice: '',
      joinedFromBoth: true,
    };
  }
  function vuln(
    id: string,
    pkg: string,
    severity: DepVulnFinding['severity'],
    topLevelDep?: string[],
  ): DepVulnFinding {
    return {
      id,
      package: pkg,
      tool: 'test',
      severity,
      ...(topLevelDep ? { topLevelDep } : {}),
    };
  }

  it('returns empty rollup when no vulns carry topLevelDep', () => {
    const result = buildByTopLevelDep([
      entry('tar', [vuln('CVE-1', 'tar', 'high')]), // no topLevelDep
    ]);
    expect(result).toEqual({});
  });

  it('accumulates advisories per top-level', () => {
    const result = buildByTopLevelDep([
      entry('tar', [vuln('CVE-1', 'tar', 'high', ['@loopback/cli'])]),
      entry('uuid', [vuln('CVE-2', 'uuid', 'critical', ['@loopback/cli'])]),
    ]);
    expect(result['@loopback/cli']).toEqual({
      advisoryCount: 2,
      maxSeverity: 'critical',
      packages: ['tar', 'uuid'],
    });
  });

  it('doubly-counts advisories reachable from multiple top-levels', () => {
    const result = buildByTopLevelDep([
      entry('lodash', [vuln('CVE-1', 'lodash', 'medium', ['@loopback/cli', 'eslint'])]),
    ]);
    expect(result['@loopback/cli'].advisoryCount).toBe(1);
    expect(result['eslint'].advisoryCount).toBe(1);
  });

  it('tracks max severity per top-level correctly', () => {
    // Same top-level with mixed-severity advisories — max should win.
    const result = buildByTopLevelDep([
      entry('a', [vuln('X1', 'a', 'low', ['top'])]),
      entry('b', [vuln('X2', 'b', 'critical', ['top'])]),
      entry('c', [vuln('X3', 'c', 'high', ['top'])]),
    ]);
    expect(result['top'].maxSeverity).toBe('critical');
    expect(result['top'].advisoryCount).toBe(3);
    expect(result['top'].packages).toEqual(['a', 'b', 'c']);
  });

  it('dedupes package names per top-level', () => {
    // Two advisories on the same package under the same top-level
    // should count as 2 advisories but 1 package.
    const result = buildByTopLevelDep([
      entry('tar', [
        vuln('CVE-1', 'tar', 'high', ['@loopback/cli']),
        vuln('CVE-2', 'tar', 'high', ['@loopback/cli']),
      ]),
    ]);
    expect(result['@loopback/cli'].advisoryCount).toBe(2);
    expect(result['@loopback/cli'].packages).toEqual(['tar']);
  });
});
