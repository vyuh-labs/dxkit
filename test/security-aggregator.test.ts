/**
 * Tests for the canonical security aggregator (G_v4_8 / 2.4.7 Phase C1).
 *
 * Three classes of regression are pinned here:
 *
 *   - **D086** (Health vs vuln-scan code-finding count drift). Verifies
 *     the aggregate produces ONE `codeBySeverity` number that both
 *     consumers will read; no consumer has a second path to re-count
 *     from.
 *
 *   - **D087** (Dep-vuln Subtotal vs "N advisories" same-page drift).
 *     Verifies `dependencyAdvisoryUniqueCount` collapses raw findings
 *     by fingerprint AND that `depBySeverity` is derived from the
 *     unique set (sums to `dependencyAdvisoryUniqueCount`).
 *
 *   - **D091** (TLS-bypass cross-tool double-count). Verifies that
 *     two raw findings at the same file/canonical-rule with a small
 *     line drift collapse to one `CodeFinding` with `keptSeverity =
 *     max` and `producedBy` carrying both source tools.
 *
 * Plus invariants the contract guarantees and consumer migration
 * later in C1.2–C1.5 will depend on.
 */
import { describe, it, expect } from 'vitest';
import {
  buildSecurityAggregate,
  type SecurityAggregateInput,
  type SecurityFinding,
} from '../src/analyzers/security/aggregator';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

function makeFinding(overrides: Partial<SecurityFinding>): SecurityFinding {
  return {
    severity: 'high',
    category: 'code',
    cwe: '',
    rule: 'test-rule',
    title: 'Test finding',
    file: 'src/test.ts',
    line: 1,
    tool: 'test-tool',
    ...overrides,
  };
}

function emptyInput(): SecurityAggregateInput {
  return {
    secrets: { findings: [], toolUsed: null },
    fileFindings: [],
    codePatterns: { findings: [], toolUsed: null },
    tlsBypass: [],
    tlsBypassPatternCount: 0,
    depVulns: { findings: [], tool: null, available: true, unavailableReason: '' },
  };
}

