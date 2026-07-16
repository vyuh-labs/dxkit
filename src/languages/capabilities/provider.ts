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
  LintGatherOutcome,
  LintResult,
} from './types';
import type { ExecutionRequirement } from '../../execution';

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
 * "tool wasn't available / no manifest" — the .NET WinForms benchmark
 * F4 baseline (Security 100/100 on 133 unscanned NuGet refs). `gatherOutcome` is
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
/**
 * Options that adjust how a dependency audit is gathered.
 *
 * `skipRemediation` drops the Tier-2 *remediation* enrichment — the structured
 * `upgradePlan` produced by guided-remediation tools (e.g. `osv-scanner fix`,
 * which resolves the dependency tree by running the package manager). The
 * guardrail/gate path sets this: the block decision and finding identity never
 * read `upgradePlan` (it's excluded from the fingerprint), so computing it there
 * is pure cost — and for the TS pack it means running `npm install` on the
 * scanned code, which is both slow and unsafe on an untrusted PR. Reports
 * (health / vulnerabilities / bom) leave it unset and keep the full enrichment.
 */
export interface DepVulnGatherOptions {
  readonly skipRemediation?: boolean;
  /**
   * The scanned source is possibly attacker-controlled (e.g. a hosted PR
   * gate). Dep audits MUST NOT execute it — no project builds, no install
   * hooks. The Python pack drops `pip-audit .` project mode (its PEP 517
   * backend can run arbitrary code) and audits only a requirements file, or
   * reports unavailable. npm-audit and osv-scanner `scan` are already
   * read-only, so the TS/Java/etc. paths are unaffected. Set by the gate via
   * `guardrail check --untrusted`; trusted local runs (reports, the loop on
   * your own repo) leave it unset and keep full coverage.
   */
  readonly untrusted?: boolean;
}

export interface DepVulnsProvider extends CapabilityProvider<DepVulnResult> {
  gatherOutcome(cwd: string, opts?: DepVulnGatherOptions): Promise<DepVulnGatherOutcome>;
  /**
   * What the audit NEEDS from the environment that runs it (CLAUDE.md
   * Rule 20). REQUIRED. Registry tools (osv-scanner, pip-audit) are NOT
   * declared here — `findTool` owns their lifecycle (Rule 1); this names the
   * AMBIENT toolchains the audit shells beyond them: `npm audit` needs node,
   * `govulncheck` needs the Go toolchain for call analysis, while a pure
   * lockfile scan (osv-scanner on Gemfile.lock / a Maven tree) needs none.
   *
   * Pure and repo-intrinsic; deterministic. Field addition is a deliberate
   * change to the frozen-in-place pack contract — pinned alongside
   * `manifestPatterns` in `test/sdk-surface-freeze.test.ts`.
   */
  execution(cwd: string): ExecutionRequirement;
  /**
   * Filenames / patterns that identify this pack's dependency manifests and
   * lockfiles (e.g. `package.json`, `package-lock.json`, `*.csproj`,
   * `gradle/verification-metadata.xml`). Declared here, next to the audit it
   * gates, so the fact lives in one place per language (CLAUDE.md Rule 6).
   *
   * Matched by the registry helper `changedFilesTouchDependencyManifest`:
   * a bare name matches any file with that basename anywhere in the tree;
   * a `*` is a glob on the basename; a multi-segment pattern matches a path
   * suffix. Used to decide, in incremental ref-based mode, whether a PR could
   * have introduced a net-new dependency vulnerability — if no changed file
   * matches any active pack's pattern, the OSV audit is skipped (sound: a
   * net-new dep vuln requires a manifest/lockfile change, and ref-based
   * audits both sides against the same OSV snapshot, so an unchanged dep is
   * identical on both sides and never net-new).
   */
  readonly manifestPatterns: readonly string[];
  /**
   * Lockfile basenames that mark an INDEPENDENT dependency-resolution root
   * (`package-lock.json`, `Gemfile.lock`, `go.mod`, `Cargo.lock`). A nested
   * directory containing one is a sub-project whose dependency tree the
   * root audit cannot see — common in monorepos with a separate `server/`
   * or `web/` app that is NOT a workspace member — so the dep audit runs
   * once per discovered root and merges (the nested-lockfile gap: a
   * critical vuln added to a nested lockfile read CLEAN at the root).
   *
   * Deliberately lockfiles, not manifests: a nested plain manifest (a Maven
   * module's `pom.xml`, an npm workspace member's `package.json`) resolves
   * from the ROOT tree and is already covered by the root audit — auditing
   * it separately would duplicate work, not close a gap. Maven therefore
   * declares no patterns (no lockfile concept); packs whose audit runs on a
   * manifest that IS independently resolved (`requirements.txt`, `go.mod`)
   * declare that manifest here.
   *
   * Optional — a pack that omits it keeps root-only auditing.
   */
  readonly lockfilePatterns?: readonly string[];
}

/**
 * Specialized provider for license inventory gathering. D031 (2.4.7):
 * extends `CapabilityProvider<LicensesResult>` with a required
 * `gatherOutcome` method exposing the underlying
 * `LicensesGatherOutcome` discriminant. Same architectural shape as
 * `DepVulnsProvider` (D025b) — solves the same customer-credibility
 * lie (the licenses report rendering "0 packages" on the .NET WinForms benchmark
 * when `nuget-license` is absent, indistinguishable from a repo with
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

/**
 * Specialized provider for lint gathering. Extends
 * `CapabilityProvider<LintResult>` with an optional `gatherOutcome`
 * exposing the underlying `LintGatherOutcome` discriminant
 * (success / unavailable). The dispatcher collapses non-success to
 * `null` for legacy consumers, but availability-aware reporting
 * (Quality dimension's "Linter coverage gap" callout, the
 * `tools used` row, the standalone Quality report) needs the
 * per-pack reason so the customer can act on it ("TypeScript lint
 * skipped: no eslint config found" beats "TypeScript lint skipped:
 * <silence>").
 *
 * The reason carried in `LintGatherOutcome.unavailable.reason` is
 * already produced inside every pack's `gather<Lang>LintResult`
 * helper today — `gatherOutcome` just exposes it through the
 * provider boundary so the dispatcher can capture it alongside the
 * pack id.
 *
 * Optional rather than required: legacy lint providers (packs that
 * haven't been refactored to expose outcomes) continue to work; the
 * dispatcher falls back to the existing `null`-collapse channel and
 * surfaces the pack id only.
 *
 * Both methods delegate to the same underlying pack helper —
 * implementations should NOT duplicate work; call the helper once,
 * unwrap for `gather()`, return the full outcome for `gatherOutcome()`.
 */
export interface LintProvider extends CapabilityProvider<LintResult> {
  gatherOutcome?(cwd: string): Promise<LintGatherOutcome>;
}
