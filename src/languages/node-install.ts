/**
 * The node ecosystem's install strategy (the TypeScript pack's
 * `installStrategy`, Rule 6): one variant per package manager, keyed on the
 * lockfile it writes, each with its frozen install, its lock-writing resync,
 * its lockfile-sync check and its declared tolerances.
 *
 * Before this, the same facts lived in three tables (the CI branch chain,
 * the resync table, the dry-run table) plus a free-floating peer-conflict
 * classifier; see `capabilities/install-strategy.ts` for the class that
 * closed. Every fact about "how a node repo installs" is HERE, once.
 *
 * Doctrine notes, kept beside the commands they explain:
 *   - `npm ci` installs the LOCKFILE's tree; `--legacy-peer-deps` only skips
 *     the peer check that rejects it, never fabricating a different
 *     resolution (falling back to a re-resolving `npm install` would).
 *   - yarn's frozen primary is the CLASSIC spelling (`--frozen-lockfile`):
 *     classic (v1) honors it, while it silently IGNORES berry's
 *     `--immutable` (verified on 1.22.22: exit 0, lockfile rewritten), so
 *     an `--immutable` primary would not be frozen at all on classic and
 *     its fallback could never fire (classic emits no rejection). Berry 2
 *     still accepts `--frozen-lockfile` as a deprecated alias; berry 3+
 *     rejects it LOUDLY (clipanion's "Unsupported option name"), and THAT
 *     rejection routes to the `--immutable` fallback. A berry immutable
 *     failure ("the lockfile would have been modified") is a REAL failure
 *     and never matches the fallback classifier.
 *   - The CI-default trap: pnpm and yarn berry flip to frozen whenever CI is
 *     set, exactly where the scheduled lanes run, so the resync commands
 *     carry the explicit mutable flag. Classic ignores `--no-immutable`
 *     (unknown flags are ignored) and plain-installs, which is already
 *     lock-writing, so the one resync primary holds on both yarns.
 *   - Lockfile-sync checks: npm's `ci --dry-run` validates sync (EUSAGE)
 *     before building the tree; bun's frozen dry-run refuses a lockfile that
 *     would change; pnpm and yarn have no non-writing check that holds
 *     across versions, so both are DISCLOSED skips with CI's frozen install
 *     as the backstop.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  addDevPrefix,
  detectLockfile,
  detectPackageManager,
  LOCKFILES,
  upgradeArgv,
  type PackageManager,
} from '../package-manager';
import {
  installCommandText,
  strategyFromVariants,
  type InstallFallback,
  type InstallStrategy,
  type InstallStrategyProvider,
  type InstallVariant,
} from './capabilities/install-strategy';
import type { ExecutionRequirement } from '../execution';

/**
 * Is a failed npm output a PEER-CONFLICT-ONLY failure, the one condition
 * `--legacy-peer-deps` legitimately answers? An out-of-sync lockfile
 * (EUSAGE, "not in sync", "Missing:") is NOT: the flag would not help and the
 * failure is real. The node pack's classifier for the `peer-conflict` class,
 * consulted by every consumer through the strategy (the frozen and resync
 * fallbacks, the lockfile-sync tolerance, the dep-bump lane).
 */
export function isPeerConflictOnly(output: string): boolean {
  if (isLockfileDrift(output)) return false;
  return /ERESOLVE|peer dep/i.test(output);
}

/** npm's "the lockfile does not record the manifest" shape: the frozen
 *  install refuses it by design and no fallback answers it. */
export function isLockfileDrift(output: string): boolean {
  return /EUSAGE|not in sync|Missing: .* from lock file|does not satisfy/.test(output);
}

/**
 * yarn berry (3+) rejecting the classic `--frozen-lockfile` spelling:
 * clipanion's "Unknown Syntax Error: Unsupported option name". Deliberately
 * narrow: berry's REAL immutable failure (YN0028 "the lockfile would have
 * been modified") must never match, and classic never emits a rejection at
 * all (it ignores unknown flags).
 */
export function isYarnBerryFlagRejection(output: string): boolean {
  return /unsupported option name|unknown syntax error|unsupported option/i.test(output);
}

