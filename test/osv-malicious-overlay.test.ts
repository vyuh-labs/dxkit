import { describe, it, expect } from 'vitest';
import { mergeMaliciousOsvFindings } from '../src/analyzers/tools/osv-scanner-deps';
import type { DepVulnFinding, DepVulnResult } from '../src/languages/capabilities/types';

/**
 * The malicious-overlay merge: osv-scanner's MAL-* feed (OpenSSF's
 * ecosystem-maintained malicious-packages database) joins a native
 * scanner's result, appending ONLY malicious findings not already
 * represented. Shapes mirror the July 2025 eslint-config-prettier
 * incident the overlay exists for.
 */
function finding(over: Partial<DepVulnFinding>): DepVulnFinding {
  return {
    id: 'GHSA-a',
    package: 'pkg',
    tool: 'npm-audit',
    severity: 'high',
    ...over,
  } as DepVulnFinding;
}

function envelope(
  findings: DepVulnFinding[],
  counts?: Partial<DepVulnResult['counts']>,
): DepVulnResult {
  return {
    schemaVersion: 1,
    tool: 'npm-audit',
    enrichment: null,
    counts: { critical: 0, high: 0, medium: 0, low: 0, ...counts },
    findings,
  };
}

describe('mergeMaliciousOsvFindings', () => {
  it('appends a MAL finding the native scanner cannot see, and bumps counts', () => {
    const base = envelope(
      [finding({ id: 'GHSA-f29h-pxvx-f335', package: 'eslint-config-prettier' })],
      { high: 1 },
    );
    const overlay = envelope([
      finding({
        id: 'MAL-2025-6022',
        package: 'eslint-config-prettier',
        tool: 'osv-scanner',
        severity: 'medium',
        summary: 'Malicious code in eslint-config-prettier (npm)',
      }),
    ]);
    const merged = mergeMaliciousOsvFindings(base, overlay);
    expect(merged.findings).toHaveLength(2);
    expect(merged.findings?.[1].id).toBe('MAL-2025-6022');
    expect(merged.counts).toEqual({ critical: 0, high: 1, medium: 1, low: 0 });
    // The native envelope stays the attribution base.
    expect(merged.tool).toBe('npm-audit');
  });

  it('never appends ordinary advisories (the native scanner is the richer source)', () => {
    const base = envelope([], {});
    const overlay = envelope([
      finding({ id: 'GHSA-ordinary', summary: 'Prototype pollution in pkg' }),
    ]);
    expect(mergeMaliciousOsvFindings(base, overlay)).toBe(base);
  });

  it('skips a malicious finding already represented by id or alias on the same package', () => {
    const base = envelope(
      [finding({ id: 'GHSA-f29h-pxvx-f335', package: 'p', aliases: ['MAL-2025-6022'] })],
      { high: 1 },
    );
    const overlay = envelope([
      finding({
        id: 'MAL-2025-6022',
        package: 'p',
        summary: 'Malicious code in p (npm)',
      }),
    ]);
    expect(mergeMaliciousOsvFindings(base, overlay)).toBe(base);
  });

  it('the same advisory on a DIFFERENT package is not deduped away', () => {
    const base = envelope(
      [finding({ id: 'MAL-2025-1', package: 'other', summary: 'Malicious code in other (npm)' })],
      { high: 1 },
    );
    const overlay = envelope([
      finding({ id: 'MAL-2025-1', package: 'target', summary: 'Malicious code in target (npm)' }),
    ]);
    expect(mergeMaliciousOsvFindings(base, overlay).findings).toHaveLength(2);
  });

  it('returns the base untouched for an empty overlay', () => {
    const base = envelope([finding({})], { high: 1 });
    expect(mergeMaliciousOsvFindings(base, envelope([]))).toBe(base);
  });
});
