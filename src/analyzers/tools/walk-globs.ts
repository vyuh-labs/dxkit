/**
 * Glob-matching primitives for the canonical source walker — basename globs
 * (`*.test.ts`), path-anchored globs (`tests/*.rs`, `__tests__/**`), and the
 * split that routes a pattern list between the two. A LEAF module (no
 * imports) so both the walker and other pattern consumers can share one glob
 * dialect without touching the walker's registry-defaulting paths (see the
 * module-cycle note in walk-source-files.ts).
 */

export function matchesAnyBasenameGlob(basename: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    if (matchesBasenameGlob(pat, basename)) return true;
  }
  return false;
}

export function matchesBasenameGlob(pat: string, base: string): boolean {
  if (!pat.includes('*') && !pat.includes('?')) return pat === base;
  const regex = globToRegex(pat, false);
  return regex.test(base);
}

export function matchesPathGlob(pat: string, relPath: string): boolean {
  // `tests/*.rs` should match `tests/foo.rs` AND `crate/tests/foo.rs`
  // (path-anchored "anywhere in tree"). Mirrors find's `-path "*/x"`.
  const regex = globToRegex(pat, true);
  return regex.test(relPath);
}

function globToRegex(pat: string, allowSlash: boolean): RegExp {
  const star = allowSlash ? '.*' : '[^/]*';
  const body = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, star)
    .replace(/\?/g, allowSlash ? '.' : '[^/]');
  // Path-anchored: allow optional leading directory segments.
  return new RegExp(allowSlash ? `(?:^|/)${body}$` : `^${body}$`, 'i');
}

export function splitTestPatterns(patterns: string[]): {
  nameOnly: string[];
  pathAnchored: string[];
} {
  const nameOnly: string[] = [];
  const pathAnchored: string[] = [];
  for (const p of patterns) {
    if (p.includes('/')) pathAnchored.push(p);
    else nameOnly.push(p);
  }
  return { nameOnly, pathAnchored };
}

/**
 * Classify a repo-relative path as a test file against an explicit pattern
 * list (name-only globs against the basename, path-anchored globs against
 * the path). The walker's `includeTests` filter and any pack-side per-file
 * predicate share this one definition.
 */
export function matchesTestPatterns(relPath: string, patterns: string[]): boolean {
  const split = splitTestPatterns(patterns);
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  for (const pat of split.nameOnly) if (matchesBasenameGlob(pat, basename)) return true;
  for (const pat of split.pathAnchored) if (matchesPathGlob(pat, relPath)) return true;
  return false;
}