/** The failure label the executor reports for npm's lockfile drift. */
export const LOCKFILE_DRIFT = 'lockfile-drift';

export const LEGACY_PEER_DEPS_DISCLOSURE =
  'the tree only resolves under --legacy-peer-deps (a peer conflict the repo already ' +
  'tolerates); the flag skips the peer check, it never fabricates a different tree';

/** The npm peer-conflict fallback for a primary, as "primary + flag". */
function legacyPeerDeps(bin: string, args: readonly string[]): InstallFallback {
  return {
    command: { bin, args: [...args, '--legacy-peer-deps'] },
    when: 'peer-conflict',
    matches: isPeerConflictOnly,
    disclosure: LEGACY_PEER_DEPS_DISCLOSURE,
    viaFlags: ['--legacy-peer-deps'],
  };
}

/** A node install needs the node toolchain and nothing else; it never
 *  builds the project (lifecycle scripts are the repo's own business).
 *  Shared with the node remediation capabilities (`node-remediation.ts`),
 *  whose installs and probes need exactly the same environment. */
export const NODE_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['node'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

const PNPM: InstallStrategy = {
  manager: 'pnpm',
  lockfile: 'pnpm-lock.yaml',
  modes: {
    frozen: { primary: { bin: 'pnpm', args: ['install', '--frozen-lockfile'] }, fallbacks: [] },
    resync: { primary: { bin: 'pnpm', args: ['install', '--no-frozen-lockfile'] }, fallbacks: [] },
  },
  syncCheck: {
    kind: 'skipped',
    reason:
      'pnpm has no documented read-only frozen-lockfile check (`--frozen-lockfile ' +
      '--lockfile-only` can rewrite the lockfile, `--dry-run` exits 0 on drift); ' +
      "CI's `pnpm install --frozen-lockfile` is the backstop",
  },
  execution: NODE_EXECUTION,
};

const YARN: InstallStrategy = {
  manager: 'yarn',
  lockfile: 'yarn.lock',
  modes: {
    // Classic-safe primary: classic honors --frozen-lockfile and silently
    // IGNORES --immutable (so --immutable-first would not be frozen there);
    // berry 3+ rejects the classic flag loudly, which is exactly the shape
    // the --immutable fallback answers. Berry 2 accepts it as a deprecated
    // alias and never needs the fallback.
    frozen: {
      primary: { bin: 'yarn', args: ['install', '--frozen-lockfile'] },
      fallbacks: [
        {
          command: { bin: 'yarn', args: ['install', '--immutable'] },
          when: 'unsupported-flag',
          matches: isYarnBerryFlagRejection,
          disclosure: 'yarn berry (3+) spells the frozen install --immutable',
          // The blanket shell retry needs a guard here: yarn CLASSIC would
          // silently ignore --immutable and run a lock-WRITING install, so
          // an unguarded `a || b` would un-freeze the chain exactly where
          // the primary failed for a real reason. Berry-only, by version.
          shellGuard: 'yarn --version 2>/dev/null | grep -qv "^1\\."',
        },
      ],
    },
    // One primary for both yarns: berry honors --no-immutable (the
    // CI-default trap needs the explicit mutable flag); classic ignores the
    // unknown flag and plain-installs, which already writes the lockfile.
    resync: { primary: { bin: 'yarn', args: ['install', '--no-immutable'] }, fallbacks: [] },
  },
  syncCheck: {
    kind: 'skipped',
    reason:
      'yarn has no non-installing frozen-lockfile check that holds across classic and ' +
      "berry; CI's frozen yarn install is the backstop",
  },
  execution: NODE_EXECUTION,
};

const BUN: InstallStrategy = {
  manager: 'bun',
  lockfile: 'bun.lock',
  modes: {
    frozen: { primary: { bin: 'bun', args: ['install', '--frozen-lockfile'] }, fallbacks: [] },
    resync: { primary: { bin: 'bun', args: ['install'] }, fallbacks: [] },
  },
  syncCheck: {
    kind: 'command',
    command: {
      bin: 'bun',
      args: ['install', '--frozen-lockfile', '--dry-run', '--ignore-scripts'],
    },
    tolerates: [],
  },
  ciSetup: ['npm install -g bun >/dev/null 2>&1 || true'],
  execution: NODE_EXECUTION,
};

const NPM_LOCKED: InstallStrategy = {
  manager: 'npm',
  lockfile: 'package-lock.json',
  modes: {
    frozen: {
      primary: { bin: 'npm', args: ['ci'] },
      fallbacks: [legacyPeerDeps('npm', ['ci'])],
      classifyFailure: (o) => (isLockfileDrift(o) ? LOCKFILE_DRIFT : null),
    },
    resync: {
      primary: { bin: 'npm', args: ['install', '--no-audit', '--no-fund'] },
      fallbacks: [legacyPeerDeps('npm', ['install', '--no-audit', '--no-fund'])],
    },
  },
  syncCheck: {
    kind: 'command',
    command: {
      bin: 'npm',
      args: ['ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'],
    },
    tolerates: ['peer-conflict'],
  },
  execution: NODE_EXECUTION,
};

/** A package.json with no lockfile: CI's own `npm install` rather than
 *  nothing, so the verification and the order agree with the workflow. */
const NPM_UNLOCKED: InstallStrategy = {
  manager: 'npm',
  lockfile: null,
  modes: {
    frozen: {
      primary: { bin: 'npm', args: ['install'] },
      fallbacks: [legacyPeerDeps('npm', ['install'])],
    },
    resync: {
      primary: { bin: 'npm', args: ['install', '--no-audit', '--no-fund'] },
      fallbacks: [legacyPeerDeps('npm', ['install', '--no-audit', '--no-fund'])],
    },
  },
  execution: NODE_EXECUTION,
};

/** The per-PM strategy of a LOCKED root, for consumers that already know
 *  the manager (the dep-bump lane reads the doctrine of the repo's PM). */
export const NODE_STRATEGY_BY_PM: Readonly<Record<PackageManager, InstallStrategy>> = {
  pnpm: PNPM,
  yarn: YARN,
  bun: BUN,
  npm: NPM_LOCKED,
};

// Each lockfile-keyed variant reads its trigger set from LOCKFILES, the ONE
// lockfile-set definition `detectLockfile` also reads, in the same
// PM-priority order, so the two projections cannot disagree (the shipped
// shape: a branch keyed on package-lock.json alone while detection also
// accepted npm-shrinkwrap.json).
const VARIANTS: readonly InstallVariant[] = [
  { when: LOCKFILES.pnpm, strategy: PNPM },
  { when: LOCKFILES.yarn, strategy: YARN },
  { when: LOCKFILES.bun, strategy: BUN },
  { when: LOCKFILES.npm, strategy: NPM_LOCKED },
  { when: ['package.json'], strategy: NPM_UNLOCKED },
];

export const nodeInstallStrategy: InstallStrategyProvider = {
  variants: () => VARIANTS,
  // The picked variant's `lockfile` is its canonical basename, but a trigger
  // set can hold several spellings of one lockfile (npm-shrinkwrap.json for
  // package-lock.json, bun.lockb for bun.lock). Resolve the file actually
  // present through the ONE detector so a shrinkwrap-only root reports the
  // file its installs really rewrite; commands are unaffected (npm and bun
  // read whichever spelling exists).
  strategy: (dir) => {
    const picked = strategyFromVariants(VARIANTS, dir);
    if (picked === null || picked.lockfile === null) return picked;
    const present = detectLockfile(dir);
    return present === null || present.lockfile === picked.lockfile
      ? picked
      : { ...picked, lockfile: present.lockfile };
  },
  ciDependencyInstall: true,
};

/**
 * The frozen install a human is pointed at for the node root at `cwd` (the
 * "run this to provision project-local tools" hint): the strategy's frozen
 * primary where a lockfile decides. When none does, the corepack
 * `packageManager` field still names the repo's manager, through the ONE
 * detector (`detectPackageManager`), so a lockfile-less pnpm repo is told
 * `pnpm install`, never a fabricating `npm install`.
 */
export function nodeProvisionHint(cwd: string): string {
  const strategy = nodeInstallStrategy.strategy(cwd);
  if (strategy !== null && strategy.lockfile !== null) {
    return installCommandText(strategy.modes.frozen.primary);
  }
  const pm = detectPackageManager(cwd);
  return pm === 'npm' ? 'npm install' : `${pm} install`;
}

/** The lock-WRITING install a human is pointed at after a manifest edit
 *  (the uninstall prune hint): the resync primary, which re-resolves and
 *  records the edit; the frozen primary would refuse the just-edited
 *  manifest. Same manager resolution as `nodeProvisionHint`. */
export function nodeResyncHint(cwd: string): string {
  const strategy = nodeInstallStrategy.strategy(cwd);
  if (strategy !== null && strategy.lockfile !== null && strategy.modes.resync) {
    return installCommandText(strategy.modes.resync.primary);
  }
  const pm = detectPackageManager(cwd);
  return installCommandText(NODE_STRATEGY_BY_PM[pm].modes.resync!.primary);
}

/**
 * Does the repo's `.npmrc` declare `legacy-peer-deps=true` (the repo itself
 * opting npm into the peer-conflict tolerance)? The ONE probe (doctor and
 * the tolerance resolver both read it — Rule 2), ini-tolerant: npm accepts
 * spaces around `=` and inline whitespace.
 */
export function npmrcDeclaresLegacyPeerDeps(cwd: string): boolean {
  const npmrc = join(cwd, '.npmrc');
  if (!existsSync(npmrc)) return false;
  try {
    return readFileSync(npmrc, 'utf8')
      .split('\n')
      .some((line) => {
        const [key, ...rest] = line.split('=');
        return (
          key !== undefined && key.trim() === 'legacy-peer-deps' && rest.join('=').trim() === 'true'
        );
      });
  } catch {
    return false;
  }
}

/**
 * Command prefixes ("<bin> <verb>", plus the bare-verb aliases each manager
 * accepts) that install or mutate dependencies, across every package manager
 * dxkit knows. Derived from the declared strategies (frozen + resync
 * primaries) and the package-manager builders (add-dev, upgrade), with the
 * short aliases each ecosystem documents declared HERE, never in a consumer.
 *
 * Consumers: the remediate order runs forbid agent-run installs (installs
 * are a frame/recipe step so the lockfile is always re-synced and
 * pre-checked), and render these prefixes into the driver's tool-deny
 * patterns.
 */
export function installCommandPrefixes(): readonly string[] {
  const prefixes = new Set<string>();
  // Documented aliases and the other dependency-mutating verbs (update /
  // remove families) the declared commands never carry. yarn has no bare
  // install alias (plain `yarn` installs, which no prefix can single out).
  const aliases: Record<PackageManager, readonly string[]> = {
    npm: ['npm i', 'npm add', 'npm update', 'npm up', 'npm uninstall', 'npm remove', 'npm rm'],
    pnpm: ['pnpm i', 'pnpm update', 'pnpm up', 'pnpm remove', 'pnpm rm', 'pnpm uninstall'],
    bun: ['bun i', 'bun update', 'bun remove', 'bun rm'],
    yarn: ['yarn up', 'yarn upgrade', 'yarn remove'],
  };
  const verb = (c: { bin: string; args: readonly string[] }) => `${c.bin} ${c.args[0]}`;
  for (const pm of Object.keys(LOCKFILES) as PackageManager[]) {
    const { modes } = NODE_STRATEGY_BY_PM[pm];
    prefixes.add(verb(modes.frozen.primary));
    if (modes.resync) prefixes.add(verb(modes.resync.primary));
    const [addBin, addVerb] = addDevPrefix(pm).split(' ');
    prefixes.add(`${addBin} ${addVerb}`);
    const [upgradeBin, upgradeVerb] = upgradeArgv(pm, 'pkg', '0.0.0', 'dependencies');
    prefixes.add(`${upgradeBin} ${upgradeVerb}`);
    for (const alias of aliases[pm]) prefixes.add(alias);
  }
  return [...prefixes].sort();
}
