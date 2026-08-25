/**
 * Package-manager detection + command building — one source of truth for
 * "which PM manages this repo, and how do I phrase an install for it".
 *
 * dxkit long assumed npm everywhere: doctor + tools hints told users to run
 * `npm install …` regardless of their lockfile, and a first-real-repo install
 * on a pnpm project surfaced the gap (npm choked on a pnpm workspace). This
 * module centralizes detection so every "install this" string dxkit prints
 * matches the repo's actual PM.
 *
 * Note on the `create-dxkit` bootstrap: that shim is a SEPARATE zero-dependency
 * published package (`packages/create-dxkit/index.js`) and cannot import from
 * `src/`, so it carries its own small copy of this logic. Two published
 * packages legitimately each need the primitive — this is not a Rule 2
 * duplication within one package. Keep the two in step when either changes.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Read the `packageManager` field (corepack, e.g. `pnpm@9.0.0`) and map it to
 *  a known PM, or null when absent/unrecognized. */
function packageManagerField(cwd: string): PackageManager | null {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager !== 'string') return null;
    const name = pkg.packageManager.split('@')[0].trim();
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
    return null;
  } catch {
    return null;
  }
}

/**
 * Detect the package manager for a repo. Lockfiles win — they reflect what
 * actually provisioned `node_modules` — and only when none is present do we
 * fall back to the `packageManager` field (a declared intent), then to npm.
 */
export function detectPackageManager(cwd: string): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun';
  if (existsSync(join(cwd, 'package-lock.json'))) return 'npm';
  return packageManagerField(cwd) ?? 'npm';
}

/** The lockfile filename(s) each PM writes, most-specific first. One source of
 *  truth for "the file a lockfile-aware tool should be pointed at" (mirrors the
 *  detection order in `detectPackageManager`). */
export const LOCKFILES: Readonly<Record<PackageManager, readonly string[]>> = {
  pnpm: ['pnpm-lock.yaml'],
  yarn: ['yarn.lock'],
  bun: ['bun.lock', 'bun.lockb'],
  npm: ['package-lock.json', 'npm-shrinkwrap.json'],
};

/**
 * The lockfile actually present in the repo (first match, PM-priority order),
 * with the PM that owns it — or null when no lockfile exists. Dependency-scanner
 * selection consults this so it never runs a scanner against a lockfile it
 * cannot read (e.g. `npm audit` needs `package-lock.json`; on a pnpm repo the
 * scanner must instead read `pnpm-lock.yaml`).
 */
export function detectLockfile(cwd: string): { pm: PackageManager; lockfile: string } | null {
  const order: PackageManager[] = ['pnpm', 'yarn', 'bun', 'npm'];
  for (const pm of order) {
    for (const f of LOCKFILES[pm]) {
      if (existsSync(join(cwd, f))) return { pm, lockfile: f };
    }
  }
  return null;
}

/** The command PREFIX that adds a dev dependency with the given PM (no package
 *  yet). `npm install --save-dev` is the token dxkit historically hardcoded, so
 *  it is also the substring other install strings are rewritten from. */
export function addDevPrefix(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm add -D';
    case 'yarn':
      return 'yarn add -D';
    case 'bun':
      return 'bun add -d';
    case 'npm':
      return 'npm install --save-dev';
  }
}

/** The command to add a package as a dev dependency with the given PM. */
export function addDevCommand(pm: PackageManager, pkg: string): string {
  return `${addDevPrefix(pm)} ${pkg}`;
}

/** Rewrite a hardcoded `npm install --save-dev …` install string to the given
 *  PM's equivalent. A no-op for npm (and when the token isn't present), so it is
 *  safe to apply to any command; used to make a tool's node-devDep install match
 *  the repo's PM without templating every registry entry. */
export function pmAwareDevInstall(command: string, pm: PackageManager): string {
  if (pm === 'npm') return command;
  return command.split('npm install --save-dev').join(addDevPrefix(pm));
}

/** Which package.json section a dependency lives in — decides the save flag
 *  an upgrade command must carry so a devDependency bump never migrates the
 *  package into `dependencies`. */
export type DependencySection = 'dependencies' | 'devDependencies' | 'optionalDependencies';

/**
 * The argv to upgrade one dependency to an exact version with the repo's own
 * package manager, preserving its manifest section. Returned as an argv (not
 * a string) so callers execFile it — package names come from advisory data
 * and must never transit a shell.
 */
