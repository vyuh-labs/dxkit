/**
 * The remediation capability seam (Rule 6 applied to the recipe executors,
 * mirror of `CorrectnessProvider`): every ecosystem fact a deterministic
 * remediation recipe needs is DECLARED here per language pack, and the four
 * cross-cutting executors under `src/remediate/recipes/` consume the
 * declarations through the registry. Nothing in an executor may hardcode an
 * ecosystem fact (an npm override key, a linter fix flag, a manifest
 * filename); the arch-check bans package-manager literals there.
 *
 * Four capabilities, one per recipe:
 *
 *   - `resyncLockfile` (the lockfile-sync recipe): the lock-writing resync
 *     COMMAND rides the pack's existing `installStrategy` (its `resync`
 *     mode, executed by the ONE install executor), and the verify rides the
 *     pack's `correctness.lockfileCheck` (the exact check that minted the
 *     order). This declaration adds only what neither seam carries: the
 *     manifest basenames that name the owning root in an order's envelope.
 *     Rule 2: never a second install path.
 *   - `pinTransitive` (the override-pin recipe): how this ecosystem pins a
 *     transitive dependency to a fixed version (npm `overrides`, later
 *     pnpm.overrides / yarn resolutions / pip constraints), as a PURE
 *     manifest text edit the executor applies, plus revert prose.
 *   - `declareDependency` (the declare-dependency recipe): how a bare
 *     import specifier becomes a declared, installed dependency: the
 *     specifier validity rail (Rule 11), the registry version probe, and
 *     the install command.
 *   - `lintFix` (the lint-autofix recipe): the builder ALREADY lives on
 *     `lintGate.fixCommand` (Rule 2: one code path); this declaration folds
 *     it into the same declared-exemption discipline, pinned consistent by
 *     the languages contract test.
 *
 * Every declaration is either a CAPABILITY or an EXEMPTION with a reason
 * (the DEFERRED_KINDS discipline): a pack that cannot support a capability
 * says why, the planner tiers its orders to the agent and discloses the
 * reason in plan output, and nothing is ever silently absent. The field is
 * REQUIRED on `LanguageSupport`, so a new pack that omits it fails to
 * compile.
 *
 * Providers are pure builders in the correctness-provider sense: they may
 * READ repo files (is the package a direct dependency here?) but they never
 * write, never spawn, and never probe PATH or the host. Execution + the
 * fail-open policy live in the recipe executors, under the required trust
 * context. These capabilities FIX findings rather than observe them; their
 * verifies run through seams whose recall inputs are already declared (the
 * dep-audit dispatch, the resolution check, the lint gate), so they carry
 * no recall inputs of their own (Rule 19 stays with the observers).
 */
import type { ExecutionRequirement } from '../../execution';
import type { InstallCommand } from './install-strategy';

/** A declared exemption: the pack cannot (or does not yet) support the
 *  capability, and says why. Rendered in plan output; never silence. */
export interface RemediationExemption {
  readonly kind: 'exemption';
  /** A full sentence a plan reader can act on. */
  readonly reason: string;
}

/** A capability with its provider, or a declared exemption. */
export type RemediationDeclaration<P> =
  | { readonly kind: 'capability'; readonly provider: P }
  | RemediationExemption;

/**
 * A rider declaration: the capability's builder lives on an existing seam
 * (`lintGate.fixCommand` for `lintFix`), so declaring it here adds only the
 * exemption discipline. The contract test pins a `capability` rider to the
 * presence of its underlying builder, so the two facts cannot drift.
 */
export type RemediationRider = { readonly kind: 'capability' } | RemediationExemption;

// ── resyncLockfile ─────────────────────────────────────────────────────────

export interface ResyncLockfileProvider {
  /**
   * Manifest basenames that name the owning dependency root in an order's
   * envelope (`package.json`, `pyproject.toml`). The executor derives the
   * root from the ONE envelope entry matching these; command and verify
   * come from `installStrategy.strategy(root).modes.resync` and
   * `correctness.lockfileCheck` respectively (Rule 2: this provider
   * declares no command of its own).
   */
  readonly manifestFiles: readonly string[];
}

// ── pinTransitive ──────────────────────────────────────────────────────────

export interface PinContext {
  readonly cwd: string;
  /** Repo-relative owning dependency root (`''` = the repo root). */
  readonly rootDir: string;
  readonly pkg: string;
  /** The concrete version to pin. */
  readonly version: string;
}

/**
 * A pure manifest edit: the EXECUTOR reads the file and writes the result;
 * the pack supplies only the text -> text transform (which may refuse with
 * a reason: a direct dependency, an unparseable manifest). Style
 * preservation (indentation, trailing newline) is the transform's job.
 */
export interface ManifestTextEdit {
  /** The manifest file the edit rewrites, relative to the owning root. */
  readonly file: string;
  readonly transform: (text: string) => { readonly text: string } | { readonly refused: string };
}

