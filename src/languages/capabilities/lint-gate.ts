/**
 * The lint-gate capability — a language pack's answer to "what linter command
 * gates NET-NEW lint findings on this repo, and how is its output parsed into
 * per-location findings?".
 *
 * This is deliberately separate from the existing `lint` capability
 * (`LintProvider`), which runs the linter to produce aggregate COUNTS for the
 * Quality dimension score. The gate needs per-FINDING locations (file, line,
 * rule) so it can fingerprint each one and diff net-new-ness — a counts-only
 * signal can't tell "the PR added a lint error" from "the repo already had 40".
 *
 * Lint is NOT a parallel gate path: a pack's `lintCommand` is normalized to a
 * `CustomCheckSpec` named `lint:<pack>` and run through the SAME custom-check
 * runner as user-declared checks. Lint is the first built-in CONSUMER of that
 * one seam.
 *
 * The command's binary is resolved by the pack (via `findTool` — Rule 1 — or a
 * `node_modules/.bin` probe), so the runner just executes it; a missing linter
 * is fail-OPEN (the runner skips it). A pack with no stable machine-parseable
 * linter returns `null` (dormant) — its users gate that linter via a
 * user-declared `checks` entry instead, and the pack wires a real command when
 * its output format is pinned.
 */

export interface LintGateContext {
  readonly cwd: string;
  /** Repo-relative changed files (from `computeChangedFiles`). A pack MAY scope
   *  its command to these; most lint the whole tree so both guardrail sides see
   *  the same set. */
  readonly changedFiles: readonly string[];
}

/**
 * A linter invocation whose text output is parsed per-line into located
 * findings.
 *
 *   - `bin` + `args`: the command. `bin` is PATH-resolvable or an absolute path
 *     the pack resolved (via `findTool` / a local-bin probe).
 *   - `parse`: a regex (string, no flags) with NAMED capture groups — `file`
 *     (required for a located finding), `line`, `rule`, `message` — matching
 *     THIS linter's output format. dxkit compiles it with the `g` flag.
 *   - `expectedExit`: the exit code that means "clean" (default 0). Most linters
 *     exit non-zero when they report findings; that non-zero exit is what tells
 *     the runner to parse the output.
 */
export interface LintGateCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly parse: string;
  readonly expectedExit?: number;
}

/** A pack's lint-gate provider. Pure command builder — it resolves the linter
 *  and returns the command (or `null` to skip); execution + fail-open policy
 *  live in the custom-check runner (a pack never shells out itself). */
export interface LintGateProvider {
  lintCommand(ctx: LintGateContext): LintGateCommand | null;
}
