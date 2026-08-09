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
import type { BrownfieldPolicy, BrownfieldBlockRules } from './policy';
import type { BaselineEntry } from './types';

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
  /** license scan → attribution + the `license` kind (prohibited-list
   *  matches only; blockable via `newProhibitedLicense`). */
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
 * Which scope flags a finding KIND's observation depends on — the ONE mapping
 * from "this gather was skipped" to "these baseline kinds were not observed"
 * (Rule 19's REMOVED direction, 4.3.2 — the coverage-parity net's spine).
 *
 * The class this closes: a committed-mode run with a partial scope produced
 * zero findings of a scoped-out kind, so every baseline entry of that kind
 * minted `removed` ("resolved") with no disclosure — the same lie the
 * untrusted custom-check skip told, one seam over. The check consults this
 * table to reclassify those pairs `not_observed` instead.
 *
 * Typed `Record` over the full kind union, so a NEW kind cannot land without
 * declaring its observation dependencies (compile error — the
 * `BLOCK_RULE_EVIDENCE` discipline). An empty array means the kind is
 * observed on every run: Layer-0 metrics (`large-file` reads the unscoped
 * generic gather), intrinsic scans (`config`), plain file reads
 * (`stale-allow`), gate-minted kinds whose own gates carry their disclosure
 * (`flow-binding`, `model-schema-drift`, `paired-change`,
 * `code-reimplementation`), and kinds no producer contributes yet
 * (`DEFERRED_KINDS`). `custom-check` is deliberately `[]` here too: the seam
 * records its own observation (`CustomChecksUnobserved`, which also carries
 * per-check runtime skips this table cannot see) — a second scope-derived
 * answer for it would be the two-projections drift class.
 */
export const KIND_OBSERVATION_SCOPE: Record<
  BaselineEntry['kind'],
  ReadonlyArray<keyof GatherScope>
> = Object.freeze({
  secret: ['secrets'],
  // Companion of the located `secret` — same gather, same observation.
  'secret-hmac': ['secrets'],
  // Partial on purpose: the cheap intrinsic scans (tls-bypass, file findings)
  // always run, so some `code` findings survive a skipped semgrep. Marking the
  // whole kind unobserved when semgrep is off withholds resolution claims —
  // the safe direction (never suppress a real finding; suppressing a
  // resolution CLAIM is the bias this platform prefers).
  code: ['codePatterns'],
  config: [],
  'dep-vuln': ['depVulns'],
  duplication: ['duplication'],
  'coverage-gap': [],
  'test-gap': ['testGaps'],
  hygiene: [],
  'test-file-degradation': ['testGaps'],
  'god-file': [],
  'stale-file': ['hygiene'],
  'large-file': [],
  'stale-allow': [],
  'flow-binding': [],
  'model-schema-drift': [],
  'code-reimplementation': [],
  'custom-check': [],
  'paired-change': [],
  // Wave-gate-minted (4.4.0 WP7): the wave surface carries its own
  // disclosure; no full-scan gather observes it.
  'broken-flow': [],
  license: ['licenses'],
});

/**
 * Kinds whose per-file MEMBERSHIP is derived from REPO-GLOBAL signals, not
 * from the file's own content. `test-gap` is the type case: a file is
 * "untested" by coverage artifacts, import-graph reachability from active
 * test files, and filename heuristics — so a change ANYWHERE in the graph
 * (removing a dead import, reformatting, deleting a test) shifts which
 * OTHER files hold findings. The live incident: an agent's lint sweep
 * removed unused relative imports; six files — two never touched by the
 * diff — fell out of the tests' 3-hop reachable set and were blocked as
 * "net-new" test gaps. They were untested all along; only dxkit's
 * VISIBILITY changed (Rule 19 causes #3/#6, never cause #1).
 *
 * The classifier consequence (`classify.ts`): an `added` finding of such a
 * kind may keep developer attribution ONLY when the finding's file was
 * ADDED by the diff — an edit cannot introduce a derived-membership finding
 * (the file was equally untested before). Everything else demotes to
 * `uncertain` (warn, never block). Extend this set deliberately, with the
 * signal chain named — a kind here trades block coverage for attribution
 * honesty.
 */
export const DERIVED_MEMBERSHIP_KINDS: ReadonlySet<BaselineEntry['kind']> = Object.freeze(
  new Set<BaselineEntry['kind']>(['test-gap']),
);

/** The finding kinds a ref-based diff structurally excludes, mapped to the
 *  scope flags of the analyzers that produce them. `secret-hmac` is absent
 *  deliberately: it is a companion output of the secrets analyzer, which
 *  must still run for the located `secret` kind. */
export type RefSkippableKind = 'duplication' | 'test-gap' | 'custom-check' | 'license';

/** The gathers each ref-skippable kind rides on. `custom-check` names its
 *  flag here (not in `KIND_OBSERVATION_SCOPE`, where the seam's own record
 *  answers observation) because this map's job is turning OFF gathers, not
 *  attributing observation. */
