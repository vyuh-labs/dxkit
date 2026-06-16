/**
 * Security → baseline-entry producer.
 *
 * Converts the canonical `SecurityAggregate` produced by the security
 * analyzer (`src/analyzers/security/aggregator.ts`) into the per-kind
 * `BaselineEntry` shape stored in the baseline file. Pure function
 * over its input apart from the optional content-hash stamp, which
 * reads the file at the baseline commit via git (skipped when the
 * caller doesn't supply a commit SHA).
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
 * are produced by the sibling `secret-hmac.ts` producer. The two
 * schemes co-exist: a single underlying secret can be represented by
 * both a `secret` entry (location identity, stable across re-runs at
 * the same line) and a `secret-hmac` entry (content identity, stable
 * across file moves).
 *
 * Content-hash stamping (third-pass matcher fallback): when `cwd` +
 * `commitSha` are supplied, the producer reads each file at the
 * baseline commit and hashes the normalized context window around
 * the finding's line. The hash lands in `BaselineEntry.contentHash`
 * for the secret / code / config kinds; the matcher's content-hash
 * pass uses it to pair findings across runs even when git diff can't
 * map the line position. Producers can pass `undefined` for the SHA
 * (e.g., non-git directories) and content-hash matching is simply
 * unavailable for that baseline — the matcher's other passes still
 * work.
 */

import { computeContentHashFromCommit } from '../content-hash';
import type { SecurityAggregate } from '../../analyzers/security/aggregator';
import { identityFor } from '../finding-identity';
import type {
  RichBaselineEntry,
  CodeIdentityInput,
  ConfigIdentityInput,
  DepVulnIdentityInput,
  SecretIdentityInput,
} from '../types';

export interface SecurityProducerOptions {
  /** Repo path; used by `computeContentHashFromCommit` to invoke
   *  `git show`. Omitting it disables content-hash stamping. */
  readonly cwd?: string;
  /** Commit SHA the baseline is anchored to. When the working tree
   *  has uncommitted changes, callers may pass `'HEAD'` so the hash
   *  reflects committed state — content-hash matching against a
   *  later run will still work as long as both sides read the same
   *  SHA. */
  readonly commitSha?: string;
}

/**
 * Build `BaselineEntry`s from a `SecurityAggregate`. Returned in the
 * iteration order of the four categories so the produced baseline
 * stays stable across re-runs of the same scan.
 */
export function securityAggregateToBaselineEntries(
  aggregate: SecurityAggregate,
  options: SecurityProducerOptions = {},
): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];
  const stamp = (file: string, line: number): string | undefined => {
    if (!options.cwd || !options.commitSha || line <= 0) return undefined;
    const hash = computeContentHashFromCommit(options.cwd, options.commitSha, file, line);
    return hash ?? undefined;
  };

  for (const f of aggregate.findingsByCategory.secret) {
    const input: SecretIdentityInput = {
      kind: 'secret',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      // D-G5: the aggregator stamped the final content anchor (secret HMAC)
      // on the finding; pass it so identityFor recomputes the SAME id the
      // finding carries. Absent → identityFor falls back to the line hash.
      ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
    };
    const contentHash = stamp(f.file, f.line);
    out.push({
      id: identityFor(input),
      kind: 'secret',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      ...(contentHash !== undefined ? { contentHash } : {}),
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
      // D-G5: the (scope, spanHash, ordinal) content anchor the aggregator
      // built; passing it reproduces the finding's content fingerprint.
      ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
    };
    const contentHash = stamp(f.file, f.line);
    out.push({
      id: identityFor(input),
      kind: 'code',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      ...(contentHash !== undefined ? { contentHash } : {}),
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
      // D-G5: config (.env-in-git, whole-file at line 0) stays on the
      // line-stable path — the aggregator leaves its anchor unset — so this
      // is normally undefined and identity is unchanged from v1.
      ...(f.contentAnchor !== undefined ? { contentAnchor: f.contentAnchor } : {}),
    };
    // Whole-file findings (`.env in git`) carry line 0; content-hash
    // is meaningless for them and `stamp` returns undefined.
    const contentHash = stamp(f.file, f.line);
    out.push({
      id: identityFor(input),
      kind: 'config',
      tool: f.tool,
      rule: f.rule,
      file: f.file,
      line: f.line,
      ...(contentHash !== undefined ? { contentHash } : {}),
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
      ...(f.installedVersion !== undefined ? { installedVersion: f.installedVersion } : {}),
    };
    out.push(entry);
  }

  return out;
}
