/**
 * Identity-scheme migrator — carries a repo's baseline + allowlist across
 * a finding-identity scheme change so an upgrade is a single command
 * instead of a manual re-baseline + re-allowlist.
 *
 * The mechanism rests on two properties:
 *
 *   1. `identityFor` can compute ANY shipped scheme (see
 *      `finding-identity.ts`), so for each current finding we can derive
 *      both its OLD-scheme id and its NEW-scheme id.
 *   2. A current scan's baseline entries already carry the NEW (current)
 *      scheme id; recomputing the OLD id from each entry's metadata yields
 *      an `old → new` remap built from one scan, with no dependency on the
 *      stale artifact's stored ids.
 *
 * From that remap we:
 *   - rewrite the allowlist's `fingerprint`s onto the new scheme
 *     (preserving every reviewed suppression decision), and
 *   - regenerate the baseline with fresh new-scheme ids.
 *
 * Allowlist entries whose fingerprint matches neither the remap NOR a
 * current finding's id are surfaced as `unmapped` (the finding they
 * suppressed is gone — already-stale entries), never silently dropped.
 *
 * This is general across schemes: only the version-VARYING finding kinds
 * change id between two schemes (everything else maps to itself and is
 * left untouched), and `identityFor` + the retained prior-scheme id
 * functions handle any `from → to` pair. A future scheme needs no new
 * wiring here.
 */

import { createBaseline, gatherCurrentScan } from './create';
import { identityFor } from './finding-identity';
import { isSanitized } from './sanitize';
import { CURRENT_IDENTITY_SCHEME } from './types';
import type {
  BaselineEntry,
  IdentityInput,
  IdentitySchemeVersion,
  RichBaselineEntry,
} from './types';
import { loadAllowlist, saveAllowlist } from '../allowlist/file';
import type { AllowlistEntry } from '../allowlist/file';

export interface MigrationResult {
  readonly fromScheme: IdentitySchemeVersion;
  readonly toScheme: IdentitySchemeVersion;
  /** Number of `old → new` id pairs whose id actually changed between the
   *  two schemes (version-independent kinds are excluded). */
  readonly remapSize: number;
  readonly allowlistTotal: number;
  /** Allowlist entries whose fingerprint was rewritten onto the new scheme. */
  readonly allowlistRemapped: number;
  /** Allowlist entries left unchanged because they already match a current
   *  finding under the new scheme (version-independent kinds / already
   *  current) — not a problem. */
  readonly allowlistUnchanged: number;
  /** Allowlist entries that match no current finding at all — the finding
   *  they suppressed is gone (already-stale). Surfaced for review. */
  readonly allowlistUnmapped: ReadonlyArray<AllowlistEntry>;
  /** Path of the regenerated baseline, or null when none was written
   *  (e.g. ref-based repos hold no committed baseline). */
  readonly baselinePath: string | null;
}

/**
 * Reconstruct the `IdentityInput` a baseline entry was minted from, so its
 * id can be recomputed under a different scheme. Fidelity is sufficient to
 * reproduce any scheme's id: `contentAnchor` is intentionally omitted —
 * only the v2 code/secret path consumes it, and an entry's stored `id`
 * already IS its current-scheme id (we never recompute the current id, only
 * the prior one, which no scheme derives from the anchor). Returns
 * `undefined` for sanitized entries (identity-only, no metadata).
 */
