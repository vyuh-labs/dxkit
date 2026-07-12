/**
 * Gather scope — which analyzers a guardrail gather actually needs to run.
 *
 * # Why this exists (2.14.0 opt 1)
 *
 * The full current-side gather runs every analyzer (semgrep, gitleaks,
 * graphify AST, jscpd, OSV, lint, coverage, cloc, test-gaps, licenses, …).
 * On a large repo that is ~60s. But a guardrail check can only ever BLOCK
 * on the finding kinds its policy escalates — see `evaluateBlockRules` in
 * `./policy.ts`. A `security-only` loop posture blocks on secrets + crit/
 * high SAST + critical dep-vulns and NOTHING else, so gathering jscpd /
 * lint / coverage / cloc / test-gaps / graphify for it is pure waste: those
 * analyzers feed only kinds the policy can't act on.
 *
 * This module derives, from a `BrownfieldPolicy`, the minimal set of
 * analyzers whose output can change the verdict, so the gather can skip the
 * rest. It is the single source of truth for that mapping.
 *
 * # Safety contract (load-bearing)
 *
 * Scoping is correct ONLY because the verdict depends solely on BLOCKING
 * pairs, and a kind the policy cannot block can never produce one. The map
 * below therefore tracks `evaluateBlockRules` exactly:
 *
 *   - `policy.block` non-empty (e.g. `['added']`, the `full-debt` posture)
 *     means ANY kind blocks by status alone → FULL_SCOPE, gather everything.
 *   - otherwise each enabled `blockRule` pulls in exactly the analyzer(s)
 *     that feed its kind.
 *
 * Two structural guarantees keep this honest:
 *   1. Scoping is OPT-IN. Every existing caller (CI guardrail, `createBaseline`,
 *      the `health` report) gets `FULL_SCOPE` and is byte-identical. Only the
 *      loop Stop-gate passes a derived scope.
 *   2. The security aggregate's cheap intrinsic scans (tls-bypass + file
 *      findings, ~0.5s) always run inside `buildSecurityAggregateForHealth`,
 *      so a `code`/`config` security finding can never be skipped by scoping.
 *
 * If a new block rule lands in `evaluateBlockRules`, `scopeForPolicy` MUST
 * gain the matching analyzer here or a real finding could be skipped — the
 * scope contract test pins this.
 */
import type { BrownfieldPolicy } from './policy';

/**
 * One boolean per skippable analyzer. `true` = run it. The names mirror the
 * gather steps in `health.ts` / `create.ts` so threading is mechanical.
 *
 * Not represented (always run, never scoped away):
 *   - the cheap tls-bypass + file-finding scans intrinsic to the security
 *     aggregate (they contribute blockable `code`/`config` findings);
 *   - generic Layer-0 metrics + package.json (microseconds).
 */
export interface GatherScope {
  /** gitleaks + grep-secrets → `secret` (+ raw secrets → `secret-hmac`). */
  readonly secrets: boolean;
  /** semgrep → `code` SAST findings. */
  readonly codePatterns: boolean;
  /** OSV / per-pack dep audit → `dep-vuln`. */
  readonly depVulns: boolean;
  /** graphify AST → structural metrics + import reachability. */
  readonly structural: boolean;
  /** jscpd → `duplication`. */
  readonly duplication: boolean;
  /** per-pack linters → Quality dimension + `code`-adjacent hygiene. */
  readonly lint: boolean;
  /** coverage providers → Tests dimension. */
  readonly coverage: boolean;
  /** license scan → attribution (never a blockable kind). */
  readonly licenses: boolean;
  /** import graph → dep-vuln reachability + DX metrics. */
  readonly imports: boolean;
  /** test-framework detection → DX metrics. */
  readonly testFramework: boolean;
  /** cloc line counts → `large-file`, comment ratio, language breakdown. */
  readonly cloc: boolean;
  /** test-gap analyzer → `test-gap` / `test-file-degradation`. */
  readonly testGaps: boolean;
  /** hygiene markers (TODO/FIXME/stale) → `stale-file` + Quality counts. */
  readonly hygiene: boolean;
  /** custom checks (user-declared `checks` + built-in lint) → `custom-check`. */
  readonly customChecks: boolean;
}

