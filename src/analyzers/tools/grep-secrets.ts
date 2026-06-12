/**
 * Pattern-based secret scanner that COMPLEMENTS gitleaks.
 *
 * gitleaks is keyed to known token *formats* (AWS / GitHub / Stripe /
 * private keys) — it is excellent at those and deliberately does NOT
 * flag generic hardcoded credentials like `password = "hunter2"`,
 * because a naive entropy rule floods every codebase with false
 * positives. Verified empirically: gitleaks reports zero on
 * `password = "..."` / `api_key = "..."` assignments.
 *
 * That leaves a real gap: a developer who hardcodes a plain password
 * sails through the guardrail. This provider closes it. The patterns
 * split into two classes:
 *
 *   - GENERIC keyword-assignment secrets (`password`/`secret`/`token` =
 *     a quoted literal). gitleaks misses these, so they run ALWAYS —
 *     they are the complement of gitleaks coverage, not a fallback.
 *   - BRANDED token shapes (AWS keys, GitHub PATs, private keys).
 *     gitleaks covers these with higher precision, so they run ONLY
 *     when gitleaks is absent — full standalone fallback, no
 *     double-counting when both scanners are present.
 *
 * Scanning is in-process via the canonical `walkSourceFiles` walker
 * (not POSIX `grep -r`, which is unavailable on Windows and overflows
 * maxBuffer on large repos). Findings flow through the same SECRETS
 * capability + fingerprint + baseline path as gitleaks, so a hardcoded
 * password gates a push exactly like a leaked AWS key.
 */
import * as fs from 'fs';
import * as path from 'path';
import { findTool, TOOL_DEFS } from './tool-registry';
import { applySuppressions, loadSuppressions } from './suppressions';
import { isTestSourceFile, walkSourceFiles } from './walk-source-files';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { SecretFinding, SecretsResult } from '../../languages/capabilities/types';

interface SecretPattern {
  regex: RegExp;
  rule: string;
}

/**
 * Generic keyword-to-quoted-literal assignments. Case-insensitive; the
 * trailing `["'][^"']{3,}` anchor requires an actual quoted value of at
 * least 3 chars, which is what separates a real hardcoded secret from a
 * config read (`password = config.get("x")` — value isn't a literal),
 * a comparison (`if password ==`), or an empty placeholder
 * (`password = ""`). These run on every scan — gitleaks does not.
 */
const GENERIC_PATTERNS: SecretPattern[] = [
  { regex: /password\s*[:=]\s*["'][^"']{3,}/i, rule: 'hardcoded-password' },
  { regex: /(?:api[_-]?key|apikey)\s*[:=]\s*["'][^"']{3,}/i, rule: 'hardcoded-api-key' },
  { regex: /(?:secret|token|passwd|pwd)\s*[:=]\s*["'][^"']{3,}/i, rule: 'hardcoded-secret' },
];

/**
 * Branded / structured token shapes. gitleaks detects these with higher
 * precision (and fewer false positives), so they only run as a
 * standalone fallback when gitleaks is unavailable.
 */
const BRANDED_PATTERNS: SecretPattern[] = [
  { regex: /BEGIN.*PRIVATE KEY/, rule: 'private-key-in-source' },
  { regex: /AKIA[0-9A-Z]{16}/, rule: 'aws-access-key' },
  { regex: /ghp_[a-zA-Z0-9]{36}/, rule: 'github-token' },
  { regex: /sk-ant-[a-zA-Z0-9]/, rule: 'anthropic-api-key' },
];

function severityFor(rule: string): SecretFinding['severity'] {
  return rule.includes('private-key') || rule.includes('password') ? 'critical' : 'high';
}

/**
 * Scan source files for hardcoded secrets gitleaks doesn't cover (plus
 * the branded fallback set when gitleaks is absent). Never returns null:
 * the generic patterns always contribute, so this provider runs on every
 * analysis rather than yielding wholesale to gitleaks.
 */
export function gatherGrepSecretsResult(cwd: string): SecretsResult | null {
  const gitleaks = findTool(TOOL_DEFS.gitleaks, cwd);
  // Generic keyword-assignment patterns always run (gitleaks misses
  // them). Branded patterns only when gitleaks is absent (it covers them
  // better, and running both would double-count the same AWS key).
  const patterns = gitleaks.available
    ? GENERIC_PATTERNS
    : [...GENERIC_PATTERNS, ...BRANDED_PATTERNS];

  // Canonical walker: project-relative source paths with the resolved
  // exclusion set already applied. includeTests so a password hardcoded
  // in a test still surfaces (a real fixture is allowlisted as
  // `test-fixture`, not silently ignored).
  const files = walkSourceFiles(cwd, { includeTests: true, includeAutogen: true });

  const raw: SecretFinding[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    // Generic keyword-assignment matches inside a test file are almost
    // always fixtures (`password: 'password1'` in a unit test), not
    // committed credentials — flagging them CRITICAL buried a real
    // customer's headline counts under their own test data. Downgrade
    // to low + tag `test-fixture` (still visible, never headline, and
    // excluded from the committed-credentials cap by the score
    // adapter). Branded token shapes keep full severity everywhere: a
    // real AWS key in a test file is still a leaked credential.
    const isTest = isTestSourceFile(rel);
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const sp of patterns) {
        if (sp.regex.test(lines[i])) {
          const fixture = isTest && GENERIC_PATTERNS.includes(sp);
          raw.push({
            file: rel,
            line: i + 1,
            rule: sp.rule,
            severity: fixture ? 'low' : severityFor(sp.rule),
            ...(fixture
              ? {
                  category: 'test-fixture' as const,
                  title: 'Likely test fixture (in a test file) — auto-downgraded',
                }
              : {}),
          });
          break; // at most one finding per line
        }
      }
    }
  }

  // Apply `.dxkit-suppressions.json` under the same key gitleaks uses, so
  // a repo's existing suppressions cover both scanners.
  const suppressions = loadSuppressions(cwd);
  const { kept, suppressed } = applySuppressions(
    raw,
    suppressions.gitleaks,
    (d) => d.rule,
    (d) => d.file,
  );

  return {
    schemaVersion: 1,
    tool: 'grep-secrets',
    findings: kept,
    suppressedCount: suppressed.length,
  };
}

export const grepSecretsProvider: CapabilityProvider<SecretsResult> = {
  source: 'grep-secrets',
  async gather(cwd) {
    return gatherGrepSecretsResult(cwd);
  },
};
