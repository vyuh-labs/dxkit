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
}

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
