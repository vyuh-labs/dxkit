/**
 * The OWNER SECTION of a generated agent file: a marker-delimited block inside
 * `AGENTS.md` that the repo owner maintains (what the product is, how to
 * build / run / test it, domain notes an agent needs) and that dxkit never
 * rewrites. dxkit owns everything OUTSIDE the markers and keeps refreshing it.
 *
 * One concept, one code path (CLAUDE.md Rule 2): this module is the ONLY place
 * that knows the markers, how a file splits around them, how a regenerated
 * file is spliced back together, and how the provenance hash treats the
 * section. Every consumer routes through it:
 *   - the generator's write path (`applyManaged`: init, re-init, `update`,
 *     `update --force`) splices the owner body into the rendered template;
 *   - the generator's manifest hash AND its on-disk hash
 *     (`managedContentHash`), so an edit INSIDE the section never reads as a
 *     user-modified file while an edit OUTSIDE it still does;
 *   - uninstall's hash guard and its keep-the-owner's-text reversal.
 * `policy render` refreshes only the registered ship surfaces
 * (MANAGED_SHIP_SURFACES), which never include `AGENTS.md`; the parity net
 * `test/owner-section-parity.test.ts` pins that, plus every writer above.
 */

import { sha256 } from './files';

export const OWNER_SECTION_START = '<!-- dxkit:owner:start -->';
export const OWNER_SECTION_END = '<!-- dxkit:owner:end -->';

/** Repo-relative managed files that carry an owner section. */
export const OWNER_SECTION_FILES: ReadonlySet<string> = new Set(['AGENTS.md']);

export interface OwnerSplit {
  /** Everything up to and including the start-marker line (with its newline). */
  readonly head: string;
  /** The owner's text between the marker lines, verbatim. */
  readonly body: string;
  /** The end-marker line and everything after it. */
  readonly tail: string;
}

/** Offsets of every line whose trimmed text equals `marker`. */
function markerLines(content: string, marker: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (pos <= content.length) {
    const nl = content.indexOf('\n', pos);
    const lineEnd = nl === -1 ? content.length : nl;
    if (content.slice(pos, lineEnd).trim() === marker) {
      out.push({ start: pos, end: nl === -1 ? lineEnd : nl + 1 });
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return out;
}

/**
 * Split `content` around its owner section. Well-formed means exactly one
 * start-marker line and exactly one end-marker line after it, each on its own
 * line. Anything else (no markers, a lone marker, duplicates, reversed order)
 * returns null: the file has no owner section dxkit can recognise, and every
 * consumer then treats the whole file as-is (never guessing at a boundary).
 */
export function splitOwnerSection(content: string): OwnerSplit | null {
  const starts = markerLines(content, OWNER_SECTION_START);
  const ends = markerLines(content, OWNER_SECTION_END);
  if (starts.length !== 1 || ends.length !== 1) return null;
  const [s] = starts;
  const [e] = ends;
  if (e.start < s.end) return null;
  return {
    head: content.slice(0, s.end),
    body: content.slice(s.end, e.start),
    tail: content.slice(e.start),
  };
}

/**
 * True when the file carries owner-section markers that do NOT form one
 * well-formed section (a lone, duplicated or reversed marker). The owner's
 * text is then of unknown extent, so no consumer may remove any of it.
 */
export function hasAmbiguousOwnerSection(content: string): boolean {
  if (splitOwnerSection(content) !== null) return false;
  return (
    markerLines(content, OWNER_SECTION_START).length > 0 ||
    markerLines(content, OWNER_SECTION_END).length > 0
  );
}

/** True when the file has a well-formed owner section with non-blank text. */
export function hasOwnerContent(content: string): boolean {
  const split = splitOwnerSection(content);
  return split !== null && split.body.trim() !== '';
}

/**
 * The provenance-normal form: the owner body emptied, everything else
 * byte-identical. A file without a well-formed section is returned unchanged,
 * so a legacy (pre-marker) install hashes exactly as it always did.
 */
export function normalizeOwnerSection(content: string): string {
  const split = splitOwnerSection(content);
  return split === null ? content : split.head + split.tail;
}

/**
 * The hash dxkit records for (and compares against) a managed file. For an
 * owner-section file it is the hash of the normal form, so the owner's text
 * never makes the file read as user-modified; every other file hashes as-is.
 */
export function managedContentHash(rel: string, content: string): string {
  return sha256(OWNER_SECTION_FILES.has(rel) ? normalizeOwnerSection(content) : content);
}

/**
 * Splice the owner body of `existing` (the file on disk, or null when absent)
 * into the freshly `rendered` template.
 *   - nothing on disk, or no owner text on disk → `rendered` unchanged;
 *   - owner text on disk + rendered carries a section → rendered with the
 *     owner's body verbatim between its markers;
 *   - owner text on disk + rendered has NO section → null: writing would drop
 *     the owner's text, so the caller must not write.
 */
export function spliceOwnerSection(rendered: string, existing: string | null): string | null {
  if (existing === null) return rendered;
  const prior = splitOwnerSection(existing);
  if (prior === null || prior.body.trim() === '') return rendered;
  const next = splitOwnerSection(rendered);
  if (next === null) return null;
  return next.head + prior.body + next.tail;
}

/**
 * The owner's text alone, for uninstall: dxkit's sections and the markers are
 * removed, the body is kept with surrounding blank lines trimmed. Null when
 * the file has no owner text (nothing of the owner's to keep).
 */
export function ownerContentOnly(content: string): string | null {
  const split = splitOwnerSection(content);
  if (split === null) return null;
  const body = split.body.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  return body === '' ? null : body + '\n';
}
