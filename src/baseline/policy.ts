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

import * as fs from 'fs';
import * as path from 'path';
import type { BaselineMode, BaselineAnchor } from './modes';
import type { FindingSeverity, FindingStatus, MatchPair, MatchReason } from './types';

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
  /** Block when an untested source file is added in a changed file. */
  readonly newUntestedChangedSource?: boolean;
  /** Block any newly-introduced severe quality issue in changed files. */
  readonly newSevereQualityIssueInChangedFiles?: boolean;
}

/**
 * One user-declared custom check in `.dxkit/policy.json:checks`. dxkit runs it
 * as a first-class gate citizen alongside its own scanners: it executes the
 * command, fingerprints each failure as a `custom-check` finding, and gates on
 * NET-NEW failures (a pre-existing failure is grandfathered) uniformly across
 * pre-push / CI / the loop Stop-gate. dxkit becomes the gate runner for ALL of a
 * repo's invariants, not just its own scanners.
 *
 * SECURITY: the command is executed. It comes ONLY from the repo's own committed
 * policy.json — the same trust boundary as the repo's npm scripts / CI config.
 * dxkit never runs a check from a CLI flag or any untrusted source.
 *
 * Schema example:
 *
 *   {
 *     "checks": [
 *       { "name": "check:seam", "command": "npm run check:seam" },
 *       { "name": "licenses", "command": ["make", "check-licenses"], "blocking": false },
 *       {
 *         "name": "custom-lint",
 *         "command": "npx eslint . -f unix",
 *         "parse": { "regex": "^(?<file>[^:]+):(?<line>\\d+):\\d+:\\s+(?<message>.*?)\\s+\\[(?<rule>[^\\]]+)\\]$" }
 *       }
 *     ]
 *   }
 */
export interface CustomCheckConfig {
  /** Stable label — becomes the finding's durable identity key. `lint:*` is
   *  reserved for pack-declared built-in lint. */
  readonly name: string;
  /** The command: a single string (whitespace-split; no shell — for a pipeline
   *  use a script) or an argv array. */
  readonly command: string | readonly string[];
  /** Net-new failure blocks (default true) or only warns (false). */
  readonly blocking?: boolean;
  /** Exit code meaning "pass" (default 0). */
  readonly expectedExit?: number;
  /** Output→findings extraction. `'exit'` (default): one binary finding per
   *  failure. `{ regex }`: one located finding per matching line, via named
   *  `(?<file>)(?<line>)(?<rule>)(?<message>)` capture groups. */
  readonly parse?: 'exit' | { readonly regex: string };
}

/**
 * `.dxkit/policy.json:lint` — opt-in gating on pack-declared built-in lint
 * (`LanguageSupport.lint`). Off by default: a lint gate is noisy on a repo that
 * hasn't opted in, so it ships dormant. When enabled, dxkit synthesizes a
 * `lint:<pack>` custom check per active language pack, running through the SAME
 * runner as user checks (lint is a consumer of the custom-check seam, not a
 * parallel path).
 */
export interface LintPolicy {
  /** Turn on pack-declared lint gating (default false). */
  readonly enabled?: boolean;
  /** Net-new lint findings block (default false — warn only). */
  readonly blocking?: boolean;
}

/**
 * Brownfield-mode policy. The product promise — "existing debt is
 * allowed; new regressions are blocked" — flows from these settings.
 */
export interface BrownfieldPolicy {
  readonly mode: 'brownfield';
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
   * Opt-in gating on pack-declared built-in lint. Absent ⟹ disabled (the
   * default — lint ships dormant).
   */
  readonly lint?: LintPolicy;
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
    newUntestedChangedSource: true,
    newSevereQualityIssueInChangedFiles: true,
  }),
  addedRequiresChangedLines: Object.freeze(['code', 'hygiene']),
});

