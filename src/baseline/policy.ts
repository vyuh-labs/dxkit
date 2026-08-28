/**
 * Brownfield policy + status classifier.
 *
 * The matcher in `git-aware-match.ts` emits raw `MatchPair`s with one
 * of four statuses (persisted / relocated / added / removed) plus a
 * confidence score and structured reasons. The guardrail check needs
 * a richer taxonomy — the difference between "developer introduced
 * a new finding" and "a scanner update surfaced a finding that was
 * always there" matters enormously for whether to block a PR.
 *
 * This module is the bridge. It takes a `MatchPair` plus optional
 * context (severity, scanner-version diff, config diff) and a
 * `BrownfieldPolicy`, then emits a `ClassifyResult` carrying the
 * post-policy `FindingStatus`, the block/warn verdict, and the
 * composed reason chain.
 *
 * Pure module — no I/O, deterministic over its inputs.
 *
 * Producer wiring note: today's classifier emits a subset of the full
 * `FindingStatus` taxonomy. Reservations for `probable_existing`,
 * `newly_detected`, and `fixed` are declared in the type space so
 * Phase 3's baseline-metadata work can light them up incrementally
 * without re-shaping consumer code.
 */

import * as path from 'path';

import type { CustomCheckConfig, LintPolicy } from './policy-checks';
export type { CustomCheckConfig, LintPolicy } from './policy-checks';
import type { BaselineMode, BaselineAnchor } from './modes';
import type { FindingSeverity, FindingStatus } from './types';
import type {
  FloorPolicy,
  GraphSection,
  LicensesPolicy,
  NewAdvisoriesPolicy,
  PairedCheckConfig,
} from './policy-sections';

// The newer section shapes + their ONE normalizers live in
// `policy-sections.ts` (split at the large-file bar); re-exported here so
// `from './policy'` stays the single import surface for policy concepts.
export {
  DEFAULT_BASELINE_REFRESH_CRON,
  DEFAULT_NEW_ADVISORY_BLOCK_SEVERITIES,
  baselineRefreshCron,
  newAdvisoryBlockSeverities,
  prohibitedLicensePatterns,
  type FloorPolicy,
  type GraphSection,
  type LicensesPolicy,
  type NewAdvisoriesPolicy,
  type PairedCheckConfig,
} from './policy-sections';

/**
 * Optional `baseline.*` block in `.dxkit/policy.json`. Pins the
 * mode + (when ref-based) the comparison ref repo-wide so every
 * developer + every CI job uses the same posture. Both fields are
 * optional; when absent the resolver in `./modes.ts` falls back to
 * visibility-derived defaults.
 *
 * Schema example:
 *
 *   {
 *     "baseline": {
 *       "mode": "ref-based",
 *       "ref": "origin/main"
 *     }
 *   }
 */
export interface BaselineSection {
  readonly mode?: BaselineMode;
  /** Git ref to compare against in `ref-based` mode. When absent,
   *  the resolver probes `origin/HEAD` and falls back to
   *  `'origin/main'`. */
  readonly ref?: string;
  /**
   * WHERE the committed anchor lives, for committed modes. It decouples the
   * baseline store from the protected default branch so the after-merge refresh
   * can stay fast + automated without a direct push to `main` (which branch
   * protection rejects — see `enforcement.ts`).
   *
   *   - `'tree'` (default when the branch is unprotected): the anchor is
   *     committed into the working tree on the default branch and refreshed by a
   *     direct push. Simplest; only valid when direct pushes are allowed.
   *   - `'branch'` (default when the default branch is protected): the anchor
   *     lives on a separate unprotected branch (`anchorRef`, default
   *     `dxkit-baselines`). The refresh direct-pushes THERE (allowed — protection
   *     targets `main`), and each check hydrates the anchor from it. Fast,
   *     automated, no PR, no deadlock.
   *   - `'cache'`: the anchor is stored in the CI cache keyed by the main SHA;
   *     no git write at all. A cold cache falls back to a live re-gather for that
   *     one check. CI-only (a local run cannot read the CI cache).
   */
  readonly anchor?: BaselineAnchor;
  /** Branch that stores the anchor when `anchor: 'branch'`. Default
   *  `'dxkit-baselines'`. Must NOT be a protection-covered branch. */
  readonly anchorRef?: string;
  /**
   * How often the scheduled baseline-refresh workflow runs — the cadence of
   * the advisory decision surface, not a gate posture. `'weekly'` (default),
   * `'daily'`, or a raw 5-field cron expression. Applies to the anchor
   * transports that refresh on a schedule (`branch`, `cache`); the `tree`
   * transport refreshes on every default-branch push and carries no schedule.
   * Cadence tunes how soon newly published advisories reach the standing
   * decision PR; it never absorbs them into the baseline.
   */
  readonly refreshCadence?: string;
}

