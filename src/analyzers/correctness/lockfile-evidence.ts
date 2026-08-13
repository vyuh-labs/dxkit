/**
 * Format-aware "which packages could this base-side file have provided?"
 * evidence (4.4.1 WP2, #284).
 *
 * The pre-push resolution refutation used whole-blob textual containment
 * (`blob.includes(spec)`) as its "maybe provided at base" test. Two live
 * false blocks showed why that is the wrong instrument: an npm lockfile
 * MENTIONS package names it does not install — peer-dependency metadata
 * inside another package's entry (`three` inside `@react-three/fiber`'s
 * block, under a `--legacy-peer-deps` install that never materializes
 * peers), and any short name is a substring of longer ones (`three` ⊂
 * `@react-three/fiber` literally). Both read as "maybe provided", the
 * refutation declined, and a pre-existing phantom import hard-blocked an
 * unrelated push.
 *
 * This module answers the question the current side actually asks —
 * "would this specifier have RESOLVED under the base install?" — by
 * parsing the file's INSTALLED/DECLARED package set per format:
 *
 *   - `package-lock.json` / `npm-shrinkwrap.json`: the `packages` map
 *     keys (v2/v3 — the literal installed tree, nested entries included)
 *     plus the v1 `dependencies` tree keys. Peer metadata inside entries
 *     is VALUES, never keys, so it no longer counts as presence.
 *   - `yarn.lock` (classic + berry): entry-header package names.
 *   - `pnpm-lock.yaml`: `packages:` section keys.
 *   - `package.json`: declared dependency names across all four sections
 *     (peers included — with no lockfile beside it dxkit cannot know the
 *     install flags, and counting a declaration keeps the block, the
 *     conservative direction).
 *
 * An unrecognized format or a parse failure returns null and the caller
 * falls back to the old containment probe for that file — non-JS
 * ecosystems keep their existing behavior byte-for-byte, and every
 * failure lands on "keep blocking", never on a new refutation.
 */

import * as path from 'path';

/** The installed/declared package-name set the file evidences, or null
 *  when the format is not modeled (caller falls back to containment). */
export function basePackageEvidence(filePath: string, blob: string): ReadonlySet<string> | null {
  switch (path.posix.basename(filePath.replace(/\\/g, '/'))) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return npmLockPackages(blob);
    case 'yarn.lock':
      return yarnLockPackages(blob);
    case 'pnpm-lock.yaml':
      return pnpmLockPackages(blob);
    case 'package.json':
      return packageJsonDeclared(blob);
    default:
      return null;
  }
}

/** npm v2/v3 `packages` keys (the installed tree) + v1 `dependencies`
 *  tree keys. Null on unparseable JSON (fail toward keeping the block). */
function npmLockPackages(blob: string): ReadonlySet<string> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(blob);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const names = new Set<string>();
  const packages = (doc as { packages?: Record<string, unknown> }).packages;
  if (packages && typeof packages === 'object') {
    for (const key of Object.keys(packages)) {
      // "" is the root project; nested keys look like
      // "node_modules/a/node_modules/@scope/b" — every node_modules
      // segment names an installed package.
      const parts = key.split('node_modules/');
      for (let i = 1; i < parts.length; i++) {
        const name = parts[i].replace(/\/$/, '');
        if (name) names.add(name);
      }
    }
  }
  const addV1Tree = (deps: unknown): void => {
    if (typeof deps !== 'object' || deps === null) return;
    for (const [name, entry] of Object.entries(deps as Record<string, unknown>)) {
      names.add(name);
      addV1Tree((entry as { dependencies?: unknown })?.dependencies);
    }
  };
  addV1Tree((doc as { dependencies?: unknown }).dependencies);
  return names;
}

/** Package names from yarn.lock entry headers — classic
 *  (`"@scope/a@^1.0", b@^2.0:`) and berry (`"a@npm:^1.0":`). Body lines
 *  are indented and never parsed, so metadata mentions do not count. */
function yarnLockPackages(blob: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const line of blob.split('\n')) {
    // Entry headers start at column 0 and end with ':'; comments start '#'.
    if (!line || line.startsWith('#') || /^\s/.test(line) || !line.trimEnd().endsWith(':')) {
      continue;
    }
    const header = line.trimEnd().slice(0, -1);
    for (const rawKey of header.split(',')) {
      const key = rawKey.trim().replace(/^"|"$/g, '');
      const name = packageNameOfSpec(key);
      if (name) names.add(name);
    }
  }
  return names;
}

/** Package names from pnpm-lock.yaml `packages:` keys, across the key
 *  dialects: `/name/1.0.0:`, `/@scope/name@1.0.0:`, `'name@1.0.0':`. */
function pnpmLockPackages(blob: string): ReadonlySet<string> {
  const names = new Set<string>();
  let inPackages = false;
  for (const line of blob.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages && /^\S/.test(line)) inPackages = false; // next top-level section
    if (!inPackages) continue;
    const m = line.match(/^ {2}['"]?([^'":]+)['"]?:\s*$/);
    if (!m) continue;
    let key = m[1];
    if (key.startsWith('/')) key = key.slice(1);
    // `/name/1.0.0` (old) → name is everything before the LAST '/'; the
    // `name@version` dialects go through the spec parser.
    const name = key.includes('@', 1)
      ? packageNameOfSpec(key)
      : key.split('/').slice(0, -1).join('/');
    if (name) names.add(name);
  }
  return names;
}

/** Declared dependency names across every package.json section. Null on
 *  unparseable JSON. */
function packageJsonDeclared(blob: string): ReadonlySet<string> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(blob);
  } catch {
    return null;
  }
  if (typeof doc !== 'object' || doc === null) return null;
  const names = new Set<string>();
  for (const field of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const section = (doc as Record<string, unknown>)[field];
    if (typeof section !== 'object' || section === null) continue;
    for (const name of Object.keys(section)) names.add(name);
  }
  return names;
}

/** The package name of a `name@range` / `@scope/name@range` /
 *  `name@npm:range` spec key. Null when the key carries no range
 *  separator (not a spec). */
function packageNameOfSpec(spec: string): string | null {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  if (at <= 0) return null;
  return spec.slice(0, at);
}
