/**
 * Project-root discovery for nested BOM aggregation.
 *
 * `vyuh-dxkit bom <path>` historically scanned `<path>` as a single
 * project root. Repos like `vyuhlabs-platform/` (root devtools +
 * `userserver/` product) fell through the cracks — the scanner saw
 * only whichever `package.json`/lockfile lived at `<path>`, missing
 * every sibling or nested sub-project. See D001a in the internal
 * defect log for the incident write-up.
 *
 * This module walks the filesystem starting at cwd and returns every
 * directory that looks like an independent project root (i.e. has any
 * language manifest, regardless of whether a parent also does). The
 * BOM analyzer then runs the existing per-root gather against each
 * and merges the results.
 *
 * Why a hardcoded skip-set rather than `exclusions.ts`: this is a
 * structural traversal, not a gitignore-based code scan. `exclusions.ts`
 * is tuned for "which files does the user consider source code?" and
 * pulls in `.gitignore` rules that would incorrectly hide sibling
 * projects (e.g. `.gitignore: dist/` would skip a sub-project under
 * `dist/` even though it might legitimately be a shippable artifact
 * the user wants inventoried).
 */

import * as fs from 'fs';
import * as path from 'path';

/** File basenames that mark a directory as a project root. */
const MANIFEST_BASENAMES: ReadonlySet<string> = new Set([
  'package.json', // Node
  'pyproject.toml', // Python (PEP 621 / poetry)
  'requirements.txt', // Python (pip)
  'setup.py', // Python (legacy)
  'Pipfile', // Python (pipenv)
  'go.mod', // Go
  'Cargo.toml', // Rust
]);

/** File extensions that mark a directory as a project root. */
const MANIFEST_EXTENSIONS: ReadonlyArray<string> = [
  '.csproj', // C# project
  '.sln', // C# solution
];

/**
 * Directories we never descend into during discovery.
 *
 *   - Dependency trees (`node_modules`, `vendor`, `venv`, `.venv`,
 *     `target`, `bin`, `obj`): contain manifests from installed
 *     packages, not user projects.
 *   - Build output (`dist`, `build`, `out`, `.next`, `.turbo`,
 *     `.cache`): derived, not source-of-truth.
 *   - VCS / tool metadata (`.git`, `.svn`, `.hg`): never has
 *     meaningful manifests.
 *
 * Any dotfile directory is also skipped — caches, IDE state, etc.
 */
const SKIP_DIR_BASENAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'vendor',
  'venv',
  '.venv',
  'target',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  '.next',
  '.turbo',
  '.cache',
  '.git',
  '.svn',
  '.hg',
  'TestResults',
  'packages',
]);

/** Default depth cap: enough for `packages/foo/sub`, excess discouraged. */
const DEFAULT_MAX_DEPTH = 4;

/**
 * Walk `cwd` and return every directory that contains at least one
 * language manifest. Always includes `cwd` itself when it has one,
 * even if nested sub-projects also exist (the aggregator treats all
 * roots symmetrically and dedupes findings across them).
 *
 * Pure over the filesystem: no caching, no side effects beyond
 * filesystem reads. Returns absolute paths, sorted alphabetically
 * for deterministic output.
 *
 * Exported for unit tests.
 */
export function discoverProjectRoots(cwd: string, maxDepth: number = DEFAULT_MAX_DEPTH): string[] {
  const roots = new Set<string>();
  walk(cwd, 0, maxDepth, roots);
  return [...roots].sort();
}

function walk(dir: string, depth: number, maxDepth: number, roots: Set<string>): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  let isRoot = false;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (MANIFEST_BASENAMES.has(e.name)) {
      isRoot = true;
      break;
    }
    if (MANIFEST_EXTENSIONS.some((ext) => e.name.endsWith(ext))) {
      isRoot = true;
      break;
    }
  }
  if (isRoot) roots.add(dir);

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (SKIP_DIR_BASENAMES.has(e.name)) continue;
    // Skip dotfile directories (caches, IDE state) except the repo root's own.
    if (e.name.startsWith('.') && depth > 0) continue;
    walk(path.join(dir, e.name), depth + 1, maxDepth, roots);
  }
}
