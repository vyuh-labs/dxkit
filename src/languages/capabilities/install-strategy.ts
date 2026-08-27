/**
 * The install-strategy capability: how a repository provisions its
 * dependency tree, and which deviations it TOLERATES, declared ONCE per
 * language pack (CLAUDE.md Rule 6) and consumed by every surface that
 * installs (Rule 2.30: one concept, one code path).
 *
 * The class this closes. "Install this repo, with its tolerated fallbacks"
 * lived in three lossy projections: a shell if-chain the CI templates
 * rendered from an npm-keyed branch table, a pack `provision()` that carried
 * the primary command only, and a lock-writing `resyncInstallFor` with its
 * own fallback list. Each grew its own copy of "retry under
 * --legacy-peer-deps on a peer conflict"; the lane's verification took the
 * fallback as a blanket retry and named the FALLBACK as the failing command
 * when a hand-edited lockfile failed both, which read as "the fallback is
 * missing". Consolidating onto any one of the three would still have been a
 * projection: the CI chain has no lock-writing form, the resync has no
 * frozen form, and neither knows which tolerances THIS repo authorizes.
 *
 * The model:
 *
 *   - An `InstallStrategy` is a repo-intrinsic fact per dependency root: the
 *     package manager, the lockfile present, and one `InstallPlan` per MODE
 *     (`frozen`: install exactly the lockfile, what CI and a verification
 *     run; `resync`: rewrite the lockfile from the manifest, what a
 *     lockfile-repairing recipe runs). Each plan is a primary command plus
 *     DECLARED fallbacks.
 *   - A fallback answers exactly one `ToleranceClass`: a closed set of
 *     deviations an ecosystem can tolerate (`peer-conflict`: npm's peer
 *     check rejects a tree the lockfile already records; `unsupported-flag`:
 *     an older manager spells a flag differently). The pack supplies the
 *     MECHANISM (the command and the failure-shape classifier); the repo
 *     supplies the AUTHORIZATION (`src/install/tolerances.ts`: policy,
 *     observed repo config, or the class's declared default). A fallback
 *     whose class the repo does not tolerate is never run and never
 *     rendered.
 *   - ONE executor (`src/install/run.ts`) walks the ladder, classifies a
 *     failure against the pack's declared classifiers (never an inline regex
 *     in a consumer) and discloses which fallback fired and why. ONE shell
 *     renderer (`src/install/shell.ts`) renders the CI chain from the same
 *     variants, so template == runner == verifier by construction.
 *
 * Declarations are PURE and REPO-INTRINSIC (read repo files only; never
 * PATH, never the host OS), deterministic, machine-independent: the
 * same discipline as `ExecutionRequirement` (Rule 20) and recall inputs
 * (Rule 19). Pinned per pack by `test/languages-contract.test.ts`.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import type { ExecutionRequirement } from '../../execution';

/** A command as an argv split: `bin` resolves on PATH, `args` are execFile'd
 *  (never a shell string; package names transit these as arguments). */
export interface InstallCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * The closed set of deviations an install may tolerate. Each class carries
 * its authorization doctrine in `TOLERANCE_CLASSES`; a pack may only declare
 * fallbacks for classes named here (the type is derived from the table, so
 * an unregistered class fails to compile).
 */
export const TOLERANCE_CLASSES = {
  /**
   * The package manager's peer-dependency check rejects a tree the lockfile
   * already records (npm 7+ ERESOLVE). The fallback skips the CHECK only: it
   * installs the same lockfile tree, never a re-resolved one, which is why it
   * has been the shipped default since the first estate whose own install
   * tolerated a peer conflict died at a generated workflow's install step.
   * Default-authorized; a repo opts OUT through `dependencies.tolerate`.
   */
  'peer-conflict': {
    summary: 'a peer-dependency conflict the lockfile tree already tolerates',
    authorization: 'default-on',
  },
  /**
   * An older manager version does not know a flag the primary carries and
   * spells the same install differently (yarn classic's `--frozen-lockfile`
   * for berry's `--immutable`). Not a deviation of the tree at all, so it is
   * intrinsic: always applied, never subject to policy.
   */
  'unsupported-flag': {
    summary: 'an older package-manager version spells the same install with a different flag',
    authorization: 'intrinsic',
  },
} as const satisfies Record<string, ToleranceDoctrine>;

/** How a tolerance class is authorized: `default-on` applies unless policy
 *  says otherwise; `intrinsic` always applies (not a repo decision);
 *  `declared` applies only through policy or observed repo config. */
export type ToleranceAuthorization = 'default-on' | 'intrinsic' | 'declared';

export interface ToleranceDoctrine {
  readonly summary: string;
  readonly authorization: ToleranceAuthorization;
}

export type ToleranceClass = keyof typeof TOLERANCE_CLASSES;

/** Every tolerance class, in declaration order (the policy enum + docs). */
export const ALL_TOLERANCE_CLASSES = Object.keys(TOLERANCE_CLASSES) as readonly ToleranceClass[];

/** The doctrine of a class, widened to the full authorization union. */
export function toleranceDoctrine(cls: ToleranceClass): ToleranceDoctrine {
  return TOLERANCE_CLASSES[cls];
}

/** The classes policy may switch on or off (`intrinsic` classes are not a
 *  repo decision and are ignored in a policy list). */
export function policyTolerances(): readonly ToleranceClass[] {
  return ALL_TOLERANCE_CLASSES.filter((c) => toleranceDoctrine(c).authorization !== 'intrinsic');
}

