import { describe, it, expect } from 'vitest';
import { isMaliciousAdvisory } from '../src/analyzers/security/malicious';

/**
 * The canonical malicious-advisory predicate, pinned against the REAL feed
 * shapes captured from the July 2025 eslint-config-prettier compromise
 * (CVE-2025-54313) — the incident whose silent pass through security-only
 * motivated the `newMaliciousDependency` rule. Each positive row is a
 * verbatim shape one of the scanners actually emitted.
 */
describe('isMaliciousAdvisory', () => {
  it('flags the OSV malicious-package namespace by id (osv-scanner feed)', () => {
    expect(
      isMaliciousAdvisory({
        id: 'MAL-2025-6022',
        summary: 'Malicious code in eslint-config-prettier (npm)',
      }),
    ).toBe(true);
  });

  it('flags a MAL alias even when the primary id is a GHSA', () => {
    expect(isMaliciousAdvisory({ id: 'GHSA-xxxx-yyyy-zzzz', aliases: ['MAL-2025-1'] })).toBe(true);
  });

  it('flags the CWE-506 malicious-code family (npm-audit feed)', () => {
    expect(
      isMaliciousAdvisory({
        id: 'GHSA-f29h-pxvx-f335',
        cwes: ['CWE-506'],
        summary:
          'eslint-config-prettier, eslint-plugin-prettier, synckit, @pkgr/core, napi-postinstall have embedded malicious code',
      }),
    ).toBe(true);
    expect(isMaliciousAdvisory({ id: 'GHSA-a', cwes: ['cwe-507'] })).toBe(true);
    // The whole 506–512 family, complete by construction (the first draft
    // of the predicate hand-picked members and missed 508/509).
    for (const n of [506, 507, 508, 509, 510, 511, 512]) {
      expect(isMaliciousAdvisory({ id: 'GHSA-x', cwes: [`CWE-${n}`] })).toBe(true);
    }
    // Range boundaries: neighbors are NOT malicious-code CWEs.
    expect(isMaliciousAdvisory({ id: 'GHSA-y', cwes: ['CWE-505'] })).toBe(false);
    expect(isMaliciousAdvisory({ id: 'GHSA-z', cwes: ['CWE-513'] })).toBe(false);
  });

  it('flags the malware title conventions without CWE or MAL id', () => {
    // GitHub's convention.
    expect(
      isMaliciousAdvisory({
        id: 'GHSA-b',
        summary: 'some-pkg versions have embedded malicious code',
      }),
    ).toBe(true);
    // OSV's convention.
    expect(isMaliciousAdvisory({ id: 'GHSA-c', summary: 'Malicious code in left-pad (npm)' })).toBe(
      true,
    );
    expect(
      isMaliciousAdvisory({ id: 'GHSA-d', summary: 'Malicious versions of foo published' }),
    ).toBe(true);
  });

  it('does NOT flag ordinary vulnerabilities, including ones that mention malicious input', () => {
    expect(
      isMaliciousAdvisory({
        id: 'GHSA-e',
        cwes: ['CWE-79'],
        summary: 'foo fails to sanitize malicious input, allowing XSS',
      }),
    ).toBe(false);
    expect(
      isMaliciousAdvisory({
        id: 'CVE-2024-12345',
        summary: 'Prototype pollution in bar',
      }),
    ).toBe(false);
    expect(isMaliciousAdvisory({ id: 'RUSTSEC-2024-0001' })).toBe(false);
    // "MALFORMED" must not match the MAL- namespace.
    expect(isMaliciousAdvisory({ id: 'MALFORMED-2024-1' })).toBe(false);
  });
});
