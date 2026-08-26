/**
 * The engine's classification stage: turn matcher pairs into
 * `ClassifiedPair`s under the policy, with every attribution signal the
 * classifier needs (severity, recall drift, changed-line overlap,
 * derived membership, manifest-untouched, removed-direction
 * observation). Extracted from `src/baseline/check.ts` in the 4.4.0 WP1
 * engine split — one stage, consumed only by `./engine.ts:runGate`.
 */

import { describeCheckSkip } from '../analyzers/custom-checks/types';
import type { CurrentScan } from '../baseline/create';
import type { BaselineFile } from '../baseline/baseline-file';
import type { ResolvedMode } from '../baseline/modes';
import type { BrownfieldPolicy } from '../baseline/policy';
import { classify } from '../baseline/classify';
import type { ClassifyContext } from '../baseline/classify';
import type { AllowlistFile } from '../allowlist/file';
import { allowlistSuppressionFor } from '../baseline/allowlist-match';
import { DERIVED_MEMBERSHIP_KINDS } from '../baseline/gather-scope';
import type { GatherScope } from '../baseline/gather-scope';
import {
  changedContentLines,
  computeAddedFiles,
  computeChangedFiles,
  createChangedLineIndex,
} from '../baseline/changed-files';
import {
  changedFilesTouchDependencyManifest,
  dependencyManifestFilesIn,
  detectActiveLanguages,
} from '../languages';
import { describeRecallDrift } from '../baseline/recall';
import { isSanitized } from '../baseline/sanitize';
import type { BaselineEntry, FindingId, MatchResult } from '../baseline/types';
import type { ClassifiedPair, EnvelopeDrift } from './result';
import {
  applyCustomCheckIntent,
  buildMaliciousIndex,
  buildReachableIndex,
  buildSeverityIndex,
  describeEntryLocation,
  indexById,
  locatorFile,
  locatorLine,
} from './context';
import { KIND_DEFAULT_SEVERITY, kindNotObservedReason } from './observation';

export interface ClassifyPairsInput {
  readonly cwd: string;
  readonly policy: BrownfieldPolicy;
  readonly mode: ResolvedMode;
  readonly scope: GatherScope;
  readonly baseline: BaselineFile;
  readonly current: CurrentScan;
  readonly matchResult: MatchResult;
  readonly envelopeDrift: EnvelopeDrift;
  /** The effective allowlist, resolved ONCE by the engine and shared with the
   *  additive gates so suppression semantics cannot fork. */
  readonly allowlist: AllowlistFile | null;
  /** The one clock for suppression + expiry decisions this run. */
  readonly now: Date;
}

export interface ClassifyPairsOutput {
  readonly pairs: ClassifiedPair[];
  readonly blocks: boolean;
  readonly warns: boolean;
  /** Prior-side entries by id — the engine reuses it for the not-observed
   *  disclosure aggregation, guaranteed identical to what classification saw. */
  readonly priorById: ReadonlyMap<FindingId, BaselineEntry>;
  /** The one removed-direction observation answer (Rule 19), shared with
   *  `collectNotObservedDisclosures` so counts and phrasing agree by
   *  construction. */
  readonly notObservedReasonFor: (entry: BaselineEntry) => string | undefined;
}

