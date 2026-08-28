/**
 * Line-level TOML text scanning shared by the remediation providers that
 * read or edit TOML manifests (pyproject.toml / Pipfile in the python
 * pack, Cargo.toml in the rust pack). Moved out of python-remediation.ts
 * when the rust pack needed the identical scans (Rule 2: one concept, one
 * code path); behavior is unchanged.
 *
 * Documented residual (inherited by every consumer): a TOML multiline
 * string containing a line shaped like a `[table]` header can false-match
 * these line-level scans. Consumers bias so the worst outcome is an INERT
 * edit or an over-refusal, and every recipe's verify then fails and the
 * runner discards the diff, so a corrupt manifest never lands. Full TOML
 * parsing is deliberately not worth that tail risk here.
 */

/** The `[name]` table in `lines`: header index and exclusive body end. */
export function findTomlTable(
  lines: readonly string[],
  name: string,
): { header: number; end: number } | null {
  // Escape every regex special: names arrive from tomlTableNames too (a
  // Cargo target table is `target.'cfg(windows)'.dependencies`), so a bare
  // dot-escape would build an invalid or mis-matching pattern.
  const headerRe = new RegExp(
    `^\\s*\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]\\s*(#.*)?$`,
  );
  for (let i = 0; i < lines.length; i++) {
    if (!headerRe.test(lines[i])) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*\[/.test(lines[j])) {
        end = j;
        break;
      }
    }
    return { header: i, end };
  }
  return null;
}

/** Every table header name in the document. */
export function tomlTableNames(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Key names declared in one table's body (`name = ...` lines, quoted or
 *  bare). */
export function tableKeyNames(
  lines: readonly string[],
  table: { header: number; end: number },
): string[] {
  const out: string[] = [];
  for (let i = table.header + 1; i < table.end; i++) {
    const m = lines[i].match(/^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*=/);
    if (m) out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/**
 * Package-name folding for direct-dependency comparisons: lowercase, with
 * runs of `-` / `_` / `.` folded to one `-`. PyPI names normalize exactly
 * this way (PEP 503); crates.io treats `-` and `_` as one name for
 * registration. Folding can only OVER-match, and every consumer uses the
 * comparison to REFUSE an edit, so the bias points the safe direction.
 */
export function foldPackageKey(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/** Every transform starts here: a manifest with no table header at all is
 *  not TOML dxkit can edit (garbage, an empty file, JSON). */
export function notToml(text: string, what: string): string | null {
  return /^\s*\[[^\]]*\]/m.test(text)
    ? null
    : `this ${what} does not parse as a TOML manifest, so it cannot be edited`;
}
