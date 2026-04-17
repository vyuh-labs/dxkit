import { describe, it, expect } from 'vitest';
import { defaultMetrics, mergeMetrics } from '../src/analyzers/health';

describe('mergeMetrics', () => {
  it('aggregates dep-vuln counts across language packs', () => {
    const base = defaultMetrics();
    // TS pack (npm-audit) reports first
    mergeMetrics(base, {
      depVulnCritical: 2,
      depVulnHigh: 29,
      depVulnMedium: 22,
      depVulnLow: 16,
      depAuditTool: 'npm-audit',
      toolsUsed: ['npm-audit'],
    });
    // Python pack (pip-audit + OSV) reports second — pre-fix this would clobber the above
    mergeMetrics(base, {
      depVulnCritical: 0,
      depVulnHigh: 0,
      depVulnMedium: 3,
      depVulnLow: 1,
      depAuditTool: 'pip-audit',
      toolsUsed: ['pip-audit', 'osv.dev'],
    });
    expect(base.depVulnCritical).toBe(2);
    expect(base.depVulnHigh).toBe(29);
    expect(base.depVulnMedium).toBe(25); // 22 + 3
    expect(base.depVulnLow).toBe(17); // 16 + 1
  });

  it('joins depAuditTool names for mixed-stack repos', () => {
    const base = defaultMetrics();
    mergeMetrics(base, { depAuditTool: 'npm-audit' });
    mergeMetrics(base, { depAuditTool: 'pip-audit' });
    expect(base.depAuditTool).toBe('npm-audit, pip-audit');
  });

  it('keeps scalar non-vuln fields as last-wins (existing behavior)', () => {
    const base = defaultMetrics();
    mergeMetrics(base, { lintErrors: 5, lintTool: 'ruff' });
    mergeMetrics(base, { lintErrors: 2, lintTool: 'eslint' });
    // lint fields are NOT in the aggregation list — last pack wins
    expect(base.lintErrors).toBe(2);
    expect(base.lintTool).toBe('eslint');
  });

  it('appends toolsUsed and toolsUnavailable from every pack', () => {
    const base = defaultMetrics();
    mergeMetrics(base, { toolsUsed: ['npm-audit'], toolsUnavailable: ['eslint'] });
    mergeMetrics(base, { toolsUsed: ['pip-audit', 'osv.dev'], toolsUnavailable: ['ruff'] });
    expect(base.toolsUsed).toEqual(['npm-audit', 'pip-audit', 'osv.dev']);
    expect(base.toolsUnavailable).toEqual(['eslint', 'ruff']);
  });

  it('ignores undefined and null overlay values', () => {
    const base = defaultMetrics();
    base.lintErrors = 10;
    mergeMetrics(base, { lintErrors: undefined, depVulnCritical: undefined });
    mergeMetrics(base, { lintTool: null });
    expect(base.lintErrors).toBe(10);
    expect(base.depVulnCritical).toBe(0);
    expect(base.lintTool).toBeNull();
  });

  it('starts vuln counts from 0 when base has no prior value', () => {
    const base = defaultMetrics();
    mergeMetrics(base, { depVulnCritical: 5 });
    expect(base.depVulnCritical).toBe(5);
  });
});
