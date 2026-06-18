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
 * Whole-file findings (test-gap, test-file-degradation, god-file,
 * stale-file, large-file) are file-anchored but carry no line. They flow
 * to the matcher's whole-file rename pass with `file` populated and `kind`
 * carried in `rule` — so a pure file rename relocates them (instead of
 * reading as removed+added → false net-new debt), and two different
 * whole-file kinds on the same renamed file never cross-pair. The
 * line-anchored passes skip them (no line); the multiset pass still pairs
 * them by exact identity-hash equality.
 *
 * THE RELOCATION INVARIANT (load-bearing — a regression test enforces it):
 * if a finding's identity is sensitive to line position — i.e. shifting the
 * finding down the file (holding its file + content constant) changes its
 * identity hash — then this converter MUST give it a full `(file, line,
 * rule)` locator, so the matcher's line-aware pass can relocate it through a
 * `git diff`; AND, when the producer can read the file, the entry carries a
 * `contentHash` that this converter passes through, so the matcher's
 * git-INDEPENDENT content-hash pass relocates it on a shallow clone /
 * force-pushed baseline too. Either way, benign churn (a comment inserted
 * above it) is not read as a removed+added pair → false net-new. A kind may
 * be locator-less ONLY when its identity is line-INDEPENDENT.
 *
 * That is why:
 *   - `duplication` carries a line locator AND a contentHash: its identity
 *     hashes the block's exact start lines, so it moves with the code. The
 *     locator uses the CANONICAL representative side (`duplicationCanonicalSides`,
 *     the same ordering the identity hash uses) so prior + current agree on
 *     which side the matcher maps; the contentHash is taken on that same side.
 *   - `stale-allow` carries a line locator AND a contentHash: its identity is
 *     line-window-bucketed, so a shift past the window re-mints it.
 *   - `coverage-gap` is split: a SYMBOL-anchored gap is line-independent
 *     (identity = `(file, symbol)`, survives vertical drift) → whole-file
 *     locator; a RANGE-anchored gap (no symbol) is line-dependent → it gets
 *     a line locator at the range start. (Its producer is not wired yet; when
 *     it lands it should also stamp a contentHash, like the kinds above.)
 *   - `dep-vuln` and `secret-hmac` stay locator-less: their identities are
 *     genuinely line-independent (advisory id; value HMAC), so the multiset
 *     pass pairs them by exact identity-hash equality with no locator.
 */

import { canonicalRuleFor } from '../analyzers/tools/fingerprint';
import { duplicationCanonicalSides } from './finding-identity';
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
      // source-anchored kinds. The line-bucketed identity re-mints on a
      // >window shift, so carry the contentHash for the git-independent
      // pass too (parity with secret/code/hygiene).
      return {
        id: entry.id,
        file: entry.file,
        line: entry.line,
        rule: entry.category,
        ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
      };
    case 'coverage-gap':
      // A symbol-anchored gap has line-independent identity ((file,
      // symbol)) → whole-file locator (no line). A range-anchored gap (no
      // symbol) hashes its line range, so it's line-dependent and needs a
      // line locator at the range start for relocation. (See the
      // relocation invariant in the module header.)
      return entry.symbol !== undefined
        ? { id: entry.id, file: entry.file, rule: entry.kind }
        : { id: entry.id, file: entry.file, line: entry.lineRange?.[0], rule: entry.kind };
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
    case 'duplication': {
      // Line-dependent identity (hashes the block's exact start lines), so
      // it MUST be relocatable — give it a line locator on the canonical
      // representative side (same ordering the identity uses, so prior +
      // current pick the same side across a shift). `kind` is the rule
      // discriminator, as for the whole-file kinds above.
      const [first] = duplicationCanonicalSides(
        entry.fileA,
        entry.startLineA,
        entry.fileB,
        entry.startLineB,
      );
      return {
        id: entry.id,
        file: first[0],
        line: first[1],
        rule: entry.kind,
        // Content-hash fallback so the matcher relocates the clone even when
        // git history is unavailable (shallow clone / force-pushed baseline),
        // where the git-line pass is skipped.
        ...(entry.contentHash !== undefined ? { contentHash: entry.contentHash } : {}),
      };
    }
    case 'dep-vuln':
    case 'secret-hmac':
      // Line-independent identity (advisory id; value HMAC) → locator-less;
      // the matcher's multiset pass pairs them by exact identity-hash.
      return { id: entry.id };
  }
}

/** Convenience: map an array of entries through `entryToLocated`. */
export function entriesToLocated(
  entries: ReadonlyArray<BaselineEntry>,
): ReadonlyArray<LocatedIdentity> {
  return entries.map(entryToLocated);
}
