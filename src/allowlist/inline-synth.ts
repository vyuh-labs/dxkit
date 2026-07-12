/**
 * Inline `dxkit-allow:` annotations → synthesized allowlist entries.
 *
 * An inline annotation is an ALTERNATE SOURCE of an allowlist decision, not a
 * second suppression mechanism (Rule 2). A committed `// dxkit-allow:test-fixture`
 * comment adjacent to a finding is resolved here into an in-memory
 * `AllowlistEntry` keyed on that finding's fingerprint, which the ONE
 * fingerprint-based suppression core (`annotateByKind` on the report side,
 * `allowlistSuppressionFor` on the gate side) then honors exactly like a
 * file-level entry. The synthesized entries are EPHEMERAL — never written to
 * `.dxkit/allowlist.json`; the annotation in the source IS the persistent record
 * (and the stale-allow producer already tracks orphaned ones).
 *
 * Why synthesize rather than match by location in both consumers: the report
 * annotator and the gate both already match findings against the loaded
 * `AllowlistFile` by fingerprint. Turning an annotation into an entry keeps the
 * "is this finding allowlisted?" decision in one place instead of adding a
 * second, location-based predicate to two code paths.
 *
 * SECURITY: only INLINE-COMPATIBLE categories (`test-fixture` / `false-positive`)
 * suppress inline — the same restriction the CLI enforces when WRITING an inline
 * annotation. accepted-risk / deferred decisions must be file-level (auditable in
 * one place). The annotation must sit exactly on (same-line) or immediately above
 * (above-line) the finding, so a stray comment elsewhere can never waive a real
 * credential. The source is the repo's own committed tree — the same trust
 * boundary as the file-level allowlist.
 */

import type { InlineAllowlistOccurrence } from './gather';
import type { AllowlistCategory } from './categories';
import { INLINE_COMPATIBLE_CATEGORIES } from './categories';
import type { AllowlistEntry, AllowlistFile } from './file';
import { emptyAllowlistFile } from './file';
import type { IdentityKind } from '../baseline/producers';

/** The minimal finding shape the synth needs. `kind` is the durable identity
 *  kind (the same discriminant the suppression core matches on) — the report
 *  side maps its `FindingCategory` through `kindForCategory`, the gate reads it
 *  off the baseline entry directly. `line` is 1-based; a finding with no
 *  resolvable line can't be inline-covered and is skipped by the caller. */
export interface InlineSynthFinding {
  readonly file: string;
  readonly line: number;
  readonly fingerprint?: string;
  readonly kind: IdentityKind;
}

/** Normalize a repo path for cross-source matching (occurrence paths come from
 *  the source walker, finding paths from the scanners — strip a leading `./`
 *  and normalize separators so the two align). */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * The finding line an inline annotation COVERS: a same-line annotation at line L
 * covers L; an above-line annotation at line L covers L+1 (the finding it sits
 * above). The ONE coverage rule (Rule 2) — shared by the suppression synth AND
 * the stale-allow producer, so "this annotation covers a finding" means the same
 * thing to both (else the synth suppresses a finding while stale-allow reports the
 * annotation orphaned — a net-new block from a working suppression).
 */
export function coveredLineFor(occ: Pick<InlineAllowlistOccurrence, 'line' | 'position'>): number {
  return occ.position === 'above' ? occ.line + 1 : occ.line;
}

/**
 * Map `${file}:${line}` → category for every line an inline annotation COVERS.
 * Non-inline-compatible categories are dropped — they never suppress inline.
 */
export function inlineCoverage(
  occurrences: readonly InlineAllowlistOccurrence[],
): Map<string, AllowlistCategory> {
  const cover = new Map<string, AllowlistCategory>();
  for (const o of occurrences) {
    if (!INLINE_COMPATIBLE_CATEGORIES.has(o.category as AllowlistCategory)) continue;
    cover.set(`${normPath(o.file)}:${coveredLineFor(o)}`, o.category as AllowlistCategory);
  }
  return cover;
}

/**
 * Synthesize ephemeral allowlist entries for every finding an inline annotation
 * covers. Deterministic given `now`; deduped by fingerprint (one entry per
 * distinct finding identity, even if multiple findings share a covered line).
 */
export function synthesizeInlineEntries(
  occurrences: readonly InlineAllowlistOccurrence[],
  findings: readonly InlineSynthFinding[],
  now: Date = new Date(),
): AllowlistEntry[] {
  const cover = inlineCoverage(occurrences);
  if (cover.size === 0) return [];
  const out: AllowlistEntry[] = [];
  const seen = new Set<string>();
  const addedAt = now.toISOString();
  for (const f of findings) {
    if (!f.fingerprint || seen.has(f.fingerprint)) continue;
    const category = cover.get(`${normPath(f.file)}:${f.line}`);
    if (!category) continue;
    seen.add(f.fingerprint);
    out.push({
      fingerprint: f.fingerprint,
      kind: f.kind,
      category,
      reason: 'inline dxkit-allow annotation',
      addedAt,
    });
  }
  return out;
}

/**
 * Return `base` augmented with the synthesized inline entries (deduped against
 * existing fingerprints — a file-level entry wins, its category is authoritative).
 * Returns `base` unchanged when there are no inline entries. Constructs a minimal
 * allowlist when `base` is null but inline entries exist, so a repo with inline
 * annotations and no `allowlist.json` still suppresses.
 */
export function augmentAllowlistWithInline(
  base: AllowlistFile | null,
  inlineEntries: readonly AllowlistEntry[],
): AllowlistFile | null {
  if (inlineEntries.length === 0) return base;
  const scaffold = base ?? emptyAllowlistFile();
  const existingFps = new Set(scaffold.entries.map((e) => e.fingerprint));
  const merged = [
    ...scaffold.entries,
    ...inlineEntries.filter((e) => !existingFps.has(e.fingerprint)),
  ];
  return { ...scaffold, entries: merged };
}