/** Everything on — the default every non-loop caller gets. */
export const FULL_SCOPE: GatherScope = Object.freeze({
  secrets: true,
  codePatterns: true,
  depVulns: true,
  structural: true,
  duplication: true,
  lint: true,
  coverage: true,
  licenses: true,
  imports: true,
  testFramework: true,
  cloc: true,
  testGaps: true,
  hygiene: true,
  customChecks: true,
});

/** All-off starting point for the additive derivation below. */
const EMPTY_SCOPE: GatherScope = Object.freeze({
  secrets: false,
  codePatterns: false,
  depVulns: false,
  structural: false,
  duplication: false,
  lint: false,
  coverage: false,
  licenses: false,
  imports: false,
  testFramework: false,
  cloc: false,
  testGaps: false,
  hygiene: false,
  customChecks: false,
});

/** True when no analyzer at all is required — caller can short-circuit. */
export function isEmptyScope(s: GatherScope): boolean {
  return !Object.values(s).some(Boolean);
}

/** True when this is the full gather (no analyzer skipped). */
export function isFullScope(s: GatherScope): boolean {
  return Object.values(s).every(Boolean);
}

/**
 * A compact, deterministic signature of which analyzers a scope runs.
 * Used to namespace the ref-scan cache so a scoped ref gather is never
 * served as if it were a full one (and vice versa). Order is fixed by the
 * sorted key list, so the signature is stable across calls.
 */
export function scopeSignature(s: GatherScope): string {
  if (isFullScope(s)) return 'full';
  return (Object.keys(s) as Array<keyof GatherScope>)
    .sort()
    .filter((k) => s[k])
    .join('+');
}

/**
 * Derive the minimal gather scope a policy needs.
 *
 * The verdict can only be changed by a kind the policy BLOCKS, so the scope
 * tracks `evaluateBlockRules` (in `./policy.ts`) one-to-one:
 *
 *   newSecret                              → secrets
 *   newCriticalSecurity / newHighSecurity  → codePatterns
 *   newCritical/HighReachableDependency…   → depVulns
 *   newUntestedChangedSource               → testGaps
 *   newSevereQualityIssueInChangedFiles    → codePatterns + hygiene
 *
 * A non-empty `policy.block` list (statuses that block regardless of kind,
 * e.g. `full-debt`'s `['added']`) means any kind can block, so we cannot
 * skip anything → `FULL_SCOPE`.
 *
 * NB: `newHighReachableDependencyVulnerability` needs reachability, which the
 * guardrail's classifier never populates today (`context.reachable` is unset
 * on the check path), so it cannot actually fire — but we still scope in
 * `depVulns` for it so the mapping stays a faithful, future-proof mirror of
 * the rule table rather than relying on that downstream gap.
 */
export function scopeForPolicy(policy: BrownfieldPolicy): GatherScope {
  // Any status-based block applies across all kinds — nothing is safe to skip.
  if (policy.block.length > 0) return FULL_SCOPE;

  const r = policy.blockRules;
  const scope = { ...EMPTY_SCOPE };
  if (r.newSecret) scope.secrets = true;
  if (r.newCriticalSecurity || r.newHighSecurity) scope.codePatterns = true;
  if (
    r.newCriticalDependencyVulnerability ||
    r.newHighReachableDependencyVulnerability ||
    r.newMaliciousDependency
  ) {
    scope.depVulns = true;
  }
  if (r.newUntestedChangedSource) scope.testGaps = true;
  if (r.newSevereQualityIssueInChangedFiles) {
    scope.codePatterns = true;
    scope.hygiene = true;
  }
  // Custom checks gate via their own per-check `blocking` flag, not a status in
  // `policy.block`, so scope them in whenever the repo configured any — else the
  // loop Stop-gate's fast path would silently skip a blocking custom check.
  if ((policy.checks && policy.checks.length > 0) || policy.lint?.enabled) {
    scope.customChecks = true;
  }
  return Object.freeze(scope);
}