/**
 * A declared fallback: the command retried when the primary fails FOR THE
 * ONE REASON `matches` recognizes, the tolerance class it answers, and the
 * disclosure every surface prints when it fires. `viaFlags` is present when
 * the fallback is exactly "the primary plus these flags", so a consumer that
 * composes its own primary (the dep-bump lane's `npm install pkg@ver`) can
 * apply the same doctrine without a second declaration.
 */
export interface InstallFallback {
  readonly command: InstallCommand;
  readonly when: ToleranceClass;
  /** The pack's classifier for this class: does a FAILED primary's output
   *  have the shape this fallback answers? Pure; biased toward false
   *  negatives (a lockfile that does not record the manifest must never
   *  read as a peer conflict). */
  readonly matches: (output: string) => boolean;
  readonly disclosure: string;
  readonly viaFlags?: readonly string[];
  /**
   * A shell condition that must hold before the RENDERED chain may retry
   * with this fallback (`primary || { guard && fallback; }`). Required
   * whenever the blanket shell retry would not be outcome-equivalent to the
   * classifier-gated executor: the worked example is yarn, where classic
   * silently ignores berry's `--immutable` and would run a lock-WRITING
   * install if the chain retried unguarded. The in-process executor never
   * reads this; its classifier is the gate.
   */
  readonly shellGuard?: string;
}

/** One mode's ladder: the primary, then the declared fallbacks in order. */
export interface InstallPlan {
  readonly primary: InstallCommand;
  readonly fallbacks: readonly InstallFallback[];
  /**
   * OPTIONAL classifier for a failure NO fallback answers, so the executor
   * can name the class (`lockfile-drift`: the lockfile does not record the
   * manifest) instead of `unclassified`. A label the pack owns; consumers
   * compare labels, never re-parse output.
   */
  readonly classifyFailure?: (output: string) => string | null;
}

/**
 * A non-installing "would the frozen install succeed?" check (the floor's
 * lockfile-sync tier), or a disclosed skip for an ecosystem whose manager
 * has no reliable dry-run. `tolerates` names the classes whose fallback
 * covers a failure of the check: the executor reads the frozen plan's
 * fallback of that class for the classifier, so the check and the install
 * cannot disagree on what "peer conflict" means.
 */
export type LockfileSyncCheck =
  | {
      readonly kind: 'command';
      readonly command: InstallCommand;
      readonly tolerates: readonly ToleranceClass[];
    }
  | { readonly kind: 'skipped'; readonly reason: string };

/** The strategy of one dependency root. */
export interface InstallStrategy {
  /** The package manager, as a display id (`npm`, `pnpm`, `poetry`, `bundler`). */
  readonly manager: string;
  /** The lockfile the strategy keys on (repo-root-relative basename), or
   *  null when the ecosystem installs from the manifest alone. */
  readonly lockfile: string | null;
  readonly modes: {
    readonly frozen: InstallPlan;
    /** Absent when the ecosystem has no lock-writing install dxkit can name
     *  (disclosed by the consumers that need one). */
    readonly resync?: InstallPlan;
  };
  /** Absent when the ecosystem has no lockfile-sync concept to check. */
  readonly syncCheck?: LockfileSyncCheck;
  /** Shell-only bootstrap lines the CI chain renders before the install
   *  (CI provisions bun on demand; locally the binary must be on PATH). */
  readonly ciSetup?: readonly string[];
  /** What the install NEEDS from the environment that runs it (Rule 20). */
  readonly execution: ExecutionRequirement;
}

/**
 * One file-keyed variant of a pack's strategy: selected when ANY of `when`
 * exists at the root (`package.json` alone for a lockfile-less root). The
 * variants are what the shell renderer enumerates into an if/elif chain and
 * what `strategyFromVariants` picks from, so the rendered chain and the
 * in-process pick read one list in one order.
 */
export interface InstallVariant {
  readonly when: readonly string[];
  readonly strategy: InstallStrategy;
}

export interface InstallStrategyProvider {
  /** Every variant, in selection order (first match wins). Pure. */
  variants(): readonly InstallVariant[];
  /** The strategy for the root at `dir`, or null when nothing is there to
   *  install. Pure and repo-intrinsic; the default derivation is
   *  `strategyFromVariants(this.variants(), dir)`. */
  strategy(dir: string): InstallStrategy | null;
  /**
   * Must a CI workflow that runs dxkit on a checkout install THIS
   * ecosystem's dependencies first? True for the node pack: the dxkit CLI
   * and the repo's project-local tools live in its tree. The shell renderer
   * chains only the packs that say so; a pack whose toolchain CI provisions
   * through `ciSetup` leaves it false.
   */
  readonly ciDependencyInstall: boolean;
}

/** The ONE variant pick: first variant any of whose `when` files exists. */
export function strategyFromVariants(
  variants: readonly InstallVariant[],
  dir: string,
): InstallStrategy | null {
  for (const v of variants) {
    if (v.when.some((f) => existsSync(join(dir, f)))) return v.strategy;
  }
  return null;
}

/** A provider over a variant list, with the default derivation. */
export function declareInstallStrategy(
  variants: readonly InstallVariant[],
  opts: { readonly ciDependencyInstall: boolean },
): InstallStrategyProvider {
  return {
    variants: () => variants,
    strategy: (dir) => strategyFromVariants(variants, dir),
    ciDependencyInstall: opts.ciDependencyInstall,
  };
}

/** `[bin, ...args]` as one display string. */
export function installCommandText(cmd: InstallCommand): string {
  return [cmd.bin, ...cmd.args].join(' ');
}
