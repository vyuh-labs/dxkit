import { describe, it, expect } from 'vitest';
import {
  checkFailOnScore,
  checkFailOnSeverity,
  parseScoreThreshold,
  parseSeverityTier,
  SEVERITY_RANK,
} from '../src/fail-on';

describe('checkFailOnScore', () => {
  it('passes when the score meets the threshold exactly', () => {
    expect(checkFailOnScore(70, 70)).toEqual({ fails: false });
  });

  it('passes when the score is above the threshold', () => {
    expect(checkFailOnScore(85, 70)).toEqual({ fails: false });
  });

  it('fails when the score is below the threshold', () => {
    const v = checkFailOnScore(60, 70);
    expect(v.fails).toBe(true);
    expect(v.reason).toContain('60');
    expect(v.reason).toContain('70');
  });

  it('throws on non-finite score', () => {
    expect(() => checkFailOnScore(NaN, 70)).toThrow(/score is not a finite/);
    expect(() => checkFailOnScore(Infinity, 70)).toThrow(/score is not a finite/);
  });

  it('throws on non-finite threshold', () => {
    expect(() => checkFailOnScore(80, NaN)).toThrow(/threshold is not a finite/);
  });

  it('treats threshold 0 as always-passing for non-negative scores', () => {
    expect(checkFailOnScore(0, 0)).toEqual({ fails: false });
    expect(checkFailOnScore(50, 0)).toEqual({ fails: false });
  });
});

describe('checkFailOnSeverity', () => {
  const empty = { critical: 0, high: 0, medium: 0, low: 0 };

  it('passes when no findings of any severity', () => {
    expect(checkFailOnSeverity(empty, 'critical')).toEqual({ fails: false });
    expect(checkFailOnSeverity(empty, 'low')).toEqual({ fails: false });
  });

  it('passes when findings are below the tier', () => {
    const counts = { critical: 0, high: 0, medium: 5, low: 10 };
    expect(checkFailOnSeverity(counts, 'high')).toEqual({ fails: false });
    expect(checkFailOnSeverity(counts, 'critical')).toEqual({ fails: false });
  });

  it('fails when findings exist at the gate tier', () => {
    const counts = { critical: 0, high: 2, medium: 0, low: 0 };
    const v = checkFailOnSeverity(counts, 'high');
    expect(v.fails).toBe(true);
    expect(v.reason).toContain('2 high');
  });

  it('fails when findings exist above the gate tier (escalation)', () => {
    const counts = { critical: 1, high: 0, medium: 0, low: 0 };
    const v = checkFailOnSeverity(counts, 'high');
    expect(v.fails).toBe(true);
    expect(v.reason).toContain('1 critical');
  });

  it('reports every contributing tier in the reason', () => {
    const counts = { critical: 1, high: 2, medium: 4, low: 7 };
    const v = checkFailOnSeverity(counts, 'medium');
    expect(v.fails).toBe(true);
    expect(v.reason).toContain('1 critical');
    expect(v.reason).toContain('2 high');
    expect(v.reason).toContain('4 medium');
    expect(v.reason).not.toContain('low');
  });

  it('throws on unknown tier', () => {
    expect(() => checkFailOnSeverity(empty, 'severe' as unknown as 'critical')).toThrow(
      /unknown tier/,
    );
  });

  it('SEVERITY_RANK orders the tiers correctly', () => {
    expect(SEVERITY_RANK.critical).toBeGreaterThan(SEVERITY_RANK.high);
    expect(SEVERITY_RANK.high).toBeGreaterThan(SEVERITY_RANK.medium);
    expect(SEVERITY_RANK.medium).toBeGreaterThan(SEVERITY_RANK.low);
  });
});

describe('parseSeverityTier', () => {
  it('accepts every canonical tier', () => {
    expect(parseSeverityTier('critical')).toBe('critical');
    expect(parseSeverityTier('high')).toBe('high');
    expect(parseSeverityTier('medium')).toBe('medium');
    expect(parseSeverityTier('low')).toBe('low');
  });

  it('rejects non-canonical strings', () => {
    expect(parseSeverityTier('CRITICAL')).toBeNull();
    expect(parseSeverityTier('severe')).toBeNull();
    expect(parseSeverityTier('')).toBeNull();
    expect(parseSeverityTier('high ')).toBeNull();
  });
});

describe('parseScoreThreshold', () => {
  it('accepts in-range integers', () => {
    expect(parseScoreThreshold('0')).toBe(0);
    expect(parseScoreThreshold('70')).toBe(70);
    expect(parseScoreThreshold('100')).toBe(100);
  });

  it('accepts in-range floats', () => {
    expect(parseScoreThreshold('72.5')).toBe(72.5);
  });

  it('rejects out-of-range values', () => {
    expect(parseScoreThreshold('-1')).toBeNull();
    expect(parseScoreThreshold('101')).toBeNull();
  });

  it('rejects non-numeric values', () => {
    expect(parseScoreThreshold('abc')).toBeNull();
    expect(parseScoreThreshold('')).toBeNull();
    expect(parseScoreThreshold(undefined)).toBeNull();
    expect(parseScoreThreshold('NaN')).toBeNull();
  });
});