export function classifyPairs(input: ClassifyPairsInput): ClassifyPairsOutput {
  const { cwd, policy, mode, scope, baseline, current, matchResult, envelopeDrift, allowlist } =
    input;

  const priorById = indexById(baseline.findings);
  // The set of finding KINDS the baseline captured. A current finding whose kind
  // is absent here means the dimension was newly measured (a gate just enabled),
  // which the classifier names as a truer cause than generic `config_drift`
  // (gh #157). Reason-only — does not change the verdict.
  const baselineKinds = new Set(baseline.findings.map((e) => e.kind));
  const currentById = indexById(current.findings);
  const severityByCurrentId = buildSeverityIndex(current.aggregate);
  const maliciousByCurrentId = buildMaliciousIndex(current.aggregate);
  const reachableByCurrentId = buildReachableIndex(current.aggregate);

  // Per-kind recall attribution (Rule 19) drives the per-pair `recallDrifted`
  // signal. A pair is in drift only when the inputs that determine ITS kind
  // moved — narrower than "any tool drifted globally," which would overstate
  // drift for unrelated kinds. The set is computed once by `diffEnvelopes`
  // from the producer-declared contexts; there is no per-kind list here to
  // fall out of date with the producer registry, which is what made the old
  // hardcoded `buildToolsByKind` silently exclude every kind but five.
  const driftByKind = new Map(envelopeDrift.recallDrift.map((d) => [d.kind, d]));

  // Changed-line attribution vs the WORKING TREE (canonical index — the
  // line-granularity sibling of computeChangedFiles, same diff basis). The
  // scan reads the working tree, so attribution must too: diffing committed
  // HEAD instead demoted every finding an uncommitted edit introduced.
  const baseSha = baseline.repo.commitSha;
  const changedLineIndex = createChangedLineIndex(cwd, baseSha);
  const linesChangedFor = (file: string): ReadonlySet<number> | 'all' | null =>
    changedLineIndex ? changedLineIndex.linesFor(file) : null;

  // D4: the manifest-untouched discriminator for `added` dep-vulns. A net-new
  // dependency vulnerability requires a manifest/lockfile change; when the diff
  // (baseline anchor → working tree, the same basis as the changed-line index)
  // touched none, the advisory was published AFTER baseline capture and the
  // classifier relabels the pair `newly_published_advisory` — attribution
  // honesty only, the verdict is unchanged. Consumes the ONE pack-declared
  // `changedFilesTouchDependencyManifest` — the same helper the ref-based
  // incremental dep-audit skip trusts (Rule 2.30 parity, pinned by
  // test/baseline/advisory-attribution.test.ts). Memoized: one `git diff` per
  // run, and only when an added dep-vuln pair actually asks. `null` changed
  // files (attribution unavailable) reads as UNKNOWN → no relabel.
  let manifestUntouchedMemo: boolean | undefined;
  const manifestUntouched = (): boolean => {
    if (manifestUntouchedMemo === undefined) {
      const changed = baseSha ? computeChangedFiles(cwd, baseSha) : null;
      manifestUntouchedMemo =
        changed !== null &&
        !changedFilesTouchDependencyManifest(changed, detectActiveLanguages(cwd));
    }
    return manifestUntouchedMemo;
  };

  // The PER-FINDING sibling of the fast path above (#283): when the diff DID
  // touch a manifest, an added dep-vuln whose package NO changed manifest
  // line mentions provably kept its resolution across the diff — the diff
  // did not change that package, so the advisory-feed attribution applies to
  // it exactly as it would under an untouched manifest. Conservative token
  // test: any mention (even a substring inside a longer name) reads as
  // "possibly changed" and keeps developer attribution — a demotion needs
  // decisive absence. Memoized: one content-line diff over the changed
  // manifests per run, only when an added dep-vuln pair under a touched
  // manifest actually asks. `null` (attribution unavailable) → no demotion.
  let manifestDiffLinesMemo: ReadonlyArray<string> | null | undefined;
  const packageUntouchedByDiff = (pkg: string): boolean => {
    if (manifestDiffLinesMemo === undefined) {
      const changed = baseSha ? computeChangedFiles(cwd, baseSha) : null;
      manifestDiffLinesMemo =
        changed === null
          ? null
          : changedContentLines(
              cwd,
              baseSha,
              dependencyManifestFilesIn(changed, detectActiveLanguages(cwd)),
            );
    }
    if (manifestDiffLinesMemo === null || pkg.length === 0) return false;
    const needle = pkg.toLowerCase();
    return !manifestDiffLinesMemo.some((line) => line.toLowerCase().includes(needle));
  };

  // Derived-membership attribution (the #25 class): for a kind whose per-file
  // finding set is computed from repo-global signals (DERIVED_MEMBERSHIP_KINDS
  // — today test-gap), an `added` finding keeps developer attribution only
  // when its FILE was added by the diff. Same diff basis as everything above
  // (baseline anchor → working tree). Memoized: one `git diff --diff-filter=A`
  // per run, and only when an added derived-membership pair actually asks.
  // `null` (attribution unavailable) reads as UNKNOWN → no demotion.
  let addedFilesMemo: ReadonlySet<string> | null | undefined;
  const addedFiles = (): ReadonlySet<string> | null => {
    if (addedFilesMemo === undefined) {
      addedFilesMemo = baseSha ? computeAddedFiles(cwd, baseSha) : null;
    }
    return addedFilesMemo;
  };

  // Removed-direction attribution (Rule 19, 4.3.2): the ONE answer to "did the
  // current side actually observe this prior entry's check?". A `removed` pair
  // whose check the run never observed (skipped: untrusted tree / unmet
  // environment / unavailable tool / timeout — or the whole gather scoped out)
  // reclassifies `not_observed` instead of rendering "resolved". The shipped
  // class: an --untrusted PR check skipped lint, diffed a baseline holding the
  // repo's 18,406-finding lint backlog against a current side holding zero,
  // and reported all of it as Resolved with no disclosure.
  const ccUnobserved = current.customChecksUnobserved;
  const unobservedByCheck = ccUnobserved.gathered
    ? new Map(ccUnobserved.checks.map((c) => [c.name, describeCheckSkip(c)]))
    : undefined;
  // The incremental scope: when the code-pattern scan was restricted to the
  // changed files, a code finding outside that set was never looked at.
  const incrementalScope =
    current.incrementalScope !== undefined ? new Set(current.incrementalScope) : undefined;
  const notObservedReasonFor = (entry: BaselineEntry): string | undefined => {
    if (entry.kind === 'custom-check') {
      // The seam records its own observation (scope-skip AND per-check
      // runtime skips) — the one source for this kind.
      if (!ccUnobserved.gathered) return ccUnobserved.reason;
      // A sanitized entry carries no check name, and per-check skip attribution
      // needs one — it stays `removed` (bias toward the false negative, the
      // benign-module discipline: never suppress a real resolution claim we
      // cannot disprove). The whole-gather branch above still covers it.
      if (!('check' in entry)) return undefined;
      const skip = unobservedByCheck!.get(entry.check);
      return skip !== undefined ? `check "${entry.check}" ${skip}` : undefined;
    }
    return kindNotObservedReason(entry.kind, {
      mode: mode.mode,
      scope,
      provenance: current.aggregate.provenance,
      incrementalScope,
      ...('file' in entry && 'tool' in entry
        ? { locus: { file: entry.file, tool: entry.tool } }
        : {}),
    });
  };

  const classifiedPairs: ClassifiedPair[] = [];
  let blocks = false;
  let warns = false;
  for (const pair of matchResult.pairs) {
    const anchorEntry =
      (pair.currentId ? currentById.get(pair.currentId) : undefined) ??
      (pair.priorId ? priorById.get(pair.priorId) : undefined);
    if (!anchorEntry) continue;

    const severity =
      (pair.currentId ? severityByCurrentId.get(pair.currentId) : undefined) ??
      KIND_DEFAULT_SEVERITY[anchorEntry.kind];

    const file = locatorFile(anchorEntry);
    const line = locatorLine(anchorEntry);
    const locator = describeEntryLocation(anchorEntry);
    // `null` (attribution unavailable) maps to `undefined` — UNKNOWN must not
    // demote (classify only demotes on a strict `false`). An untracked file
    // ('all') overlaps at every line: the whole file is this change's work.
    const changedInFile = file !== undefined ? linesChangedFor(file) : null;
    const overlapsChangedLines =
      file !== undefined && line !== undefined && line > 0 && changedInFile !== null
        ? changedInFile === 'all' || changedInFile.has(line)
        : undefined;

    const kindDrift = pair.status === 'added' ? driftByKind.get(anchorEntry.kind) : undefined;
    const configDiffers =
      pair.status === 'added' &&
      (envelopeDrift.configHashChanged ||
        envelopeDrift.ignoreHashChanged ||
        envelopeDrift.policyHashChanged);
    // The finding's file was added/modified by this diff → developer-introduced,
    // so it outranks config_drift (a coincident policy.json edit must not
    // re-label a net-new finding on a new file). Non-empty changed-line set = the
    // file is in the diff (a brand-new file has all its lines added).
    const fileChangedInDiff =
      changedInFile !== null && (changedInFile === 'all' || changedInFile.size > 0);
    // Dimension newly measured: the baseline held no findings of this kind, so
    // this one is unmatched because the gate/dimension was just enabled — a
    // truer reason than generic config_drift (gh #157). Reason-only.
    const kindAbsentFromBaseline = pair.status === 'added' && !baselineKinds.has(anchorEntry.kind);

    const malicious =
      pair.currentId !== undefined && maliciousByCurrentId.has(pair.currentId) ? true : undefined;
    const reachable =
      pair.currentId !== undefined && reachableByCurrentId.has(pair.currentId) ? true : undefined;

    // Derived-membership kinds: was this finding's file ADDED by the diff?
    // Only asked for added pairs of a declared kind, so runs with none never
    // pay the git diff. `null` added-set (attribution unavailable) leaves the
    // flag ABSENT — unknown never demotes.
    const derivedMembership =
      pair.status === 'added' && DERIVED_MEMBERSHIP_KINDS.has(anchorEntry.kind);
    const added = derivedMembership && file !== undefined ? addedFiles() : null;
    const fileAddedInDiff = added !== null ? added.has(file!) : undefined;

    // Only a `removed` pair can be a not-observed candidate: an unobserved
    // check produces no current findings, so no other pair status exists.
    const notObserved = pair.status === 'removed' ? notObservedReasonFor(anchorEntry) : undefined;

    // The declared block intent of a custom-check finding, feeding the
    // `newBlockingCustomCheckFailure` rule. Sanitized entries carry no
    // intent — the flag stays absent and the rule never fires on them.
    const customCheckBlocking =
      anchorEntry.kind === 'custom-check' && !isSanitized(anchorEntry)
        ? anchorEntry.blocking
        : undefined;

    const context: ClassifyContext = {
      severity,
      kind: anchorEntry.kind,
      ...(kindDrift
        ? { recallDrifted: true, recallDriftDetail: describeRecallDrift(kindDrift) }
        : {}),
      ...(configDiffers ? { configDiffers: true } : {}),
      ...(fileChangedInDiff ? { fileChangedInDiff: true } : {}),
      ...(kindAbsentFromBaseline ? { kindAbsentFromBaseline: true } : {}),
      ...(overlapsChangedLines !== undefined ? { overlapsChangedLines } : {}),
      ...(derivedMembership ? { derivedMembership: true } : {}),
      ...(fileAddedInDiff !== undefined ? { fileAddedInDiff } : {}),
      ...(malicious ? { malicious } : {}),
      ...(reachable ? { reachable } : {}),
      ...(customCheckBlocking !== undefined ? { customCheckBlocking } : {}),
      ...(notObserved !== undefined ? { notObserved } : {}),
      // Only asked for added dep-vuln pairs, so a run with none never pays the
      // git diff (and other kinds never see the flags). Two tiers of the ONE
      // attribution question (#283): the run-level fast path (no manifest
      // touched at all), then the per-finding fallback (manifests touched,
      // but no changed manifest line mentions THIS package).
      ...(anchorEntry.kind === 'dep-vuln' && pair.status === 'added'
        ? manifestUntouched()
          ? { manifestUntouched: true }
          : // A sanitized entry carries no package name — per-finding
            // attribution then has no subject and the pair keeps `added`
            // (bias toward the conservative claim, never a blind demotion).
            'package' in anchorEntry && packageUntouchedByDiff(anchorEntry.package)
            ? { packageUntouchedByDiff: true }
            : {}
        : {}),
    };

    // `classify` is kind-agnostic; fold in the custom-check block INTENT (a
    // net-new finding from a `blocking: false` check warns instead of blocks)
    // into the ONE classification object, so the main verdict AND the
    // `--changed-only` re-derivation (pairBlocks, which reads `p.classification`)
    // stay consistent (Rule 2).
    const classification = applyCustomCheckIntent(anchorEntry, classify(pair, policy, context));

    // Allowlist suppression: consulted for any pair that would BLOCK or WARN. An
    // active entry matching this finding's fingerprint (and kind, to rule out an
    // astronomically-unlikely cross-kind hash collision) waives it from the
    // verdict — a reviewed-and-accepted finding drops out of the warning list
    // too, not just the block list (a warning-class pair used to keep warning
    // forever because suppression was gated on `blocks` alone). Expired entries
    // are skipped here so the finding re-surfaces the moment its window lapses.
    const suppressedByAllowlist =
      (classification.blocks || classification.warns) && allowlist
        ? allowlistSuppressionFor(allowlist, anchorEntry, input.now)
        : undefined;

    const effectiveBlocks = classification.blocks && suppressedByAllowlist === undefined;
    if (effectiveBlocks) blocks = true;
    if (classification.warns && suppressedByAllowlist === undefined) warns = true;

    classifiedPairs.push({
      pair,
      classification,
      severity,
      kind: anchorEntry.kind,
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(locator ? { locator } : {}),
      ...(overlapsChangedLines !== undefined ? { overlapsChangedLines } : {}),
      ...(suppressedByAllowlist !== undefined ? { suppressedByAllowlist } : {}),
    });
  }

  return { pairs: classifiedPairs, blocks, warns, priorById, notObservedReasonFor };
}
