/**
 * User-authored tool-location config — `.dxkit/tools.json`.
 *
 * Lets a developer point dxkit at tool binaries that don't live in any
 * of the default probe locations, and choose where `tools install`
 * drops them. The motivating case is locked-down or non-standard
 * environments (corporate Windows boxes, air-gapped CI) where the
 * scanner toolchain is installed into a project- or team-specific
 * directory rather than `~/.local/bin` / the npm global prefix / brew.
 *
 * Shape (every field optional):
 *
 *   {
 *     "probePaths": ["D:\\devtools\\bin", "/opt/team/bin"],
 *     "installDir": "D:\\devtools\\bin"
 *   }
 *
 *   - `probePaths` — extra directories `findTool` searches (PATHEXT-aware
 *     on Windows) AFTER PATH / brew / npm-g / pipx / system probes. A
 *     hit here reports the tool as available with `source: 'probe'`.
 *   - `installDir` — directory `tools install` targets, injected into the
 *     per-ecosystem install command via the ecosystem's bin-dir env var
 *     / flag. Implies a matching `probePaths` entry so the freshly
 *     installed binary is immediately discoverable.
 *
 * The file is optional and hand-authored (or written by the
 * `dxkit-config` skill). Absent / malformed → empty config, never an
 * error: tool detection must degrade gracefully, not crash.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ToolsConfig {
  /** Extra directories to search for tool binaries. */
  readonly probePaths: string[];
  /** Target directory for `tools install`, or null when unset. */
  readonly installDir: string | null;
}

const EMPTY: ToolsConfig = { probePaths: [], installDir: null };

/** Location of the config inside a project. */
export function toolsConfigPath(cwd: string): string {
  return path.join(cwd, '.dxkit', 'tools.json');
}

/**
 * Per-process cache keyed by cwd. Tool config doesn't change mid-run,
 * and `findTool` calls into this on every probe — caching avoids
 * re-reading + re-parsing the file for every tool on every analyzer.
 */
const CACHE = new Map<string, ToolsConfig>();

/** Test seam: drop the cache so per-test fixtures don't leak. */
export function clearToolsConfigCache(): void {
  CACHE.clear();
}

/**
 * Load `.dxkit/tools.json` for `cwd`. Returns an empty config when the
 * file is absent or unparseable — detection never depends on this file
 * existing.
 */
export function loadToolsConfig(cwd: string): ToolsConfig {
  const cached = CACHE.get(cwd);
  if (cached) return cached;
  const resolved = readToolsConfig(cwd);
  CACHE.set(cwd, resolved);
  return resolved;
}

function readToolsConfig(cwd: string): ToolsConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(toolsConfigPath(cwd), 'utf8');
  } catch {
    return EMPTY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return EMPTY;
  const obj = parsed as { probePaths?: unknown; installDir?: unknown };
  const probePaths = Array.isArray(obj.probePaths)
    ? obj.probePaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const installDir =
    typeof obj.installDir === 'string' && obj.installDir.length > 0 ? obj.installDir : null;
  // The install target is always also a probe location so a freshly
  // installed binary is found without the user duplicating the path.
  // Probe both `installDir` (pipx / go install land binaries here) and
  // `installDir/bin` (npm-g / cargo install nest under `bin/`).
  const allProbes = installDir
    ? [...new Set([...probePaths, installDir, path.join(installDir, 'bin')])]
    : probePaths;
  return { probePaths: allProbes, installDir };
}