describe('buildSecurityAggregate — empty case', () => {
  it('returns all-zero counts and ran=false provenance when no input', () => {
    const agg = buildSecurityAggregate(emptyInput());

    expect(agg.codeBySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(agg.depBySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
    expect(agg.secretsBySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });

    expect(agg.findingsByCategory.secret).toEqual([]);
    expect(agg.findingsByCategory.code).toEqual([]);
    expect(agg.findingsByCategory.config).toEqual([]);
    expect(agg.findingsByCategory.dependency).toEqual([]);

    expect(agg.dependencyAdvisoryUniqueCount).toBe(0);
    expect(agg.dependencyFindingsRawCount).toBe(0);
    expect(agg.dedupCollisions).toEqual([]);

    expect(agg.provenance.secrets.ran).toBe(false);
    expect(agg.provenance.codePatterns.ran).toBe(false);
    expect(agg.provenance.tlsBypass.ran).toBe(false);
    expect(agg.provenance.depVulns.available).toBe(true);
  });
});

describe('buildSecurityAggregate — D091 cross-tool TLS-bypass dedup', () => {
  it('collapses semgrep + registry-grep TLS findings at the same file/line-window into one CodeFinding', () => {
    // Pre-aggregator state on platform: registry-grep flagged
    // ldap-spec.ts:74 HIGH (`tls-bypass-registry / tls-validation-disabled`),
    // semgrep flagged the same construct at :72 MEDIUM
    // (`semgrep / bypass-tls-verification`). Both are the same root
    // finding; aggregator must collapse them.
    const input = emptyInput();
    input.tlsBypass = [
      makeFinding({
        severity: 'high',
        category: 'code',
        rule: 'tls-validation-disabled',
        tool: 'tls-bypass-registry',
        file: 'src/utils/ldap-spec.ts',
        line: 74,
        cwe: 'CWE-295',
        title: 'TLS / certificate validation bypass',
      }),
    ];
    input.codePatterns = {
      toolUsed: 'semgrep',
      findings: [
        makeFinding({
          severity: 'medium',
          category: 'code',
          rule: 'bypass-tls-verification',
          tool: 'semgrep',
          file: 'src/utils/ldap-spec.ts',
          line: 72,
          cwe: 'CWE-295',
          title: 'Checks for setting NODE_TLS_REJECT_UNAUTHORIZED to 0',
        }),
      ],
    };

    const agg = buildSecurityAggregate(input);

    // ONE code finding, not two.
    expect(agg.findingsByCategory.code).toHaveLength(1);
    const f = agg.findingsByCategory.code[0];
    expect(f.severity).toBe('high'); // max(high, medium)
    expect(f.canonicalRule).toBe('canonical:tls-bypass');
    expect(f.producedBy).toEqual(['semgrep', 'tls-bypass-registry']); // sorted
    expect(f.line).toBe(72); // earlier line preferred (declaration over assignment)

    // Severity buckets reflect the single collapsed finding.
    expect(agg.codeBySeverity.high).toBe(1);
    expect(agg.codeBySeverity.medium).toBe(0);

    // Audit trail captures the collapse.
    expect(agg.dedupCollisions).toHaveLength(1);
    expect(agg.dedupCollisions[0].canonicalRule).toBe('canonical:tls-bypass');
    expect(agg.dedupCollisions[0].file).toBe('src/utils/ldap-spec.ts');
    expect(agg.dedupCollisions[0].keptSeverity).toBe('high');
    expect(agg.dedupCollisions[0].collapsedFrom).toHaveLength(2);
  });

  it('does NOT collapse genuinely-different findings in the same file', () => {
    // Two unrelated semgrep findings far apart in the same file should
    // stay as two findings — the line-window bucket is 3 lines wide,
    // so anything ≥ 3 lines apart stays separate.
    const input = emptyInput();
    input.codePatterns = {
      toolUsed: 'semgrep',
      findings: [
        makeFinding({
          severity: 'high',
          rule: 'sql-injection',
          tool: 'semgrep',
          file: 'src/api/users.ts',
          line: 42,
        }),
        makeFinding({
          severity: 'medium',
          rule: 'xss-reflected',
          tool: 'semgrep',
          file: 'src/api/users.ts',
          line: 200,
        }),
      ],
    };
    const agg = buildSecurityAggregate(input);
    expect(agg.findingsByCategory.code).toHaveLength(2);
    expect(agg.codeBySeverity.high).toBe(1);
    expect(agg.codeBySeverity.medium).toBe(1);
    expect(agg.dedupCollisions).toEqual([]);
  });

  it('passes unmapped rules through with raw: canonicalRule prefix (no accidental collapse)', () => {
    // Two findings with the same file/line-window but DIFFERENT rules
    // should NOT collapse — the canonical-rule registry has no entry
    // for them, so each gets a unique `raw:tool:rule` canonical key.
    const input = emptyInput();
    input.codePatterns = {
      toolUsed: 'semgrep',
      findings: [
        makeFinding({
          rule: 'rule-alpha',
          tool: 'semgrep',
          file: 'src/api/users.ts',
          line: 42,
          severity: 'high',
        }),
        makeFinding({
          rule: 'rule-beta',
          tool: 'semgrep',
          file: 'src/api/users.ts',
          line: 43,
          severity: 'medium',
        }),
      ],
    };
    const agg = buildSecurityAggregate(input);
    expect(agg.findingsByCategory.code).toHaveLength(2);
    const canonicals = agg.findingsByCategory.code.map((f) => f.canonicalRule).sort();
    expect(canonicals).toEqual(['raw:semgrep:rule-alpha', 'raw:semgrep:rule-beta']);
    expect(agg.dedupCollisions).toEqual([]);
  });
});

describe('buildSecurityAggregate — D086 health/vuln-scan parity', () => {
  it('produces ONE code-finding count surface both consumers read from', () => {
    // The D086 root cause was two separate aggregation paths:
    // standalone vuln-scan summed `[secrets, files, code, tlsBypass]`,
    // health-side iterated `c.codePatterns.findings` AND added
    // `m.tlsDisabledCount` to high regardless. They drift when TLS
    // bypass patterns match both registry AND semgrep — each consumer
    // double-counts in a different way.
    //
    // Post-aggregator: there's ONE `codeBySeverity` field. Both
    // consumers read it. They CANNOT drift.
    const input = emptyInput();
    input.codePatterns = {
      toolUsed: 'semgrep',
      findings: [
        makeFinding({
          severity: 'medium',
          rule: 'bypass-tls-verification',
          tool: 'semgrep',
          file: 'src/a.ts',
          line: 10,
        }),
        makeFinding({
          severity: 'medium',
          rule: 'bypass-tls-verification',
          tool: 'semgrep',
          file: 'src/b.ts',
          line: 20,
        }),
        makeFinding({
          severity: 'high',
          rule: 'eval-usage',
          tool: 'semgrep',
          file: 'src/c.ts',
          line: 5,
        }),
      ],
    };
    input.tlsBypass = [
      // Same file/line-window as semgrep finding in a.ts:10 → collapse
      makeFinding({
        severity: 'high',
        rule: 'tls-validation-disabled',
        tool: 'tls-bypass-registry',
        file: 'src/a.ts',
        line: 11,
      }),
      // Different file from any semgrep finding → standalone
      makeFinding({
        severity: 'high',
        rule: 'tls-validation-disabled',
        tool: 'tls-bypass-registry',
        file: 'src/d.ts',
        line: 30,
      }),
    ];

    const agg = buildSecurityAggregate(input);

    // 5 raw → 4 unique after a.ts collapse (semgrep MED + registry HIGH).
    expect(agg.findingsByCategory.code).toHaveLength(4);

    // Severity buckets:
    //   - a.ts: collapsed to HIGH (max)
    //   - b.ts: MED (semgrep TLS, alone)
    //   - c.ts: HIGH (eval)
    //   - d.ts: HIGH (registry TLS, alone)
    // → 3 HIGH, 1 MED
    expect(agg.codeBySeverity).toEqual({ critical: 0, high: 3, medium: 1, low: 0 });

    // The fact that this is exposed as ONE field means health-side
    // and vuln-scan-side renderers will produce IDENTICAL prose. D086
    // becomes structurally impossible to re-introduce.
  });
});

describe('buildSecurityAggregate — D087 dep-vuln subtotal vs raw count', () => {
  it('exposes both unique-by-fingerprint count and raw-count, names them distinctly', () => {
    // The D087 root cause was: vuln-scan exec summary used envelope
    // bucket-sum (70) and the same page later showed findings.length
    // (81). 70 vs 81 on one page. The aggregator forces consumers
    // to choose by name: `dependencyAdvisoryUniqueCount` is the
    // user-facing canonical count; `dependencyFindingsRawCount` is
    // diagnostic only.
    const input = emptyInput();
    const baseFinding = (overrides: Partial<DepVulnFinding>): DepVulnFinding => ({
      id: 'CVE-2024-0001',
      package: 'axios',
      installedVersion: '0.20.0',
      severity: 'high',
      tool: 'npm-audit',
      fingerprint: 'fp-axios-high',
      ...overrides,
    });
    input.depVulns = {
      tool: 'npm-audit',
      available: true,
      unavailableReason: '',
      findings: [
        // Three duplicates of the same fingerprint (e.g. same advisory
        // reported by both npm-audit and osv-scanner against the same
        // installed version)
        baseFinding({}),
        baseFinding({ tool: 'osv-scanner' }),
        baseFinding({ tool: 'snyk' }),
        // Distinct advisories
        baseFinding({
          id: 'CVE-2024-0002',
          package: 'lodash',
          fingerprint: 'fp-lodash-med',
          severity: 'medium',
        }),
        baseFinding({
          id: 'CVE-2024-0003',
          package: 'minimatch',
          fingerprint: 'fp-mm-crit',
          severity: 'critical',
        }),
      ],
    };

    const agg = buildSecurityAggregate(input);

    // Raw count = 5 (what envelope.findings.length would show).
    expect(agg.dependencyFindingsRawCount).toBe(5);

    // Unique-by-fingerprint count = 3 (the canonical user-facing total).
    expect(agg.dependencyAdvisoryUniqueCount).toBe(3);

    // Severity buckets sum to the unique count, not the raw count.
    expect(agg.depBySeverity).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
    const bucketSum =
      agg.depBySeverity.critical +
      agg.depBySeverity.high +
      agg.depBySeverity.medium +
      agg.depBySeverity.low;
    expect(bucketSum).toBe(agg.dependencyAdvisoryUniqueCount);

    // findingsByCategory.dependency is the unique set, not raw.
    expect(agg.findingsByCategory.dependency).toHaveLength(3);
  });

  it('preserves the higher-severity representative when fingerprints collide', () => {
    // If the same fingerprint shows up at both MEDIUM (one tool) and
    // HIGH (another tool), we keep the HIGH representative. Mirrors
    // the code-finding `keptSeverity = max` rule.
    const input = emptyInput();
    input.depVulns = {
      tool: 'npm-audit',
      available: true,
      unavailableReason: '',
      findings: [
        {
          id: 'CVE-2024-0001',
          package: 'axios',
          installedVersion: '0.20.0',
          severity: 'medium',
          tool: 'npm-audit',
          fingerprint: 'fp-axios',
        },
        {
          id: 'CVE-2024-0001',
          package: 'axios',
          installedVersion: '0.20.0',
          severity: 'high',
          tool: 'osv-scanner',
          fingerprint: 'fp-axios',
        },
      ],
    };
    const agg = buildSecurityAggregate(input);
    expect(agg.findingsByCategory.dependency).toHaveLength(1);
    expect(agg.findingsByCategory.dependency[0].severity).toBe('high');
    expect(agg.depBySeverity.high).toBe(1);
    expect(agg.depBySeverity.medium).toBe(0);
  });

  it('passes findings without fingerprints through individually (defensive)', () => {
    // Defensive: in normal operation `stampFingerprints` in
    // `gatherDepVulns` runs before the aggregator. But if a producer
    // somehow bypassed that, unstamped findings should pass through
    // as distinct rather than silently merging into one.
    const input = emptyInput();
    input.depVulns = {
      tool: 'npm-audit',
      available: true,
      unavailableReason: '',
      findings: [
        {
          id: 'CVE-A',
          package: 'a',
          severity: 'high',
          tool: 'x',
          // no fingerprint
        },
        {
          id: 'CVE-B',
          package: 'b',
          severity: 'low',
          tool: 'x',
          // no fingerprint
        },
      ],
    };
    const agg = buildSecurityAggregate(input);
    expect(agg.findingsByCategory.dependency).toHaveLength(2);
    expect(agg.dependencyAdvisoryUniqueCount).toBe(2);
  });
});

describe('buildSecurityAggregate — provenance', () => {
  it('distinguishes "tool ran, 0 findings" from "tool didn\'t run"', () => {
    const input = emptyInput();
    // Semgrep ran cleanly, zero findings
    input.codePatterns = { toolUsed: 'semgrep', findings: [] };
    // Secrets scan never ran (gitleaks unavailable)
    input.secrets = { toolUsed: null, findings: [] };
    // TLS-bypass registry has patterns registered (would run if there
    // were any source files); zero findings is a real "no bypass" signal
    input.tlsBypassPatternCount = 17;
    // Dep-audit succeeded
    input.depVulns = {
      tool: 'npm-audit',
      available: true,
      unavailableReason: '',
      findings: [],
    };

    const agg = buildSecurityAggregate(input);

    expect(agg.provenance.codePatterns.ran).toBe(true);
    expect(agg.provenance.codePatterns.tool).toBe('semgrep');

    expect(agg.provenance.secrets.ran).toBe(false);
    expect(agg.provenance.secrets.tool).toBeNull();

    expect(agg.provenance.tlsBypass.ran).toBe(true);
    expect(agg.provenance.tlsBypass.patternCount).toBe(17);

    expect(agg.provenance.depVulns.available).toBe(true);
    expect(agg.provenance.depVulns.tool).toBe('npm-audit');
  });

  it('marks tlsBypass.ran=false when no patterns are registered', () => {
    const input = emptyInput();
    input.tlsBypassPatternCount = 0;
    const agg = buildSecurityAggregate(input);
    expect(agg.provenance.tlsBypass.ran).toBe(false);
  });

  it('captures depVulns unavailable state for the scorer cap signal', () => {
    const input = emptyInput();
    input.depVulns = {
      findings: [],
      tool: null,
      available: false,
      unavailableReason: 'csharp: dotnet list package produced no output',
    };
    const agg = buildSecurityAggregate(input);
    expect(agg.provenance.depVulns.available).toBe(false);
    expect(agg.provenance.depVulns.unavailableReason).toContain('csharp:');
  });
});

describe('buildSecurityAggregate — categorization', () => {
  it('routes secrets to secret category, .env to config, and counts both into secretsBySeverity', () => {
    const input = emptyInput();
    input.secrets = {
      toolUsed: 'gitleaks',
      findings: [
        makeFinding({
          severity: 'critical',
          category: 'secret',
          rule: 'aws-secret',
          tool: 'gitleaks',
          file: 'src/x.ts',
          line: 5,
        }),
      ],
    };
    input.fileFindings = [
      makeFinding({
        severity: 'high',
        category: 'config',
        rule: 'env-in-git',
        tool: 'git',
        file: '.env',
        line: 0,
      }),
      makeFinding({
        severity: 'critical',
        category: 'secret',
        rule: 'private-key-file',
        tool: 'find',
        file: 'keys/server.pem',
        line: 0,
      }),
    ];
    const agg = buildSecurityAggregate(input);

    expect(agg.findingsByCategory.secret).toHaveLength(2);
    expect(agg.findingsByCategory.config).toHaveLength(1);
    expect(agg.findingsByCategory.code).toHaveLength(0);

    // secretsBySeverity covers both `secret` and `config` axes —
    // pre-aggregator code paths agreed on this; the aggregator
    // preserves the convention.
    expect(agg.secretsBySeverity).toEqual({ critical: 2, high: 1, medium: 0, low: 0 });
    // codeBySeverity is untouched by secret/config findings.
    expect(agg.codeBySeverity).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });
});

describe('buildSecurityAggregate — fingerprint stability', () => {
  it('same (canonicalRule, file, lineWindow) input produces same fingerprint across calls', () => {
    const inputA = emptyInput();
    inputA.codePatterns = {
      toolUsed: 'semgrep',
      findings: [
        makeFinding({
          rule: 'bypass-tls-verification',
          tool: 'semgrep',
          file: 'src/x.ts',
          line: 42,
        }),
      ],
    };
    const inputB = emptyInput();
    inputB.codePatterns = {
      toolUsed: 'semgrep',
      findings: [
        makeFinding({
          rule: 'bypass-tls-verification',
          tool: 'semgrep',
          file: 'src/x.ts',
          line: 42,
        }),
      ],
    };

    const a = buildSecurityAggregate(inputA);
    const b = buildSecurityAggregate(inputB);
    expect(a.findingsByCategory.code[0].fingerprint).toBe(b.findingsByCategory.code[0].fingerprint);
  });

  it('line drift within a 3-line window produces the same fingerprint', () => {
    // The D091 case: lines 72 and 74 must hash to the same fingerprint.
    const a = buildSecurityAggregate({
      ...emptyInput(),
      codePatterns: {
        toolUsed: 'semgrep',
        findings: [
          makeFinding({
            rule: 'bypass-tls-verification',
            tool: 'semgrep',
            file: 'src/x.ts',
            line: 72,
          }),
        ],
      },
    });
    const b = buildSecurityAggregate({
      ...emptyInput(),
      codePatterns: {
        toolUsed: 'semgrep',
        findings: [
          makeFinding({
            rule: 'bypass-tls-verification',
            tool: 'semgrep',
            file: 'src/x.ts',
            line: 74,
          }),
        ],
      },
    });
    expect(a.findingsByCategory.code[0].fingerprint).toBe(b.findingsByCategory.code[0].fingerprint);
  });

  it('different files produce different fingerprints even with same rule and line', () => {
    const a = buildSecurityAggregate({
      ...emptyInput(),
      codePatterns: {
        toolUsed: 'semgrep',
        findings: [
          makeFinding({
            rule: 'bypass-tls-verification',
            tool: 'semgrep',
            file: 'src/a.ts',
            line: 10,
          }),
        ],
      },
    });
    const b = buildSecurityAggregate({
      ...emptyInput(),
      codePatterns: {
        toolUsed: 'semgrep',
        findings: [
          makeFinding({
            rule: 'bypass-tls-verification',
            tool: 'semgrep',
            file: 'src/b.ts',
            line: 10,
          }),
        ],
      },
    });
    expect(a.findingsByCategory.code[0].fingerprint).not.toBe(
      b.findingsByCategory.code[0].fingerprint,
    );
  });
});
