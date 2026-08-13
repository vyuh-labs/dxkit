/**
 * Verdict-adjacent disclosure collection — the block of `runGate` that
 * turns the classified pair set into the disclosures the renderers and
 * the verdict derivation consume: attribution gaps (Rule 19), required-
 * observation gaps (WP1 §7.1), the baseline-suspect staleness signature
 * (#222), the not-observed aggregate (Rule 19's REMOVED direction), and
 * the suppression-lapse projection.
 *
 * Split from `engine.ts` for module size, not semantics: every input is
 * the SAME pair set / clock the verdict reads (post `--changed-only`
 * filter), so a filtered-out pair can neither block, refuse, nor lapse —
 * that invariant is this module's contract, and new disclosure kinds
 * belong here so they inherit it.
 */

import type { BaselineFile } from '../baseline/baseline-file';
import type { CurrentScan } from '../baseline/create';
import type { BrownfieldPolicy } from '../baseline/policy';
import { collectAttributionGaps } from '../baseline/attribution-gap';
import { collectExpiryProjection } from '../baseline/expiry-projection';
import { computeChangedFiles } from '../baseline/changed-files';
import { detectBaselineSuspect, readBaselineProvenance } from '../baseline/provenance';
import type { PriorClass } from '../baseline/modes';
import type { FlowGateOutcome } from '../baseline/flow-gate-check';
import type { SchemaDriftGateOutcome } from '../baseline/schema-drift-gate-check';
import type { DupGateOutcome } from '../baseline/dup-gate-check';
import type { PairedGateOutcome } from '../baseline/paired-gate-check';
import type { ClassifiedPair, EnvelopeDrift, GuardrailCheckResult } from './result';
import type { BaselineEntry } from '../baseline/types';
import { collectNotObservedDisclosures } from './observation';
import { requiredCustomCheckGaps } from './required-observation';

export interface DisclosureInputs {
  readonly cwd: string;
  readonly policy: BrownfieldPolicy;
  readonly priorClass: PriorClass;
  readonly baseline: BaselineFile;
  readonly current: CurrentScan;
  /** The post-filter pair set the verdict reads — never the raw pairs. */
  readonly filteredPairs: ReadonlyArray<ClassifiedPair>;
  readonly envelopeDrift: EnvelopeDrift;
  readonly refExcludedKinds: GuardrailCheckResult['refExcludedKinds'];
  readonly priorById: ReadonlyMap<string, BaselineEntry>;
  readonly notObservedReasonFor: (entry: BaselineEntry) => string | undefined;
  readonly flowGate: FlowGateOutcome;
  readonly schemaDriftGate: SchemaDriftGateOutcome;
  readonly dupGate: DupGateOutcome;
  readonly pairedGate: PairedGateOutcome;
  /** The one clock of the run — the same `now` the suppression decision used. */
  readonly now: Date;
}

export interface VerdictDisclosures {
  readonly attributionGaps: GuardrailCheckResult['attributionGaps'];
  readonly requiredNotObserved: GuardrailCheckResult['requiredNotObserved'];
  readonly baselineSuspect: GuardrailCheckResult['baselineSuspect'] | null;
  readonly notObserved: GuardrailCheckResult['notObserved'];
  readonly suppressionExpiry: GuardrailCheckResult['suppressionExpiry'];
}

export function collectVerdictDisclosures(inputs: DisclosureInputs): VerdictDisclosures {
  const { cwd, policy, priorClass, baseline, current, filteredPairs, envelopeDrift } = inputs;

  // Attribution gaps: block-rule-class findings recall drift demoted out of
  // block-rule reach. While one exists the run cannot render PASSED.
  const attributionGaps = collectAttributionGaps(filteredPairs, envelopeDrift.recallDrift);

  // Required-observation gaps (WP1, §7.1): policy-declared `required: true`
  // checks whose observation is missing this run — the observation sibling
  // of the attribution gaps. Empty for every policy without a required check.
  const requiredNotObserved = requiredCustomCheckGaps(
    policy,
    current.customChecksUnobserved,
    inputs.refExcludedKinds,
  );

  // Baseline-suspect staleness disclosure (#222): a large share of ADDED
  // findings in files the diff never touched is a stale-anchor signature,
  // not developer fault. Committed modes only — ref-based re-gathers the
  // prior at the PR's own base, so there is no stale-anchor concept.
  // Disclosure only: reframes a mechanically-correct BLOCKED with the
  // workflow-aware re-anchor remedy.
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

  // The not-observed AGGREGATE (one line per unobserved check, with counts)
  // — never per-finding rows: a repo-scale lint backlog is tens of
  // thousands of entries, and listing them is both a lie ("Resolved
  // (18406)") and a comment-size failure. Same reason function the
  // classifier consumed, so counts and phrasing agree by construction.
  const notObserved = collectNotObservedDisclosures(
    filteredPairs,
    inputs.priorById,
    inputs.notObservedReasonFor,
  );

  // The lapse projection: what today's active suppressions will cost when
  // their windows close. Disclosure only — deliberately absent from
  // `blocks` / `warns`.
  const suppressionExpiry = collectExpiryProjection({
    pairs: filteredPairs,
    flowGate: inputs.flowGate,
    schemaDriftGate: inputs.schemaDriftGate,
    dupGate: inputs.dupGate,
    pairedGate: inputs.pairedGate,
    now: inputs.now,
  });

  return { attributionGaps, requiredNotObserved, baselineSuspect, notObserved, suppressionExpiry };
}