/**
 * Contextual signals the classifier reads when available. Every field
 * is optional — pass `{}` for the basic matcher-only classification.
 * Phase 3 baseline-metadata work will populate these from the stored
 * baseline + current scan envelope.
 */
export interface ClassifyContext {
  /** Severity of the underlying finding. */
  readonly severity?: FindingSeverity;
  /** Kind discriminator from `IdentityInput`, for block-rule checks. */
  readonly kind?: string;
  /** True when the baseline's scanner / advisory-db version differs
   *  from the current scan. Reclassifies an `added` finding as
   *  `tooling_drift` rather than blocking it as a new regression. */
  readonly scannerVersionDiffers?: boolean;
  /** True when the baseline's `.dxkit-ignore` / policy hash differs
   *  from the current scan. Reclassifies `added` as `config_drift` —
   *  UNLESS the finding is on a file the diff itself added/changed
   *  (`fileChangedInDiff`), in which case it's developer-introduced, not
   *  a config artifact, and stays `added`. */
  readonly configDiffers?: boolean;
  /** True when the finding's source file was added or modified by the current
   *  diff (base→HEAD). A finding on such a file is developer-introduced, so it
   *  outranks `config_drift`: editing policy.json in the same PR must not
   *  re-label a net-new finding on a brand-new file as "config changed between
   *  runs". */
  readonly fileChangedInDiff?: boolean;
  /** True when the underlying source file's lines overlap lines
   *  changed by the current diff. Used by `newSevereQualityIssueIn
   *  ChangedFiles` and similar rules; absent context is treated as
   *  "we don't know, assume outside changed lines." */
  readonly overlapsChangedLines?: boolean;
  /** True when an `added` dep-vuln is on a reachable code path. */
  readonly reachable?: boolean;
}

/** Verdict + reasoning for one classified pair. */
export interface ClassifyResult {
  readonly status: FindingStatus;
  /** Whether the policy blocks based on the classified status or a
   *  specific block-rule override. */
  readonly blocks: boolean;
  /** Whether the policy warns. */
  readonly warns: boolean;
  /** Reasons backing the status — composed of the matcher's reasons
   *  plus any classification-time additions. */
  readonly reasons: ReadonlyArray<MatchReason>;
}

/**
 * Classify one match pair against a brownfield policy.
 *
 * Pipeline:
 *   1. Start with the matcher's `pair.status` as the candidate
 *      `FindingStatus`.
 *   2. For `added`: check drift context. Scanner-version drift wins
 *      (more specific signal) over config drift; both demote to
 *      drift-bucket statuses regardless of severity.
 *   3. For `persisted` / `relocated`: check confidence against the
 *      per-severity threshold. Below threshold demotes to
 *      `'uncertain'`.
 *   4. Apply block-rule overrides: if a block-rule fires for this
 *      kind+severity combination AND the candidate status is
 *      `'added'`, the result blocks even if `'added'` weren't in the
 *      policy's block list.
 *   5. Apply the policy's `block` / `warn` membership to the final
 *      status to produce the booleans.
 */
