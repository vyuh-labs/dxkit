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
 * A located finding as the PACK's parser reports it, before validation. The
 * seam boundary (`parseLocated`'s post-condition) — not the pack — enforces
 * that `file` leaves as a repo-relative POSIX path, dedupes, and applies the
 * itemization ceiling; the pack just maps its linter's native shape to this.
 */
export interface RawLocatedFinding {
  readonly file: string;
  readonly line?: number;
  readonly rule?: string;
  readonly message?: string;
}

/**
 * How a linter's output becomes located findings.
 *
 *   - `structured` (preferred): the pack parses the linter's native
 *     machine-readable output (eslint `--format json`, ruff `--output-format
 *     json`, clippy `--message-format json`, …). A display format is for
 *     humans and every regex over one eventually diverges from it — the
 *     shipped class: eslint's unix render dropped findings the JSON carries,
 *     and clippy's short format omits the LINT NAME entirely, so two
 *     different lints in one 3-line window collided into one identity
 *     (Rule 5 ×4: prefer the tool's own structured output over a custom
 *     parser). `label` names the format for recall/diagnostics (a function
 *     cannot be hashed); it must change if the parse's semantics change.
 *   - `regex`: a regex (string, no flags) with NAMED capture groups — `file`
 *     (required for a located finding), `line`, `rule`, `message` — matched
 *     per output line. For linters with no stable machine-readable output
 *     (today: the MSBuild diagnostic stream behind `dotnet build`).
 *
 * A pack parser must be PURE and total over untrusted linter output — throw
 * on nothing, return [] for anything unrecognizable; the runner treats a
 * throw as a check misconfiguration (one binary finding), never a crash.
 */
export type LintOutputParse =
  | { readonly kind: 'regex'; readonly pattern: string }
  | {
      readonly kind: 'structured';
      readonly label: string;
      readonly parse: (output: string) => readonly RawLocatedFinding[];
    };

/**
 * A linter invocation whose output is parsed into located findings.
 *
 *   - `bin` + `args`: the command. `bin` is PATH-resolvable or an absolute path
 *     the pack resolved (via `findTool` / a local-bin probe).
 *   - `parse`: see `LintOutputParse`.
 *   - `expectedExit`: the exit code that means "clean" (default 0). Most linters
 *     exit non-zero when they report findings; that non-zero exit is what tells
 *     the runner to parse the output.
 */
export interface LintGateCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly parse: LintOutputParse;
  readonly expectedExit?: number;
}

/** How a pack resolves the versions it reports as recall inputs.
 *
 *  - `resolved` (default): what ACTUALLY ran — the installed version
 *    (`node_modules/eslint/package.json`, `ruff --version`). Honest: if a
 *    developer and CI run different plugin versions they genuinely produce
 *    different findings, and that IS worth surfacing.
 *  - `locked`: the DECLARED range (`package.json` devDependencies:
 *    `"eslint": "^9.0.0"`), which does not move when a caret range resolves
 *    forward. For repos that tolerate dev != CI and want fewer re-baselines.
 */
export type RecallInputMode = 'resolved' | 'locked';

export interface LintGateRecallContext extends LintGateContext {
  readonly mode: RecallInputMode;
}

/** A pack's lint-gate provider. Pure command builder — it resolves the linter
 *  and returns the command (or `null` to skip); execution + fail-open policy
 *  live in the custom-check runner (a pack never shells out itself). */
export interface LintGateProvider {
  lintCommand(ctx: LintGateContext): LintGateCommand | null;

  /**
   * What determines what THIS pack's linter can see, beyond its command
   * (CLAUDE.md Rule 19). Returns `name -> version | hash` pairs: the linter's
   * own version, its plugin versions, its config-file content hash.
   *
   * REQUIRED, because the command alone is not enough and the gap is not
   * hypothetical: `eslint-plugin-react-hooks ^7.0.1 -> 7.1.1` adds rules under
   * a byte-identical argv, so without this every newly-reported finding is
   * attributed to whoever opened the next PR. Only the pack knows how to
   * resolve its ecosystem's versions (Rule 6), and an optional field here would
   * recreate exactly the second-class status that made lint unattributable for
   * its entire life.
   *
   * Contract: keys must be STABLE across runs (never a timestamp or an absolute
   * temp path — an unstable input reads as permanent drift and silently
   * disables the gate). Return `{}` only when the pack genuinely has nothing to
   * resolve; a missing linter resolves to no entry rather than an error, since
   * the runner is fail-open on an absent binary.
   */
  recallInputs(ctx: LintGateRecallContext): Record<string, string>;
}
