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
  /** True when what dxkit can SEE for this finding's KIND changed between the
   *  baseline and this scan (CLAUDE.md Rule 19): a scanner or plugin version,
   *  a linter config, a check command, an ingested engine — or dxkit's own
   *  recall epoch for the kind. Reclassifies an `added` finding as
   *  `tooling_drift` rather than blocking it as a new regression, because the
   *  delta has an explanation other than "the developer introduced it".
   *
   *  Named for the CONCEPT, not one instance of it: this began as
   *  `scannerVersionDiffers`, and the narrow name is part of why the
   *  mechanism only ever covered five kinds' scanner versions while lint,
   *  duplication and test-gap could never drift at all. */
  readonly recallDrifted?: boolean;
  /** The specific evidence behind `recallDrifted` — which input moved and from
   *  what to what (`describeRecallDrift`). Rides onto the finding's reason
   *  chain so a reader is told "eslint-plugin-react-hooks 7.0.1 -> 7.1.1", not
   *  the useless generic "something changed". Absent ⇒ the generic wording. */
  readonly recallDriftDetail?: string;
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
  /** True when the finding's KIND had ZERO entries in the baseline — the
   *  dimension was newly measured (e.g. `lint.enabled` was just turned on, so the
   *  repo's whole pre-existing lint backlog appears net-new against a baseline
   *  that had no lint dimension). Under envelope drift this is a MORE specific,
   *  truer explanation than the generic `config_drift` label, so the reason names
   *  it. Does NOT change the verdict — the status stays `config_drift`. */
  readonly kindAbsentFromBaseline?: boolean;
  /** True when the underlying source file's lines overlap lines
   *  changed by the current diff. Used by `newSevereQualityIssueIn
   *  ChangedFiles` and similar rules; absent context is treated as
   *  "we don't know, assume outside changed lines." */
  readonly overlapsChangedLines?: boolean;
  /** True when the diff (baseline anchor → working tree) touched NO dependency
   *  manifest of any active pack. For an `added` dep-vuln this rules the
   *  developer out as the delta's cause — the dependency set is unchanged, so
   *  the advisory was published to the feed after baseline capture (D4). The
   *  discriminator is the ONE `changedFilesTouchDependencyManifest` — the same
   *  helper the ref-based incremental dep-audit skip trusts (Rule 2.30 parity).
   *  Absent (changed files unknowable) ⇒ no relabel: the evidence is missing,
   *  so the finding keeps its `added` attribution. */
  readonly manifestUntouched?: boolean;
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
  /**
   * Present when this finding was demoted `added` → `tooling_drift` by recall
   * drift (CLAUDE.md Rule 19) BUT an armed block rule would have fired had it
   * stayed `added`. Names the rule that would have fired.
   *
   * This is the value that makes un-observation impossible to render as a
   * pass: the classifier can neither BLOCK (the drift is real evidence of a
   * cause other than the developer — blocking would misattribute) nor let the
   * finding warn its way into a PASSED banner (a net-new secret rode exactly
   * that path out the door: recall-absent → `tooling_drift` → every block rule
   * disarmed — the closed #20 config-drift bypass, one status over). So the
   * classification records that the answer is UNKNOWABLE, and the verdict
   * layer refuses to say PASSED while any such finding exists — the same
   * treatment the identity-scheme mismatch already gets.
   */
  readonly unattributableBlockRule?: string;
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
  let unattributableBlockRule: string | undefined;

  // Step 2: drift context can reclassify 'added'.
  if (status === 'added') {
    if (context.recallDrifted) {
      status = 'tooling_drift';
      reasons.push({
        code: 'tooling-drift',
        detail:
          context.recallDriftDetail ??
          'what dxkit can see for this kind changed between runs, so this finding cannot be attributed to the diff',
      });
      // Rule 19 demotes because the delta has an explanation other than "the
      // developer introduced it". But when the demoted finding would have been
      // caught by an armed block rule — the policy's non-negotiable floor —
      // demote-to-warn quietly disarms that floor (a live credential then rides
      // a PASSED banner out the door). Blocking would misattribute; passing
      // would under-claim what the gate enforces. Record the third answer:
      // this finding is UNATTRIBUTABLE, and the verdict layer must refuse to
      // pass over it. Evaluated through the ONE `evaluateBlockRules` (no
      // second kind↔rule table to drift — CLAUDE.md 2.30).
      const wouldHaveFired = evaluateBlockRules('added', policy.blockRules, context);
      if (wouldHaveFired) {
        unattributableBlockRule = wouldHaveFired;
        reasons.push({
          code: 'unattributable-block-rule',
          detail:
            `block rule ${wouldHaveFired} covers this finding, but recall drift means dxkit ` +
            `cannot tell whether it is net-new — the guardrail refuses to pass until the ` +
            `baseline is re-captured`,
        });
      }
    } else if (context.kind === 'dep-vuln' && context.manifestUntouched) {
      // D4: the PR changed no dependency manifest, so the dependency set is
      // identical to the baseline's — the developer cannot be the cause of an
      // added dep-vuln. The one input that moved is the advisory FEED
      // (published after baseline capture). Recall is genuinely clean here
      // (Rule 19's recallDrifted branch above wins when it isn't), so this is
      // its own status — never "regression", never `tooling_drift`. The
      // VERDICT is unchanged (phase 1): block rules and policy membership
      // treat it exactly as `added` — a live high/critical advisory must not
      // silently ride in — but the report stops blaming the PR and names the
      // two lanes (fix the vuln, or short-dated `allowlist defer`).
      status = 'newly_published_advisory';
      reasons.push({
        code: 'newly-published-advisory',
        detail:
          'not introduced by this PR — the diff touches no dependency manifest, so this ' +
          'advisory was published after the baseline was captured. Fix the vulnerability to ' +
          'unblock, or defer time-boxed: vyuh-dxkit allowlist defer --from-last-check ' +
          '--reason="…"',
      });
    } else if (context.configDiffers && !context.fileChangedInDiff) {
      // Config drift only explains a finding that appeared WITHOUT a code
      // change (e.g. a path the policy newly un-ignored). A finding on a file
      // the diff itself added/changed is developer-introduced — it stays
      // `added` even when policy.json changed in the same PR (the misattribution
      // #19 reported: a net-new finding on a brand-new file labelled config_drift
      // because policy.json was edited alongside it).
      status = 'config_drift';
      // `configDiffers` is a REPO-WIDE envelope signal (a dxkit-version /
      // toolchain / policy / config hash change) — true for every finding in the
      // run, so a bare "config changed" reason over-claims a specific cause it
      // can't actually attribute. Name the truer per-finding cause when we have
      // one: a kind with no baseline entries is a newly-enabled gate/dimension
      // (its whole pre-existing backlog reads as net-new), not a policy edit.
      // Verdict is unchanged either way — only the reason string differs.
      reasons.push(
        context.kindAbsentFromBaseline
          ? {
              code: 'dimension-newly-measured',
              detail:
                "this finding's kind had no baseline entries — a gate or dimension was " +
                'newly enabled, so pre-existing findings appear net-new (not a policy change)',
            }
          : {
              code: 'config-drift',
              detail:
                'unmatched after an envelope change (dxkit version / toolchain / policy / ' +
                'config hash differs) — inspect per-finding with --json, or re-capture if the ' +
                'baseline is stale',
            },
      );
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

  // Step 5: policy block/warn membership. `newly_published_advisory` is an
  // attribution RELABEL of `added` (D4 phase 1: gate semantics unchanged), so
  // membership is evaluated as `added` — every policy that blocks added
  // dep-vulns today keeps blocking them, whatever its lists say, without each
  // committed policy.json needing to learn the new status.
  const membershipStatus: FindingStatus = status === 'newly_published_advisory' ? 'added' : status;
  const blocks = blockRuleHit !== null || policy.block.includes(membershipStatus);
  const warns = policy.warn.includes(membershipStatus);

  return {
    status,
    blocks,
    warns,
    reasons,
    ...(unattributableBlockRule !== undefined ? { unattributableBlockRule } : {}),
  };
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
 * legitimate false-block prevention there — but `tooling_drift` does NOT get to
 * silently pass a block-rule-class finding: the recall-drift branch above records
 * `unattributableBlockRule` for it, and the verdict layer refuses to print PASSED
 * while one exists. Without that, `tooling_drift` is the #20 bypass one status
 * over: every pre-Rule-19 baseline reads as drifted, so a net-new secret sailed
 * through as a warning on upgrade day while the banner said PASSED.
 */
function evaluateBlockRules(
  status: FindingStatus,
  rules: BrownfieldBlockRules,
  context: ClassifyContext,
): string | null {
  // `newly_published_advisory` fires block rules exactly as `added` — the
  // relabel changes attribution (who is blamed), never the floor (D4 phase 1).
  if (status !== 'added' && status !== 'config_drift' && status !== 'newly_published_advisory') {
    return null;
  }
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