/**
 * Per-finding-kind overrides that escalate specific guardrail rules
 * beyond the generic `block` / `warn` lists. Each rule maps to a
 * common product-level concern; the classifier checks them when the
 * relevant context fields are present.
 */
export interface BrownfieldBlockRules {
  /** Block any newly-introduced secret regardless of confidence. */
  readonly newSecret?: boolean;
  /** Block any newly-introduced critical security finding. */
  readonly newCriticalSecurity?: boolean;
  /** Block any newly-introduced high-severity security finding. */
  readonly newHighSecurity?: boolean;
  /** Block any newly-introduced critical dependency vulnerability. */
  readonly newCriticalDependencyVulnerability?: boolean;
  /** Block any newly-introduced high-severity reachable dep vuln. */
  readonly newHighReachableDependencyVulnerability?: boolean;
  /** Block a newly-introduced dependency carrying a malicious-code
   *  advisory (OSV `MAL-*`, the CWE-506 family, a malware-titled GHSA),
   *  REGARDLESS of CVSS severity: install-time malware executes at
   *  install, so severity scores and code-reachability are the wrong
   *  lens. Classified by the one canonical predicate,
   *  `src/analyzers/security/malicious.ts`. */
  readonly newMaliciousDependency?: boolean;
  /** Block a test-gap finding on a source file this diff ADDED (a new file
   *  shipping without a test). Deliberately never fires on an EDITED file:
   *  test-gap membership is derived from repo-global signals (coverage /
   *  reachability), so an edit cannot introduce one — see
   *  `DERIVED_MEMBERSHIP_KINDS`. */
  readonly newUntestedChangedSource?: boolean;
  /** Block any newly-introduced severe quality issue in changed files. */
  readonly newSevereQualityIssueInChangedFiles?: boolean;
  /** Block a newly-introduced dependency whose license matches the repo's
   *  `licenses.prohibited` list. Inert until that list is declared — every
   *  minted `license` finding IS a prohibited-license match (the inventory
   *  itself never becomes findings), so the rule needs no severity tier. */
  readonly newProhibitedLicense?: boolean;
  /** Block a net-new failure from a custom check the policy declared
   *  `blocking: true` (a user command check or a declarative text rule —
   *  4.4.0). Armed under every posture on the license-rule doctrine: an
   *  explicitly-blocking check is the repo's own declared invariant, and
   *  it is inert until one is configured, so arming costs an unconfigured
   *  repo nothing. Distinct from the generic `block: ['added']` path —
   *  this is what lets a security-posture DoD block on its declared rules
   *  without also blocking every added quality finding. A `blocking:
   *  false` check (pack lint's default) never fires it. */
  readonly newBlockingCustomCheckFailure?: boolean;
}

/**
 * `.dxkit/policy.json:recall` — tuning for recall attribution (CLAUDE.md
 * Rule 19), which decides whether a finding delta may be blamed on the
 * developer or must be reported as "cannot attribute".
 *
 * Guardrail TUNING, not a posture knob: it refines a gate the repo already
 * adopted rather than opting into a capability, so it carries no Rule 16
 * discovery contract — same class as `confidence` / `blockRules` /
 * `largeFileThreshold`.
 */
export interface RecallPolicy {
  /**
   * How tool versions are resolved into recall inputs.
   *
   *  - `'resolved'` (default) — what ACTUALLY ran. If a developer's machine
   *    and CI resolve different plugin versions they genuinely produce
   *    different findings, and that is worth surfacing rather than hiding.
   *  - `'locked'` — the DECLARED range from the manifest, which does not move
   *    when a caret resolves forward. Fewer re-baselines, for repos that
   *    tolerate dev != CI.
   */
  readonly inputs?: 'resolved' | 'locked';
}

/**
 * `.dxkit/policy.json:reports` — opt-in report snapshots published to the
 * dedicated `dxkit-reports` side ref on merge to the default branch. Off by
 * default; the on-merge workflow + `vyuh-dxkit report snapshot` read it.
 */