export function upgradeArgv(
  pm: PackageManager,
  pkg: string,
  version: string,
  section: DependencySection,
): string[] {
  const spec = `${pkg}@${version}`;
  switch (pm) {
    case 'pnpm':
      return [
        'pnpm',
        'add',
        spec,
        ...(section === 'devDependencies'
          ? ['--save-dev']
          : section === 'optionalDependencies'
            ? ['--save-optional']
            : []),
      ];
    case 'yarn':
      return [
        'yarn',
        'add',
        spec,
        ...(section === 'devDependencies'
          ? ['--dev']
          : section === 'optionalDependencies'
            ? ['--optional']
            : []),
      ];
    case 'bun':
      return ['bun', 'add', spec, ...(section === 'devDependencies' ? ['--dev'] : [])];
    case 'npm':
      return [
        'npm',
        'install',
        spec,
        section === 'devDependencies'
          ? '--save-dev'
          : section === 'optionalDependencies'
            ? '--save-optional'
            : '--save-prod',
      ];
  }
}

/** The command to (re)provision `node_modules` from the manifest + lockfile —
 *  the "your project-local tools aren't installed, run this" hint. */
export function provisionCommand(pm: PackageManager): string {
  return provisionArgv(pm).join(' ');
}

/** The same provision command as an argv (`[bin, ...args]`), for callers
 *  that execFile it. `provisionCommand` is the display projection of this. */
export function provisionArgv(pm: PackageManager): [string, ...string[]] {
  switch (pm) {
    case 'pnpm':
      return ['pnpm', 'install'];
    case 'yarn':
      return ['yarn', 'install'];
    case 'bun':
      return ['bun', 'install'];
    case 'npm':
      return ['npm', 'ci'];
  }
}

// ---------------------------------------------------------------------------
// Frozen-lockfile install + lockfile-sync check: the ONE definition CI and the
// lane's verification share (4.4.5). Before this, every workflow template
// carried a hand-copied `if [ -f pnpm-lock.yaml ] ... npm ci || npm ci
// --legacy-peer-deps` block, and the remediate lane verified the agent's
// dirty workspace with whatever node_modules it last installed. A draft whose
// package.json had moved ahead of its lockfile was pushed as "verified"; CI's
// `npm ci` then died with EUSAGE before the gate ran. The table below is what
// both sides now render from, so the lane cannot certify a tree CI cannot
// install.
// ---------------------------------------------------------------------------

/** One branch of the install decision, in PM-priority order (the same order
 *  `detectLockfile` uses). `argv` is the frozen install; `fallback` is retried
 *  when it fails, for the one condition named in `fallbackReason`. */
interface InstallBranch {
  readonly pm: PackageManager | 'none';
  /** Files whose presence selects this branch (any-of); `package.json` for
   *  the no-lockfile branch, empty for the final else. */
  readonly when: readonly string[];
  /** Shell-only bootstrap lines rendered before the install (CI provisions
   *  bun on demand; locally the binary must already be on PATH). */
  readonly shellSetup?: readonly string[];
  readonly argv: readonly string[];
  /** Silence the primary's stderr in the shell rendering (yarn classic rejects
   *  `--immutable` with a noisy error before the fallback runs). */
  readonly quietPrimary?: boolean;
  readonly fallback?: readonly string[];
  readonly fallbackReason?: string;
}

const LEGACY_PEER_DEPS_REASON =
  'the tree only resolves under --legacy-peer-deps (a peer conflict the repo already ' +
  'tolerates); the flag skips the peer check, it never fabricates a different tree';

