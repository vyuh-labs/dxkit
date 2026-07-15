/**
 * Types for the custom-check gate runner.
 *
 * A "custom check" is any repo command dxkit runs as a gate citizen: a
 * user-declared invariant from `.dxkit/policy.json:checks` (`check:seam`,
 * `make lint`, a license audit) OR a pack-declared built-in check (lint). Both
 * normalize to the SAME `CustomCheckSpec` and flow through the SAME runner, so
 * lint is not a parallel code path — it is the first built-in consumer of this
 * one seam.
 *
 * The runner turns each check's exit code + output into zero or more
 * `CustomCheckFinding`s, which the baseline producer maps to `custom-check`
 * baseline entries (identity in `finding-identity.ts`). From there they inherit
 * the whole native-finding machine: fingerprint, baseline, matcher, brownfield
 * classify, allowlist, guardrail verdict — so a PRE-EXISTING check failure is
 * grandfathered and only a NET-NEW one blocks/warns.
 */

/** The binary + args a check runs. `bin` is resolved on PATH by the shared
 *  `bounded-exec` primitive (a missing binary is fail-OPEN — skipped, not
 *  failed). Structurally a `RunnableCommand`. */
export interface CustomCheckCommand {
  readonly bin: string;
  readonly args: readonly string[];
}

/**
 * How to turn a failing check's output into findings.
 *
 *   - `{ mode: 'exit' }` (default): BINARY. A non-`expectedExit` exit yields ONE
 *     finding for the whole check (identity = the check name). This is the
 *     `check:seam` / `check:platform` shape — a pass/fail command with no
 *     per-location parse. Its net-new appearance means "this command started
 *     failing".
 *   - `{ mode: 'regex', pattern }`: PARSED. Each output line matching `pattern`
 *     yields one located finding. The regex uses NAMED capture groups —
 *     `(?<file>…)`, `(?<line>…)`, `(?<rule>…)`, `(?<message>…)` — any subset;
 *     `file` present makes the finding located (per file+line+rule identity),
 *     which is what lets a net-new lint diagnostic block while the repo's
 *     pre-existing lint debt is grandfathered. A failing exit that produces zero
 *     regex matches falls back to one BINARY finding, so a failing check never
 *     silently yields nothing.
 */
export type CustomCheckParse =
  | { readonly mode: 'exit' }
  | { readonly mode: 'regex'; readonly pattern: string };

/**
 * A normalized check the runner executes. Built from a user policy entry
 * (`policyCheckToSpec`) or a pack's lint provider (`lintProviderToSpec`) — the
 * runner never distinguishes the two.
 */
export interface CustomCheckSpec {
  /** Stable label — the durable identity key (Rule 9). User checks use their
   *  declared `name`; lint uses `lint:<pack>`. */
  readonly name: string;
  readonly command: CustomCheckCommand;
  /** Whether a NET-NEW failure blocks (true) or only warns (false). Carried onto
   *  each finding so the guardrail folds a non-blocking net-new finding to warn. */
  readonly blocking: boolean;
  /** Exit code that means "pass" (default 0). Any other exit is a failure. */
  readonly expectedExit: number;
  /** Output-to-findings extraction (default `{ mode: 'exit' }`). */
  readonly parse: CustomCheckParse;
}

/** A single failure extracted from a check's output. Maps 1:1 to a
 *  `custom-check` baseline entry. */
export interface CustomCheckFinding {
  readonly check: string;
  readonly blocking: boolean;
  /** Present ⟹ located (per-line diagnostic); absent ⟹ binary (whole command). */
  readonly file?: string;
  readonly line?: number;
  readonly rule?: string;
  /** Human-facing detail (a linter's message, or the captured output tail for a
   *  binary failure). Display only — never hashed into identity (Rule 9). */
  readonly message?: string;
}

export type CustomCheckStatus =
  | 'pass'
  | 'fail'
  | 'skipped-unavailable'
  | 'skipped-timeout'
  /** The command's output outran the capture buffer, so dxkit never read it all.
   *  Fail-OPEN (never a block): a finding count parsed from a fragment is fiction,
   *  and it would slide between runs, so the baseline and the guardrail would
   *  disagree about what is net-new. */
  | 'skipped-overflow';

/** Per-check outcome. `findings` is non-empty only on `fail`. */
export interface CustomCheckResult {
  readonly name: string;
  readonly status: CustomCheckStatus;
  readonly findings: readonly CustomCheckFinding[];
}

/** Aggregate result across every configured check. */
export interface CustomChecksRunResult {
  /** True when at least one check actually executed (not all skipped). */
  readonly ran: boolean;
  readonly results: readonly CustomCheckResult[];
  /** Flattened findings across every failed check — what the producer consumes. */
  readonly findings: readonly CustomCheckFinding[];
}
