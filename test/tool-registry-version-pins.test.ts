import { describe, it, expect } from 'vitest';
import { TOOL_DEFS } from '../src/analyzers/tools/tool-registry';

/**
 * Version-pin guard for the tool registry.
 *
 * Tool-version drift is a recurring defect class: an unpinned install
 * pulls whatever is newest, and a new major can change a CLI flag or the
 * JSON schema dxkit parses — breaking the analyzer at runtime with no code
 * change on our side. Real instances we shipped fixes for:
 *   - jscpd 5.x (Rust rewrite) dropped `--gitignore` + changed the report
 *     schema → exit 2.  (pinned jscpd@4.2.5)
 *   - graphifyy 0.8 changed an internal `cache_dir` signature.  (pinned
 *     graphifyy==0.8.36; the generated script now also drives graphify only
 *     through its public API)
 *
 * This test locks every tool we install from a versioned GitHub release /
 * pinned npm-or-pip spec so the pin can't silently regress to "latest".
 * The expected version is the substring that must appear in every platform
 * install command (and the top-level `install` hint where it carries one).
 *
 * `KNOWN_UNPINNED` is the explicit, visible backlog: tools still installed
 * unpinned. They are listed here on purpose — so the gap is auditable in one
 * place rather than discovered the next time a tool ships a breaking major.
 * Moving a tool from KNOWN_UNPINNED into PINNED_TOOLS (with a tested version)
 * is the closure step. Package-manager-tracked installs (brew / cargo / go /
 * gem / dotnet / rustup) are intentionally absent from both lists — they
 * resolve their own versions and dxkit doesn't author the pin.
 */

/** tool name → version substring that MUST appear in its install commands. */
const PINNED_TOOLS: Record<string, string> = {
  gitleaks: 'v8.24.0',
  'osv-scanner': 'v2.3.8',
  pmd: '7.24.0',
  detekt: 'v1.23.6',
  graphify: 'graphifyy==0.8.36',
  jscpd: 'jscpd@4.2.5',
};

/**
 * Tools dxkit installs from a spec it authors (npm / pip / `go install`)
 * that is NOT yet version-pinned — the audited backlog. Pinning one (with a
 * tested version) is the closure: move it into PINNED_TOOLS. `semgrep` is
 * the highest-risk entry — universal, runs on every scan, and dxkit parses
 * its JSON output, so a breaking CLI/schema change lands like jscpd 5.x did.
 * The go-toolchain entries currently float on `@latest`.
 */
const KNOWN_UNPINNED = [
  'semgrep',
  'ruff',
  'pip-audit',
  'pip-licenses',
  'coverage-py',
  'eslint',
  'vitest-coverage',
  'license-checker-rseidelsohn',
  'snyk',
  'codeql',
  'cloc',
  'golangci-lint',
  'govulncheck',
  'go-licenses',
];

/**
 * Tools installed through a system / language package manager that owns its
 * own version resolution (brew, cargo, rustup, gem, `dotnet tool`, builtin).
 * dxkit doesn't author a pinnable spec for these, so they're neither pinned
 * nor part of the unpinned backlog — but they're listed so the partition
 * below is exhaustive and a new tool can't slip in unclassified.
 */
const PACKAGE_MANAGER_TRACKED = [
  'cargo-audit',
  'cargo-license',
  'cargo-llvm-cov',
  'clippy',
  'dotnet-format',
  'npm-audit',
  'nuget-license',
  'rubocop',
  'simplecov',
];

function installStrings(name: string): string[] {
  const def = TOOL_DEFS[name];
  const cmds = Object.values(def.installCommands ?? {}).filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  // Some install hints carry the pin on the top-level `install` field too
  // (e.g. graphify, jscpd); include it when it names the package.
  return [...cmds, def.install];
}

describe('tool-registry version pins', () => {
  for (const [name, version] of Object.entries(PINNED_TOOLS)) {
    it(`pins ${name} to ${version} in every install command`, () => {
      const def = TOOL_DEFS[name];
      expect(def, `TOOL_DEFS.${name} missing`).toBeTruthy();
      const strings = installStrings(name);
      // Every concrete install command for this tool must carry the pin.
      // (The top-level `install` hint is allowed to omit it only when it
      // delegates to the platform list — but our pinned tools all name the
      // version, so we require it everywhere it appears as a real command.)
      for (const cmd of Object.values(def.installCommands ?? {})) {
        if (typeof cmd !== 'string' || cmd.length === 0) continue;
        // brew/scoop/winget lines track their own version; only assert the
        // pin on lines that actually fetch a versioned artifact or package.
        const isPkgMgrLine =
          /^(brew install|scoop install|winget install|builtin)/.test(cmd.trim()) &&
          !/curl|npm install|pip install|releases\/download/.test(cmd);
        if (isPkgMgrLine) continue;
        expect(cmd, `${name} install command not pinned: ${cmd}`).toContain(version);
      }
      // And at least one of the strings carries it (guards against a tool
      // whose installCommands were all pkg-mgr lines yet claims a pin).
      expect(strings.some((s) => s.includes(version))).toBe(true);
    });
  }

  it('the three pin-policy buckets exactly partition the registry', () => {
    // Every tool must be a deliberate decision: pinned, audited-unpinned, or
    // package-manager-tracked. A tool in none of them is a blind spot; a tool
    // in two is a contradiction. This forces any newly-added tool to declare
    // its version-stability story instead of silently floating on "latest".
    const buckets = [...Object.keys(PINNED_TOOLS), ...KNOWN_UNPINNED, ...PACKAGE_MANAGER_TRACKED];
    const counts = new Map<string, number>();
    for (const n of buckets) counts.set(n, (counts.get(n) ?? 0) + 1);

    const duplicated = [...counts].filter(([, c]) => c > 1).map(([n]) => n);
    expect(duplicated, `tools listed in more than one bucket: ${duplicated.join(', ')}`).toEqual(
      [],
    );

    const registry = new Set(Object.keys(TOOL_DEFS));
    const unclassified = [...registry].filter((n) => !counts.has(n));
    expect(
      unclassified,
      `unclassified tools (add to a pin-policy bucket): ${unclassified.join(', ')}`,
    ).toEqual([]);

    const stale = [...counts.keys()].filter((n) => !registry.has(n));
    expect(stale, `bucketed tools no longer in the registry: ${stale.join(', ')}`).toEqual([]);
  });
});