// Each lockfile-keyed branch reads its trigger set from LOCKFILES — the ONE
// lockfile-set definition `detectLockfile` also reads — so the two
// projections cannot disagree (the shipped shape: the npm branch keyed on
// package-lock.json alone while detectLockfile also accepted
// npm-shrinkwrap.json, so a shrinkwrap repo's floor dry-ran `npm ci` while
// its CI ran a plain `npm install`). Pinned by the parity test in
// test/package-manager-frozen-install.test.ts.
const INSTALL_BRANCHES: readonly InstallBranch[] = [
  { pm: 'pnpm', when: LOCKFILES.pnpm, argv: ['pnpm', 'install', '--frozen-lockfile'] },
  {
    pm: 'yarn',
    when: LOCKFILES.yarn,
    argv: ['yarn', 'install', '--immutable'],
    quietPrimary: true,
    fallback: ['yarn', 'install', '--frozen-lockfile'],
    fallbackReason: 'yarn classic (v1) spells the immutable install --frozen-lockfile',
  },
  {
    pm: 'bun',
    when: LOCKFILES.bun,
    shellSetup: ['npm install -g bun >/dev/null 2>&1 || true'],
    argv: ['bun', 'install', '--frozen-lockfile'],
  },
  {
    pm: 'npm',
    when: LOCKFILES.npm,
    argv: ['npm', 'ci'],
    fallback: ['npm', 'ci', '--legacy-peer-deps'],
    fallbackReason: LEGACY_PEER_DEPS_REASON,
  },
  {
    pm: 'npm',
    when: ['package.json'],
    argv: ['npm', 'install'],
    fallback: ['npm', 'install', '--legacy-peer-deps'],
    fallbackReason: LEGACY_PEER_DEPS_REASON,
  },
  // No package.json at all: CI still needs the dxkit CLI on PATH.
  { pm: 'none', when: [], argv: ['npm', 'install', '-g', '@vyuhlabs/dxkit'] },
];

/** The frozen (lockfile-exact) install for a repo, with the fallback CI
 *  mirrors. */
export interface FrozenInstall {
  readonly pm: PackageManager;
  readonly argv: readonly string[];
  readonly fallback?: { readonly argv: readonly string[]; readonly reason: string };
}

/**
 * The frozen install a verification of THIS repo must run: exactly what the
 * rendered CI step picks on the same tree. Reads the same file presence the
 * shell `if` chain tests, in the same order. `null` when the repo has no
 * package.json (nothing to install).
 */
export function frozenInstallFor(cwd: string): FrozenInstall | null {
  for (const b of INSTALL_BRANCHES) {
    if (b.pm === 'none') return null;
    if (!b.when.some((f) => existsSync(join(cwd, f)))) continue;
    return {
      pm: b.pm,
      argv: b.argv,
      ...(b.fallback ? { fallback: { argv: b.fallback, reason: b.fallbackReason ?? '' } } : {}),
    };
  }
  return null;
}

/** The whole-line placeholder a workflow template carries where its
 *  dependency install goes; the ONE workflow writer substitutes it with
 *  `renderInstallDependenciesShell`. */
export const INSTALL_DEPS_PLACEHOLDER = '__DXKIT_INSTALL_DEPS__';

/**
 * The shell block that installs a repo's dependencies the frozen way, rendered
 * from `INSTALL_BRANCHES` at the given indent (a workflow `run: |` body).
 * corepack provides pnpm/yarn with no extra action, honoring the repo's
 * `packageManager` field; the chain picks the lockfile-appropriate installer
 * so the audited tree is the tree the repo ships, never a fabricated npm
 * resolution of a pnpm workspace.
 */
export function renderInstallDependenciesShell(indent: string): string {
  const lines: string[] = ['corepack enable >/dev/null 2>&1 || true'];
  INSTALL_BRANCHES.forEach((b, i) => {
    const cond = b.when.map((f) => `[ -f ${f} ]`).join(' || ');
    lines.push(cond ? `${i === 0 ? 'if' : 'elif'} ${cond}; then` : 'else');
    for (const s of b.shellSetup ?? []) lines.push(`  ${s}`);
    const primary = b.argv.join(' ') + (b.quietPrimary ? ' 2>/dev/null' : '');
    lines.push(`  ${primary}${b.fallback ? ` || ${b.fallback.join(' ')}` : ''}`);
  });
  lines.push('fi');
  return lines.map((l) => indent + l).join('\n');
}

/**
 * Is a failed npm install/ci output a PEER-CONFLICT-ONLY failure, the one
 * condition `--legacy-peer-deps` legitimately answers? An out-of-sync lockfile
 * (EUSAGE, "not in sync", "Missing:") is NOT: the flag would not help and the
 * failure is real. Consulted by every consumer of the legacy-peer-deps
 * doctrine (the CI install fallback, the dep-bump lane, the lockfile-sync
 * floor check) so the two failure classes are told apart in one place.
 */
export function isPeerConflictOnly(output: string): boolean {
  if (/EUSAGE|not in sync|Missing: .* from lock file|does not satisfy/.test(output)) return false;
  return /ERESOLVE|peer dep/i.test(output);
}

/** A non-installing "is the lockfile in sync with the manifest?" check. */
export type LockfileSyncCheck =
  | {
      readonly kind: 'command';
      readonly argv: readonly string[];
      /** A failure this check TOLERATES as pass-with-disclosure, because the
       *  frozen install's fallback covers it (npm's peer conflict). */
      readonly tolerated?: {
        readonly matches: (output: string) => boolean;
        readonly disclosure: string;
      };
    }
  | { readonly kind: 'skipped'; readonly reason: string };

