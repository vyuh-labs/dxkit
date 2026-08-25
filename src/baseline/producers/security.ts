/**
 * Security → baseline-entry producer.
 *
 * Converts the canonical `SecurityAggregate` produced by the security
 * analyzer (`src/analyzers/security/aggregator.ts`) into the per-kind
 * `BaselineEntry` shape stored in the baseline file. Pure function
 * over its input — a pure map from the aggregate to entries. The
 * `contentHash` stamp is applied by the ORCHESTRATOR (`stampEntries`
 * in content-stamp.ts), never per producer.
 *
 * Four `BaselineEntry` kinds are derived here, matching the four
 * categories the aggregator emits:
 *
 * - `findingsByCategory.secret` → kind: 'secret'
 * - `findingsByCategory.code` → kind: 'code'
 * - `findingsByCategory.config` → kind: 'config'
 * - `findingsByCategory.dependency`→ kind: 'dep-vuln'
 *
 * The location-based `secret` entries are sufficient for tracking a
 * secret that stays in the same file. The companion `secret-hmac`
 * scheme (recognizes a leaked token moving files) requires raw
 * secret values that the aggregator doesn't carry — those entries
 * are produced by the sibling `secret-hmac.ts` producer. The two
 * schemes co-exist: a single underlying secret can be represented by
 * both a `secret` entry (location identity, stable across re-runs at
 * the same line) and a `secret-hmac` entry (content identity, stable
 * across file moves).
 *
 * Content-hash stamping lives in the orchestrator (content-stamp.ts):
 * producers emit bare entries; `stampEntries` hashes every located one
 * from the working tree the findings were scanned on.
 */

import type { SecurityAggregate } from '../../analyzers/security/aggregator';
import { identityFor } from '../finding-identity';
import type {
  RichBaselineEntry,
  CodeIdentityInput,
  ConfigIdentityInput,
  DepVulnIdentityInput,
  SecretIdentityInput,
} from '../types';

/**
 * Build `BaselineEntry`s from a `SecurityAggregate`. Returned in the
 * iteration order of the four categories so the produced baseline
 * stays stable across re-runs of the same scan.
 */
export function securityAggregateToBaselineEntries(
  aggregate: SecurityAggregate,
): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];

  for (const f of aggregate.findingsByCategory.secret) {
    const input: SecretIdentityInput = {
      kind: 'secret',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      // Content-anchored identity: the aggregator stamped the final content anchor (secret HMAC)
      // on the finding; pass it so identityFor recomputes the SAME id the
      // finding carries. Absent → identityFor falls back to the line hash.
      ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
    };
    out.push({
      id: identityFor(input),
      kind: 'secret',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.absorbedFingerprints && f.absorbedFingerprints.length > 0
        ? { absorbedFingerprints: f.absorbedFingerprints }
        : {}),
    });
  }

  for (const f of aggregate.findingsByCategory.code) {
    const input: CodeIdentityInput = {
      kind: 'code',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      // Content-anchored identity: the (scope, spanHash, ordinal) content anchor the aggregator
      // built; passing it reproduces the finding's content fingerprint.
      ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
    };
    out.push({
      id: identityFor(input),
      kind: 'code',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.absorbedFingerprints && f.absorbedFingerprints.length > 0
        ? { absorbedFingerprints: f.absorbedFingerprints }
        : {}),
    });
  }

  for (const f of aggregate.findingsByCategory.config) {
    const input: ConfigIdentityInput = {
      kind: 'config',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      // Content-anchored identity: config (.env-in-git, whole-file at line 0) stays on the
      // line-stable path — the aggregator leaves its anchor unset — so this
      // is normally undefined and identity is unchanged from v1.
      ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
    };
    // Whole-file findings (`.env in git`) carry line 0; content-hash
    // is meaningless for them and `stamp` returns undefined.
    out.push({
      id: identityFor(input),
      kind: 'config',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.absorbedFingerprints && f.absorbedFingerprints.length > 0
        ? { absorbedFingerprints: f.absorbedFingerprints }
        : {}),
    });
  }

  for (const f of aggregate.findingsByCategory.dependency) {
    const input: DepVulnIdentityInput = {
      kind: 'dep-vuln',
      package: f.package,
      installedVersion: f.installedVersion,
      id: f.id,
      ...(f.aliases !== undefined ? { aliases: f.aliases } : {}),
    };
    const entry: RichBaselineEntry = {
      id: identityFor(input),
      kind: 'dep-vuln',
      package: f.package,
      advisoryId: f.id,
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.installedVersion !== undefined ? { installedVersion: f.installedVersion } : {}),
    };
    out.push(entry);
  }

  return out;
}