export type PinPlanResult =
  | {
      readonly kind: 'plan';
      readonly edit: ManifestTextEdit;
      /** How a human undoes the pin, rendered in ledger prose. */
      readonly revert: string;
    }
  | { readonly kind: 'refused'; readonly reason: string };

export interface PinTransitiveProvider {
  /** Manifest basenames naming the owning root in an envelope (the edit
   *  surface); drives the same root derivation `resyncLockfile` uses. */
  readonly manifestFiles: readonly string[];
  /** OSV ecosystem name for the candidate pre-check (`npm`, `PyPI`, ...). */
  readonly osvEcosystem: string;
  /** Plan the pin at a root: a pure decision (may READ repo files, writes
   *  nothing) yielding the edit + revert prose, or a refusal with the
   *  reason (an override mechanism the pack does not implement yet). */
  plan(ctx: PinContext): PinPlanResult;
  /** What applying the pin needs from the environment (Rule 20). Pure and
   *  repo-intrinsic, the install-strategy discipline. */
  execution(cwd: string): ExecutionRequirement;
}

// ── declareDependency ──────────────────────────────────────────────────────

export interface DeclareContext {
  readonly cwd: string;
  /** Repo-relative owning dependency root (`''` = the repo root). */
  readonly rootDir: string;
  readonly specifier: string;
}

export interface DeclareInstallContext extends DeclareContext {
  /** The concrete registry version the probe resolved. */
  readonly version: string;
  /** True when every importer is a test file (a dev dependency). */
  readonly dev: boolean;
}

export interface DeclareDependencyProvider {
  /** Manifest basenames naming the owning root in an envelope. */
  readonly manifestFiles: readonly string[];
  /** OSV ecosystem name for the candidate pre-check. */
  readonly osvEcosystem: string;
  /** The ecosystem's word for a valid specifier, used in refusal prose
   *  (`npm package name`). */
  readonly packageNameLabel: string;
  /**
   * The Rule 11 argument-injection rail: is `specifier` a package-name
   * shape safe to hand to the ecosystem's tools as an argument? A leading
   * dash, whitespace, or a URL must be rejected BEFORE any argv exists.
   * Consulted at planning time (the registry's `matches`) AND re-checked by
   * the executor. Pure.
   */
  validSpecifier(specifier: string): boolean;
  /** The registry version probe for a candidate; the executor runs it
   *  through bounded exec and reads its output via `parseProbeOutput`. */
  versionProbe(ctx: DeclareContext): InstallCommand;
  /** The concrete version out of the probe's output, or null when the
   *  output does not name one. Pure and total over untrusted output. */
  parseProbeOutput(output: string): string | null;
  /** The install command declaring `specifier@version` into the manifest
   *  (the dev section when `dev`). */
  installCommand(ctx: DeclareInstallContext): InstallCommand;
  /** What the declare + install needs from the environment (Rule 20). */
  execution(cwd: string): ExecutionRequirement;
}

// ── the pack-level declaration ─────────────────────────────────────────────

/**
 * A pack's remediation declarations, one per recipe capability. REQUIRED on
 * `LanguageSupport`: every pack answers every capability, with a provider
 * or a reasoned exemption.
 */
export interface RemediationSupport {
  readonly resyncLockfile: RemediationDeclaration<ResyncLockfileProvider>;
  readonly pinTransitive: RemediationDeclaration<PinTransitiveProvider>;
  readonly declareDependency: RemediationDeclaration<DeclareDependencyProvider>;
  /** Builder = `lintGate.fixCommand` (Rule 2); this is the exemption
   *  discipline only. */
  readonly lintFix: RemediationRider;
}

export type RemediationCapabilityId = keyof RemediationSupport;

/** Every capability id, in declaration order. */
export const REMEDIATION_CAPABILITY_IDS: readonly RemediationCapabilityId[] = [
  'resyncLockfile',
  'pinTransitive',
  'declareDependency',
  'lintFix',
];

/**
 * The declaration set for a pack whose ecosystem fills land in a later unit
 * of this release: every capability an honest planned exemption naming the
 * ecosystem. Orders of these packs tier to the agent with the reason
 * disclosed; a pack graduates by replacing entries with real providers.
 */
export function plannedRemediationSupport(ecosystem: string): RemediationSupport {
  const planned = (what: string): RemediationExemption => ({
    kind: 'exemption',
    reason:
      `${what} is not declared for the ${ecosystem} ecosystem yet ` +
      '(planned); these orders stay on the agent tier',
  });
  return {
    resyncLockfile: planned('the lockfile resync recipe'),
    pinTransitive: planned('transitive dependency pinning'),
    declareDependency: planned('dependency declaration'),
    lintFix: planned('the linter autofix recipe'),
  };
}
