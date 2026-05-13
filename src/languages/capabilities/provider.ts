/**
 * Capability provider contract.
 *
 * Anything that can produce a capability result implements this — language
 * packs (`LanguageSupport.capabilities.depVulns`, …) and global gatherers
 * (`gitleaks`, `semgrep`, …) alike. Returning `null` means "this provider
 * has nothing to contribute for this cwd" (e.g. the Python pack on a
 * Go-only repo); the dispatcher filters nulls before aggregating.
 */

import type {
  CapabilityEnvelope,
  DepVulnGatherOutcome,
  DepVulnResult,
  LicensesGatherOutcome,
  LicensesResult,
} from './types';

/**
 * Outcome of a side-effecting `runTests()` invocation (D021).
 *
 * Discriminated so the CLI can render per-pack status (success/skip/fail)
 * AND so the report orchestrator can decide whether downstream consumers
 * (health, test-gaps) will find a usable coverage artifact afterwards.
 *
 *   - `success`     — the test runner exited cleanly AND the expected
 *                     coverage artifact is on disk. `artifact` is the
 *                     relative path so the CLI summary can name it.
 *   - `unavailable` — the pack can't run tests in this repo (test runner
 *                     missing, project config absent, no `.cov` setup).
 *                     `reason` is the human-readable explanation. Not a
 *                     failure — the user just doesn't have the prereqs.
 *   - `failed`      — the test runner ran but exited non-zero (tests
 *                     failed) OR exited zero but produced no artifact.
 *                     `reason` carries the exit message; `durationMs`
 *                     records wall-clock so the CLI can surface the
 *                     "tests ran for 8 min then failed" framing.
 */
export type RunTestsOutcome =
  | { kind: 'success'; artifact: string; durationMs: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string; durationMs: number };

export interface CapabilityProvider<T extends CapabilityEnvelope> {
  /** Source name for attribution in logs and errors (usually the language id). */
  readonly source: string;
  gather(cwd: string): Promise<T | null>;
  /**
   * Optional side-effecting hook that materializes the artifact this
   * provider's `gather()` later reads. Only meaningful on coverage
   * providers today (D021's `vyuh-dxkit coverage` subcommand iterates
   * every active pack's coverage capability and calls `runTests()` if
   * defined). Other capabilities can adopt the same shape if a similar
   * "run the upstream tool to produce input" need arises.
   *
   * Implementations should be idempotent: re-invoking on an already-
   * populated repo should produce the same outcome (rerunning the test
   * suite is fine; the upstream tool typically truncates+rewrites its
   * output file).
   */
  runTests?(cwd: string): Promise<RunTestsOutcome>;
}

/**
 * Specialized provider for dependency-vulnerability gathering. Extends
 * `CapabilityProvider<DepVulnResult>` with a required `gatherOutcome`
 * method that exposes the underlying `DepVulnGatherOutcome` discriminant
 * (success / unavailable / no-manifest) to availability-aware analyzers.
 *
 * D025b (2.4.7): the dispatcher-routed `gather()` method collapses every
 * non-success outcome to `null`, which makes the security scorer blind
 * to the difference between "tool ran cleanly with zero findings" and
 * "tool wasn't available / no manifest" — the dpl-studio F4 baseline
 * (Security 100/100 on 133 unscanned NuGet refs). `gatherOutcome` is
 * the channel by which `gatherDepVulns` in `analyzers/security/gather.ts`
 * computes `DepVulnSummary.available`, which the security scorer reads
 * via `SecurityScoreInput.depVulnsAvailable` to cap the dimension at
 * 65/100 when false.
 *
 * Both methods on this interface delegate to the same underlying pack
 * helper (e.g. `gatherCsharpDepVulnsResult`); implementations should NOT
 * duplicate work between them — call the helper once and unwrap for
 * `gather()`, return the full outcome for `gatherOutcome()`. In practice
 * `gatherDepVulns` only calls `gatherOutcome` (and unwraps locally), so
 * `gather()` is preserved for legacy/dispatcher consumers and isn't
 * invoked on the hot path.
 */
export interface DepVulnsProvider extends CapabilityProvider<DepVulnResult> {
  gatherOutcome(cwd: string): Promise<DepVulnGatherOutcome>;
}

/**
 * Specialized provider for license inventory gathering. D031 (2.4.7):
 * extends `CapabilityProvider<LicensesResult>` with a required
 * `gatherOutcome` method exposing the underlying
 * `LicensesGatherOutcome` discriminant. Same architectural shape as
 * `DepVulnsProvider` (D025b) — solves the same customer-credibility
 * lie (the licenses report rendering "0 packages" on dpl-studio when
 * `nuget-license` is absent, indistinguishable from a repo with
 * legitimately zero third-party deps).
 *
 * `gatherOutcome` channels the discriminant to `gatherLicensesWith
 * Availability` in `analyzers/licenses/gather.ts`, which feeds it
 * into the licenses report's framing block (success → full
 * inventory; unavailable → ⚠ notice + degraded fallback path;
 * no-manifest → "no packages to license" honest framing). The
 * dispatcher-routed `gather()` continues to collapse non-success
 * outcomes to null for legacy consumers.
 *
 * Both methods on this interface delegate to the same underlying
 * pack helper (e.g. `gatherCsharpLicensesResult`); implementations
 * should NOT duplicate work — call the helper once, unwrap for
 * `gather()`, return the full outcome for `gatherOutcome()`.
 */
export interface LicensesProvider extends CapabilityProvider<LicensesResult> {
  gatherOutcome(cwd: string): Promise<LicensesGatherOutcome>;
}
