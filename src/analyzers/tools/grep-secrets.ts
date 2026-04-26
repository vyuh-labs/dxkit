/**
 * Grep-based secret scanner — the 7-pattern fallback that runs when
 * gitleaks is unavailable. Re-registered under `GLOBAL_CAPABILITIES.secrets`
 * in Phase 10e.C.7.5 after `generic.ts`'s legacy Layer-0 equivalent was
 * deleted alongside the capability-owned `HealthMetrics.secretDetails`.
 *
 * When gitleaks IS available, this provider returns null — gitleaks's
 * 800+ rules are a strict superset, and running both would double-count
 * overlapping matches (AWS keys, GitHub tokens, Anthropic keys). The
 * SECRETS descriptor aggregate unions findings, so a null from this
 * provider simply yields to gitleaks. That mirrors pre-C.7 behavior
 * exactly: gitleaks dominates when installed, grep carries the signal
 * when it isn't.
 */
import * as path from 'path';
import { run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { getGrepExcludeDirFlags, isExcludedPath } from './exclusions';
import { toProjectRelative } from './paths';
import { applySuppressions, loadSuppressions } from './suppressions';
import { allSourceExtensions } from '../../languages';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { SecretFinding, SecretsResult } from '../../languages/capabilities/types';

interface GrepPattern {
  pattern: string;
  rule: string;
}

/**
 * Seven patterns that catch the most common hardcoded-secret shapes.
 * Mirrors the set that lived in `generic.ts` pre-C.7, with identical
 * rule IDs so downstream reports stay stable.
 */
const PATTERNS: GrepPattern[] = [
  { pattern: 'password[[:space:]]*[:=]', rule: 'hardcoded-password' },
  { pattern: 'api[_-]?key[[:space:]]*[:=]', rule: 'hardcoded-api-key' },
  { pattern: 'secret[[:space:]]*[:=]', rule: 'hardcoded-secret' },
  { pattern: 'BEGIN.*PRIVATE KEY', rule: 'private-key-in-source' },
  { pattern: 'AKIA[0-9A-Z]{16}', rule: 'aws-access-key' },
  { pattern: 'ghp_[a-zA-Z0-9]{36}', rule: 'github-token' },
  { pattern: 'sk-ant-[a-zA-Z0-9]', rule: 'anthropic-api-key' },
];

function severityFor(rule: string): SecretFinding['severity'] {
  return rule.includes('private-key') || rule.includes('password') ? 'critical' : 'high';
}

/** Scan source files for the fallback patterns. Returns null when gitleaks is installed. */
export function gatherGrepSecretsResult(cwd: string): SecretsResult | null {
  // Yield to gitleaks — superset coverage, no point running both. When
  // gitleaks is absent `findTool` returns `available: false` and we proceed
  // with the fallback scan.
  const gitleaks = findTool(TOOL_DEFS.gitleaks, cwd);
  if (gitleaks.available) return null;

  const excludes = getGrepExcludeDirFlags(cwd);
  // Pack-driven include flags (Phase 10i.0-LP.3). Replaces the prior
  // hardcoded `.ts/.tsx/.js/.py/.go` set with all packs'
  // `sourceExtensions`. Behavior expansion: `.cs` and `.rs` files are
  // now scanned for secrets when gitleaks is unavailable. The legacy
  // hardcoded set was a subset oversight — gitleaks (the primary
  // scanner) covers all file types, so the fallback should too.
  const includeFlags = allSourceExtensions()
    .map((e) => `--include='*${e}'`)
    .join(' ');

  const raw: SecretFinding[] = [];
  for (const sp of PATTERNS) {
    // Single-quoted pattern + -E for extended regex. Per the feedback memory.
    const output = run(
      `grep -rnE '${sp.pattern}' ${includeFlags} ${excludes} . 2>/dev/null | head -50`,
      cwd,
    );
    if (!output) continue;
    for (const line of output.split('\n').filter((l) => l.trim())) {
      // Format: ./relative/path:lineno:matched-text
      const match = line.match(/^\.\/(.+?):(\d+):/);
      if (!match) continue;
      const file = toProjectRelative(cwd, path.join(cwd, match[1]));
      if (isExcludedPath(cwd, file)) continue;
      raw.push({
        file,
        line: parseInt(match[2], 10),
        rule: sp.rule,
        severity: severityFor(sp.rule),
      });
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
