/**
 * The rust ecosystem's remediation capabilities (the pack's `remediation`,
 * Rule 6, the go-remediation.ts sibling): every cargo fact the recipe
 * executors consume through the capability seam.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - Cargo.toml and Cargo.lock are tool-owned; dxkit never hand-edits
 *     them. The pin is the seam's COMMAND shape:
 *     `cargo update -p pkg --precise version` rewrites the Cargo.lock
 *     entry to exactly the patched version, no manifest change at all
 *     (the cleanest revert story of any ecosystem here: the pin lives in
 *     one lockfile line). An incompatible pin (a dependent's version
 *     requirement the fix does not satisfy) fails cargo loudly, the
 *     recipe's step fails, and the runner discards the diff; nothing is
 *     ever guessed past the resolver.
 *   - A DIRECT dependency refuses the pin: its manifest states the range,
 *     so the honest fix is upgrading the declared dependency (the
 *     dep-bump lane). The direct read is a line-level Cargo.toml scan of
 *     every dependencies-shaped table, including `[workspace.dependencies]`
 *     and target-specific tables, plus renamed entries (`alias = {
 *     package = "real-name" }`). Refusal-biased: over-matching only ever
 *     refuses. A `[patch]` entry naming the crate refuses too (the patch
 *     wins over the lock).
 *   - crates.io versions are x.y.z semver, so the default pin grammar
 *     applies (no declared `versions`).
 *   - `declareDependency` is a REASONED EXEMPTION: the rust compiler is
 *     the import-resolution floor (no `resolutionCheck`), so
 *     unresolved-import orders are never minted and a declare could not
 *     be resolution-verified; `cargo add` serves it if that floor lands.
 *   - `lintFix` is a REASONED EXEMPTION: `cargo clippy --fix` rewrites
 *     whole crates (no file-scoped fix mode, so it cannot honor a work
 *     order's envelope) and refuses a dirty working tree without
 *     `--allow-dirty`, a flag dxkit will not pass.
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  PinPlanResult,
  PinTransitiveProvider,
  RemediationSupport,
} from './capabilities/remediation';
import { CARGO_LOCK_EXECUTION } from './rust-install';
import { findTomlTable, foldPackageKey, tableKeyNames, tomlTableNames } from './toml-text';

/** A crates.io package-name shape (alphanumeric start, then letters,
 *  digits, `-`, `_`). The Rule 11 rail before the name lands in a cargo
 *  argv: a leading dash would be a flag. */
const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidCrateName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && CRATE_NAME.test(name);
}

/** Dependencies-shaped table names: `[dependencies]`, `[dev-dependencies]`,
 *  `[build-dependencies]`, `[workspace.dependencies]`, and the
 *  target-specific `[target.'cfg(...)'.dependencies]` family. */
const DEP_TABLE = /(^|\.)(dev-|build-)?dependencies$/;

/** Is `pkg` a direct dependency of this Cargo.toml: a key in any
 *  dependencies-shaped table, or the target of a rename
 *  (`alias = { package = "pkg" }`), or named by a `[patch]` table? */
function cargoDeclaresDirectly(cargoToml: string, pkg: string): boolean {
  const lines = cargoToml.split('\n');
  const target = foldPackageKey(pkg);
  for (const name of tomlTableNames(lines)) {
    const isDepTable = DEP_TABLE.test(name);
    const isPatchTable = /^patch(\.|$)/.test(name);
    if (!isDepTable && !isPatchTable) continue;
    const table = findTomlTable(lines, name);
    if (table === null) continue;
    if (tableKeyNames(lines, table).some((n) => foldPackageKey(n) === target)) return true;
    if (isDepTable) {
      // A renamed entry declares the real crate through `package = "..."`.
      for (let i = table.header + 1; i < table.end; i++) {
        const m = lines[i].match(/\bpackage\s*=\s*["']([^"']+)["']/);
        if (m && foldPackageKey(m[1]) === target) return true;
      }
    }
  }
  return false;
}

/** A crates.io version shape for the rail (the grammar itself is the
 *  default concrete-semver scheme; this only guards the argv). */
const CARGO_VERSION = /^[0-9][0-9A-Za-z.+-]*$/;

const rustPinTransitive: PinTransitiveProvider = {
  manifestFiles: ['Cargo.toml'],
  osvEcosystem: 'crates.io',
  plan(ctx): PinPlanResult {
    // Rule 11: both tokens land in a cargo argv verbatim.
    if (!isValidCrateName(ctx.pkg) || !CARGO_VERSION.test(ctx.version)) {
      return {
        kind: 'refused',
        reason: `'${ctx.pkg}@${ctx.version}' is not a crate name + version shape dxkit will hand to cargo`,
      };
    }
    const manifestPath = path.join(ctx.cwd, ctx.rootDir, 'Cargo.toml');
    let cargoToml: string;
    try {
      cargoToml = fs.readFileSync(manifestPath, 'utf8');
    } catch {
      return {
        kind: 'refused',
        reason: `no readable Cargo.toml exists at ${ctx.rootDir || 'the repo root'}, so there is no package to pin in`,
      };
    }
    if (cargoDeclaresDirectly(cargoToml, ctx.pkg)) {
      return {
        kind: 'refused',
        reason:
          `'${ctx.pkg}' is declared directly in this Cargo.toml (a dependency, rename, or ` +
          'patch entry); the honest fix is upgrading the declared dependency (the dep-bump ' +
          'lane), not pinning it',
      };
    }
    return {
      kind: 'command',
      command: { bin: 'cargo', args: ['update', '-p', ctx.pkg, '--precise', ctx.version] },
      writes: ['Cargo.lock'],
      revert: `run 'cargo update -p ${ctx.pkg}' to release the precise pin in ${
        ctx.rootDir ? `${ctx.rootDir}/` : ''
      }Cargo.lock`,
      notes: [
        'the precise pin lives in Cargo.lock only (Cargo.toml is unchanged); cargo refuses a ' +
          "pin that violates a dependent's version requirement, so an incompatible fix fails " +
          'loudly instead of landing',
      ],
    };
  },
  execution: () => CARGO_LOCK_EXECUTION,
};

/** The rust pack's remediation declarations: resync + pin are capabilities
 *  (the resync rides `rustInstallStrategy`; Rule 2: one code path each);
 *  declare + lintFix are the reasoned exemptions the doctrine block above
 *  explains. */
export const rustRemediation: RemediationSupport = {
  resyncLockfile: { kind: 'capability', provider: { manifestFiles: ['Cargo.toml'] } },
  pinTransitive: { kind: 'capability', provider: rustPinTransitive },
  declareDependency: {
    kind: 'exemption',
    reason:
      'the rust compiler is the import-resolution floor for this pack (no resolutionCheck is ' +
      'declared), so unresolved-import orders are never minted and a declare could not be ' +
      'resolution-verified; these orders stay on the agent tier',
  },
  lintFix: {
    kind: 'exemption',
    reason:
      "cargo clippy's fix mode rewrites whole crates rather than a work order's files and " +
      'refuses a dirty working tree without --allow-dirty (a flag dxkit will not pass); ' +
      'these orders stay on the agent tier',
  },
};
