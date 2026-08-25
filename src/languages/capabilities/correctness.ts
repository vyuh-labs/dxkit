/**
 * The correctness-floor capability — a language pack's answer to "does this
 * change still COMPILE, and do the tests it affects still PASS?".
 *
 * This is deliberately separate from the finding capabilities (security,
 * coverage, dep-vulns). Those ask "is this code GOOD"; the correctness floor
 * asks "is this code VALID" — a prior, load-bearing question for an autonomous
 * loop, which can otherwise satisfy the finding gate while shipping code that
 * does not build or whose tests fail. A failing floor is a pass/fail signal, not
 * a fingerprinted, grandfathered finding (there is no "grandfather a syntax
 * error").
 *
 * Each pack declares two checks. Both return a command to run, or `null` to skip
 * (tool not applicable, or no relevant change on the fast surface). The runner
 * (`src/analyzers/correctness/`) executes them; it never hardcodes a per-language
 * command (Rule 6).
 */

/** The scope the floor is running at — a fast surface (hook / Stop-gate) runs
 *  the affected subset; CI runs the full suite. Packs whose ecosystem has no
 *  impact-based test selection fall back to a coarser command for `affected`. */
export type CorrectnessScope = 'affected' | 'full';

export interface CorrectnessContext {
  readonly cwd: string;
  /** Repo-relative changed files (from `computeChangedFiles`). Empty when the
   *  caller could not determine the diff — a pack should then treat the scope as
   *  `full` rather than skip. */
  readonly changedFiles: readonly string[];
  readonly scope: CorrectnessScope;
}

/** A command a correctness check runs. `bin` is resolved on PATH by the runner;
 *  a missing binary is fail-OPEN (the check is skipped, not failed). */
export interface CorrectnessCommand {
  /** Short label for output, e.g. `typecheck` / `affected-tests`. */
  readonly label: string;
  readonly bin: string;
  readonly args: readonly string[];
  /**
   * OPTIONAL failure-level parser (4.2): extract durable per-failure
   * identities (failing test names / failing suite files) from the command's
   * FULL captured output on a non-zero exit. The pack attaches the parser
   * matching the exact command it built — it knows whether it emitted vitest
   * or jest — so the runner stays runner-agnostic (Rule 6).
   *
   * Why: check-level identity (`pack:label`) silently absorbs a NEW failing
   * test into an already-red check — on a repo whose suite was already
   * failing at loop entry, nothing the agent breaks in that check can ever
   * block. With per-failure identities the attribution comparator diffs the
   * SET, so new failures block while the pre-existing red stays
   * grandfathered.
   *
   * Contract: identities must be output-order-independent and durable across
   * runs (test full names, suite file paths — never durations or line
   * numbers). Return null when the output is not confidently parseable —
   * the comparator then stays at check level and the non-comparability is
   * DISCLOSED, never guessed (Rule 19: no fabricated precision). Bias
   * false-negative: an unmatched line is dropped, not guessed at.
   */
  readonly parseFailures?: (output: string) => string[] | null;
}

/**
 * The identity prefix of an unresolved PROJECT-PATH import (a relative
 * `./x` / `../x` specifier that reached no file in the repo tree). The
 * identity is the repo-root-relative POSIX path of the missing target,
 * extension-less, prefixed `./` (`./src/components/categoryIcon`), so two
 * files importing the same missing module share ONE finding (the package
 * granularity bare specifiers already have) and the attribution comparator
 * diffs it like any other specifier. A bare package specifier never starts
 * with `./`, so the prefix is the ONE discriminator every consumer reads
 * (`isProjectPathIdentity`), never a second table.
 */
export const PROJECT_PATH_IDENTITY_PREFIX = './';

/** Whether an unresolved-import identity names a repo-tree path (a relative
 *  import whose target is missing) rather than a package. */
export function isProjectPathIdentity(specifier: string): boolean {
  return specifier.startsWith(PROJECT_PATH_IDENTITY_PREFIX);
}

