/**
 * Stale-allow → baseline-entry producer.
 *
 * Detects orphaned inline allowlist annotations — `dxkit-allow:`
 * comments in source files that no longer match any current
 * finding. The developer added the annotation when something was
 * flagged; the finding is now gone (resolved, scanner-rule changed,
 * code refactored); the annotation is dead code that should be
 * removed.
 *
 * # The matching contract
 *
 * An annotation at `(file, line)` is considered ACTIVE when at
 * least one current finding lands at the same `(file, lineWindow)` —
 * the 3-line window from `lineWindowFor` absorbs small formatter /
 * line-shift drift so a still-relevant annotation doesn't get
 * flagged stale by an unrelated edit.
 *
 * Annotations with no matching finding emit a `stale-allow`
 * `BaselineEntry` whose identity is `(file, lineWindow, category)`.
 * The strict-stale model (TypeScript's `@ts-expect-error` pattern)
 * forces the developer to clean up — preventing the annotation
 * graveyard pattern common to less strict tools.
 *
 * # What counts as a "covered location"
 *
 * Source-anchored finding kinds — `secret`, `code`, `config` —
 * carry `(file, line)` and contribute to the covered set. The
 * `findingsByCategory` arrays on the canonical `SecurityAggregate`
 * are the only source today; the aggregator is the single canonical
 * fingerprint-deduped source of these findings (CLAUDE.md G_v4_8).
 *
 * Kinds without `(file, line)` — `dep-vuln`, `duplication`,
 * `secret-hmac`, `license`, etc. — never participate in inline-
 * annotation matching by construction. Annotations targeting those
 * findings always use the file-level allowlist.
 *
 * # Mode handling
 *
 * `staleHandling` lives in `.dxkit/policy.json` (out of scope for
 * this producer — the orchestrator gates whether to call it). When
 * called, the producer emits `stale-allow` entries unconditionally
 * for every orphan; the policy-level "lenient mode" surfaces these
 * as warnings in the renderer rather than as blocking entries.
 */

import { lineWindowFor } from '../../analyzers/tools/fingerprint';
import type { SecurityAggregate } from '../../analyzers/security/aggregator';
import type { InlineAllowlistOccurrence } from '../../allowlist/gather';
import { computeContentHashFromCommit } from '../content-hash';
import { identityFor } from '../finding-identity';
import type { RichBaselineEntry, StaleAllowIdentityInput } from '../types';

export interface StaleAllowInput {
  readonly annotations: ReadonlyArray<InlineAllowlistOccurrence>;
  readonly aggregate: SecurityAggregate | null;
  /** Repo + baseline commit. When present, each stale entry is stamped with a
   * `contentHash` of the annotation's surrounding context, so the matcher's
   * content-hash pass relocates it without git (the line-bucketed identity
   * re-mints on a >window shift). Best-effort: omitted when absent or the file
   * can't be read at the commit. */
  readonly commit?: { readonly cwd: string; readonly commitSha: string };
}

/**
 * Build `stale-allow` entries from the annotation list + the
 * canonical security aggregate. Deterministic over equal inputs; the
 * only I/O is the best-effort `contentHash` read when `input.commit`
 * is supplied (reading the annotation's context from the baseline
 * commit, same as the secret/code producer).
 *
 * Returns an empty array when:
 *   - The annotation list is empty (nothing to check).
 *   - The aggregate is null AND the annotation list is empty.
 *
 * When the aggregate is null but annotations exist, the producer
 * conservatively emits NO stale entries — the caller has no way to
 * know whether annotations are active or stale without the
 * findings. Surfacing "everything is stale" in that scenario would
 * be wrong; surfacing "everything is fine" is also wrong but less
 * actively misleading.
 */
export function staleAllowToBaselineEntries(input: StaleAllowInput): RichBaselineEntry[] {
  if (input.annotations.length === 0) return [];
  if (input.aggregate === null) return [];

  const covered = buildCoveredLocations(input.aggregate);
  const out: RichBaselineEntry[] = [];
  for (const occ of input.annotations) {
    const key = locationKey(occ.file, occ.line);
    if (covered.has(key)) continue; // active suppression — not stale
    const identityInput: StaleAllowIdentityInput = {
      kind: 'stale-allow',
      file: occ.file,
      line: occ.line,
      category: occ.category,
    };
    const contentHash = input.commit
      ? (computeContentHashFromCommit(
          input.commit.cwd,
          input.commit.commitSha,
          occ.file,
          occ.line,
        ) ?? undefined)
      : undefined;
    out.push({
      id: identityFor(identityInput),
      kind: 'stale-allow',
      file: occ.file,
      line: occ.line,
      category: occ.category,
      ...(contentHash !== undefined ? { contentHash } : {}),
    });
  }
  return out;
}

// ─── Internals ────────────────────────────────────────────────────────────

function buildCoveredLocations(aggregate: SecurityAggregate): Set<string> {
  const out = new Set<string>();
  for (const f of aggregate.findingsByCategory.secret) {
    out.add(locationKey(f.file, f.line));
  }
  for (const f of aggregate.findingsByCategory.code) {
    out.add(locationKey(f.file, f.line));
  }
  for (const f of aggregate.findingsByCategory.config) {
    out.add(locationKey(f.file, f.line));
  }
  return out;
}

function locationKey(file: string, line: number): string {
  return `${file}\0${lineWindowFor(line)}`;
}