export function classify(
  pair: MatchPair,
  policy: BrownfieldPolicy = DEFAULT_BROWNFIELD_POLICY,
  context: ClassifyContext = {},
): ClassifyResult {
  let status: FindingStatus = pair.status;
  const reasons: MatchReason[] = [...pair.reasons];

  // Step 2: drift context can reclassify 'added'.
  if (status === 'added') {
    if (context.scannerVersionDiffers) {
      status = 'tooling_drift';
      reasons.push({
        code: 'tooling-drift',
        detail: 'scanner or advisory-db version changed between runs',
      });
    } else if (context.configDiffers && !context.fileChangedInDiff) {
      // Config drift only explains a finding that appeared WITHOUT a code
      // change (e.g. a path the policy newly un-ignored). A finding on a file
      // the diff itself added/changed is developer-introduced — it stays
      // `added` even when policy.json changed in the same PR (the misattribution
      // #19 reported: a net-new finding on a brand-new file labelled config_drift
      // because policy.json was edited alongside it).
      status = 'config_drift';
      reasons.push({
        code: 'config-drift',
        detail: 'suppression or policy config changed between runs',
      });
    } else if (
      context.kind &&
      policy.addedRequiresChangedLines.includes(context.kind) &&
      context.overlapsChangedLines === false
    ) {
      // Scanner-wobble demotion: an `added` finding from a high-
      // wobble scanner (semgrep code, grep-based hygiene) that
      // sits outside the diff's changed lines is more likely a
      // baseline gap than a real regression. Demote to `uncertain`
      // (warn). The block-rules below still fire for findings the
      // diff actually touched.
      status = 'uncertain';
      reasons.push({
        code: 'unchanged-lines',
        detail: `${context.kind} finding outside diff hunks — demoted from added to uncertain (likely scanner wobble, not a developer-introduced regression)`,
      });
    }
  }

  // Step 3: confidence demotion for persisted/relocated pairs.
  if (status === 'persisted' || status === 'relocated') {
    const threshold = context.severity
      ? policy.confidence[context.severity]
      : Math.min(...Object.values(policy.confidence));
    if (pair.confidence < threshold) {
      reasons.push({
        code: 'low-confidence',
        detail:
          `match confidence ${pair.confidence.toFixed(2)} below threshold ${threshold.toFixed(2)}` +
          (context.severity ? ` for severity ${context.severity}` : ''),
      });
      status = 'uncertain';
    }
  }

  // Step 4: block-rule overrides for newly-added findings.
  const blockRuleHit = evaluateBlockRules(status, policy.blockRules, context);
  if (blockRuleHit) {
    reasons.push({
      code: 'block-rule',
      detail: `policy block-rule fired: ${blockRuleHit}`,
    });
  }

  // Step 5: policy block/warn membership.
  const blocks = blockRuleHit !== null || policy.block.includes(status);
  const warns = policy.warn.includes(status);

  return { status, blocks, warns, reasons };
}

/**
 * Check whether any block-rule fires for the given classified pair.
 * Returns the matching rule's name (for reason rendering) or null
 * when no rule fires.
 *
 * Block-rules escalate specific kinds of net-new findings beyond the generic
 * policy. They fire on a matcher-`added` finding INCLUDING one demoted to
 * `config_drift`: a config / .dxkit-ignore / policy-hash change does not create
 * phantom findings (the credential or vuln is really in the code — the config
 * edit only changed the *reason* string), so it must never disable a block for a
 * net-new blocking-class finding. That closes the bypass where a coincident
 * policy.json edit — or drift vs a stale baseline — let a net-new critical secret
 * pass as a warning (feedback #20). `tooling_drift` (a scanner / advisory-DB
 * version change CAN surface a phantom critical that isn't a real regression) and
 * `uncertain` (scanner wobble) still suppress block-rules, preserving the
 * legitimate false-block prevention there.
 */
function evaluateBlockRules(
  status: FindingStatus,
  rules: BrownfieldBlockRules,
  context: ClassifyContext,
): string | null {
  if (status !== 'added' && status !== 'config_drift') return null;
  if (rules.newSecret && context.kind === 'secret') return 'newSecret';
  if (rules.newCriticalSecurity && context.kind === 'code' && context.severity === 'critical') {
    return 'newCriticalSecurity';
  }
  if (rules.newHighSecurity && context.kind === 'code' && context.severity === 'high') {
    return 'newHighSecurity';
  }
  if (
    rules.newCriticalDependencyVulnerability &&
    context.kind === 'dep-vuln' &&
    context.severity === 'critical'
  ) {
    return 'newCriticalDependencyVulnerability';
  }
  if (
    rules.newHighReachableDependencyVulnerability &&
    context.kind === 'dep-vuln' &&
    context.severity === 'high' &&
    context.reachable === true
  ) {
    return 'newHighReachableDependencyVulnerability';
  }
  if (
    rules.newUntestedChangedSource &&
    context.kind === 'test-gap' &&
    context.overlapsChangedLines === true
  ) {
    return 'newUntestedChangedSource';
  }
  if (
    rules.newSevereQualityIssueInChangedFiles &&
    (context.kind === 'code' || context.kind === 'hygiene') &&
    (context.severity === 'critical' || context.severity === 'high') &&
    context.overlapsChangedLines === true
  ) {
    return 'newSevereQualityIssueInChangedFiles';
  }
  return null;
}