export interface ReportsPolicy {
  /** Publish a snapshot on merge to the default branch (the workflow trigger). */
  readonly onMerge?: boolean;
  /** Which reports to publish under `latest/` (default: health + dashboard). */
  readonly kinds?: ReadonlyArray<string>;
  /** Side ref the snapshots + `report-history.jsonl` live on. Default
   *  `dxkit-reports` (kept distinct from the baseline anchor). */
  readonly anchorRef?: string;
  /** Retention: how many history entries / full snapshots to keep. */
  readonly retain?: { readonly history?: number; readonly snapshots?: number };
}

/**
 * `.dxkit/policy.json:impact`, tuning for the PR Impact surface. These
 * refine an already-adopted surface (the guardrail comment); they are not a
 * capability a repo opts into, so they carry no discovery contract (Rule 16
 * tuning-field discipline, declared in `POSTURE_KNOBS`).
 */
export interface ImpactPolicy {
  /**
   * Project dimension scores in the Impact section ("security 40 -> 46
   * (projected)") from the run's own shared analysis against the latest
   * snapshot. Default TRUE: the spike measured the marginal cost at ~20ms
   * (a cache-hit re-score; the run's gather is reused, never repeated) plus
   * one shallow fetch of the reports ref. That fetch also feeds the Impact
   * section's trend context line, so false drops the projection line, the
   * trend line, and the snapshot read entirely.
   */
  readonly projectScores?: boolean;
}

/**
 * Brownfield-mode policy. The product promise — "existing debt is
 * allowed; new regressions are blocked" — flows from these settings.
 */
