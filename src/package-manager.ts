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
const LOCKFILES: Record<PackageManager, string[]> = {
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

/** The command to (re)provision `node_modules` from the manifest + lockfile —
 *  the "your project-local tools aren't installed, run this" hint. */
export function provisionCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install';
    case 'yarn':
      return 'yarn install';
    case 'bun':
      return 'bun install';
    case 'npm':
      return 'npm ci';
  }
}
