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
 *     graphifyy==0.8.40; the generated script now also drives graphify only
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
  'osv-scanner': 'v2.4.0',
  pmd: '7.24.0',
  detekt: 'v1.23.6',
  ktlint: '1.5.0',
  graphify: 'graphifyy==0.8.40',
  jscpd: 'jscpd@4.2.5',
  // 2.10 version-pin sweep: defensive freezes for the dxkit-owned,
  // deterministic-output scanners so a future breaking major can't
  // silently change parsed output or exit codes (the jscpd-5.x class).
  // Proper schema-adaptive multi-version handling is deferred to a
  // later release. Versions are the current releases as of the sweep
  // (semgrep is the benchmark-validated 1.165.0). Consumer-owned and
  // SaaS/managed tools deliberately stay in KNOWN_UNPINNED below.
  semgrep: 'semgrep==1.165.0',
  ruff: 'ruff==0.15.17',
  'pip-audit': 'pip-audit==2.10.1',
  'pip-licenses': 'pip-licenses==5.5.5',
  'coverage-py': 'coverage==7.14.1',
  'license-checker-rseidelsohn': 'license-checker-rseidelsohn@5.0.1',
  'golangci-lint': '@v1.64.8',
  govulncheck: '@v1.3.0',
  'go-licenses': '@v1.6.0',
  // T2.1 (4.0.3): previously KNOWN_UNPINNED on `releases/latest`, which was
  // both unpinned AND unverifiable. Now pinned to a bundle tag with the
  // release's published sha256 checksums verified at install time.
  codeql: 'codeql-bundle-v2.26.1',
  // 4.1 swift pack: SwiftLint's lint-gate JSON is parsed by the pack, so
  // the linux artifact is pinned + checksum-verified (brew tracks its own).
  swiftlint: '0.65.0',
  // 4.1 php pack: phpcs's lint-gate JSON is parsed by the pack — same
  // pin + checksum discipline.
  phpcs: '4.0.1',
};

/**
 * Tools dxkit installs but does NOT version-pin — each for a deliberate
 * reason, not an oversight. The 2.10 sweep emptied the "just hasn't been
 * pinned yet" backlog into PINNED_TOOLS; what remains stays unpinned BY
 * DESIGN:
 *
 *   - `eslint`, `vitest-coverage` — `installScope: 'project-local'`. They
 *     install into the CONSUMER's package.json; the consumer owns the
 *     version. dxkit pinning them would override the project's own choice.
 *   - `snyk` — a SaaS CLI that authenticates against Snyk's backend and
 *     self-manages client/server compatibility. Pinning an old client
 *     risks server-side deprecation breaking it; let it float.
 *   - `cloc` — a stable line-counter on a non-semver npm tag
 *     (`2.6.0-cloc`); lowest-risk output schema in the registry, and the
 *     odd version string makes a clean pin fragile for negligible gain.
 *
 * Moving a tool here into PINNED_TOOLS (with a tested version) is the
 * closure step for any future backlog entry.
 */
const KNOWN_UNPINNED = ['eslint', 'vitest-coverage', 'snyk', 'cloc'];

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

describe('tool-registry download verification (T2.1 supply chain)', () => {
  const allCommands: Array<{ name: string; cmd: string }> = [];
  for (const [name, def] of Object.entries(TOOL_DEFS)) {
    for (const cmd of Object.values(def.installCommands ?? {})) {
      if (typeof cmd === 'string' && cmd.length > 0) allCommands.push({ name, cmd });
    }
  }

  it('every dxkit_fetch call carries a 64-hex sha256 argument', () => {
    // dxkit_fetch <url> <sha256> <dest> — a call missing the hash (or with a
    // truncated one) would verify nothing while LOOKING verified.
    const calls = allCommands.filter(({ cmd }) => cmd.includes('dxkit_fetch '));
    expect(calls.length).toBeGreaterThanOrEqual(7); // gitleaks, osv×2, dotnet×2, pmd, detekt, ktlint, codeql×2
    for (const { name, cmd } of calls) {
      for (const m of cmd.matchAll(/dxkit_fetch\s+(\S+)\s+(\S+)\s+/g)) {
        expect(m[1], `${name}: dxkit_fetch first arg should be a URL`).toMatch(/^["']?https:\/\//);
        expect(m[2], `${name}: dxkit_fetch second arg must be a sha256: ${cmd}`).toMatch(
          /^[0-9a-f]{64}$/,
        );
      }
    }
  });

  it('no unverified network download remains in any install command', () => {
    // Runtime mirror of the arch-check rule: a raw curl/wget with a URL is a
    // new unverified download path; an Invoke-WebRequest must be paired with
    // a Get-FileHash comparison in the same command.
    for (const { name, cmd } of allCommands) {
      const rawFetch = /(curl|wget)\s[^|]*https?:\/\//.test(cmd);
      expect(rawFetch, `${name}: unverified curl/wget download: ${cmd}`).toBe(false);
      if (cmd.includes('Invoke-WebRequest')) {
        expect(cmd, `${name}: Invoke-WebRequest without Get-FileHash: ${cmd}`).toContain(
          'Get-FileHash',
        );
      }
    }
  });

  it.skipIf(process.platform === 'win32')(
    'dxkit_fetch verifies and fails CLOSED on mismatch (functional)',
    async () => {
      const { DXKIT_FETCH_PREAMBLE } = await import('../src/analyzers/tools/install-exec');
      const { execSync } = await import('child_process');
      const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import('fs');
      const { createHash } = await import('crypto');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const dir = mkdtempSync(join(tmpdir(), 'dxkit-fetch-'));
      try {
        const src = join(dir, 'artifact.bin');
        writeFileSync(src, 'artifact-bytes\n');
        const sha = createHash('sha256').update('artifact-bytes\n').digest('hex');
        const good = join(dir, 'good.out');
        const bad = join(dir, 'bad.out');
        // Correct hash → artifact lands at dest.
        execSync(`${DXKIT_FETCH_PREAMBLE}\ndxkit_fetch "file://${src}" ${sha} "${good}"`, {
          shell: '/bin/bash',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(existsSync(good)).toBe(true);
        // Wrong hash → non-zero exit AND no artifact at dest (fail closed).
        const wrong = '0'.repeat(64);
        expect(() =>
          execSync(`${DXKIT_FETCH_PREAMBLE}\ndxkit_fetch "file://${src}" ${wrong} "${bad}"`, {
            shell: '/bin/bash',
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        ).toThrow();
        expect(existsSync(bad)).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