export interface BrownfieldPolicy {
  readonly mode: 'brownfield';
  /**
   * Optional author-declared policy NAME (P0-3, 4.4.0): a stable id
   * (`acme.dod.pkg`) + version (`1`) the verdict carries alongside the
   * content hash, so two policy versions produce distinguishable
   * verdicts BY NAME and an embedded policy document can be re-verified
   * against the same DoD. Naming is declaration-only — it never changes
   * what the policy does.
   */
  readonly id?: string;
  readonly version?: string;
  /**
   * The BASE this policy file refines (WP1b, strategy §7.2):
   * `"security-only"` / `"full-debt"` (the presets) or `"default"` (the
   * fully armed compiled default). Absent ⟹ `"default"` — the pre-4.4.1
   * merge base, kept so existing files resolve byte-identically. Declare
   * it: a minimal file without a base silently inherits every armed
   * rule of the compiled default (the embedder footgun this closes).
   * Unknown tokens are a load ERROR, never a silent fallback. Resolved
   * only by `policyBaseFor` in `./policy-resolve`.
   */
  readonly extends?: string;
  /** Statuses that fail the guardrail check (non-zero exit code). */
  readonly block: ReadonlyArray<FindingStatus>;
  /** Statuses that emit a warning but don't fail. */
  readonly warn: ReadonlyArray<FindingStatus>;
  /**
   * Per-severity confidence thresholds. A `relocated` or `persisted`
   * match with confidence below the per-severity threshold demotes
   * to `'uncertain'` — the policy can warn rather than silently
   * accept a low-confidence pairing.
   */
  readonly confidence: Readonly<Record<FindingSeverity, number>>;
  /** Per-kind block-on-new overrides. */
  readonly blockRules: BrownfieldBlockRules;
  /**
   * Finding kinds whose `added` classification only blocks when the
   * finding overlaps lines actually changed in the current diff.
   *
   * Some upstream scanners (notably semgrep on large codebases) are
   * non-deterministic across runs — parallel rule execution + per-
   * rule timeouts mean each run discovers a slightly different
   * subset of the full match space. When the baseline missed a real
   * finding and a later scan catches it on UNCHANGED code, the
   * matcher legitimately reports `added` — but the developer
   * didn't introduce it.
   *
   * For kinds listed here, an `added` finding outside the diff's
   * changed lines gets demoted to `uncertain` (a warn status).
   * Findings inside changed lines still block — that's where the
   * developer actually wrote code.
   *
   * Default: `['code', 'hygiene']` — the kinds with confirmed
   * scanner-wobble risk. Customers can extend (`'duplication'`,
   * `'large-file'`) or clear it (block on everything regardless of
   * diff overlap) via `.dxkit/policy.json`.
   */
  readonly addedRequiresChangedLines: ReadonlyArray<string>;
  /**
   * Line count above which a source file is flagged `large-file`. Optional;
   * defaults to the canonical `LARGE_FILE_THRESHOLD_LINES` (500) when unset, so
   * a repo can tune the bar to its own norms without a code change:
   *
   *   { "largeFileThreshold": 800 }
   *
   * Identity is path-based, so raising/lowering it only changes WHICH files are
   * flagged, never a fingerprint — no baseline migration.
   */
  readonly largeFileThreshold?: number;
  /** Opt-in report snapshots on merge (see ReportsPolicy). */
  readonly reports?: ReportsPolicy;
  /** Impact-surface tuning (see ImpactPolicy). */
  readonly impact?: ImpactPolicy;
  /**
   * Baseline-mode pinning. When absent, the resolver in `./modes.ts`
   * falls back to visibility-derived defaults
   * (`'public'` → `ref-based`; `'private'` / `'internal'` /
   * `'unknown'` → `committed-full`). Customers pin this to lock the
   * posture across all developers + CI jobs:
   *
   *   - `'committed-full'`: rich entries committed (default for
   *     private repos with small teams).
   *   - `'committed-sanitized'`: stripped entries committed
   *     (compliance-conscious private repos).
   *   - `'ref-based'`: no committed baseline; computed from a git
   *     ref at check time (default for public repos).
   */
  readonly baseline?: BaselineSection;
  /**
   * User-declared custom checks — repo invariants dxkit runs as gate citizens.
   * Absent/empty ⟹ no custom checks (the default). Normalized to runner specs
   * by `policyChecksToSpecs` (`src/analyzers/custom-checks/config.ts`).
   */
  readonly checks?: readonly CustomCheckConfig[];
  /**
   * Declared paired-change rules ("changing X requires also changing Y"),
   * evaluated over the diff by the paired-change gate. Absent/empty ⟹ the
   * gate is off (the default). Normalized by `normalizePairedChecks`
   * (`src/analyzers/custom-checks/config.ts`).
   */
  readonly pairedChecks?: readonly PairedCheckConfig[];
  /**
   * Opt-in gating on pack-declared built-in lint. Absent ⟹ disabled (the
   * default — lint ships dormant).
   */
  readonly lint?: LintPolicy;
  /**
   * Posture for dep-vulns classified `newly_published_advisory` (D4): the
   * advisory feed moved after baseline capture and the diff touched no
   * dependency manifest, so the finding is not the PR's fault — but a live
   * advisory still must not silently ride in. This tier decides which
   * severities BLOCK (the rest warn). Absent ⟹ the default
   * (`DEFAULT_NEW_ADVISORY_BLOCK_SEVERITIES`: critical + high block,
   * medium + low warn). Malicious-package advisories always block regardless
   * — install-time malware is not tier-negotiable.
   */
  readonly newAdvisories?: NewAdvisoriesPolicy;
  /**
   * License posture. `licenses.prohibited` names SPDX ids/prefixes whose
   * appearance on a NEW dependency blocks (the `newProhibitedLicense` block
   * rule). Absent ⟹ inert — dxkit never invents a legal posture.
   */
  readonly licenses?: LicensesPolicy;
  /**
   * The deterministic dependency-bump lane. `enabled: true` installs the
   * scheduled `dxkit-dep-bump` workflow (weekly `deps bump --apply --land pr`
   * — no LLM; the floor + guardrail verify before the standing PR opens).
   * `allowMajor: true` lets the scheduled lane include producer-classified
   * major bumps (default false — majors stay a human decision, disclosed in
   * the skip list). Opt-in, default off.
   */
  readonly depBump?: {
    readonly enabled?: boolean;
    readonly allowMajor?: boolean;
    /** Cadence for the scheduled lane — the shared grammar (`weekly`, `daily`,
     *  or a strict 5-field cron). Absent ⇒ the lane's own default (Monday
     *  07:00 UTC, an hour after the refresh/remediate default). */
    readonly schedule?: string;
  };
  /**
   * The expiry decision surface: while the scheduled refresh is running anyway,
   * maintain ONE GitHub issue naming the allowlist suppressions whose windows
   * close inside the shared horizon, who accepted each, and when. Opt-in,
   * default OFF — it is the only dxkit lane that opens an issue on its own
   * initiative, and enabling it grants the refresh workflow `issues: write`
   * (run `vyuh-dxkit update` after flipping it so the workflow is re-rendered).
   *
   * The guardrail check already warns every author and reviewer during the
   * window (the lapse projection). This closes the remaining hole: a repo where
   * nobody opens a PR for a week gets no warning at all, and the person who
   * accepted the deferral is never addressed. Never gates — the expiry itself
   * remains the forcing function.
   */
  readonly expiryNotice?: { readonly enabled?: boolean };
  /**
   * Recall-attribution tuning (Rule 19). Absent ⟹ `inputs: 'resolved'`.
   */
  readonly recall?: RecallPolicy;
  /**
   * Correctness-floor posture for the surfaces that own tree-level floor
   * execution (the `gate` command family). `required` defaults TRUE there:
   * a floor that cannot run (untrusted tree) makes the verdict `CANNOT
   * GATE` instead of a disclosed skip under PASSED. `{ "required": false }`
   * restores skip-and-disclose. Loop / pre-push / CI floor surfaces are NOT
   * governed by this field — they keep the declared Rule-15 fail-open-on-
   * infrastructure doctrine (CI is their backstop; the one-shot gate has
   * none).
   */
  readonly floor?: FloorPolicy;
  /**
   * Code-graph freshness transport. Absent/`'off'` ⟹ the graph is rebuilt on
   * demand by each consumer (the default). `'cache'` installs the
   * `dxkit-graph-refresh` workflow, which rebuilds `graph.json` on merge to the
   * default branch and stores it in the Actions cache (NEVER git — no repo
   * bloat) so the guardrail run restores it instead of a cold rebuild. Opt-in
   * because it's a CI-performance optimization, not a correctness gate.
   */
  readonly graph?: GraphSection;
}