const REF_SKIPPABLE_FLAGS: Record<RefSkippableKind, keyof GatherScope> = Object.freeze({
  duplication: 'duplication',
  'test-gap': 'testGaps',
  'custom-check': 'customChecks',
  license: 'licenses',
});

/**
 * Drop the analyzers whose finding kinds a ref-based diff throws away
 * (`REF_UNRELIABLE_KINDS` in check.ts: duplication, test-gap,
 * custom-check). Gathering them in ref-based mode pays the jscpd /
 * coverage / check-runner cost on BOTH sides for findings
 * `partitionForRefBasedDiff` then discards — found by stress-running the
 * zero-write trial under full-debt, where the discarded gathers dominated
 * the per-landing cost (the same waste applied to ref-based CI runs and
 * full-debt loop gates).
 *
 * Returns the adjusted scope plus the kinds whose analyzers were skipped,
 * so the caller still DISCLOSES the exclusion — the honest "not gated in
 * ref-based mode" note must not disappear just because the thrown-away
 * gather stopped being paid for. Pure.
 */
export function scopeForRefBasedDiff(scope: GatherScope): {
  readonly scope: GatherScope;
  readonly skippedKinds: ReadonlyArray<RefSkippableKind>;
} {
  const skipped: RefSkippableKind[] = [];
  const next = { ...scope };
  for (const kind of Object.keys(REF_SKIPPABLE_FLAGS) as RefSkippableKind[]) {
    const flag = REF_SKIPPABLE_FLAGS[kind];
    if (next[flag]) {
      next[flag] = false;
      skipped.push(kind);
    }
  }
  if (skipped.length === 0) return { scope, skippedKinds: skipped };
  return { scope: Object.freeze(next), skippedKinds: skipped };
}

/**
 * The evidence each block rule needs, declared once (T1.2 class fix).
 *
 * A block rule is only alive when EVERY analyzer producing its evidence
 * actually runs. The shipped bug: `newHighReachableDependencyVulnerability`
 * was armed in both presets, scoped in `depVulns` — and was still
 * structurally dead, because its reachability evidence comes from the
 * IMPORTS gather, which the hand-maintained if-chain here never pulled in
 * (and the check path never threaded). The rule table and the scope
 * mapping were two projections of one concept in two places (Rule 2.30).
 *
 * This table is the ONE declaration. `scopeForPolicy` derives from it, and
 * the `Record` over `keyof BrownfieldBlockRules` makes omission a COMPILE
 * error: a new block rule cannot land without declaring which analyzers
 * produce its evidence. `test/baseline/gather-scope.test.ts` additionally
 * pins per-rule scope derivation both directions (armed ⇒ scoped,
 * un-armed ⇒ not scoped).
 */
export const BLOCK_RULE_EVIDENCE: Record<
  keyof BrownfieldBlockRules,
  ReadonlyArray<keyof GatherScope>
> = Object.freeze({
  newSecret: ['secrets'],
  newCriticalSecurity: ['codePatterns'],
  newHighSecurity: ['codePatterns'],
  newCriticalDependencyVulnerability: ['depVulns'],
  // Reachability evidence = the import graph. Without `imports` the
  // classifier can never see `reachable === true` and the rule is dead.
  newHighReachableDependencyVulnerability: ['depVulns', 'imports'],
  newMaliciousDependency: ['depVulns'],
  newUntestedChangedSource: ['testGaps'],
  newSevereQualityIssueInChangedFiles: ['codePatterns', 'hygiene'],
  // The license inventory is the whole evidence: every minted `license`
  // finding is already a prohibited-list match, so no second signal exists.
  newProhibitedLicense: ['licenses'],
  // The seam's gather is the whole evidence: the block intent rides on
  // each finding (`entry.blocking`), so no second signal exists.
  newBlockingCustomCheckFailure: ['customChecks'],
});

/**
 * Derive the minimal gather scope a policy needs.
 *
 * The verdict can only be changed by a kind the policy BLOCKS, so the scope
 * is the union of `BLOCK_RULE_EVIDENCE[rule]` over the armed rules.
 *
 * A non-empty `policy.block` list (statuses that block regardless of kind,
 * e.g. `full-debt`'s `['added']`) means any kind can block, so we cannot
 * skip anything → `FULL_SCOPE`.
 */
export function scopeForPolicy(policy: BrownfieldPolicy): GatherScope {
  // Any status-based block applies across all kinds — nothing is safe to skip.
  if (policy.block.length > 0) return FULL_SCOPE;

  const r = policy.blockRules;
  const scope = { ...EMPTY_SCOPE };
  for (const rule of Object.keys(BLOCK_RULE_EVIDENCE) as Array<keyof BrownfieldBlockRules>) {
    if (!r[rule]) continue;
    for (const flag of BLOCK_RULE_EVIDENCE[rule]) scope[flag] = true;
  }
  // Custom checks gate via their own per-check `blocking` flag, not a status in
  // `policy.block`, so scope them in whenever the repo configured any — else the
  // loop Stop-gate's fast path would silently skip a blocking custom check.
  if ((policy.checks && policy.checks.length > 0) || policy.lint?.enabled) {
    scope.customChecks = true;
  }
  return Object.freeze(scope);
}
