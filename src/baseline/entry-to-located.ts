/**
 * Convert a stored `BaselineEntry` into the `LocatedIdentity` shape
 * the git-aware matcher consumes. Pure function — no I/O.
 *
 * The matcher's location-pair pass keys off `(file, rule, line)` and
 * its content-hash pass keys off `(rule, contentHash)`. Both passes
 * pair on the rule string verbatim, so the converter MUST normalize
 * the rule across tool boundaries — otherwise a finding reported by
 * tool A in run 1 and tool B in run 2 would silently fail to pair
 * (the identity hashes would agree via the canonical-rule mapping,
 * but the matcher's earlier passes would have already missed them).
 *
 * For hygiene findings the marker acts as the rule discriminator —
 * the identity hash partitions occurrences by marker text, so the
 * location-pair pass must too. The canonical-rule registry doesn't
 * apply to hygiene markers; the marker IS the canonical name.
 *
 * Whole-file findings (test-gap, coverage-gap, test-file-degradation,
 * god-file, stale-file, large-file) are file-anchored but carry no
 * line. They flow to the matcher's whole-file rename pass with `file`
 * populated and `kind` carried in `rule` — so a pure file rename
 * relocates them (instead of reading as removed+added → false net-new
 * debt), and two different whole-file kinds on the same renamed file
 * never cross-pair. The line-anchored passes skip them (no line); the
 * multiset pass still pairs them by exact identity-hash equality.
 *
 * Kinds without any file/line locator (dep-vuln, duplication,
 * secret-hmac) fall through to the matcher's multiset pass — paired by
 * exact identity-hash equality, no locator metadata needed.
 */

import { canonicalRuleFor } from '../analyzers/tools/fingerprint';
import type { LocatedIdentity } from './git-aware-match';
import { isSanitized } from './sanitize';
import type { BaselineEntry } from './types';

/**
 * Build a `LocatedIdentity` from one stored entry. The id is the
 * already-computed identity hash; locator fields are populated for
 * the kinds the matcher's location-pair / content-hash passes can
 * use.
 *
 * Sanitized entries (`sanitized: true`) carry only identity + kind;
 * they short-circuit to identity-only locators because the
 * location-pair pass has no fields to compare. The matcher's
 * multiset pass still pairs them at full confidence by id.
 */
export function entryToLocated(entry: BaselineEntry): LocatedIdentity {
  if (isSanitized(entry)) return { id: entry.id };
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
      return {
        id: entry.id,
        file: entry.file,
        line: entry.line,
        rule: canonicalRuleFor(entry.tool, entry.rule),
        ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
      };
    case 'hygiene':
      return {
        id: entry.id,
        file: entry.file,
        line: entry.line,
        rule: entry.marker,
        ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
      };
    case 'stale-allow':
      // Annotation comments don't have a tool/rule pair — the
      // "rule" is the annotation's category. Reuse the field so
      // the matcher's location-pair pass can treat them like other
      // source-anchored kinds.
      return {
        id: entry.id,
        file: entry.file,
        line: entry.line,
        rule: entry.category,
      };
    case 'coverage-gap':
    case 'test-gap':
    case 'test-file-degradation':
    case 'god-file':
    case 'stale-file':
    case 'large-file':
      // Whole-file findings: file-anchored, no line. `file` lets the
      // matcher's whole-file rename pass relocate them on a pure rename;
      // `kind` (reused as the `rule` discriminator, like hygiene/marker
      // and stale-allow/category above) keeps two different whole-file
      // kinds on the same renamed file from cross-pairing. No line, so
      // the line-anchored passes correctly skip them.
      return { id: entry.id, file: entry.file, rule: entry.kind };
    case 'dep-vuln':
    case 'duplication':
    case 'secret-hmac':
      return { id: entry.id };
  }
}

/** Convenience: map an array of entries through `entryToLocated`. */
export function entriesToLocated(
  entries: ReadonlyArray<BaselineEntry>,
): ReadonlyArray<LocatedIdentity> {
  return entries.map(entryToLocated);
}
