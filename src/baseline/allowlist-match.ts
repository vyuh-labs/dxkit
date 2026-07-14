/**
 * Match a stored/produced `BaselineEntry` against the effective allowlist —
 * the ONE predicate for "is this finding actively suppressed" (CLAUDE.md
 * Rule 2), and the ONE partition of a finding set into live vs allowlisted.
 *
 * The suppression predicate lived in `check.ts` (the guardrail's only
 * consumer). `baseline create` also needs it — an actively-allowlisted finding
 * must be kept OUT of the captured baseline so it never grandfathers as
 * `persisted` and its allowlist expiry stays load-bearing (gh #155). Rather
 * than re-derive the fingerprint-candidate + expiry logic (the exact
 * duplication that shipped the bug), both consumers import from here.
 *
 * It sits in the baseline layer, not `src/allowlist/`, because the predicate
 * reasons over `BaselineEntry` shapes (sanitized vs rich, `absorbedFingerprints`)
 * — and importing it here (rather than from `check.ts`) also breaks the
 * `check.ts ⇄ create.ts` import cycle: `create.ts` needs the predicate but
 * `check.ts` imports `gatherCurrentScan` from `create.ts`.
 */

import type { AllowlistCategory } from '../allowlist/categories';
import type { AllowlistableFinding } from '../allowlist/effective';
import { findEntry, isEntryActive } from '../allowlist/file';
import type { AllowlistFile } from '../allowlist/file';
import { entryToLocated } from './entry-to-located';
import { isSanitized } from './sanitize';
import type { BaselineEntry } from './types';

/**
 * Why a would-block finding didn't block: an active allowlist entry accepted
 * it. Carries the audit fields a reviewer needs to judge the suppression at a
 * glance (category + expiry), keyed by the matched fingerprint.
 */
export interface AllowlistSuppression {
  readonly fingerprint: string;
  readonly category: AllowlistCategory;
  /** ISO `YYYY-MM-DD` expiry when the entry carries one; absent for
   *  non-expiring categories. */
  readonly expiresAt?: string;
}

/**
 * The active allowlist entry that suppresses `anchorEntry`, or `undefined`.
 * Matches on the entry's candidate fingerprints AND kind (ruling out an
 * astronomically-unlikely cross-kind hash collision), and skips EXPIRED
 * entries via `isEntryActive` — so a finding re-surfaces the moment its
 * suppression window lapses. Non-expiring categories (`test-fixture`,
 * `false-positive`, `mitigated-externally`) are always active.
 */
export function allowlistSuppressionFor(
  allowlist: AllowlistFile,
  anchorEntry: BaselineEntry,
  now: Date,
): AllowlistSuppression | undefined {
  for (const fp of candidateFingerprints(anchorEntry)) {
    const entry = findEntry(allowlist, fp);
    if (!entry || entry.kind !== anchorEntry.kind) continue;
    if (!isEntryActive(entry, now)) continue;
    return {
      fingerprint: entry.fingerprint,
      category: entry.category,
      ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
    };
  }
  return undefined;
}

/**
 * Fingerprints an allowlist entry may match against for one finding: the
 * representative `id` first (most direct), then any absorbed contributing
 * fingerprints. Absorbed fingerprints live only on the rich secret/code/config
 * variant — a sanitized entry carries id only.
 */
function candidateFingerprints(entry: BaselineEntry): string[] {
  if (isSanitized(entry)) return [entry.id];
  if (
    (entry.kind === 'secret' || entry.kind === 'code' || entry.kind === 'config') &&
    entry.absorbedFingerprints &&
    entry.absorbedFingerprints.length > 0
  ) {
    return [entry.id, ...entry.absorbedFingerprints];
  }
  return [entry.id];
}

/**
 * Project a `BaselineEntry` into the `AllowlistableFinding` shape
 * `resolveEffectiveAllowlist` consumes, reusing the canonical entry→location
 * mapping (`entryToLocated`) so there is no third locator implementation.
 */
export function entryToAllowlistable(entry: BaselineEntry): AllowlistableFinding {
  const loc = entryToLocated(entry);
  return {
    fingerprint: loc.id,
    kind: entry.kind,
    ...(loc.file !== undefined ? { file: loc.file } : {}),
    ...(loc.line !== undefined ? { line: loc.line } : {}),
  };
}

/** A finding-set split by active-allowlist suppression. */
export interface AllowlistPartition<T> {
  /** Findings NO active entry suppresses — the set that grandfathers into a
   *  baseline / contributes to the verdict. */
  readonly live: T[];
  /** Findings an active entry suppresses — kept out of the baseline; each
   *  paired with its suppression for reporting the `allowlisted:M` split. */
  readonly allowlisted: T[];
  readonly suppressions: AllowlistSuppression[];
}

/**
 * Partition `entries` into live vs actively-allowlisted. With no allowlist
 * every entry is live. THE single place a finding set is filtered by the
 * allowlist for capture — `baseline create` uses it so an allowlisted finding
 * is never grandfathered as `persisted`.
 */
export function partitionByActiveAllowlist<T extends BaselineEntry>(
  entries: readonly T[],
  allowlist: AllowlistFile | null,
  now: Date,
): AllowlistPartition<T> {
  if (!allowlist) return { live: [...entries], allowlisted: [], suppressions: [] };
  const live: T[] = [];
  const allowlisted: T[] = [];
  const suppressions: AllowlistSuppression[] = [];
  for (const e of entries) {
    const s = allowlistSuppressionFor(allowlist, e, now);
    if (s) {
      allowlisted.push(e);
      suppressions.push(s);
    } else {
      live.push(e);
    }
  }
  return { live, allowlisted, suppressions };
}
