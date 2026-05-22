/**
 * Baseline sanitization — pure transformation that strips every
 * non-identity field from a `BaselineEntry`, producing a
 * `SanitizedBaselineEntry` carrying only `id`, `kind`, and the
 * `sanitized: true` discriminant.
 *
 * # Why sanitization exists
 *
 * A committed-to-git baseline carries human-readable metadata that
 * can leak useful intelligence to anyone with read access to the
 * repo:
 *
 *   - `secret` / `code` / `config` findings disclose the exact file
 *     path + line + rule that flagged them — an attacker reading the
 *     baseline knows where to grep history for the leaked credential
 *     or which insecure call site to inspect first.
 *   - `dep-vuln` findings disclose private package names + installed
 *     versions + advisory ids — discloses internal repo structure
 *     and which CVEs the codebase is currently vulnerable to.
 *   - File paths in any source-anchored kind disclose repo layout
 *     (module boundaries, internal naming conventions).
 *
 * The sanitization pass collapses every entry to identity-only.
 * What's lost:
 *   - The matcher's location-pair pass (no `file` / `line` to
 *     compare across runs); the matcher falls back to identity-
 *     multiset matching, which still works at full confidence for
 *     exact-byte-equality matches.
 *   - The renderer's ability to surface human-readable locators.
 *     `baseline show` collapses to `<sanitized>` for the locator
 *     string.
 *
 * What's preserved:
 *   - The 16-char fingerprint `id`. Cross-run matching works.
 *   - The `kind` discriminant. Severity defaults + classifier
 *     behavior work.
 *   - The full envelope metadata (createdAt, commitSha, tools,
 *     analysis hashes) — none of those carry per-finding sensitive
 *     content.
 *
 * # Public-repo + private-repo posture
 *
 * The two modes that consume sanitization (selected in a later
 * commit alongside the visibility-aware mode picker):
 *   - `committed-full` — store rich entries; default on private
 *     repos with small teams.
 *   - `committed-sanitized` — strip every entry via `sanitizeFile`;
 *     default on public repos and on private repos with
 *     compliance-conscious posture.
 *
 * Pure module — no I/O. The write path applies the transformation
 * before serializing; the read path observes the `sanitized: true`
 * field on each entry and routes consumers accordingly.
 */

import type { BaselineEntry, SanitizedBaselineEntry } from './types';
import type { BaselineFile } from './baseline-file';

/**
 * Type guard: distinguishes a stripped entry from a rich one.
 * Consumers walking a `BaselineEntry` exhaustively call this first
 * so the rest of their switch narrows to the rich union and stays
 * type-safe.
 */
export function isSanitized(entry: BaselineEntry): entry is SanitizedBaselineEntry {
  return (entry as { sanitized?: boolean }).sanitized === true;
}

/**
 * Strip every non-identity field from a single entry. Already-
 * sanitized entries pass through unchanged. `kind` is preserved
 * verbatim; readers can still partition the baseline by kind for
 * count reporting + per-kind severity defaults.
 */
export function sanitizeEntry(entry: BaselineEntry): SanitizedBaselineEntry {
  if (isSanitized(entry)) return entry;
  return { id: entry.id, kind: entry.kind, sanitized: true };
}

/**
 * Apply `sanitizeEntry` to every finding in a baseline file. The
 * envelope (repo, analysis, tools, saltMode, createdAt, etc.)
 * passes through unchanged — none of those fields carry per-finding
 * sensitive content. The resulting file is byte-stable across
 * repeated sanitizations: a sanitized file sanitized again returns
 * an identity-equal file.
 */
export function sanitizeFile(file: BaselineFile): BaselineFile {
  return { ...file, findings: file.findings.map(sanitizeEntry) };
}
