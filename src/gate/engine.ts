/**
 * The gate engine (4.4.0 WP1) — the ONE implementation of dxkit's core
 * judgment: a SUBJECT (the tree being judged) against a PRIOR (what was
 * already true, expressed as a resolved mode) under a POLICY.
 *
 * Pipeline:
 *
 *   1. Plan the gather (scope, incremental sets, mode-specific trims).
 *   2. Acquire the prior side (`./prior.ts` — the one acquisition seam).
 *   3. Re-run every analyzer (via `gatherCurrentScan`) to produce the
 *      current side of the diff.
 *   4. Convert both sides to `LocatedIdentity[]` and run the
 *      git-aware matcher.
 *   5. Classify every pair under the policy (`./classify-pairs.ts`).
 *   6. Optionally filter via `--changed-only`.
 *   7. Run the four additive gates (flow / schema-drift / seam-dup /
 *      paired-change) and fold their verdicts in.
 *   8. Compose a `GuardrailCheckResult`; verdict + exit-code derivation
 *      stay downstream in `check-renderers.ts:verdictCounts` — never here.
 *
 * Surfaces are thin parameterizations of this function: `guardrail
 * check` (src/baseline/check.ts, consumer #1), `gate <dir>` (WP2),
 * `gate --workspace` (WP7). The WP0 parity net
 * (test/gate/guardrail-parity.test.ts) freezes the behavior every
 * surface must share; extend the engine, never fork a surface pipeline.
 */

import { gatherCurrentScan } from '../baseline/create';
import { entriesToLocated } from '../baseline/entry-to-located';
import { gitAwareMatch } from '../baseline/git-aware-match';
import type { LocatedIdentity } from '../baseline/git-aware-match';
import { priorClassOf } from '../baseline/modes';
import type { ResolvedMode } from '../baseline/modes';
import type { BrownfieldPolicy } from '../baseline/policy';
import { FULL_SCOPE, scopeForPolicy, scopeForRefBasedDiff } from '../baseline/gather-scope';
import { computeChangedFiles } from '../baseline/changed-files';
import { changedFilesTouchDependencyManifest, detectActiveLanguages } from '../languages';
import { collectAttributionGaps } from '../baseline/attribution-gap';
import { collectExpiryProjection } from '../baseline/expiry-projection';
import { evaluateFlowGateForGuardrail } from '../baseline/flow-gate-check';
import { evaluateSchemaDriftGateForGuardrail } from '../baseline/schema-drift-gate-check';
import { evaluateDupGateForGuardrail } from '../baseline/dup-gate-check';
import { evaluatePairedGateForGuardrail } from '../baseline/paired-gate-check';
import type { BaselineEntry } from '../baseline/types';
import {
  refreshWorkflowInstalled,
  detectBaselineSuspect,
  readBaselineProvenance,
} from '../baseline/provenance';
import { MANAGED_SHIP_SURFACES } from '../managed-artifacts';
import {
  computeAllowlistDelta,
  resolveAllowlistDeltaBase,
  type AllowlistDelta,
} from '../allowlist/diff';
import { resolveEffectiveAllowlist } from '../allowlist/effective';
import { entryToAllowlistable } from '../baseline/allowlist-match';
import { classifyPairs } from './classify-pairs';
import { diffEnvelopes, keepUnderChangedOnly, pairBlocks } from './context';
import { collectNotObservedDisclosures, partitionForRefBasedDiff } from './observation';
import { acquirePrior, assertPriorSchemeComparable, emptyPriorFromScan } from './prior';
import type { GuardrailCheckResult } from './result';
import type { GateEngineOptions, GateSubject } from './types';

/**
 * Judge a subject against a prior under a policy. The prior arrives as a
 * `ResolvedMode` — Rule 11's one resolver picks it; the engine never
 * second-guesses the pick. Policy arrives resolved for the same reason
 * (the surface owns "which policy file", the engine owns "what the
 * policy means for this diff").
 */