/**
 * The dry-run frozen install per PM: fails when the lockfile does not satisfy
 * the manifest, touches nothing on disk, runs no lifecycle scripts.
 *
 *   - npm: `npm ci --dry-run` validates lockfile/manifest sync (EUSAGE) before
 *     building the ideal tree, so an out-of-sync lockfile fails and a peer
 *     conflict (ERESOLVE) surfaces the same way the real `npm ci` does. The
 *     peer conflict is tolerated with a disclosure: CI's install retries with
 *     `--legacy-peer-deps`. npm 7+ semantics (Node 18+, dxkit's floor, ships
 *     npm 9).
 *   - pnpm: `--frozen-lockfile --lockfile-only` fails with
 *     ERR_PNPM_OUTDATED_LOCKFILE on drift and never touches node_modules.
 *   - bun: `--frozen-lockfile --dry-run` refuses a lockfile that would change.
 *   - yarn: no non-installing frozen check holds across classic and berry
 *     (classic's `--frozen-lockfile` installs for real; berry's
 *     `--mode=update-lockfile` still fetches), so this is a DISCLOSED skip and
 *     CI's immutable install stays the backstop.
 */
export function lockfileSyncCheck(pm: PackageManager): LockfileSyncCheck {
  switch (pm) {
    case 'npm':
      return {
        kind: 'command',
        argv: ['npm', 'ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'],
        tolerated: {
          matches: isPeerConflictOnly,
          disclosure:
            'peer conflict only (ERESOLVE): the lockfile is in sync, and the repo installs ' +
            'under --legacy-peer-deps, which the CI install step mirrors',
        },
      };
    case 'pnpm':
      return {
        kind: 'command',
        argv: ['pnpm', 'install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts'],
      };
    case 'bun':
      return {
        kind: 'command',
        argv: ['bun', 'install', '--frozen-lockfile', '--dry-run', '--ignore-scripts'],
      };
    case 'yarn':
      return {
        kind: 'skipped',
        reason:
          'yarn has no non-installing frozen-lockfile check that holds across classic and ' +
          "berry; CI's `yarn install --immutable` is the backstop",
      };
  }
}

// ---------------------------------------------------------------------------
// Lock-WRITING install (the recipe tier's resync, 4.4.5): the ONE definition
// of "make the lockfile record the manifest" per PM, beside the frozen table
// above so the two cannot drift. A frozen install (`npm ci`) REFUSES an
// out-of-sync lockfile by design; repairing one needs the ecosystem's
// re-resolving install. Fabricating a different tree is exactly what the
// frozen CI install exists to prevent, so this command is only ever run by a
// surface whose PURPOSE is to update the lockfile (the lockfile-sync /
// override-pin recipes), never by a verification.
// ---------------------------------------------------------------------------

/** The install that (re)writes the lockfile from the manifest, with the same
 *  declared fallback doctrine as the frozen table (`isPeerConflictOnly` is
 *  the shared gate on when the fallback may run). */
export interface ResyncInstall {
  readonly pm: PackageManager;
  readonly argv: readonly string[];
  readonly fallback?: { readonly argv: readonly string[]; readonly reason: string };
}

/**
 * The lock-writing install per PM. npm re-resolves and writes
 * `package-lock.json` (`--no-audit --no-fund` keeps it quiet and offline-ish);
 * its peer-conflict fallback mirrors the frozen install's declared doctrine.
 * pnpm/yarn/bun re-resolve and write their lockfiles by default; pnpm gets the
 * explicit flag because a CI environment flips its default to frozen.
 */
export function resyncInstallFor(pm: PackageManager): ResyncInstall {
  switch (pm) {
    case 'npm':
      return {
        pm,
        argv: ['npm', 'install', '--no-audit', '--no-fund'],
        fallback: {
          argv: ['npm', 'install', '--legacy-peer-deps', '--no-audit', '--no-fund'],
          reason: LEGACY_PEER_DEPS_REASON,
        },
      };
    case 'pnpm':
      return { pm, argv: ['pnpm', 'install', '--no-frozen-lockfile'] };
    case 'yarn':
      return { pm, argv: ['yarn', 'install'] };
    case 'bun':
      return { pm, argv: ['bun', 'install'] };
  }
}