/**
 * Build the project-path identity for a repo-relative POSIX target path.
 * The ONE normalizer both the current side (the pack's check) and the base
 * side (the attribution probe) mint through: a trailing `/index` folds into
 * the directory (`./widgets`, `./widgets/`, `./widgets/index` and
 * `./widgets/index.js` name one module), so respelling an import is never
 * read as a net-new miss.
 */
export function projectPathIdentity(targetRel: string): string {
  let rel = targetRel.replace(/^\.\//, '').replace(/\/+$/, '');
  while (rel.endsWith('/index')) rel = rel.slice(0, -'/index'.length);
  if (rel === 'index') rel = '';
  return PROJECT_PATH_IDENTITY_PREFIX + rel;
}

/** One import specifier that demonstrably does not resolve against the
 *  installed dependency tree or the repo tree. */
export interface UnresolvedImport {
  /** The identity of what failed to resolve: a bare package specifier
   *  (`form-data`), or for a relative import the project-path identity of
   *  the missing target (`./src/components/categoryIcon`, see
   *  `projectPathIdentity`). */
  readonly specifier: string;
  /** Repo-relative POSIX path of an importing file (the first one seen), so
   *  the failure is actionable without re-running the walk. */
  readonly file: string;
  /** What the check actually observed about the target, phrased truthfully
   *  (`is not in the git tree`, `exists on disk but is not tracked in git`);
   *  rendered in place of the generic message when present. */
  readonly detail?: string;
}

/**
 * The tri-state result of a pack's import-resolution check.
 *
 *   - `clean`      — every checked specifier resolves. A floor PASS.
 *   - `unresolved` — at least one bare specifier demonstrably does not exist
 *     on the resolution path. A floor FAILURE (finding-level: each entry is
 *     its own diffable identity, so a repo with pre-existing unresolved debt
 *     still blocks on a NEW one).
 *   - `skipped`    — the check could not answer here (dependencies not
 *     installed, an alias/PnP configuration it does not understand). Fail-OPEN
 *     with the reason DISCLOSED, never silent.
 */
export type ResolutionCheckResult =
  | {
      readonly kind: 'clean';
      readonly checkedSpecifiers: number;
      readonly disclosures?: readonly string[];
    }
  | {
      readonly kind: 'unresolved';
      readonly unresolved: readonly UnresolvedImport[];
      /** What the check declined to judge while still answering (a class of
       *  specifier it stepped back from, and why). Rendered with the
       *  verdict: a partial answer is disclosed, never silent (Rule 19). */
      readonly disclosures?: readonly string[];
    }
  | { readonly kind: 'skipped'; readonly reason: string };

/** One structurally broken artifact — identity is the FILE (a second
 *  problem in the same file is the same broken artifact; a NEW broken
 *  file on an already-red tree is a new finding). */
export interface StructuralFinding {
  readonly file: string;
  readonly problem: string;
}

/**
 * Result of a pack's optional STRUCTURE check (#309): the floor tier
 * between "file exists" and "parses", for artifact classes NO parser
 * covers (the ABAP pack's `.bdef` behavior definitions — abaplint has no
 * BDL parser). `label` names the check's own id so a verdict reader can
 * tell "structurally plausible" from "parsed"; when an upstream parser
 * lands, the structural check retires in its favor. `none` = the tree
 * carries no artifacts of the class (the check never ran, nothing is
 * claimed).
 */
export type StructureCheckResult =
  | { readonly kind: 'clean'; readonly label: string; readonly checkedFiles: number }
  | {
      readonly kind: 'broken';
      readonly label: string;
      readonly findings: readonly StructuralFinding[];
    }
  | { readonly kind: 'skipped'; readonly label: string; readonly reason: string }
  | { readonly kind: 'none' };

import type { ExecutionRequirement } from '../../execution';

/**
 * A pack's correctness-floor provider. Both methods are pure command builders —
 * they inspect the repo + changed files and return the command to run (or
 * `null` to skip). Execution + PATH resolution + fail-open/closed policy live in
 * the runner, so a pack never shells out itself.
 */
export interface CorrectnessProvider {
  /** Compile / typecheck the change. The uniform, cheap floor every pack can
   *  provide — catches the most common agent failure (non-compiling code). */
  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null;
  /** Run the tests the change affects. Native impact-selection where the
   *  ecosystem supports it; a coarser (module / full) fallback otherwise, with
   *  CI's `full` scope as the backstop. Returns `null` when nothing relevant
   *  changed, or when the pack has no test command at all. */
  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null;
  /**
   * OPTIONAL: verify every bare import specifier in the repo's source resolves
   * against the installed dependency tree. This is the floor BETWEEN "compiles"
   * and "bundles" that interpreted stacks lack: a pure-JS repo has no compile
   * stage, and a broken/empty test suite loads nothing — so a lockfile change
   * that un-hoists a phantom dependency ("module not found" at build time)
   * passed every check. Compiled packs DECLINE by omission (their compiler IS
   * the resolution check).
   *
   * Unlike the two command builders this is a direct computation — the pack
   * already extracts import specifiers (Rule 6), and checking them against the
   * installed tree needs no external tool. It must be read-only, never spawn,
   * and bias hard toward false NEGATIVES (benign.ts discipline): skip builtins,
   * `#`-imports, path aliases, anything ambiguous — only report a specifier
   * whose package demonstrably does not exist on the resolution path. The
   * runner treats a throw as a disclosed skip (fail-open).
   */
  resolutionCheck?(ctx: CorrectnessContext): ResolutionCheckResult;
  /**
   * OPTIONAL, paired with `resolutionCheck` when it judges RELATIVE imports:
   * the project-path identities (`projectPathIdentity`) a source file's
   * relative imports would mint if their targets were missing, from the
   * file's CONTENT alone (no tree access), or null when the pack would not
   * judge that file (a test, a declaration file, a static-asset dir). The
   * base-side attribution probe reads base blobs through this, so "was it
   * imported at the base" is decided by the same extractor, plausibility
   * filter and exclusion set as the current side (Rule 2.30), never by a
   * regex over raw lines.
   */
  relativeImportIdentities?(file: string, content: string): readonly string[] | null;
  /**
   * OPTIONAL: verify artifacts of a class NO parser covers are at least
   * STRUCTURALLY plausible (#309 — the `.bdef` class: generation cutoffs,
   * prose/markup leakage, missing header shape, empty files all pass a
   * parser-less floor silently). Pure, read-only, never spawns; discovery
   * routes through the canonical walker; bias hard toward false NEGATIVES
   * (a legal artifact must never be refused — shallow checks only). The
   * runner treats a throw as a disclosed skip (fail-open). Distinct check
   * label so "structurally plausible" is never presented as "parsed";
   * cross-artifact consistency is explicitly OUT of scope (contract-level
   * verification, not syntax).
   */
  structureCheck?(ctx: CorrectnessContext): StructureCheckResult;
  /**
   * What the floor NEEDS from the environment that runs it (CLAUDE.md Rule 20):
   * host OS, ambient toolchains, whether it builds the project, how its target
   * resolves. REQUIRED — the pre-declaration model implicitly assumed
   * `{ hosts: any, toolchains: [], needsBuild: false }` for every floor, which
   * was wrong on every axis for compiled stacks (`dotnet build` of a
   * `net9.0-windows` target on a Linux driver). The runner consults this
   * BEFORE executing, so an unrunnable floor is a disclosed environment
   * boundary, never a silent binary-missing skip; the placement resolver
   * routes on the same declaration.
   *
   * Pure and repo-intrinsic: reads repo files only (a `.csproj` TFM, the build
   * system present), NEVER the current machine — availability is the
   * environment model's side of the line. Deterministic across calls with no
   * machine-specific values, the same contract-tested discipline as
   * `recallInputs` (Rule 19).
   */
  execution(cwd: string): ExecutionRequirement;
}
