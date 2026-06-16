import { describe, it, expect } from 'vitest';
import {
  canonicalAdvisoryId,
  codeContentAnchor,
  codeContentAnchorFromHash,
  collectFingerprints,
  computeContentFingerprint,
  computeFingerprint,
  computeSecretHmac,
  normalizeSpan,
  spanHash,
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

describe('canonicalAdvisoryId', () => {
  it('prefers a GHSA id over the producer id', () => {
    expect(canonicalAdvisoryId({ id: 'CVE-2024-1', aliases: ['GHSA-aa-bb-cc'] })).toBe(
      'ghsa-aa-bb-cc',
    );
  });

  it('prefers CVE when no GHSA is present', () => {
    expect(canonicalAdvisoryId({ id: 'OSV-2024-9', aliases: ['CVE-2024-7'] })).toBe('cve-2024-7');
  });

  it('falls back to the producer id when no GHSA / CVE alias exists', () => {
    expect(canonicalAdvisoryId({ id: 'RUSTSEC-2024-1' })).toBe('rustsec-2024-1');
  });

  it('lowercases so case differences do not fork identity', () => {
    expect(canonicalAdvisoryId({ id: 'GHSA-AB-CD-EF' })).toBe(
      canonicalAdvisoryId({ id: 'ghsa-ab-cd-ef' }),
    );
  });
});

describe('computeFingerprint', () => {
  it('is deterministic for identical (package, id) pairs', () => {
    const a = computeFingerprint({ package: 'axios', id: 'GHSA-xxx' });
    const b = computeFingerprint({ package: 'axios', id: 'GHSA-xxx' });
    expect(a).toBe(b);
  });

  it('returns a 16-char lowercase hex string', () => {
    const fp = computeFingerprint({ package: 'lodash', id: 'CVE-2020-8203' });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs when package differs', () => {
    const a = computeFingerprint({ package: 'axios', id: 'CVE-2024-1' });
    const b = computeFingerprint({ package: 'lodash', id: 'CVE-2024-1' });
    expect(a).not.toBe(b);
  });

  it('is INDEPENDENT of installedVersion (the whole point of the fix)', () => {
    // The same advisory must hash identically whether or not the scanner
    // could resolve the installed version. npm-audit (node_modules) reports
    // it; a lockfile-only scanner (osv-scanner, or a bare git worktree)
    // omits it. Including version forked the same finding into two
    // identities depending on the scan environment.
    const withVersion = computeFingerprint(
      mkFinding({ package: 'axios', id: 'GHSA-1', installedVersion: '0.18.0' }),
    );
    const otherVersion = computeFingerprint(
      mkFinding({ package: 'axios', id: 'GHSA-1', installedVersion: '0.19.0' }),
    );
    const noVersion = computeFingerprint({ package: 'axios', id: 'GHSA-1' });
    expect(withVersion).toBe(noVersion);
    expect(otherVersion).toBe(noVersion);
  });

  it('differs when id differs', () => {
    const a = computeFingerprint({ package: 'axios', id: 'CVE-2024-1' });
    const b = computeFingerprint({ package: 'axios', id: 'CVE-2024-2' });
    expect(a).not.toBe(b);
  });

  it('is identical whether the GHSA arrives as the id or as an alias', () => {
    // The cross-tool stabilizer: npm-audit primaries the GHSA; osv-scanner
    // may primary an OSV/CVE id with the GHSA in aliases. Same advisory →
    // same fingerprint either way.
    const asId = computeFingerprint({ package: 'p', id: 'GHSA-zz' });
    const asAlias = computeFingerprint({ package: 'p', id: 'OSV-1', aliases: ['GHSA-zz'] });
    expect(asAlias).toBe(asId);
  });

  it('does not collide when NUL-separating would matter (ab|c vs a|bc)', () => {
    // Without the NUL separator, package='ab' + id='c' would produce the
    // same input stream as package='a' + id='bc'. The separator defends
    // against that.
    const a = computeFingerprint({ package: 'ab', id: 'c' });
    const b = computeFingerprint({ package: 'a', id: 'bc' });
    expect(a).not.toBe(b);
  });

  it('ignores severity / enrichment / producer tool fields', () => {
    // Two findings with identical identity but different signals must
    // produce the same fingerprint — re-scoring an advisory can't mint
    // a new identity.
    const base = computeFingerprint({ package: 'p', id: 'i' });
    const withSeverity = computeFingerprint(
      mkFinding({ package: 'p', id: 'i', severity: 'critical' }),
    );
    const withEnrichment = computeFingerprint(
      mkFinding({
        package: 'p',
        id: 'i',
        epssScore: 0.9,
        kev: true,
        reachable: true,
        riskScore: 95,
      }),
    );
    const withDifferentTool = computeFingerprint(
      mkFinding({ package: 'p', id: 'i', tool: 'snyk' }),
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
    expect(findings[0].fingerprint).toBe(computeFingerprint({ package: 'p1', id: 'CVE-a' }));
    expect(findings[1].fingerprint).toBe(computeFingerprint({ package: 'p2', id: 'CVE-b' }));
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

describe('computeSecretHmac', () => {
  it('produces a 16-char lowercase hex string', () => {
    const hmac = computeSecretHmac('AKIAEXAMPLEABCDEF123', 'salt-value');
    expect(hmac).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for identical (secret, salt) pairs', () => {
    const a = computeSecretHmac('hunter2', 'fixed-salt');
    const b = computeSecretHmac('hunter2', 'fixed-salt');
    expect(a).toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = computeSecretHmac('hunter2', 'fixed-salt');
    const b = computeSecretHmac('hunter3', 'fixed-salt');
    expect(a).not.toBe(b);
  });

  it('changes when the salt changes', () => {
    // This is the property that makes per-repo isolation work — same
    // secret in two different repos produces two different HMACs.
    const a = computeSecretHmac('hunter2', 'salt-repo-a');
    const b = computeSecretHmac('hunter2', 'salt-repo-b');
    expect(a).not.toBe(b);
  });

  it('handles unicode and binary-ish secret inputs', () => {
    // Secrets sometimes contain weird bytes (raw tokens, multi-line
    // PEMs, etc.). The HMAC primitive must not blow up on them.
    const tricky = '\u0000秘密\nline2\t\r';
    const hmac = computeSecretHmac(tricky, 'salt');
    expect(hmac).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does not leak the secret in the HMAC (one-way property)', () => {
    // We can't *prove* one-way-ness in a unit test, but we can assert
    // a basic structural property: the hex output bytes don't contain
    // the secret as a substring.
    const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const hmac = computeSecretHmac(secret, 'salt');
    expect(hmac.includes(secret)).toBe(false);
    expect(secret.includes(hmac)).toBe(false);
  });
});

describe('content-anchored identity', () => {
  describe('normalizeSpan', () => {
    it('collapses whitespace runs and trims so reformatting is invariant', () => {
      expect(normalizeSpan(' rejectUnauthorized: false ')).toBe('rejectUnauthorized: false');
      expect(normalizeSpan('a\t\tb\n c')).toBe('a b c');
    });
    it('reindentation does not change the normalized form', () => {
      expect(normalizeSpan(' eval(x)')).toBe(normalizeSpan('\teval(x)'));
    });
  });

  describe('spanHash', () => {
    it('is stable across cosmetic reformatting', () => {
      expect(spanHash('rejectUnauthorized: false')).toBe(spanHash(' rejectUnauthorized: false'));
    });
    it('differs when the construct actually changes', () => {
      expect(spanHash('eval(a)')).not.toBe(spanHash('eval(b)'));
    });
    it('returns 16-char lowercase hex', () => {
      expect(spanHash('x')).toMatch(/^[0-9a-f]{16}$/);
    });
  });

  describe('codeContentAnchor', () => {
    it('distinguishes ordinals within the same scope + span', () => {
      expect(codeContentAnchor('fn', 'eval(x)', 0)).not.toBe(codeContentAnchor('fn', 'eval(x)', 1));
    });
    it('distinguishes scope (B): same construct in different symbols', () => {
      expect(codeContentAnchor('foo', 'eval(x)', 0)).not.toBe(
        codeContentAnchor('bar', 'eval(x)', 0),
      );
    });
    it('file-level fallback (A) uses empty scope', () => {
      expect(codeContentAnchor('', 'eval(x)', 0)).not.toBe(codeContentAnchor('fn', 'eval(x)', 0));
    });
  });

  describe('codeContentAnchorFromHash', () => {
    it('equals codeContentAnchor when fed spanHash(span)', () => {
      // The gather boundary carries only spanHash downstream (never raw
      // matched text); the aggregator rebuilds the anchor from it. The two
      // construction paths MUST agree or gather-side and direct identities
      // would diverge.
      const span = 'rejectUnauthorized: false';
      expect(codeContentAnchorFromHash('validateLogin', spanHash(span), 2)).toBe(
        codeContentAnchor('validateLogin', span, 2),
      );
    });
    it('distinguishes scope, spanHash, and ordinal', () => {
      const h = spanHash('eval(x)');
      expect(codeContentAnchorFromHash('a', h, 0)).not.toBe(codeContentAnchorFromHash('b', h, 0));
      expect(codeContentAnchorFromHash('a', h, 0)).not.toBe(codeContentAnchorFromHash('a', h, 1));
      expect(codeContentAnchorFromHash('a', h, 0)).not.toBe(
        codeContentAnchorFromHash('a', spanHash('eval(y)'), 0),
      );
    });
  });

  describe('computeContentFingerprint', () => {
    it('is line-independent: identity does not encode a line at all', () => {
      // The whole point — a finding that moves keeps its identity because
      // the anchor (scope/span/ordinal or HMAC) carries no line.
      const anchor = codeContentAnchor('validateLogin', 'rejectUnauthorized: false', 0);
      const atTop = computeContentFingerprint('canonical:tls-bypass', 'a.ts', anchor);
      const atBottom = computeContentFingerprint('canonical:tls-bypass', 'a.ts', anchor);
      expect(atTop).toBe(atBottom);
    });
    it('differs by rule, file, and anchor', () => {
      const a = computeContentFingerprint('r1', 'a.ts', 'x');
      expect(a).not.toBe(computeContentFingerprint('r2', 'a.ts', 'x'));
      expect(a).not.toBe(computeContentFingerprint('r1', 'b.ts', 'x'));
      expect(a).not.toBe(computeContentFingerprint('r1', 'a.ts', 'y'));
    });
    it('a secret HMAC anchor is line-independent by construction', () => {
      const hmac = computeSecretHmac('AKIAEXAMPLE', 'salt');
      const fp = computeContentFingerprint('aws-access-key', 'cfg.ts', hmac);
      expect(fp).toBe(computeContentFingerprint('aws-access-key', 'cfg.ts', hmac));
    });
    it('returns 16-char lowercase hex', () => {
      expect(computeContentFingerprint('r', 'f', 'a')).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});