/**
 * Convenience: classify every pair in a match result against the
 * same policy. Returns an array aligned with the input pair order
 * so callers can render side-by-side. Per-pair context (severity,
 * kind, drift flags) is supplied via the optional `contextFor`
 * callback — callers map their `FindingId` back to the producer
 * envelope to fill in the fields the classifier reads.
 */
export function classifyAll(
  pairs: ReadonlyArray<MatchPair>,
  policy: BrownfieldPolicy = DEFAULT_BROWNFIELD_POLICY,
  contextFor: (pair: MatchPair) => ClassifyContext = () => ({}),
): ReadonlyArray<ClassifyResult> {
  return pairs.map((pair) => classify(pair, policy, contextFor(pair)));
}

/** Conventional location for a per-repo brownfield policy. Loaded
 *  automatically by `resolvePolicy` when present. */
export const DEFAULT_POLICY_FILENAME = path.join('.dxkit', 'policy.json');

/**
 * Load a brownfield policy with the three-step resolution order
 * shared by `createBaseline` and `runGuardrailCheck`:
 *
 *   1. `policyPath` (explicit `--policy <p>` flag). Errors if the
 *      path is supplied but unreadable / malformed.
 *   2. `<cwd>/.dxkit/policy.json` (conventional). Silently skipped
 *      when absent so consumers without a policy get the defaults.
 *   3. `DEFAULT_BROWNFIELD_POLICY` (compiled-in fallback).
 *
 * Customer fields shallow-merge over the default. The
 * `confidence` / `blockRules` blocks deep-merge by key. Unknown
 * fields are preserved — the classifier ignores what it doesn't
 * know, so forward-compatible policy files don't break old dxkit.
 */
export function resolvePolicy(policyPath: string | undefined, cwd: string): BrownfieldPolicy {
  let resolvedPath: string | undefined = policyPath;
  if (!resolvedPath) {
    const conventional = path.join(cwd, DEFAULT_POLICY_FILENAME);
    if (fs.existsSync(conventional)) resolvedPath = conventional;
  }
  if (!resolvedPath) return DEFAULT_BROWNFIELD_POLICY;
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`policy file not readable: ${resolvedPath} (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy file is not valid JSON: ${resolvedPath} (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`policy file root is not an object: ${resolvedPath}`);
  }
  const obj = parsed as Partial<BrownfieldPolicy>;
  return {
    ...DEFAULT_BROWNFIELD_POLICY,
    ...obj,
    confidence: { ...DEFAULT_BROWNFIELD_POLICY.confidence, ...(obj.confidence ?? {}) },
    blockRules: { ...DEFAULT_BROWNFIELD_POLICY.blockRules, ...(obj.blockRules ?? {}) },
    block: obj.block ?? DEFAULT_BROWNFIELD_POLICY.block,
    warn: obj.warn ?? DEFAULT_BROWNFIELD_POLICY.warn,
    addedRequiresChangedLines:
      obj.addedRequiresChangedLines ?? DEFAULT_BROWNFIELD_POLICY.addedRequiresChangedLines,
    mode: 'brownfield',
  };
}

/**
 * Convenience wrapper for callers that don't take a `--policy`
 * override (e.g., `createBaseline`). Loads the conventional file if
 * present; returns defaults otherwise.
 */
export function loadPolicyFromCwd(cwd: string): BrownfieldPolicy {
  return resolvePolicy(undefined, cwd);
}