/**
 * Default brownfield policy. Captures the conservative posture from
 * the agentic-brownfield strategy: block only on high-confidence new
 * regressions; warn on the categories that suggest a problem might
 * be real but might also be drift; legacy debt is permitted.
 *
 * Confidence thresholds: secrets + critical security demand a tight
 * confidence threshold (a low-confidence persisted secret pairing
 * gets demoted to uncertain and warned, not blocked). Lower-severity
 * findings can pair on weaker signal because the cost of a false
 * "secret is new" event is much higher than a false "TODO is new."
 */
export const DEFAULT_BROWNFIELD_POLICY: BrownfieldPolicy = Object.freeze({
  mode: 'brownfield',
  block: Object.freeze(['added'] as ReadonlyArray<FindingStatus>),
  warn: Object.freeze([
    'probable_existing',
    'newly_detected',
    'tooling_drift',
    'config_drift',
    'uncertain',
  ] as ReadonlyArray<FindingStatus>),
  confidence: Object.freeze({
    critical: 0.75,
    high: 0.8,
    medium: 0.85,
    low: 0.9,
  }),
  blockRules: Object.freeze({
    newSecret: true,
    newCriticalSecurity: true,
    newHighSecurity: true,
    newCriticalDependencyVulnerability: true,
    newHighReachableDependencyVulnerability: true,
    newMaliciousDependency: true,
    newUntestedChangedSource: true,
    newSevereQualityIssueInChangedFiles: true,
    newProhibitedLicense: true,
    newBlockingCustomCheckFailure: true,
  }),
  addedRequiresChangedLines: Object.freeze(['code', 'hygiene']),
});

/** Conventional location for a per-repo brownfield policy. Loaded
 *  automatically by `resolvePolicy` when present. */
export const DEFAULT_POLICY_FILENAME = path.join('.dxkit', 'policy.json');

// Policy NAMING (the verdict.v1 content hash) lives in `./policy-naming`
// — split at the large-file bar, re-exported here so `from './policy'`
// stays the single import surface for policy concepts.
export { policyContentHash } from './policy-naming';

// Policy RESOLUTION (the --policy / conventional-file / fallback order,
// and the `extends` base merge) lives in `./policy-resolve` — split at
// the large-file bar, re-exported here so `from './policy'` stays the
// single import surface for policy concepts.
export {
  POLICY_BASE_TOKENS,
  loadPolicyFromCwd,
  policyBaseFor,
  resolvePolicy,
  type PolicyBaseToken,
} from './policy-resolve';
