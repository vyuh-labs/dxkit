/**
 * Canonical depth-unlimited path walker for language packs.
 *
 * Every pack that needs to discover its manifest files (`.csproj` /
 * `.sln` for C#, `pyproject.toml` / `setup.py` for Python,
 * `build.gradle.kts` for Kotlin, `pom.xml` for Java, `Gemfile` for
 * Ruby, etc.) routes through `walkPaths`. ONE walker — no per-pack
 * recursive readdir reimplementations, no hardcoded depth caps that
 * silently miss deep monorepo structures.
 *
 * Why a separate primitive from `walk-source-files.ts`:
 *
 *   - `walkSourceFiles` resolves auto-generated patterns + test
 *     patterns + default extensions from the language registry
 *     (`LANGUAGES.flatMap(...)`). Language pack modules that need
 *     manifest discovery during their own initialization can't import
 *     that — circular dependency, partially-loaded registry entries
 *     surface as `undefined`-property reads at module-eval time.
 *
 *   - This walker is the foundational layer: pure FS traversal +
 *     `isExcludedPath` (gitignore + bundled defaults) + extension
 *     filter. No LANGUAGES touch, no autogen/test heuristics. Safe to
 *     call from any pack at any point in the load order.
 *
 * Behavioral contract:
 *
 *   - **Depth-unlimited.** The single largest class of latent bugs
 *     the previous per-pack walkers shipped: `maxDepth = 2/3/4/5`
 *     caps chosen by each pack author based on their idea of "deep
 *     enough." Real customer monorepos routinely exceed every one of
 *     those values (dpl-studio: 6–9). This walker walks the whole
 *     tree minus exclusions, period.
 *
 *   - **Exclusion-aware.** Honors the bundled exclusion list
 *     (`node_modules`, `bin`, `obj`, `vendor`, `dist`, `target`, …)
 *     plus the project's `.gitignore` + `.dxkit-ignore` via the
 *     canonical `isExcludedPath`. Same answer the rest of dxkit
 *     uses.
 *
 *   - **Dot-directory pruning.** `.git`, `.vscode`, `.idea`,
 *     `.dxkit`, etc. are universally skipped even when not in
 *     `.gitignore`.
 *
 *   - **POSIX paths, relative to cwd, sorted.** Deterministic for
 *     test fixtures and snapshot comparisons.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isExcludedPath } from './exclusions';

export interface WalkPathsOpts {
  /**
   * File extensions to include (e.g., `['.csproj', '.sln']`). Matched
   * against `path.extname(file)`, so values must include the leading
   * dot. An empty list returns no files.
   */
  extensions: string[];

  /**
   * Apply `.gitignore` + `.dxkit-ignore` + bundled default
   * exclusions? Default `true`. Set `false` only when the caller
   * genuinely needs a raw FS view (rare).
   */
  respectIgnore?: boolean;

  /**
   * Restrict to specific basename matches in ADDITION to the
   * extension filter (e.g., `['Gemfile', 'Gemfile.lock']` for
   * extensionless manifest files). When provided, a file passes
   * if EITHER its extension is in `extensions` OR its basename is
   * in `basenames`. Defaults to `[]` (extension-only matching).
   */
  basenames?: string[];
}

// Memoization keyed by `(cwd, opts-fingerprint)`. Mirrors
// `walk-source-files`'s cache pattern so repeat callers within one
// process pay the walk cost once.
const walkCache = new Map<string, string[]>();

export function clearWalkPathsCache(): void {
  walkCache.clear();
}

/**
 * Walk the tree rooted at `cwd` and return every file matching the
 * extension or basename filter, depth-unlimited, exclusion-aware.
 * Returns POSIX-style relative paths, sorted. Never throws —
 * unreadable directories are skipped and the partial result is
 * returned.
 */
export function walkPaths(cwd: string, opts: WalkPathsOpts): string[] {
  const respectIgnore = opts.respectIgnore ?? true;
  const extensions = new Set(opts.extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)));
  const basenames = new Set(opts.basenames ?? []);
  const cacheKey = `${cwd}\0${[...extensions].sort().join(',')}\0${[...basenames].sort().join(',')}\0${respectIgnore}`;
  const hit = walkCache.get(cacheKey);
  if (hit) return hit;

  const out: string[] = [];
  walkDir(cwd, '', { extensions, basenames, respectIgnore }, out);
  out.sort();
  walkCache.set(cacheKey, out);
  return out;
}

interface ResolvedOpts {
  extensions: Set<string>;
  basenames: Set<string>;
  respectIgnore: boolean;
}

function walkDir(cwd: string, relDir: string, opts: ResolvedOpts, out: string[]): void {
  const absDir = relDir ? path.join(cwd, relDir) : cwd;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const relPath = relDir ? `${relDir}/${ent.name}` : ent.name;

    if (ent.isDirectory()) {
      // Always skip dot-directories — universal noise (.git, .vscode,
      // .idea, .dxkit, .ci, …). Many aren't in `.gitignore` but no
      // sane manifest discovery wants them.
      if (ent.name.startsWith('.')) continue;
      // Bundled excludes (node_modules, bin, obj, vendor, target,
      // dist, …) + project `.gitignore`/`.dxkit-ignore`.
      if (opts.respectIgnore && isExcludedPath(cwd, relPath)) continue;
      walkDir(cwd, relPath, opts, out);
      continue;
    }
    if (!ent.isFile()) continue;

    const ext = path.extname(ent.name);
    const matches = opts.extensions.has(ext) || opts.basenames.has(ent.name);
    if (!matches) continue;
    if (opts.respectIgnore && isExcludedPath(cwd, relPath)) continue;

    out.push(relPath);
  }
}
