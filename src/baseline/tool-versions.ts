/**
 * Per-tool version resolution + its per-process cache. Split out of `create.ts`
 * for module size; `buildToolsMap` feeds the baseline's toolchain hash, and
 * `clearToolVersionCache` is a test seam.
 */
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { VERSION as DXKIT_VERSION } from '../constants';

/** Build the per-tool name → version map from the security
 *  aggregate's provenance. Sparse; only the tools that actually
 *  ran appear. Versions come from each tool's registered
 *  `versionCheck` invocation via `findTool`, so the resulting
 *  `toolchainHash` actually differs when a tool is upgraded —
 *  closing the drift-detection gap that placeholder values left
 *  open. In-process scanners (no external binary) are tagged with
 *  the dxkit version so a dxkit upgrade invalidates the toolchain
 *  hash even when no external tool changed — see
 *  `IN_PROCESS_TOOLS`.
 *
 *  Compound tool names like `'osv-scanner-nuget-direct'` (the
 *  per-pack synthetic names the dep-vuln providers emit) are
 *  resolved by progressively shortening on `-` boundaries until a
 *  matching TOOL_DEFS key is found — so
 *  `'osv-scanner-nuget-direct'` → `'osv-scanner-nuget'` →
 *  `'osv-scanner'` (the canonical key). */
export function buildToolsMap(
  toolNames: ReadonlyArray<string>,
  cwd: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of toolNames) {
    if (!name) continue;
    out[name] = resolveToolVersion(name, cwd);
  }
  return out;
}

/**
 * Scanner names that don't correspond to an external binary — their
 * "version" tracks the dxkit version. Adding a new in-process
 * scanner (e.g. a future regex-based dependency checker) means
 * appending its name here, never special-casing inside
 * `resolveToolVersion`.
 *
 * Drives the `provenance.{secrets,codePatterns,...}.tool` values
 * that surface when external tools are unavailable — gitleaks
 * absent → `grep-secrets` runs the in-process fallback; the
 * TLS-bypass registry is always in-process.
 */
const IN_PROCESS_TOOLS: ReadonlySet<string> = new Set(['tls-bypass-registry', 'grep-secrets']);

/**
 * Per-process cache of resolved tool versions, keyed by `${name}::${cwd}`.
 *
 * Why this exists: `findTool` spawns an `execFileSync` subprocess to
 * run each tool's `versionCheck` command. Under heavy concurrent
 * load (parallel vitest workers, large suites running side-by-side),
 * that subprocess can occasionally complete with empty stdout —
 * `resolveToolVersion`'s `if (status.version) return status.version`
 * branch is skipped, the `return 'present'` fallback fires, and the
 * resulting toolchainHash drifts between two back-to-back gathers
 * within the same process. The matcher's `tooling_drift` gate then
 * fires spuriously.
 *
 * Tool versions don't change mid-process — once we've resolved
 * `gitleaks → 8.24.0` for `cwd`, every subsequent ask in the same
 * process should return the same answer. The cache locks the first
 * probe's outcome and skips later subprocess spawns entirely; same
 * answer always, with the side benefit of faster repeated gathers.
 *
 * NOT applied to `findTool` itself: `tools-cli.ts` runs an install
 * command then immediately re-probes (the install just created the
 * binary, we need fresh state). That callsite must keep getting
 * uncached results. The cache stays local to the toolchain-version
 * resolver here.
 */
const VERSION_CACHE = new Map<string, string>();

function resolveToolVersion(name: string, cwd: string): string {
  const cacheKey = `${name}::${cwd}`;
  const cached = VERSION_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = resolveToolVersionUncached(name, cwd);
  VERSION_CACHE.set(cacheKey, resolved);
  return resolved;
}

function resolveToolVersionUncached(name: string, cwd: string): string {
  if (IN_PROCESS_TOOLS.has(name)) return `dxkit-${DXKIT_VERSION}`;
  const parts = name.split('-');
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('-');
    const def = TOOL_DEFS[candidate];
    if (!def) continue;
    // Probe the version a few times — under heavy CPU load (parallel
    // test pools, concurrent scanner runs) the underlying `execSync`
    // subprocess can occasionally return before its `--version`
    // output streams back, leaving us with a bare `'present'` even
    // though the tool itself is fully functional. The per-process
    // VERSION_CACHE then locks that empty result for the lifetime of
    // the run, which is what we want for byte-stable toolchainHashes
    // but is wrong when the empty result was a transient artifact.
    // Three attempts absorb the hiccup without slowing the common
    // path (first probe succeeds → exit immediately).
    for (let attempt = 0; attempt < 3; attempt++) {
      const status = findTool(def, cwd);
      if (status.version) return status.version;
    }
    return 'present';
  }
  return 'unknown';
}

/**
 * Test seam: clear the version cache between test runs so per-test
 * fixtures don't leak resolutions into one another. Production
 * callers never use this — the cache lives for the entire CLI
 * invocation and dies with the process.
 */
export function clearToolVersionCache(): void {
  VERSION_CACHE.clear();
}
