/**
 * Acceptance gate for content-anchored finding identity.
 *
 * Reproduces the failure mode that motivated content-anchored identity:
 * when a finding's identity hashed its line number, any unrelated edit
 * that shifted the finding more than the 3-line bucket re-minted its
 * identity — which silently stranded the allowlist entry pinned to the
 * old identity, so a reviewed-and-accepted finding came back as if new.
 *
 * Content-anchored identity hashes WHAT a finding is (a secret's salted
 * HMAC; a code finding's enclosing-symbol + matched-span + ordinal), not
 * WHERE it sits, so the identity is stable across line moves. This test
 * plants a real hardcoded secret, scans it end-to-end through the real
 * pipeline (in-process grep-secrets gather -> buildSecurityAggregate ->
 * allowlist annotator — not a mock, so a regression in any layer fails
 * the gate), allowlists it by its content fingerprint, shifts it 20 lines
 * down, and re-scans. The allowlist MUST still match.
 *
 * The in-process grep-secrets scanner avoids any external-tool dependency
 * (gitleaks/semgrep); the deterministic salt is supplied via
 * DXKIT_BASELINE_SALT so the HMAC content anchor is reproducible across
 * both scans without needing a git repo in the temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gatherGrepSecretsResult } from '../../src/analyzers/tools/grep-secrets';
import {
  buildSecurityAggregate,
  type SecurityAggregateInput,
  type SecurityFinding,
} from '../../src/analyzers/security/aggregator';
import { canonicalRuleFor, computeCodeFingerprint } from '../../src/analyzers/tools/fingerprint';
import type { AllowlistFile } from '../../src/allowlist/file';

let dir: string;
let savedSalt: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dxkit-dg5-accept-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  savedSalt = process.env.DXKIT_BASELINE_SALT;
  // Deterministic salt → reproducible HMAC content anchor across scans,
  // without needing a git repo in the temp dir.
  process.env.DXKIT_BASELINE_SALT = 'dg5-acceptance-fixed-salt';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedSalt === undefined) delete process.env.DXKIT_BASELINE_SALT;
  else process.env.DXKIT_BASELINE_SALT = savedSalt;
});

/** Reshape the grep-secrets envelope into the aggregator's input shape
 *  (mirrors `gatherSecrets`), carrying the content anchor through. */
function secretsInput(cwd: string): SecurityAggregateInput {
  const res = gatherGrepSecretsResult(cwd);
  const findings: SecurityFinding[] = (res?.findings ?? []).map((f) => ({
    severity: f.severity,
    category: 'secret' as const,
    cwe: 'CWE-798',
    rule: f.rule,
    title: f.title ?? `Secret detected: ${f.rule}`,
    file: f.file,
    line: f.line,
    tool: 'grep-secrets',
    ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
  }));
  return {
    secrets: { findings, toolUsed: 'grep-secrets' },
    fileFindings: [],
    codePatterns: { findings: [], toolUsed: null },
    tlsBypass: [],
    tlsBypassPatternCount: 0,
    depVulns: { findings: [], tool: null, available: true, unavailableReason: '' },
  };
}

const SECRET_LINE = 'const password = "s3cr3t-not-a-real-credential-123";\n';

describe('content-anchored identity — allowlist survives a >3-line shift', () => {
  it('a content-anchored secret stays allowlisted after shifting 20 lines down', () => {
    const file = join(dir, 'src', 'config.ts');

    // ── First scan: secret near the top of the file ──
    writeFileSync(file, `export const a = 1;\n${SECRET_LINE}export const b = 2;\n`);
    const agg1 = buildSecurityAggregate(secretsInput(dir));
    expect(agg1.findingsByCategory.secret).toHaveLength(1);
    const before = agg1.findingsByCategory.secret[0];
    const fp = before.fingerprint;
    expect(before.contentAnchor).toBeTruthy(); // HMAC anchor resolved (salt present)

    // Allowlist it by its content fingerprint.
    const allowlist: AllowlistFile = {
      schemaVersion: 'dxkit-allowlist/v1',
      mode: 'full',
      entries: [
        {
          fingerprint: fp,
          kind: 'secret',
          category: 'false-positive',
          reason: 'fixture',
          addedBy: 't@t.t',
          addedAt: '2026-06-16',
        },
      ],
    };

    // ── Edit: prepend 20 lines, shifting the secret far past the 3-line
    //    window (the exact motion that used to strand the allowlist). ──
    const padded = `${'\n'.repeat(20)}export const a = 1;\n${SECRET_LINE}export const b = 2;\n`;
    writeFileSync(file, padded);

    const agg2 = buildSecurityAggregate({ ...secretsInput(dir), allowlist });
    expect(agg2.findingsByCategory.secret).toHaveLength(1);
    const after = agg2.findingsByCategory.secret[0];

    // The finding genuinely moved...
    expect(after.line).toBeGreaterThan(before.line);
    expect(after.line - before.line).toBeGreaterThan(3);
    // ...yet its identity is unchanged...
    expect(after.fingerprint).toBe(fp);
    // ...so the allowlist still suppresses it. THE regression gate.
    expect(after.allowlisted).toBe(true);
    expect(after.allowlistCategory).toBe('false-positive');

    // Contrast: the OLD line-based identity WOULD have changed across the
    // shift — proving the fix is what saved the match, not luck.
    const canonical = canonicalRuleFor('grep-secrets', before.rule);
    expect(computeCodeFingerprint(canonical, before.file, before.line)).not.toBe(
      computeCodeFingerprint(canonical, after.file, after.line),
    );
  });
});
