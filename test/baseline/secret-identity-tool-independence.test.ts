/**
 * Regression gate: a secret's durable identity must be independent of which
 * scanner found it and of how the per-repo salt resolves.
 *
 * The failure this locks out: a secret's content fingerprint once folded in
 * the salted HMAC of the tool-captured value. gitleaks (`Secret` field) and
 * the grep fallback (regex capture) capture different text, and the salt
 * differs across environments (env var / `.dxkit/salt` / root-SHA), so the
 * SAME leak fingerprinted differently between a developer's machine and CI —
 * stranding the committed allowlist entry and re-flagging an accepted finding
 * as net-new. (Observed concretely: dxkit's own self-guardrail blocked on two
 * fixture secrets whose allowlist fps were harvested under a stray
 * DXKIT_BASELINE_SALT.)
 *
 * The fix: secret identity is (SECRET_CANONICAL_RULE, file, ordinal) — a
 * tool-independent constant discriminator plus a per-file document-order
 * ordinal, carrying NO captured value and NO salt. This test asserts the
 * invariant at the aggregator (the unit-level identity authority) and
 * end-to-end through the real grep-secrets gather under two different salts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  buildSecurityAggregate,
  type SecurityAggregateInput,
  type SecurityFinding,
} from '../../src/analyzers/security/aggregator';
import { gatherGrepSecretsResult } from '../../src/analyzers/tools/grep-secrets';

/** A secret-category finding at a fixed location, attributed to `tool`. */
function secretFinding(tool: string, rule: string): SecurityFinding {
  return {
    severity: 'high',
    category: 'secret',
    cwe: 'CWE-798',
    rule,
    title: `Secret: ${rule}`,
    file: 'src/config.ts',
    line: 10,
    tool,
  };
}

function aggregateSecrets(findings: SecurityFinding[]): SecurityAggregateInput {
  return {
    secrets: { findings, toolUsed: 'mixed' },
    fileFindings: [],
    codePatterns: { findings: [], toolUsed: null },
    tlsBypass: [],
    tlsBypassPatternCount: 0,
    depVulns: { findings: [], tool: null, available: true, unavailableReason: '' },
  };
}

const fpsOf = (findings: SecurityFinding[]): string[] =>
  buildSecurityAggregate(aggregateSecrets(findings)).findingsByCategory.secret.map(
    (f) => f.fingerprint,
  );

describe('secret identity is tool-independent', () => {
  it('the same leak fingerprints identically whether gitleaks, grep, or both found it', () => {
    // gitleaks and the grep fallback report the SAME leak under DIFFERENT
    // rule names. All three views must collapse to one fingerprint.
    const gitleaksOnly = fpsOf([secretFinding('gitleaks', 'generic-api-key')]);
    const grepOnly = fpsOf([secretFinding('grep-secrets', 'hardcoded-password')]);
    const both = fpsOf([
      secretFinding('gitleaks', 'generic-api-key'),
      secretFinding('grep-secrets', 'hardcoded-password'),
    ]);

    expect(gitleaksOnly).toHaveLength(1);
    expect(grepOnly).toHaveLength(1);
    // Two tools at one location collapse to ONE finding (no double-count)...
    expect(both).toHaveLength(1);
    // ...and every view shares the same identity.
    expect(grepOnly[0]).toBe(gitleaksOnly[0]);
    expect(both[0]).toBe(gitleaksOnly[0]);
  });

  it('distinct secrets in one file stay distinct (ordinal disambiguates)', () => {
    const fps = fpsOf([
      { ...secretFinding('grep-secrets', 'hardcoded-password'), line: 10 },
      { ...secretFinding('grep-secrets', 'hardcoded-password'), line: 50 },
    ]);
    expect(fps).toHaveLength(2);
    expect(fps[0]).not.toBe(fps[1]);
  });
});

describe('secret identity is salt-independent (end-to-end grep gather)', () => {
  let dir: string;
  let savedSalt: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-secret-toolindep-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'config.ts'),
      'const password = "s3cr3t-not-a-real-credential-xyz";\n',
    );
    savedSalt = process.env.DXKIT_BASELINE_SALT;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
    else process.env.DXKIT_BASELINE_SALT = savedSalt;
  });

  /** Run the real grep-secrets gather → aggregator under a chosen salt. */
  function fingerprintUnderSalt(salt: string): string {
    process.env.DXKIT_BASELINE_SALT = salt;
    const res = gatherGrepSecretsResult(dir);
    const findings: SecurityFinding[] = (res?.findings ?? []).map((f) => ({
      severity: f.severity,
      category: 'secret' as const,
      cwe: 'CWE-798',
      rule: f.rule,
      title: f.title ?? `Secret: ${f.rule}`,
      file: f.file,
      line: f.line,
      tool: 'grep-secrets',
    }));
    const secret = buildSecurityAggregate(aggregateSecrets(findings)).findingsByCategory.secret;
    expect(secret).toHaveLength(1);
    return secret[0].fingerprint;
  }

  it('two different salts produce the same fingerprint', () => {
    // The salt drove identity under the old salted-HMAC scheme; now it must
    // not enter secret identity at all.
    expect(fingerprintUnderSalt('salt-environment-A')).toBe(
      fingerprintUnderSalt('salt-environment-B'),
    );
  });
});