export function baselineEntryToIdentityInput(entry: BaselineEntry): IdentityInput | undefined {
  if (isSanitized(entry)) return undefined;
  const e = entry as RichBaselineEntry;
  switch (e.kind) {
    case 'secret':
    case 'code':
    case 'config':
      return { kind: e.kind, tool: e.tool, rule: e.rule, file: e.file, line: e.line };
    case 'dep-vuln':
      return {
        kind: 'dep-vuln',
        package: e.package,
        installedVersion: e.installedVersion,
        id: e.advisoryId,
      };
    case 'duplication':
      return {
        kind: 'duplication',
        fileA: e.fileA,
        fileB: e.fileB,
        lines: e.lines,
        startLineA: e.startLineA,
        startLineB: e.startLineB,
      };
    case 'coverage-gap':
      return { kind: 'coverage-gap', file: e.file, symbol: e.symbol, lineRange: e.lineRange };
    case 'test-gap':
      return { kind: 'test-gap', file: e.file, risk: e.risk };
    case 'hygiene':
      return { kind: 'hygiene', file: e.file, line: e.line, marker: e.marker };
    case 'test-file-degradation':
      return { kind: 'test-file-degradation', file: e.file, status: e.status };
    case 'god-file':
      return { kind: 'god-file', file: e.file };
    case 'stale-file':
      return { kind: 'stale-file', file: e.file, suffix: e.suffix };
    case 'large-file':
      return { kind: 'large-file', file: e.file };
    case 'secret-hmac':
      return { kind: 'secret-hmac', tool: e.tool, rule: e.rule, hmac: e.hmac };
    case 'stale-allow':
      return { kind: 'stale-allow', file: e.file, line: e.line, category: e.category };
  }
}

/**
 * Build an `old → new` id remap from a current scan's entries. Each
 * entry's own `id` is the new (current) scheme id; the old id is
 * recomputed from its reconstructed input. Only ids that actually change
 * between the two schemes enter the map — version-independent kinds map to
 * themselves and are skipped. Pure.
 */
export function buildIdentityRemap(
  entries: ReadonlyArray<BaselineEntry>,
  from: IdentitySchemeVersion,
): Map<string, string> {
  const remap = new Map<string, string>();
  for (const entry of entries) {
    const input = baselineEntryToIdentityInput(entry);
    if (!input) continue;
    // The migrator legitimately recomputes a prior-scheme id to build the
    // remap — it consumes identity, it doesn't mint a new finding kind.
    const fromId = identityFor(input, from); // rule10-producer-ok
    if (fromId !== entry.id) remap.set(fromId, entry.id);
  }
  return remap;
}

/**
 * Migrate a repo's baseline + allowlist from `from` scheme to the current
 * scheme: one scan, rewrite the allowlist through the remap, regenerate
 * the baseline. Idempotent in spirit — running it when already current
 * produces an empty remap and a re-stamped baseline. Returns a summary the
 * caller renders.
 */
export async function migrateIdentity(opts: {
  readonly cwd: string;
  readonly from: IdentitySchemeVersion;
  readonly verbose?: boolean;
}): Promise<MigrationResult> {
  const { cwd } = opts;
  const to = CURRENT_IDENTITY_SCHEME;

  // One scan: entries carry the new-scheme ids; the remap recomputes the
  // old id per entry.
  const scan = await gatherCurrentScan({ cwd, verbose: opts.verbose });
  const remap = buildIdentityRemap(scan.findings, opts.from);
  const currentIds = new Set(scan.findings.map((f) => f.id));

  // Rewrite the allowlist, preserving reviewed decisions.
  const allowlist = loadAllowlist(cwd);
  let remapped = 0;
  let unchanged = 0;
  const unmapped: AllowlistEntry[] = [];
  if (allowlist) {
    const entries = allowlist.entries.map((entry) => {
      const next = remap.get(entry.fingerprint);
      if (next !== undefined) {
        remapped++;
        return { ...entry, fingerprint: next };
      }
      // Not in the remap: either it already matches a current finding
      // (version-independent kind / already current scheme) — leave it —
      // or it matches nothing (the suppressed finding is gone) — flag it.
      if (currentIds.has(entry.fingerprint)) unchanged++;
      else unmapped.push(entry);
      return entry;
    });
    saveAllowlist(cwd, { ...allowlist, identityScheme: to, entries });
  }

  // Regenerate the baseline with fresh new-scheme ids + stamped scheme.
  const created = await createBaseline({ cwd, force: true, verbose: opts.verbose });

  return {
    fromScheme: opts.from,
    toScheme: to,
    remapSize: remap.size,
    allowlistTotal: allowlist?.entries.length ?? 0,
    allowlistRemapped: remapped,
    allowlistUnchanged: unchanged,
    allowlistUnmapped: unmapped,
    baselinePath: created.path ?? null,
  };
}
