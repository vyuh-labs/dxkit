import { describe, it, expect } from 'vitest';
import { computeRiskScore, riskTier, scoreFindings } from '../src/analyzers/tools/risk-score';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

describe('computeRiskScore', () => {
  it('returns null when CVSS is missing', () => {
    expect(computeRiskScore({})).toBeNull();
    expect(computeRiskScore({ epssScore: 0.5, kev: true })).toBeNull();
  });

  it('multiplies CVSS by 10 when no modifiers apply and reachable is unknown', () => {
    // base=98, kevMul=1, epssMul=1, reachMul=0.7 → 98 * 1 * 1 * 0.7 ≈ 68.6
    expect(computeRiskScore({ cvssScore: 9.8 })).toBe(68.6);
  });

  it('caps at 100 for high-risk combos', () => {
    // base=98, kev=2, epss→1+2*0.8=2.6, reach=1.0 → 509.6 → clamped
    expect(computeRiskScore({ cvssScore: 9.8, kev: true, epssScore: 0.8, reachable: true })).toBe(
      100,
    );
  });

  it('discounts heavily when definitely not reachable', () => {
    // base=98, kev=1, epss=1.02, reach=0.25 → 24.99 → 25.0
    expect(computeRiskScore({ cvssScore: 9.8, reachable: false, epssScore: 0.01 })).toBeCloseTo(
      25.0,
      1,
    );
  });

  it('doubles the score under KEV alone', () => {
    const plain = computeRiskScore({ cvssScore: 5.0, reachable: true });
    const kev = computeRiskScore({ cvssScore: 5.0, reachable: true, kev: true });
    expect(plain).toBe(50);
    expect(kev).toBe(100); // 50 * 2 = 100
  });

  it('rounds to one decimal', () => {
    const s = computeRiskScore({ cvssScore: 3.33, reachable: true });
    expect(s).toBe(33.3);
  });
});

describe('riskTier', () => {
  it('maps score ranges to tiers', () => {
    expect(riskTier(null)).toBe('none');
    expect(riskTier(0)).toBe('low');
    expect(riskTier(14.9)).toBe('low');
    expect(riskTier(15)).toBe('moderate');
    expect(riskTier(39.9)).toBe('moderate');
    expect(riskTier(40)).toBe('high');
    expect(riskTier(69.9)).toBe('high');
    expect(riskTier(70)).toBe('critical');
    expect(riskTier(100)).toBe('critical');
  });
});

describe('scoreFindings', () => {
  function finding(cvss?: number, kev?: boolean, reachable?: boolean): DepVulnFinding {
    return {
      id: 'CVE-X',
      package: 'p',
      tool: 't',
      severity: 'high',
      cvssScore: cvss,
      kev,
      reachable,
    };
  }

  it('writes riskScore in place for findings with CVSS', () => {
    const fs: DepVulnFinding[] = [finding(9.8, true, true), finding(2.0, false, false)];
    scoreFindings(fs);
    expect(fs[0].riskScore).toBe(100);
    expect(fs[1].riskScore).toBeCloseTo(5.0, 1);
  });

  it('leaves riskScore unset when CVSS is missing', () => {
    const fs: DepVulnFinding[] = [finding()];
    scoreFindings(fs);
    expect(fs[0].riskScore).toBeUndefined();
  });
});