export async function runGate(
  subject: GateSubject,
  mode: ResolvedMode,
  policy: BrownfieldPolicy,
  options: GateEngineOptions,
): Promise<GuardrailCheckResult> {
  // The analysis root. A `tree` subject is a bare directory: every
  // git-derived signal below (changed-line attribution, relocation
  // matching, base-ref gates) degrades DECLARATIVELY — attribution reads
  // UNKNOWN (never a demotion), the matcher falls back to set-diff, and
  // the base-ref gates skip with `no-base-ref` disclosed.
  const cwd = subject.kind === 'repo' ? subject.cwd : subject.dir;
  // Every prior-semantics branch keys on the declared class of the mode
  // (committed / dir-gathered / empty), never on mode strings — a new
  // mode declares its class once in modes.ts and every branch follows.
  const priorClass = priorClassOf(mode.mode);

  // Incremental scanning in ref-based mode: the changed set is the diff of
  // the ref against the working HEAD, known upfront from `mode.ref`. We scope
  // BOTH the ref side and the current side to this same set so the cross-run
  // diff stays symmetric (sound for the net-new gate — semgrep is
  // intraprocedural). `computeChangedFiles` returns null on any uncertainty,
  // which maps to `undefined` here, i.e. a full scan (the safe default).
  const refIncrementalFiles =
    options.incremental && mode.mode === 'ref-based' && mode.ref
      ? (computeChangedFiles(cwd, mode.ref) ?? undefined)
      : undefined;

  // Gather scope. Incremental mode mirrors the loop Stop-gate's fast path: it
  // scopes the gather to the analyzers the policy can actually block on
  // (opt 1, via the shared `scopeForPolicy`) IN ADDITION to the changed-files
  // semgrep scoping (opt 3) — the dominant speed win is skipping the analyzers
  // a `security-only` posture can never block on (lint, coverage, jscpd,
  // structural, licenses). An explicit `options.scope` still wins; default
  // (non-incremental) callers stay on FULL_SCOPE so their full report and
  // every warning are unaffected. Both sides use the SAME scope so the
  // cross-run diff stays balanced.
  let gatherScope = options.scope ?? (options.incremental ? scopeForPolicy(policy) : FULL_SCOPE);

  // Incremental ref-based dep-audit skip. A net-new dependency vulnerability
  // requires a manifest/lockfile change, so when the PR changed none the OSV
  // audit on the ref side and the current side run over identical dependency
  // sets against the SAME OSV snapshot — it cannot surface anything net-new.
  // The audit is the dominant cost on large repos (the rest of a scoped gather
  // is sub-second), so skipping it on both sides is the single biggest
  // incremental win. Sound ONLY in ref-based mode: committed mode compares
  // against an older baseline snapshot, where a newly-disclosed CVE on an
  // unchanged dependency genuinely IS net-new and must still surface — so this
  // never fires there (it is gated on `refIncrementalFiles`, which only exists
  // in ref-based mode). Manifest patterns are pack-declared (Rule 6).
  if (
    gatherScope.depVulns &&
    options.incremental &&
    mode.mode === 'ref-based' &&
    refIncrementalFiles &&
    !changedFilesTouchDependencyManifest(refIncrementalFiles, detectActiveLanguages(cwd))
  ) {
    gatherScope = { ...gatherScope, depVulns: false };
    if (options.verbose) {
      process.stderr.write(
        '    [incremental] no dependency manifest changed — skipping dep-vuln audit\n',
      );
    }
  }

  // Ref-based mode structurally discards the REF_UNRELIABLE kinds from the
  // diff (see partitionForRefBasedDiff), so don't pay to gather them on
  // either side — under full-debt this was minutes of jscpd + coverage +
  // check-runner per run for output that got thrown away. The skipped
  // kinds are recorded so the "not gated in ref-based mode" disclosure
  // survives the optimization.
  let refScopeSkippedKinds: ReadonlyArray<BaselineEntry['kind']> = [];
  if (priorClass === 'dir-gathered') {
    const adjusted = scopeForRefBasedDiff(gatherScope);
    gatherScope = adjusted.scope;
    refScopeSkippedKinds = adjusted.skippedKinds;
  }

  // Acquire the prior side through the ONE seam, then guard comparability
  // (a stale-scheme committed baseline refuses with the remedy named).
  // The `fresh` (empty) prior is the one arm deferred: it derives from
  // the current scan, so it's built right after the gather below —
  // still by prior.ts, the one prior home.
  const acquired =
    priorClass === 'empty'
      ? undefined
      : await acquirePrior(cwd, mode, options, refIncrementalFiles, gatherScope);
  if (acquired) assertPriorSchemeComparable(acquired, mode);

  const scope = gatherScope;
  // Incremental scanning: scope the current side's semgrep to changed files.
  // `computeChangedFiles` returns null when it can't enumerate the changed
  // set completely (base unreachable, git error) — that maps to `undefined`
  // here, i.e. a full scan (the safe default).
  //   - ref-based: reuse the set already computed from `mode.ref` above; the
  //     ref/baseline side was scoped to the SAME set, keeping the diff
  //     symmetric.
  //   - committed: the prior side is the on-disk (full) baseline, so only the
  //     current side is scoped, against the baseline's commit.
  const incrementalFiles =
    mode.mode === 'ref-based'
      ? refIncrementalFiles
      : options.incremental && acquired?.baseline.repo.commitSha
        ? (computeChangedFiles(cwd, acquired.baseline.repo.commitSha) ?? undefined)
        : undefined;
  const current = await gatherCurrentScan({
    cwd,
    verbose: options.verbose,
    // The ONE resolved policy governs the whole run — the custom-check
    // seam must see the same document the verdict is judged under (a
    // --policy override reaching findings but not checks was the WP4
    // class this closes).
    policy,
    scope,
    incrementalFiles,
    // The guardrail verdict never reads dep `upgradePlan` (it's excluded from
    // finding identity), so skip the Tier-2 remediation enrichment that runs
    // the package manager — pure cost here, and unsafe on untrusted PR code.
    skipRemediation: true,
    // Hosted PR gates set --untrusted so dep audits never execute the scanned
    // source (e.g. Python skips `pip-audit .` project-build).
    trust: options.trust,
  });

  // The empty prior materializes here, from the current scan's own
  // envelope (recall matches by construction — Rule 19 composes, never
  // disabled). Every other class arrived through acquirePrior above.
  const prior = acquired ?? emptyPriorFromScan(current, options.name);
  const { baseline, baselinePath, anchorSource } = prior;

  // Under a dir-gathered prior (a materialized ref, a supplied tree) the
  // prior side can't produce the build-artifact-dependent kinds; drop
  // them from both sides so the diff stays symmetric (see
  // partitionForRefBasedDiff). An empty prior excludes NOTHING: there is
  // no prior-side asymmetry to protect against, and the gate's whole
  // point is full observation of the subject tree.
  const partitioned = partitionForRefBasedDiff(
    baseline.findings,
    current.findings,
    priorClass === 'dir-gathered',
  );
  const { diffablePrior, diffableCurrent } = partitioned;
  // Union in the kinds whose analyzers were scope-skipped up front: their
  // gathers never ran, so the partition saw no findings to record, but the
  // disclosure ("not gated in ref-based mode") must still surface.
  const refExcludedKinds: GuardrailCheckResult['refExcludedKinds'] = [
    ...partitioned.refExcludedKinds,
    ...refScopeSkippedKinds
      .filter((k) => !partitioned.refExcludedKinds.some((e) => e.kind === k))
      .map((kind) => ({ kind, currentCount: 0 })),
  ];

  const priorLocated: ReadonlyArray<LocatedIdentity> = entriesToLocated(diffablePrior);
  const currentLocated: ReadonlyArray<LocatedIdentity> = entriesToLocated(diffableCurrent);

  // The matcher needs the baseline's anchor commit to drive `git
  // diff`. Empty string is the canonical "not a git repo at capture
  // time" value; the matcher's reachability check handles it by
  // falling back to plain set-diff (passes 1 + 1.5 are skipped).
  const matchResult = gitAwareMatch(priorLocated, currentLocated, {
    cwd,
    baseSha: baseline.repo.commitSha || 'HEAD',
    headSha: 'HEAD',
  });

  const envelopeDrift = diffEnvelopes(baseline, current, mode.mode, refreshWorkflowInstalled(cwd));

  // Load the per-finding allowlist once. An active (unexpired) entry
  // whose fingerprint matches a would-block finding waives the block —
  // this is what makes "I reviewed and accepted this finding" actually
  // suppress a net-new regression, not just annotate it. Null when no
  // allowlist file is present (the common case).
  // The effective allowlist (file-level ∪ inline `dxkit-allow:` annotations),
  // resolved through the ONE canonical constructor so the guardrail, the
  // security score, and `baseline create` all see the identical suppression set
  // (Rule 2). An inline suppression on a NET-NEW finding waives its block
  // exactly like a file-level entry.
  const allowlist = resolveEffectiveAllowlist({
    cwd,
    findings: current.findings.map(entryToAllowlistable),
  });
  const now = new Date();

  const classified = classifyPairs({
    cwd,
    policy,
    mode,
    scope,
    baseline,
    current,
    matchResult,
    envelopeDrift,
    allowlist,
    now,
  });
  const { pairs: classifiedPairs, blocks, warns, priorById, notObservedReasonFor } = classified;

  const filteredPairs = options.changedOnly
    ? classifiedPairs.filter((p) => keepUnderChangedOnly(p))
    : classifiedPairs;

  // Re-derive the verdict after filtering — a --changed-only run
  // shouldn't be blocked by a pair that the filter just dropped.
  // `pairBlocks` folds in allowlist suppression so a suppressed pair
  // never contributes to the verdict here either.
  let filteredBlocks = false;
  let filteredWarns = false;
  for (const p of filteredPairs) {
    if (pairBlocks(p)) filteredBlocks = true;
    if (p.classification.warns && p.suppressedByAllowlist === undefined) filteredWarns = true;
  }

  // Allowlist delta between the branch the PR MERGES INTO and the current
  // working tree. Surfaced in the markdown renderer so PR reviewers see the new
  // suppressions THIS branch introduces (not every entry accumulated since the
  // baseline was captured). The base is the base-branch tip, resolved per mode —
  // diffing against the stale findings-baseline SHA made the whole allowlist
  // read as "added" when that commit predated the allowlist. Absent/degenerate
  // when the base isn't reachable (shallow clone) → renderer shows "unavailable".
  const allowlistBase = resolveAllowlistDeltaBase(
    cwd,
    mode.mode === 'ref-based' ? mode.ref : undefined,
    baseline.repo.branch,
    baseline.repo.commitSha,
  );
  const allowlistDelta: AllowlistDelta = computeAllowlistDelta(cwd, allowlistBase);

  // The flow integration gate — an additive, fail-open pass that runs its own
  // base↔HEAD flow gather (independent of the finding matcher above) and never
  // throws; its verdict folds into the top-level one. It needs only a base
  // COMMIT to diff against: the resolved git ref in ref-based mode, or the
  // committed baseline's anchor SHA in committed mode (flow-binding has no
  // committed prior side — the base flow model is gathered fresh from that
  // commit either way, so the gate works in both modes).
  // Gate-only priors have no base COMMIT at all (an empty prior, a bare
  // supplied tree), so the base-ref gates skip with `no-base-ref` —
  // disclosed by their own outcome shape, never silently run against a
  // meaningless ref.
  const flowBaseRef =
    mode.mode === 'ref-based'
      ? mode.ref
      : priorClass === 'committed'
        ? baseline.repo.commitSha
        : undefined;
  const flowGate = await evaluateFlowGateForGuardrail({
    cwd,
    ...(flowBaseRef ? { baseRef: flowBaseRef } : {}),
    // Same loaded allowlist + clock the matcher-pair suppression uses, so an
    // active `flow-binding` entry waives a flow block exactly like any other
    // finding kind (the per-finding escape hatch).
    allowlist,
    now,
    ...(options.flowMode !== undefined ? { modeOverride: options.flowMode } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
    // Hosted-PR posture reaches the gate so rung-4 plugins never load on
    // untrusted source (the overlay degrades symmetrically on both sides).
    trust: options.trust,
  });

  // The model-schema drift gate — same additive, fail-open shape as the flow
  // gate, sharing its base-commit resolution, allowlist, and clock. Opt-in:
  // with no `schema` policy block it skips as 'off' at zero cost.
  const schemaDriftGate = await evaluateSchemaDriftGateForGuardrail({
    cwd,
    ...(flowBaseRef ? { baseRef: flowBaseRef } : {}),
    allowlist,
    now,
    ...(options.schemaMode !== undefined ? { modeOverride: options.schemaMode } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });

  // The structural-duplicate (seam) gate — same additive, fail-open shape,
  // sharing the base-commit resolution, allowlist, and clock. Opt-in: with no
  // `duplication` policy block it skips as 'off' at zero cost (no graph build).
  const dupGate = await evaluateDupGateForGuardrail({
    cwd,
    ...(flowBaseRef ? { baseRef: flowBaseRef } : {}),
    allowlist,
    now,
    ...(options.duplicationMode !== undefined ? { modeOverride: options.duplicationMode } : {}),
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });

  // The paired-change gate — the fourth additive, fail-open sibling. PURE
  // (globs vs the changed-path set, no spawn), so it needs no trust gating
  // and no mode restriction; it shares the base-commit resolution, allowlist,
  // and clock.
  const pairedGate = evaluatePairedGateForGuardrail({
    cwd,
    ...(flowBaseRef ? { baseRef: flowBaseRef } : {}),
    allowlist,
    now,
    ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
  });

  const baseBlocks = options.changedOnly ? filteredBlocks : blocks;
  const baseWarns = options.changedOnly ? filteredWarns : warns;

  // Attribution gaps: block-rule-class findings recall drift demoted out of
  // block-rule reach. Computed from the SAME pair set the verdict reads
  // (post --changed-only filter), so a filtered-out pair can neither block
  // nor refuse. The verdict derivation (`verdictCounts`) consumes these —
  // while one exists the run cannot render PASSED.
  const attributionGaps = collectAttributionGaps(filteredPairs, envelopeDrift.recallDrift);

  // Baseline-suspect staleness disclosure (#222): a large share of ADDED
  // findings in files the diff never touched is a stale-anchor signature (the
  // baseline predates the base branch's recent history), not developer fault.
  // Committed modes only — ref-based re-gathers the prior side at the PR's own
  // base, so there is no stale-anchor concept. Disclosure only: the verdict is
  // mechanically correct either way; this reframes it and names the honest
  // remedy (workflow-aware via the provenance module).
  const baselineSuspect =
    priorClass === 'committed'
      ? detectBaselineSuspect({
          addedFiles: filteredPairs
            .filter((p) => p.classification.status === 'added' && p.file !== undefined)
            .map((p) => p.file!),
          changedFiles: baseline.repo.commitSha
            ? computeChangedFiles(cwd, baseline.repo.commitSha)
            : null,
          provenance: readBaselineProvenance(cwd, baseline),
        })
      : null;

  // Aggregate the not-observed pairs into per-reason disclosures for the
  // renderers. Aggregate ON PURPOSE: a repo-scale lint backlog is tens of
  // thousands of entries, and listing them (the "Resolved (18406)" table this
  // fixes) is both a lie and a comment-size failure — the honest output is one
  // line per unobserved check with its count. Computed from the SAME pair set
  // the verdict reads (post --changed-only filter), through the same reason
  // function the classifier consumed, so the counts and phrasing agree by
  // construction.
  const notObservedDisclosures = collectNotObservedDisclosures(
    filteredPairs,
    priorById,
    notObservedReasonFor,
  );

  // The lapse projection: what today's active suppressions will cost when their
  // windows close. Reads the same pair set the verdict reads (post
  // --changed-only filter) and the same `now` the suppression decision used, so
  // a pair cannot be treated as suppressed here and lapsing on a different day.
  // Disclosure only — it is deliberately absent from `blocks` / `warns` below.
  const suppressionExpiry = collectExpiryProjection({
    pairs: filteredPairs,
    flowGate,
    schemaDriftGate,
    dupGate,
    pairedGate,
    now,
  });

  return {
    mode,
    ...(baselinePath !== undefined ? { baselinePath } : {}),
    ...(anchorSource !== undefined ? { anchorSource } : {}),
    baseline,
    current,
    matchResult,
    pairs: filteredPairs,
    envelopeDrift,
    policy,
    blocks:
      baseBlocks ||
      flowGate.blocks ||
      schemaDriftGate.blocks ||
      dupGate.blocks ||
      pairedGate.blocks,
    warns:
      baseWarns || flowGate.warns || schemaDriftGate.warns || dupGate.warns || pairedGate.warns,
    attributionGaps,
    ...(baselineSuspect ? { baselineSuspect } : {}),
    suppressionExpiry,
    notObserved: notObservedDisclosures,
    allowlistDelta,
    refExcludedKinds,
    ...(MANAGED_SHIP_SURFACES.find((s) => s.id === 'ci-comment-defer')?.detectPresent?.(cwd)
      ? { commentDeferInstalled: true as const }
      : {}),
    // Capture-deferral (Rule 20): classes the committed baseline could not
    // observe at capture. Committed prior class only — a re-gathered or
    // empty prior has no committed baseline to complete, so the
    // "completing on CI" framing does not apply.
    ...(priorClass === 'committed' && baseline.deferred && baseline.deferred.length > 0
      ? { deferredCapture: baseline.deferred }
      : {}),
    ...(flowGate.ran || flowGate.skipped !== 'no-base-ref' ? { flowGate } : {}),
    // Attach when the gate is configured on (ran, or skipped for a reason
    // worth disclosing); an off/no-base-ref skip stays out of the result so
    // unconfigured repos see nothing new.
    ...(schemaDriftGate.ran ||
    (schemaDriftGate.skipped !== 'off' && schemaDriftGate.skipped !== 'no-base-ref')
      ? { schemaDriftGate }
      : {}),
    // Attach when the seam gate is configured on (ran, or skipped for a reason
    // worth disclosing); an off/no-base-ref skip stays out so unconfigured
    // repos see nothing new.
    ...(dupGate.ran || (dupGate.skipped !== 'off' && dupGate.skipped !== 'no-base-ref')
      ? { dupGate }
      : {}),
    // Attach when the paired gate is configured on (ran, or skipped for a
    // reason worth disclosing — an uncomputable changed set or an error on a
    // repo that DECLARED rules must be visible); an off/no-base-ref skip
    // stays out so unconfigured repos see nothing new.
    ...(pairedGate.ran || (pairedGate.skipped !== 'off' && pairedGate.skipped !== 'no-base-ref')
      ? { pairedGate }
      : {}),
    // Fail-loud: a dep scan that was REQUESTED but could not run must not read as
    // a clean "no net-new dep vulns" — surface it. Incrementally-skipped scans
    // (scope.depVulns false) and nothing-to-scan stacks are legitimately silent.
    ...(scope.depVulns && !current.aggregate.provenance.depVulns.available
      ? {
          depVulnsUnmeasured: {
            reason:
              current.aggregate.provenance.depVulns.unavailableReason ||
              'dependency scanner unavailable',
          },
        }
      : {}),
  };
}
