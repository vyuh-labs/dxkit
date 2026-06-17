import { describe, it, expect } from 'vitest';

import { scoreDocsDimension } from '../src/analyzers/docs/shallow';
import { scoreMaintainabilityDimension } from '../src/analyzers/maintainability/shallow';
import { scoreDxDimension } from '../src/analyzers/dx/shallow';
import { scoreSecurityDimension, toSecurityScoreInput } from '../src/analyzers/security/shallow';
import { scoreQualityDimension } from '../src/analyzers/quality/shallow';
import { scoreTestsDimension } from '../src/analyzers/tests/shallow';
import { SECURITY_SCORING_SPEC, SecurityScoreInput, evaluateSpec } from '../src/scoring';

const scoreSecurityFromInput = (input: SecurityScoreInput) =>
  evaluateSpec(SECURITY_SCORING_SPEC, input);
import { scoreTestGapsCounts } from '../src/analyzers/tests/scoring';
import { buildSecurityAggregate } from '../src/analyzers/security/aggregator';
import {
  computeContentFingerprint,
  secretContentAnchor,
  SECRET_CANONICAL_RULE,
} from '../src/analyzers/tools/fingerprint';
import { buildSecurityDetailed } from '../src/analyzers/security/detailed';
import type { SecurityReport } from '../src/analyzers/security/types';
import {
  coverageCapability,
  codePatternsCapabilityWithFindings,
  depVulnCapability,
  lintCapability,
  qualityMeasuredCapabilities,
  secretsCapabilityWithCount,
  withInput,
} from './fixtures/score-input';

// ── Shallow dimension scorers (all delegate to scoring.ts) ─────────────

