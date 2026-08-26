/**
 * The lockfile-sync half of package-manager knowledge: the non-installing
 * "is the lockfile in sync?" check the correctness floor runs, and the
 * lock-writing resync install the lockfile-sync recipe runs. Split from
 * `package-manager.ts` for module size only; PM detection and the install
 * argv tables stay there (one definition each).
 */
import {
  isPeerConflictOnly,
  LEGACY_PEER_DEPS_REASON,
  type PackageManager,
} from './package-manager';

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
 *   - pnpm: a DISCLOSED skip. `--frozen-lockfile` is documented only as "does
 *     not generate a lockfile and fails if an update is needed", not as a
 *     read-only check: paired with `--lockfile-only` (documented as "only
 *     updates pnpm-lock.yaml") it has rewritten an in-sync lockfile on a
 *     format upgrade, and `install --dry-run` (pnpm 11.8+) exits 0 even when
 *     it reports the lockfile would change, so neither can back a verdict
 *     without touching the tree. CI's `pnpm install --frozen-lockfile` stays
 *     the backstop.
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
        kind: 'skipped',
        reason:
          'pnpm has no documented read-only frozen-lockfile check (`--frozen-lockfile ' +
          '--lockfile-only` can rewrite the lockfile, `--dry-run` exits 0 on drift); ' +
          "CI's `pnpm install --frozen-lockfile` is the backstop",
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

/** The install that (re)writes the lockfile from the manifest. A fallback is
 *  a DECLARED doctrine, never a blanket retry: `matches` names the one
 *  primary-failure shape the fallback answers (npm's peer conflict via the
 *  shared `isPeerConflictOnly`; yarn classic rejecting a berry-only flag). */
export interface ResyncInstall {
  readonly pm: PackageManager;
  readonly argv: readonly string[];
  readonly fallback?: {
    readonly argv: readonly string[];
    readonly reason: string;
    readonly matches: (output: string) => boolean;
  };
}

/**
 * The lock-writing install per PM. npm re-resolves and writes
 * `package-lock.json` (`--no-audit --no-fund` keeps it quiet and offline-ish);
 * its peer-conflict fallback mirrors the frozen install's declared doctrine.
 * The CI-default trap: pnpm flips to `--frozen-lockfile` and yarn berry to
 * `--immutable` whenever CI is set, exactly where the scheduled lane runs, so
 * both carry the explicit mutable flag. yarn classic (v1) does not know
 * `--no-immutable`; the declared fallback drops to its plain install, which
 * is already lock-writing. bun has no CI flip (that is what its separate
 * `bun ci` alias is for), so its plain install stays lock-writing as is.
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
          matches: isPeerConflictOnly,
        },
      };
    case 'pnpm':
      return { pm, argv: ['pnpm', 'install', '--no-frozen-lockfile'] };
    case 'yarn':
      return {
        pm,
        argv: ['yarn', 'install', '--no-immutable'],
        fallback: {
          argv: ['yarn', 'install'],
          reason:
            'yarn classic (v1) does not know --no-immutable; its plain install already ' +
            'writes the lockfile',
          matches: (output) => /no-immutable|unknown (option|flag)/i.test(output),
        },
      };
    case 'bun':
      return { pm, argv: ['bun', 'install'] };
  }
}
