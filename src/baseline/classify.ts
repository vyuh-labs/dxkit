/**
 * Brownfield status classifier — the bridge from a raw `MatchPair` (matcher
 * output: persisted / relocated / added / removed + confidence + reasons) to the
 * richer guardrail taxonomy. Given a pair + optional context (severity,
 * scanner-version diff, config diff) + a `BrownfieldPolicy`, emits a
 * `ClassifyResult` with the post-policy `FindingStatus`, the block/warn verdict,
 * and the composed reason chain. Pure module, split out of `policy.ts` for size.
 */
import type { FindingSeverity, FindingStatus, MatchPair, MatchReason } from './types';
import {
  type BrownfieldPolicy,
  type BrownfieldBlockRules,
  DEFAULT_BROWNFIELD_POLICY,
} from './policy';

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
  /** True when an `added` dep-vuln's advisory reports the package itself
   *  as malicious code (OSV `MAL-*`, CWE-506 family, malware-titled
   *  advisory) — see `src/analyzers/security/malicious.ts`. */
  readonly malicious?: boolean;
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
  // Malicious-code advisories block at ANY severity: install-time malware
  // executes at install, so CVSS and reachability are the wrong lens. The
  // `malicious` signal comes from the one canonical predicate
  // (`src/analyzers/security/malicious.ts`) applied to the current scan.
  if (rules.newMaliciousDependency && context.kind === 'dep-vuln' && context.malicious === true) {
    return 'newMaliciousDependency';
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
