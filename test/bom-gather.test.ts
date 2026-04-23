import { describe, it, expect } from 'vitest';
import { compareSemver, deriveTier1Resolution, maxSemver } from '../src/analyzers/bom/gather';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

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