describe('shallow dimension scorers', () => {
  const baseInput = withInput();

  it('scoreDocsDimension returns a DimensionScore', () => {
    const r = scoreDocsDimension(baseInput);
    expect(r).toHaveProperty('score');
    expect(r).toHaveProperty('maxScore', 100);
    expect(r).toHaveProperty('rating');
    expect(typeof r.score).toBe('number');
  });

  it('scoreMaintainabilityDimension returns a DimensionScore', () => {
    const r = scoreMaintainabilityDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('scoreDxDimension returns a DimensionScore', () => {
    const r = scoreDxDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
  });

  it('scoreSecurityDimension returns a DimensionScore', () => {
    const r = scoreSecurityDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('scoreQualityDimension returns a DimensionScore', () => {
    const r = scoreQualityDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('scoreTestsDimension returns a DimensionScore', () => {
    const r = scoreTestsDimension(baseInput);
    expect(r.score).toBeGreaterThanOrEqual(0);
  });

  it('docs score improves with README + CONTRIBUTING', () => {
    const good = withInput({
      metrics: { readmeExists: true, readmeLines: 100, contributingExists: true },
    });
    expect(scoreDocsDimension(good).score).toBeGreaterThan(scoreDocsDimension(baseInput).score);
  });

  it('security score drops with secret findings', () => {
    const bad = withInput({
      metrics: { privateKeyFiles: 2, evalCount: 3 },
      capabilities: { secrets: secretsCapabilityWithCount(5) },
    });
    expect(scoreSecurityDimension(bad).score).toBeLessThan(scoreSecurityDimension(baseInput).score);
  });

  it('quality score drops with lint errors + large files', () => {
    // Use a measured-capabilities baseline so the cap doesn't shadow
    // the formula's penalty contribution we're testing.
    const measuredBaseline = withInput({ capabilities: qualityMeasuredCapabilities() });
    const bad = withInput({
      metrics: { filesOver500Lines: 20, consoleLogCount: 200 },
      capabilities: { ...qualityMeasuredCapabilities(), lint: lintCapability(0, 100) },
    });
    expect(scoreQualityDimension(bad).score).toBeLessThan(
      scoreQualityDimension(measuredBaseline).score,
    );
  });

  it('maintainability score drops with huge god files', () => {
    const bad = withInput({
      metrics: { largestFileLines: 10000, filesOver500Lines: 40, controllers: 200 },
    });
    expect(scoreMaintainabilityDimension(bad).score).toBeLessThan(
      scoreMaintainabilityDimension(baseInput).score,
    );
  });

  it('dx score improves with CI + Docker + pre-commit', () => {
    const good = withInput({
      metrics: {
        ciConfigCount: 2,
        dockerConfigCount: 1,
        precommitConfigCount: 1,
        makefileExists: true,
        envExampleExists: true,
        npmScriptsCount: 8,
      },
    });
    expect(scoreDxDimension(good).score).toBeGreaterThan(scoreDxDimension(baseInput).score);
  });

  it('test score improves with test files + passing tests', () => {
    const good = withInput({
      metrics: { testFiles: 20, testsPass: true, coverageConfigExists: true },
      capabilities: { coverage: coverageCapability(80) },
    });
    expect(scoreTestsDimension(good).score).toBeGreaterThan(scoreTestsDimension(baseInput).score);
  });
});

// ── Canonical security scorer ──────────────────────────────────────────

function emptyScoreInput(overrides: Partial<SecurityScoreInput> = {}): SecurityScoreInput {
  return {
    secretFindings: 0,
    privateKeyFiles: 0,
    envFilesInGit: 0,
    codeFindings: { critical: 0, high: 0, medium: 0, low: 0 },
    depVulns: { critical: 0, high: 0, medium: 0, low: 0 },
    // D025b default: helper models the "happy path" where the dep-vuln
    // scan ran cleanly. Tests for the cap explicitly override
    // `depVulnsAvailable: false`.
    depVulnsAvailable: true,
    // Same happy-path default for the secret + code-pattern axes.
    secretsAvailable: true,
    codePatternsAvailable: true,
    ...overrides,
  };
}

describe('scoreSecurityFromInput', () => {
  it('returns 100 for an empty input', () => {
    expect(scoreSecurityFromInput(emptyScoreInput()).score).toBe(100);
  });

  it('allowlisted (false-positive/test-fixture) secrets do not drive secretFindings; real ones do', () => {
    // A repo that has reviewed and accepted its flagged secrets as
    // false-positive / test-fixture must not stay capped at the
    // committed-credentials tier on that noise — but an un-triaged real
    // secret still counts. The aggregate carries the allowlist-adjusted
    // scoreable buckets; toSecurityScoreInput reads them.
    // Content-anchored SECRET identity: tool-independent constant rule +
    // file + in-file ordinal (the only secret in the file → ordinal 0).
    const fixtureFp = computeContentFingerprint(
      SECRET_CANONICAL_RULE,
      'src/__tests__/validator.unit.ts',
      secretContentAnchor(0),
    );
    const buildAgg = (entries: object[]) =>
      buildSecurityAggregate({
        secrets: {
          findings: [
            {
              severity: 'critical',
              category: 'secret',
              cwe: 'CWE-798',
              rule: 'hardcoded-password',
              title: 's',
              file: 'src/__tests__/validator.unit.ts',
              line: 10,
              tool: 'grep-secrets',
            },
          ],
          toolUsed: 'grep-secrets',
        },
        fileFindings: [],
        codePatterns: { findings: [], toolUsed: null },
        tlsBypass: [],
        tlsBypassPatternCount: 0,
        depVulns: { findings: [], tool: null, available: true, unavailableReason: '' },
        allowlist: { schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries } as never,
      });

    // No allowlist → the secret counts (real-secret baseline).
    const counted = withInput({ capabilities: { securityAggregate: buildAgg([]) } });
    expect(toSecurityScoreInput(counted).secretFindings).toBe(1);

    // Allowlisted as test-fixture → lifted from the score.
    const lifted = withInput({
      capabilities: {
        securityAggregate: buildAgg([
          {
            fingerprint: fixtureFp,
            kind: 'secret',
            category: 'test-fixture',
            addedAt: '2026-06-01',
          },
        ]),
      },
    });
    expect(toSecurityScoreInput(lifted).secretFindings).toBe(0);
  });

  it('C2.2 / D098: every secret-class signal caps the score at 40', () => {
    // Pre-C2.2: secretFindings tier penalties produced 85 / 80 / 75
    // and privateKeyFiles produced 80 — all "Good" or "Excellent"
    // territory despite committed credentials. Post-C2.2:
    // SECRETS_PRESENT_CAP forces the dimension to ≤ 40 ("Fair") for
    // ANY non-zero count. Foundational trust failure regardless of
    // magnitude.
    expect(scoreSecurityFromInput(emptyScoreInput({ secretFindings: 1 })).score).toBe(40);
    expect(scoreSecurityFromInput(emptyScoreInput({ secretFindings: 6 })).score).toBe(40);
    expect(scoreSecurityFromInput(emptyScoreInput({ secretFindings: 11 })).score).toBe(40);
    expect(scoreSecurityFromInput(emptyScoreInput({ privateKeyFiles: 1 })).score).toBe(40);
    expect(scoreSecurityFromInput(emptyScoreInput({ privateKeyFiles: 5 })).score).toBe(40);
    expect(scoreSecurityFromInput(emptyScoreInput({ envFilesInGit: 1 })).score).toBe(40);
    expect(scoreSecurityFromInput(emptyScoreInput({ envFilesInGit: 7 })).score).toBe(40);
  });

  it('C2.2 / D098: secrets cap compounds with deeper penalties below the cap', () => {
    // The cap is a CEILING, not a floor. When other penalties drive
    // the score below 40, the cap doesn't lift it back up. A repo
    // with 11 secrets (-25) + 11 critical code findings (-25) +
    // private keys (-20) starts at 100 - 70 = 30, which is below 40.
    // Final = 30.
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({
          secretFindings: 11,
          privateKeyFiles: 1,
          codeFindings: { critical: 11, high: 0, medium: 0, low: 0 },
        }),
      ).score,
    ).toBe(30);
  });

  it('tiers code-finding penalties by severity (capped at fixable-finding for HIGH+ open)', () => {
    // Any open HIGH or CRITICAL code finding caps the dimension at
    // CAP_TIERS['fixable-finding'] (79). The raw-penalty tiers still
    // apply when the penalty drives the score below the cap.

    // critical: raw 85 / 80 → both capped at 79; raw 75 stays at 75
    // (below the cap, so the cap doesn't bind).
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ codeFindings: { critical: 1, high: 0, medium: 0, low: 0 } }),
      ).score,
    ).toBe(79);
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ codeFindings: { critical: 6, high: 0, medium: 0, low: 0 } }),
      ).score,
    ).toBe(79);
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ codeFindings: { critical: 11, high: 0, medium: 0, low: 0 } }),
      ).score,
    ).toBe(75);
    // high: raw 95 / 90 → both capped at 79.
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ codeFindings: { critical: 0, high: 1, medium: 0, low: 0 } }),
      ).score,
    ).toBe(79);
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ codeFindings: { critical: 0, high: 6, medium: 0, low: 0 } }),
      ).score,
    ).toBe(79);
    // medium > 10: raw 95, cap does NOT apply (no HIGH/CRITICAL open).
    // The cap is severity-gated, not count-gated.
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ codeFindings: { critical: 0, high: 0, medium: 11, low: 0 } }),
      ).score,
    ).toBe(95);
  });

  it('deducts for dep vulns by severity', () => {
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ depVulns: { critical: 1, high: 0, medium: 0, low: 0 } }),
      ).score,
    ).toBe(85);
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ depVulns: { critical: 0, high: 3, medium: 0, low: 0 } }),
      ).score,
    ).toBe(95);
    expect(
      scoreSecurityFromInput(
        emptyScoreInput({ depVulns: { critical: 0, high: 10, medium: 0, low: 0 } }),
      ).score,
    ).toBe(90);
  });

  it('stacks penalties and clamps to 0', () => {
    const s = scoreSecurityFromInput(
      emptyScoreInput({
        secretFindings: 20,
        privateKeyFiles: 5,
        envFilesInGit: 1,
        codeFindings: { critical: 20, high: 20, medium: 20, low: 0 },
        depVulns: { critical: 5, high: 20, medium: 0, low: 0 },
      }),
    );
    expect(s.score).toBe(0);
  });

  it('clamps to 0 on absurdly large inputs', () => {
    const s = scoreSecurityFromInput(
      emptyScoreInput({
        secretFindings: 1000,
        privateKeyFiles: 1000,
        envFilesInGit: 1000,
        codeFindings: { critical: 1000, high: 1000, medium: 1000, low: 1000 },
        depVulns: { critical: 1000, high: 1000, medium: 1000, low: 1000 },
      }),
    );
    expect(s.score).toBe(0);
  });

  // ── D025b honesty cap ─────────────────────────────────────────────────

  it('caps at 65 when depVulnsAvailable is false on otherwise-clean signals', () => {
    // Pre-D025b: this would return 100 (no penalties applied).
    // Post-D025b: cap fires because dxkit can't honestly claim "excellent"
    // when it never actually scanned the deps. This is the F4 baseline
    // .NET WinForms benchmark lie closure.
    const s = scoreSecurityFromInput(emptyScoreInput({ depVulnsAvailable: false }));
    expect(s.score).toBe(65);
  });

  it('does NOT cap when depVulnsAvailable is true and signals are clean', () => {
    // Sanity check: cap only fires on the false case.
    const s = scoreSecurityFromInput(emptyScoreInput({ depVulnsAvailable: true }));
    expect(s.score).toBe(100);
  });

  // ── Symmetric unavailable-scanner honesty caps ────────────────────────────────────────

  it('caps at 65 when the secret scan did not run', () => {
    // Pre-2.10 a missing secret scan silently scored as "0 secrets" — a
    // confident clean subtotal next to "Sources: (none)", so enabling the
    // scanner later read as a phantom score drop. Same uncertainty
    // treatment as dep-vulns now.
    const s = scoreSecurityFromInput(emptyScoreInput({ secretsAvailable: false }));
    expect(s.score).toBe(65);
    expect(s.capsApplied.map((c) => c.id)).toContain('secrets-unavailable');
  });

  it('caps at 65 when the code-pattern scan did not run', () => {
    const s = scoreSecurityFromInput(emptyScoreInput({ codePatternsAvailable: false }));
    expect(s.score).toBe(65);
    expect(s.capsApplied.map((c) => c.id)).toContain('code-patterns-unavailable');
  });

  it('trust-broken (40) still dominates an unavailability cap (65)', () => {
    // Found credentials are worse news than a scanner that didn't run;
    // most-aggressive cap wins.
    const s = scoreSecurityFromInput(
      emptyScoreInput({ secretFindings: 1, codePatternsAvailable: false }),
    );
    expect(s.score).toBe(40);
  });

  it('dep-availability cap is a ceiling, not a floor — other penalties still drop the score below 65', () => {
    // 100 - 15 (1 critical code finding) - 5 (1 high) - 10 (>5 high) - 25 (>10 critical) ... etc.
    // Adjusted post-C2.2 to use code-only inputs (no secrets/private-
    // keys/.env so the SECRETS_PRESENT_CAP at 40 doesn't fire). This
    // test specifically pins the DEP_VULNS_UNAVAILABLE_CAP composition
    // with other penalties below the cap.
    //
    // 11 critical code findings → 100 - 25 = 75. With depVulnsAvailable
    // false, capped to 65. Adding 11 more critical → 100 - 25 = 75
    // unchanged (the > 10 tier maxes out). So we use 11 critical +
    // 11 high to trigger an additional -10 = 65, then need MORE to
    // drop below 65.
    //
    // Final: 100 - 25 (critical>10) - 10 (high>5) - 5 (med>10) - 15
    // (critical dep) - 10 (high dep > 5) = 35. The dep-cap is a
    // ceiling at 65 but penalties already drove us to 35.
    const s = scoreSecurityFromInput(
      emptyScoreInput({
        depVulnsAvailable: false,
        codeFindings: { critical: 11, high: 6, medium: 11, low: 0 },
        depVulns: { critical: 1, high: 6, medium: 0, low: 0 },
      }),
    );
    expect(s.score).toBe(35);
  });

  it('multiple caps compose monotonically (most-aggressive wins)', () => {
    // 100 - 15 (1 critical code finding) = raw 85. Then:
    //   • dep-vulns-unavailable cap brings it to 65 (uncertainty tier).
    //   • fixable-finding cap (79) would also apply but is less
    //     aggressive than 65, so the dep-unavailable cap dominates.
    const cappedByBoth = scoreSecurityFromInput(
      emptyScoreInput({
        depVulnsAvailable: false,
        codeFindings: { critical: 1, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(cappedByBoth.score).toBe(65);
    // Without dep-unavailable: fixable-finding cap (79) binds, since
    // raw 85 > 79.
    const cappedByHighOnly = scoreSecurityFromInput(
      emptyScoreInput({
        depVulnsAvailable: true,
        codeFindings: { critical: 1, high: 0, medium: 0, low: 0 },
      }),
    );
    expect(cappedByHighOnly.score).toBe(79);
  });
});

// ── D023 parity: health dimension score === standalone vuln-scan score ─

describe('D023 parity: unified security scorer', () => {
  it('health Security dim score equals standalone Security Score for the same signals', () => {
    // Build a SecurityReport whose findings match the same signals we
    // feed through the health-side adapter. If the two adapters agree
    // on what each finding means, the unified scorer produces the
    // same number from both paths.
    const securityReport: SecurityReport = {
      repo: 'test',
      analyzedAt: '2026-05-10T00:00:00.000Z',
      commitSha: 'abc1234',
      branch: 'main',
      summary: {
        findings: { critical: 4, high: 4, medium: 0, low: 0, total: 8 },
        codeOnly: { critical: 4, high: 4, medium: 0, low: 0, total: 8 },
        secretsOnly: { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
        dependencies: {
          critical: 1,
          high: 2,
          medium: 0,
          low: 0,
          total: 3,
          tool: 'npm-audit',
          findings: [],
          available: true,
          unavailableReason: '',
        },
      },
      findings: [
        // 3 gitleaks-detected secrets
        {
          severity: 'high',
          category: 'secret',
          cwe: 'CWE-798',
          rule: 'aws-key',
          title: 's1',
          file: 'a.ts',
          line: 1,
          tool: 'gitleaks',
        },
        {
          severity: 'high',
          category: 'secret',
          cwe: 'CWE-798',
          rule: 'aws-key',
          title: 's2',
          file: 'b.ts',
          line: 1,
          tool: 'gitleaks',
        },
        {
          severity: 'high',
          category: 'secret',
          cwe: 'CWE-798',
          rule: 'aws-key',
          title: 's3',
          file: 'c.ts',
          line: 1,
          tool: 'gitleaks',
        },
        // 2 private-key files on disk
        {
          severity: 'critical',
          category: 'secret',
          cwe: 'CWE-798',
          rule: 'private-key-file',
          title: 'pk1',
          file: 'k1.pem',
          line: 0,
          tool: 'find',
        },
        {
          severity: 'critical',
          category: 'secret',
          cwe: 'CWE-798',
          rule: 'private-key-file',
          title: 'pk2',
          file: 'k2.pem',
          line: 0,
          tool: 'find',
        },
        // 1 .env in git
        {
          severity: 'high',
          category: 'config',
          cwe: 'CWE-798',
          rule: 'env-in-git',
          title: 'env',
          file: '.env',
          line: 0,
          tool: 'git',
        },
        // 4 critical + 1 high semgrep code findings
        {
          severity: 'critical',
          category: 'code',
          cwe: 'CWE-89',
          rule: 'sqli',
          title: 'sql',
          file: 'q.ts',
          line: 1,
          tool: 'semgrep',
        },
        {
          severity: 'critical',
          category: 'code',
          cwe: 'CWE-89',
          rule: 'sqli',
          title: 'sql',
          file: 'q.ts',
          line: 2,
          tool: 'semgrep',
        },
        {
          severity: 'critical',
          category: 'code',
          cwe: 'CWE-79',
          rule: 'xss',
          title: 'xss',
          file: 'r.ts',
          line: 1,
          tool: 'semgrep',
        },
        {
          severity: 'critical',
          category: 'code',
          cwe: 'CWE-79',
          rule: 'xss',
          title: 'xss',
          file: 'r.ts',
          line: 2,
          tool: 'semgrep',
        },
        {
          severity: 'high',
          category: 'code',
          cwe: 'CWE-95',
          rule: 'eval',
          title: 'eval',
          file: 's.ts',
          line: 1,
          tool: 'semgrep',
        },
      ],
      toolsUsed: ['gitleaks', 'find', 'git', 'semgrep', 'npm-audit'],
      toolsUnavailable: [],
    };

    // Standalone path: SecurityReport → countsFromReport → scorer.
    const detailed = buildSecurityDetailed(securityReport);
    const standaloneScore = detailed.securityScore;

    // Health path: synthesize a ScoreInput whose capability envelopes
    // describe the SAME signals, then run the dimension scorer.
    const healthScore = scoreSecurityDimension(
      withInput({
        metrics: {
          privateKeyFiles: 2,
          envFilesInGit: 1,
          // evalCount + tlsDisabledCount are only consulted as a
          // fallback when codePatterns is absent; codePatterns IS
          // present below, so leave the grep-based fields at 0 to
          // avoid double-counting.
          evalCount: 0,
          tlsDisabledCount: 0,
        },
        capabilities: {
          secrets: secretsCapabilityWithCount(3),
          codePatterns: codePatternsCapabilityWithFindings({ critical: 4, high: 1 }),
          depVulns: depVulnCapability(1, 2),
        },
      }),
    ).score;

    expect(standaloneScore).toBe(healthScore);
  });

  it('health-side falls back to grep-based metrics when codePatterns is absent', () => {
    // Without semgrep, the health-side should still penalize eval/TLS
    // through the m.evalCount + m.tlsDisabledCount grep counts so the
    // semgrep-less environment doesn't surface as fully clean.
    const r = scoreSecurityDimension(
      withInput({
        metrics: { evalCount: 1, tlsDisabledCount: 1 },
      }),
    );
    // 2 high-severity code findings raw-penalize -5 (high > 0), then
    // the fixable-finding cap brings the dimension to 79 — even one
    // open HIGH code finding caps the rating at B.
    expect(r.score).toBe(79);
  });
});

// ── Test gaps sub-scorer ───────────────────────────────────────────────

describe('scoreTestGapsCounts', () => {
  it('returns high score when everything is tested', () => {
    const r = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    expect(r.score).toBe(100);
  });

  it('penalizes untested critical files most', () => {
    const withCrit = scoreTestGapsCounts({
      untestedCritical: 5,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    const withLow = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 5,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    expect(withCrit.score).toBeLessThan(withLow.score);
  });

  it('penalizes commented-out test files', () => {
    const clean = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 0,
    });
    const withCommented = scoreTestGapsCounts({
      untestedCritical: 0,
      untestedHigh: 0,
      untestedMedium: 0,
      untestedLow: 0,
      testedSource: 50,
      commentedOutFiles: 3,
    });
    expect(withCommented.score).toBeLessThan(clean.score);
  });

  it('clamps to 0-100', () => {
    const worst = scoreTestGapsCounts({
      untestedCritical: 100,
      untestedHigh: 100,
      untestedMedium: 100,
      untestedLow: 100,
      testedSource: 0,
      commentedOutFiles: 10,
    });
    expect(worst.score).toBeGreaterThanOrEqual(0);
    expect(worst.score).toBeLessThanOrEqual(100);
  });
});
