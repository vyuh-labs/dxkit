/**
 * The ONE block-rule evaluator (CLAUDE.md Rule 19 / 2.30) — split from
 * `classify.ts` at the large-file bar, semantics unchanged. Both the
 * classifier's live verdict and the recall-drift refusal path
 * (`unattributableBlockRule`) call THIS function; `scopeForPolicy`
 * (`gather-scope.ts`) and `BLOCK_RULE_EVIDENCE` track its predicates.
 * A new rule lands here, in the evidence table, and nowhere else.
 */

import type { BrownfieldBlockRules } from './policy';
import type { FindingStatus } from './types';
import type { ClassifyContext } from './classify';

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
export function evaluateBlockRules(
  status: FindingStatus,
  rules: BrownfieldBlockRules,
  context: ClassifyContext,
): string | null {
  // `newly_published_advisory` never reaches here — its verdict is governed by
  // the advisory tier (see the early return in `classify`), which owns the
  // malicious always-block invariant that `newMaliciousDependency` covers for
  // ordinary `added` findings.
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
  // Every minted `license` finding is already a prohibited-list match (the
  // inventory never becomes findings), so kind alone is the whole predicate.
  if (rules.newProhibitedLicense && context.kind === 'license') {
    return 'newProhibitedLicense';
  }
  // A custom check the policy declared `blocking: true` (4.4.0): the block
  // intent rides on the finding itself, threaded here as
  // `customCheckBlocking`. Only a strict `true` fires — a sanitized entry
  // (intent stripped) or a `blocking: false` check never does; those keep
  // the generic `block` list's verdict and applyCustomCheckIntent's
  // demotion respectively.
  if (
    rules.newBlockingCustomCheckFailure &&
    context.kind === 'custom-check' &&
    context.customCheckBlocking === true
  ) {
    return 'newBlockingCustomCheckFailure';
  }
  // A net-new test gap the developer can actually have caused: a file this
  // diff ADDED, shipping without a test. The rule's original predicate
  // (`overlapsChangedLines === true`) was structurally DEAD — a test-gap
  // finding is whole-file and carries no line, so the overlap was always
  // undefined and the rule could never fire (the T1.2 armed-but-dead class).
  // The added-file predicate is also the only honest one for a
  // derived-membership kind: an EDIT never introduces a test gap (see
  // `derived-membership-shift` above), so firing on edits would misattribute.
  if (rules.newUntestedChangedSource && context.kind === 'test-gap' && context.fileAddedInDiff) {
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
