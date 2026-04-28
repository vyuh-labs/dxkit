import { describe, it, expect } from 'vitest';
import {
  collectFingerprints,
  computeFingerprint,
  stampFingerprints,
} from '../src/analyzers/tools/fingerprint';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

/** Minimal DepVulnFinding builder for tests — identity + severity only. */
function mkFinding(
  overrides: Partial<DepVulnFinding> & Pick<DepVulnFinding, 'id' | 'package'>,
): DepVulnFinding {
  // id + package are required in overrides per Pick<>; defaults apply
  // only to the rest. Spread last so overrides win.
  return {
    installedVersion: '1.0.0',
    tool: 'npm-audit',
    severity: 'high',
    ...overrides,
  };
}

describe('computeFingerprint', () => {
  it('is deterministic for identical (package, installedVersion, id) triples', () => {
    const a = computeFingerprint({ package: 'axios', installedVersion: '0.18.0', id: 'GHSA-xxx' });
    const b = computeFingerprint({ package: 'axios', installedVersion: '0.18.0', id: 'GHSA-xxx' });
    expect(a).toBe(b);
  });

  it('returns a 16-char lowercase hex string', () => {
    const fp = computeFingerprint({
      package: 'lodash',
      installedVersion: '4.17.0',
      id: 'CVE-2020-8203',
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs when package differs', () => {
    const a = computeFingerprint({ package: 'axios', installedVersion: '1.0.0', id: 'CVE-2024-1' });
    const b = computeFingerprint({
      package: 'lodash',
      installedVersion: '1.0.0',
      id: 'CVE-2024-1',
    });
    expect(a).not.toBe(b);
  });

  it('differs when version differs', () => {
    const a = computeFingerprint({
      package: 'axios',
      installedVersion: '0.18.0',
      id: 'CVE-2024-1',
    });
    const b = computeFingerprint({
      package: 'axios',
      installedVersion: '0.19.0',
      id: 'CVE-2024-1',
    });
    expect(a).not.toBe(b);
  });

  it('differs when id differs', () => {
    const a = computeFingerprint({
      package: 'axios',
      installedVersion: '0.18.0',
      id: 'CVE-2024-1',
    });
    const b = computeFingerprint({
      package: 'axios',
      installedVersion: '0.18.0',
      id: 'CVE-2024-2',
    });
    expect(a).not.toBe(b);
  });

  it('treats missing installedVersion as empty string, not undefined string literal', () => {
    const missing = computeFingerprint({ package: 'pkg', id: 'CVE-x' });
    const explicitUndef = computeFingerprint({
      package: 'pkg',
      installedVersion: undefined,
      id: 'CVE-x',
    });
    const emptyStr = computeFingerprint({ package: 'pkg', installedVersion: '', id: 'CVE-x' });
    // All three must agree — version-less findings hash the same way.
    expect(missing).toBe(emptyStr);
    expect(explicitUndef).toBe(emptyStr);
    // And the fingerprint must not leak the literal 'undefined' string.
    const literalUndef = computeFingerprint({
      package: 'pkg',
      installedVersion: 'undefined',
      id: 'CVE-x',
    });
    expect(literalUndef).not.toBe(missing);
  });

  it('does not collide when NUL-separating would matter (ab|c vs a|bc)', () => {
    // Without the NUL separator, package='ab' + version='c' would produce
    // the same input stream as package='a' + version='bc'. The separator
    // defends against that.
    const a = computeFingerprint({ package: 'ab', installedVersion: 'c', id: 'x' });
    const b = computeFingerprint({ package: 'a', installedVersion: 'bc', id: 'x' });
    expect(a).not.toBe(b);
  });

  it('ignores severity / enrichment / producer tool fields', () => {
    // Two findings with identical identity but different signals must
    // produce the same fingerprint — re-scoring an advisory can't mint
    // a new identity.
    const base = computeFingerprint({ package: 'p', installedVersion: '1', id: 'i' });
    const withSeverity = computeFingerprint(
      mkFinding({ package: 'p', installedVersion: '1', id: 'i', severity: 'critical' }),
    );
    const withEnrichment = computeFingerprint(
      mkFinding({
        package: 'p',
        installedVersion: '1',
        id: 'i',
        epssScore: 0.9,
        kev: true,
        reachable: true,
        riskScore: 95,
      }),
    );
    const withDifferentTool = computeFingerprint(
      mkFinding({ package: 'p', installedVersion: '1', id: 'i', tool: 'snyk' }),
    );
    expect(withSeverity).toBe(base);
    expect(withEnrichment).toBe(base);
    expect(withDifferentTool).toBe(base);
  });
});

describe('stampFingerprints', () => {
  it('stamps every finding in place with its computed fingerprint', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'CVE-a', package: 'p1' }),
      mkFinding({ id: 'CVE-b', package: 'p2' }),
    ];
    stampFingerprints(findings);
    expect(findings[0].fingerprint).toBe(
      computeFingerprint({ package: 'p1', installedVersion: '1.0.0', id: 'CVE-a' }),
    );
    expect(findings[1].fingerprint).toBe(
      computeFingerprint({ package: 'p2', installedVersion: '1.0.0', id: 'CVE-b' }),
    );
  });

  it('is idempotent', () => {
    const findings: DepVulnFinding[] = [mkFinding({ id: 'CVE-1', package: 'axios' })];
    stampFingerprints(findings);
    const first = findings[0].fingerprint;
    stampFingerprints(findings);
    expect(findings[0].fingerprint).toBe(first);
  });

  it('handles an empty list without throwing', () => {
    expect(() => stampFingerprints([])).not.toThrow();
  });
});

describe('collectFingerprints', () => {
  it('returns sorted, deduplicated fingerprints', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'CVE-a', package: 'p1' }),
      mkFinding({ id: 'CVE-b', package: 'p2' }),
      mkFinding({ id: 'CVE-a', package: 'p1' }), // exact duplicate
    ];
    stampFingerprints(findings);
    const list = collectFingerprints(findings);
    expect(list).toHaveLength(2);
    expect([...list]).toEqual([...list].sort());
  });

  it('skips findings missing a fingerprint rather than throwing', () => {
    const findings: DepVulnFinding[] = [
      mkFinding({ id: 'CVE-a', package: 'p1' }),
      mkFinding({ id: 'CVE-b', package: 'p2' }),
    ];
    // Only stamp the first one.
    findings[0].fingerprint = computeFingerprint(findings[0]);
    const list = collectFingerprints(findings);
    expect(list).toEqual([findings[0].fingerprint]);
  });
});
