/**
 * Writer for Snyk's `.snyk` policy file — the OUTBOUND half of the
 * Snyk ↔ dxkit suppression sync.
 *
 * 2.9.1 wired the INBOUND direction: dxkit honors SARIF
 * `result.suppressions` so a finding the team dismissed in Snyk is
 * dropped at ingest time (`src/ingest/sarif.ts`). This module is the
 * mirror: when the team allowlists a Snyk-originated finding in dxkit,
 * `allowlist export --snyk` writes a `.snyk` ignore so the decision
 * propagates back to Snyk's own gate (`snyk code test`, the Snyk UI).
 *
 * The `.snyk` file is YAML. dxkit carries no YAML dependency, so this
 * is a small CONTROLLED serializer for exactly the policy shape Snyk's
 * tooling reads — not a general YAML emitter. The structure is fixed:
 *
 *   version: v1.25.0
 *   ignore:
 *     '<rule-id>':
 *       - '<path>':
 *           reason: "<reason>"
 *           expires: <ISO datetime>     # omitted for a permanent ignore
 *           created: <ISO datetime>
 *   patch: {}
 *
 * Caveat surfaced to the user by the CLI: Snyk Code (SAST) honors
 * `.snyk` ignores only when the org has Snyk's "consistent ignores"
 * feature enabled; SCA/dependency ignores are standard. dxkit writes
 * the file either way — the caller documents the prerequisite.
 */

/** One ignore directive — a single (rule, path) pair plus metadata. */
export interface SnykIgnore {
  /** Snyk-native rule / issue id (e.g. `javascript/InsecureTLSConfig`). */
  readonly ruleId: string;
  /** Repo-relative path the ignore applies to. */
  readonly path: string;
  /** Human rationale carried over from the allowlist entry. */
  readonly reason?: string;
  /** ISO 8601 datetime after which the ignore lapses. Omitted →
   *  permanent ignore (Snyk treats a missing `expires` as no expiry). */
  readonly expires?: string;
  /** ISO 8601 datetime the ignore was written. */
  readonly created: string;
}

/** Snyk policy schema version dxkit emits. Matches the version Snyk's
 *  own `snyk ignore` writes for the ignore/patch shape used here. */
export const SNYK_POLICY_VERSION = 'v1.25.0' as const;

/**
 * Convert `.dxkit-ignore` lines (gitignore syntax) into Snyk
 * `exclude.global` glob patterns — the path-exclusion half of the
 * dxkit ↔ Snyk sync, mirroring how allowlist entries become `.snyk`
 * ignores. A directory dxkit skips for analysis should be a directory
 * Snyk skips too, so the two tools agree on what's out of scope.
 *
 * Conversion (conservative — Snyk globs are path-relative):
 *   - `#` comments and blank lines are dropped.
 *   - Negations (`!pat`) are dropped: Snyk's exclude list has no
 *     re-include, and silently inverting one would be worse than
 *     omitting it.
 *   - A leading `/` (gitignore "anchored to root") is stripped.
 *   - A trailing `/` (explicit directory) → `dir/**`.
 *   - A bare name with no glob metacharacter (e.g. `vendor`,
 *     `generated`) is treated as a directory → `vendor/**`.
 *   - Anything already carrying a glob (`*.generated.ts`,
 *     `fixtures/**`) passes through unchanged.
 * Results are de-duplicated, order-preserving.
 */
export function dxkitIgnoreLinesToSnykExcludes(lines: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    let pat = line.replace(/^\/+/, ''); // strip anchoring leading slash
    if (!pat) continue;
    if (pat.endsWith('/')) {
      pat = `${pat}**`;
    } else if (!/[*?[\]]/.test(pat)) {
      // No glob metacharacter → a plain path. Treat as a directory so a
      // bare `vendor` excludes its whole subtree (gitignore semantics),
      // not just a single file named `vendor`.
      pat = `${pat}/**`;
    }
    if (!seen.has(pat)) {
      seen.add(pat);
      out.push(pat);
    }
  }
  return out;
}

/**
 * Convert an allowlist entry's `expiresAt` (`YYYY-MM-DD`) into the ISO
 * datetime Snyk's policy file expects. Returns `undefined` for a
 * missing date so the caller emits a permanent ignore.
 */
export function expiryToSnykDatetime(expiresAt: string | undefined): string | undefined {
  if (!expiresAt) return undefined;
  return `${expiresAt}T00:00:00.000Z`;
}

/**
 * Serialize ignores into `.snyk` policy YAML. Groups by rule id (the
 * file's top-level ignore key), each carrying a list of per-path
 * directives. Deterministic ordering (rules + paths sorted) so the
 * committed file has stable diffs across runs.
 */
export function buildSnykPolicy(
  ignores: ReadonlyArray<SnykIgnore>,
  excludes: ReadonlyArray<string> = [],
): string {
  const byRule = new Map<string, SnykIgnore[]>();
  for (const ig of ignores) {
    const list = byRule.get(ig.ruleId) ?? [];
    list.push(ig);
    byRule.set(ig.ruleId, list);
  }

  const lines: string[] = [
    '# Snyk (https://snyk.io) policy file, written by dxkit allowlist export.',
    `version: ${SNYK_POLICY_VERSION}`,
  ];

  if (byRule.size === 0) {
    lines.push('ignore: {}');
  } else {
    lines.push('ignore:');
    for (const ruleId of [...byRule.keys()].sort()) {
      lines.push(`  ${quoteKey(ruleId)}:`);
      const perPath = byRule.get(ruleId)!;
      // Stable order + one directive per unique path.
      const seen = new Set<string>();
      for (const ig of perPath.slice().sort((a, b) => a.path.localeCompare(b.path))) {
        if (seen.has(ig.path)) continue;
        seen.add(ig.path);
        lines.push(`    - ${quoteKey(ig.path)}:`);
        lines.push(`        reason: ${doubleQuote(ig.reason ?? '')}`);
        if (ig.expires) lines.push(`        expires: ${ig.expires}`);
        lines.push(`        created: ${ig.created}`);
      }
    }
  }
  lines.push('patch: {}');

  // exclude.global — the path-exclusion half of the dxkit ↔ Snyk sync,
  // sourced from `.dxkit-ignore`. Emitted only when present so an
  // ignore-only export keeps its prior byte-for-byte shape.
  if (excludes.length > 0) {
    lines.push('exclude:');
    lines.push('  global:');
    for (const pat of excludes) {
      lines.push(`    - ${quoteKey(pat)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ─── Minimal scalar quoting ───────────────────────────────────────────────

/** Single-quote a YAML key/scalar, escaping embedded single quotes by
 *  doubling (the YAML single-quote rule). Used for rule ids + paths,
 *  which never contain newlines. */
function quoteKey(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Double-quote a YAML scalar. JSON's string encoding is a valid YAML
 *  double-quoted flow scalar (YAML is a JSON superset), so JSON.stringify
 *  gives correct escaping for reasons that may carry quotes, colons, or
 *  other special characters. */
function doubleQuote(value: string): string {
  return JSON.stringify(value);
}
