/**
 * Security → baseline-entry producer.
 *
 * Converts the canonical `SecurityAggregate` produced by the security
 * analyzer (`src/analyzers/security/aggregator.ts`) into the per-kind
 * `BaselineEntry` shape stored in the baseline file. Pure function:
 * no I/O, deterministic over its input.
 *
 * Four `BaselineEntry` kinds are derived here, matching the four
 * categories the aggregator emits:
 *
 *   - `findingsByCategory.secret`    → kind: 'secret'
 *   - `findingsByCategory.code`      → kind: 'code'
 *   - `findingsByCategory.config`    → kind: 'config'
 *   - `findingsByCategory.dependency`→ kind: 'dep-vuln'
 *
 * The location-based `secret` entries are sufficient for tracking a
 * secret that stays in the same file. The companion `secret-hmac`
 * scheme (recognizes a leaked token moving files) requires raw
 * secret values that the aggregator doesn't carry — those entries
 * come from the gitleaks-side producer wired in a later phase. The
 * two schemes co-exist: a single secret can be represented by both
 * a `secret` entry (location identity) and a `secret-hmac` entry
 * (content identity).
 */

import type { SecurityAggregate } from '../../analyzers/security/aggregator';
import { identityFor } from '../finding-identity';
import type {
  BaselineEntry,
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
export function securityAggregateToBaselineEntries(aggregate: SecurityAggregate): BaselineEntry[] {
  const out: BaselineEntry[] = [];

  for (const f of aggregate.findingsByCategory.secret) {
    const input: SecretIdentityInput = {
      kind: 'secret',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
    };
    out.push({
      id: identityFor(input),
      kind: 'secret',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
    });
  }

  for (const f of aggregate.findingsByCategory.code) {
    const input: CodeIdentityInput = {
      kind: 'code',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
    };
    out.push({
      id: identityFor(input),
      kind: 'code',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
    });
  }

  for (const f of aggregate.findingsByCategory.config) {
    const input: ConfigIdentityInput = {
      kind: 'config',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
    };
    out.push({
      id: identityFor(input),
      kind: 'config',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
    });
  }

  for (const f of aggregate.findingsByCategory.dependency) {
    const input: DepVulnIdentityInput = {
      kind: 'dep-vuln',
      package: f.package,
      installedVersion: f.installedVersion,
      id: f.id,
    };
    const entry: BaselineEntry = {
      id: identityFor(input),
      kind: 'dep-vuln',
      package: f.package,
      advisoryId: f.id,
      ...(f.installedVersion !== undefined ? { installedVersion: f.installedVersion } : {}),
    };
    out.push(entry);
  }

  return out;
}
