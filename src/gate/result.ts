/**
 * The gate engine's result shape.
 *
 * `GuardrailCheckResult` (the name predates the engine extraction and is
 * kept — it is re-exported from `src/baseline/check.ts`, the stable
 * import surface every existing consumer uses) is what `runGate`
 * returns for every surface. Verdict + exit-code derivation live in ONE
 * place downstream — `verdictCounts` in `src/baseline/check-renderers.ts`
 * — never here and never in a consumer.
 */

import type { CurrentScan } from '../baseline/create';
import type { BaselineFile, DeferredCaptureClass } from '../baseline/baseline-file';
import type { ResolvedMode } from '../baseline/modes';
import type { BrownfieldPolicy } from '../baseline/policy';
import type { ClassifyResult } from '../baseline/classify';
import type { BaselineEntry, FindingSeverity, MatchPair, MatchResult } from '../baseline/types';
import type { CoverageDrift } from '../baseline/coverage';
import type { RecallDrift } from '../baseline/recall';
import type { AttributionGap } from '../baseline/attribution-gap';
import type { RequiredObservationGap } from './required-observation';
import type { ExpiryProjection } from '../baseline/expiry-projection';
import type { FlowGateOutcome } from '../baseline/flow-gate-check';
import type { SchemaDriftGateOutcome } from '../baseline/schema-drift-gate-check';
import type { DupGateOutcome } from '../baseline/dup-gate-check';
import type { PairedGateOutcome } from '../baseline/paired-gate-check';
import type { BaselineSuspect } from '../baseline/provenance';
import type { AllowlistDelta } from '../allowlist/diff';
import type { AllowlistSuppression } from '../baseline/allowlist-match';

/**
 * Per-pair entry the CLI renderers consume. Carries the raw
 * `MatchPair`, the classifier verdict, and enough context to render
 * a meaningful diagnostic (which side the entry lives on, kind,
 * severity, file/line locator).
 */
export interface ClassifiedPair {
  readonly pair: MatchPair;
  readonly classification: ClassifyResult;
  /** Resolved severity (or undefined when the pair has no current-
   *  side entry to attribute to — `removed` pairs typically). */
  readonly severity?: FindingSeverity;
  /** Kind of the pair's anchor entry (prior for `removed`, current
   *  for everything else). */
  readonly kind: BaselineEntry['kind'];
  /** Locator info for renderers — populated when the anchor entry
   *  carries `file` / `line`. */
  readonly file?: string;
  readonly line?: number;
  /** Human location descriptor for finding tables — kind-aware, computed once
   *  from the anchor entry. `file:line` for located kinds; `package@version ·
   *  advisory-id` for dep-vulns (which have no file:line — the reason a
   *  dep-vuln row used to render `Location: —`). Absent for locator-less
   *  kinds with no meaningful descriptor. */
  readonly locator?: string;
  /** True when the anchor entry's line falls inside the diff
   *  between baseline and HEAD. Undefined when the pair has no
   *  line locator (dep-vuln, etc.) or when git history isn't
   *  reachable. Drives `--changed-only` filtering and the
   *  `newSevereQualityIssueInChangedFiles` / `newUntestedChangedSource`
   *  block rules. */
  readonly overlapsChangedLines?: boolean;
  /** Present when an active (unexpired) allowlist entry matches this
   *  finding's fingerprint AND the classifier would otherwise block.
   *  The block is waived; this field records WHY so renderers can
   *  show the reviewed-and-accepted rationale instead of silently
   *  dropping the finding. Expired entries never populate this — the
   *  finding re-blocks and the stale entry is surfaced for pruning. */
  readonly suppressedByAllowlist?: AllowlistSuppression;
}

export interface EnvelopeDrift {
  readonly toolchainHashChanged: boolean;
  readonly policyHashChanged: boolean;
  readonly ignoreHashChanged: boolean;
  readonly configHashChanged: boolean;
  readonly dxkitVersionChanged: boolean;
  /** Per-tool version drift. Empty when `tools` maps agree. Reporting only —
   *  attribution reads `recallDrift`, which knows WHICH kind each input
   *  affects. */
  readonly toolVersionDiffs: ReadonlyArray<{
    readonly tool: string;
    readonly baselineVersion: string | undefined;
    readonly currentVersion: string | undefined;
  }>;
  /** Kinds that cannot be attributed this run (CLAUDE.md Rule 19): dxkit or the
   *  environment changed what the kind can SEE since the baseline, so its delta
   *  has an explanation other than "the developer introduced it". Their net-new
   *  findings warn instead of blocking, and every renderer says why. Filtered
   *  to kinds with findings on at least one side — drift with nothing to
   *  misattribute is not worth reporting. */
  readonly recallDrift: ReadonlyArray<RecallDrift>;
  /** The baseline's capture provenance (4.2): drives the drift REMEDY. A
   *  locally captured baseline drifting is the machine-dependent flavor whose
   *  root fix is the CI-canonical re-capture; renderers lead there instead of
   *  a local `--force`. Absent on pre-4.2 baselines (unknown provenance). */
  readonly baselineCapturedIn?: 'ci' | 'local';
  /** Whether the CI baseline-refresh workflow is installed (the provenance
   *  module's one probe). Drives the drift/attribution-gap REMEDY: a repo
   *  with the lane is pointed at a CI re-capture, never at the local
   *  `--force` anti-pattern the docs warn about. */
  readonly refreshLaneInstalled?: boolean;
  /** Scanners whose availability flipped between baseline capture and
   *  this check. A tool missing at baseline but present now means the
   *  baseline never covered that category — its findings surface as new
   *  rather than pre-existing. Empty when coverage agrees (or when the
   *  baseline predates the coverage record). */
  readonly coverageDrift: ReadonlyArray<CoverageDrift>;
}

/** How the committed prior side was obtained under the `branch` anchor
 *  transport (D4d). `anchor` = read fresh from the side branch (the intended
 *  path — the footer's baseline SHA is the anchor's). `tree-fallback` = the
 *  side branch was unreachable and the check gated against the possibly-stale
 *  tree copy. The fallback stays fail-open, but it is DISCLOSED: in the #375
 *  incident nothing in the output said which file loaded, so an inert branch
 *  transport was invisible (the GateFailure discipline — fail open, always say
 *  why). */
export interface AnchorSourceDisclosure {
  readonly used: 'anchor' | 'tree-fallback';
  readonly anchorRef: string;
  readonly note: string;
}

/**
 * One unobserved slice of the baseline: a check (or a scoped-out gather) the
 * current run never executed, with how many committed baseline findings that
 * leaves un-re-verified. The aggregate the renderers print INSTEAD of listing
 * the pairs — see `GuardrailCheckResult.notObserved`.
 */
export interface NotObservedDisclosure {
  /** Finding kind of the unobserved entries (today always `custom-check`). */
  readonly kind: BaselineEntry['kind'];
  /** The shared human phrasing of why (embeds the check name), identical to
   *  the per-pair reason detail — one phrasing, both surfaces. */
  readonly reason: string;
  /** Baseline findings not re-verified under this reason. */
  readonly count: number;
}

export interface GuardrailCheckResult {
  /** Pre-resolved baseline mode (which path produced `baseline`).
   *  Carries the audit trail (CLI / policy / auto-detect) so the
   *  CLI surface can log WHY the mode was picked. */
  readonly mode: ResolvedMode;
  /** Present only when the anchor transport is `branch` (D4d disclosure). */
  readonly anchorSource?: AnchorSourceDisclosure;
  /** On-disk path of the baseline file, or undefined when mode is
   *  `ref-based` (the prior side was computed from a git ref, not
   *  read from a committed file). */
  readonly baselinePath?: string;
  readonly baseline: BaselineFile;
  readonly current: CurrentScan;
  readonly matchResult: MatchResult;
  readonly pairs: ReadonlyArray<ClassifiedPair>;
  readonly envelopeDrift: EnvelopeDrift;
  readonly policy: BrownfieldPolicy;
  /** True when at least one classified pair blocks. Exit-code and verdict
   *  derivation live in ONE place — `verdictCounts` in `check-renderers.ts` —
   *  which also consumes `attributionGaps`; never map this field to an exit
   *  code directly. */
  readonly blocks: boolean;
  /** True when at least one pair warns. Informational; doesn't
   *  affect exit code by itself. */
  readonly warns: boolean;
  /**
   * Kinds whose block-rule-class findings could not be attributed this run
   * (recall drift demoted them out of block-rule reach — CLAUDE.md Rule 19).
   * REQUIRED, and consumed by the one verdict derivation: while a gap exists
   * the run cannot render PASSED — it refuses (`CANNOT GATE`, exit 1) and
   * names the evidence + remedy, the same treatment the identity-scheme
   * mismatch gets. Empty on a healthy run. See `src/baseline/attribution-gap.ts`.
   */
  readonly attributionGaps: ReadonlyArray<AttributionGap>;
  /**
   * Policy-declared REQUIRED checks whose observation is missing this run
   * (4.4.1 WP1, strategy §7.1 — the observation sibling of
   * `attributionGaps`). REQUIRED, and consumed by the one verdict
   * derivation: while a gap exists the run cannot render PASSED — it
   * refuses (`CANNOT GATE`) and names the missing evidence + remedy.
   * Empty for every policy that declares no `required: true` check (all
   * pre-4.4.1 policies), so existing repos see no behavior change. ONE
   * evaluator: `src/gate/required-observation.ts`. The floor's own gap is
   * surface-owned (`GateCommandOutcome.floorRequiredGap`) — the engine
   * does not run the floor.
   */
  readonly requiredNotObserved: ReadonlyArray<RequiredObservationGap>;
  /** Present when the ADDED-finding pattern matches the stale-anchor
   *  signature (most net-new findings in files the diff never touched —
   *  #222). Disclosure only: reframes a mechanically-correct BLOCKED as
   *  "baseline suspect" with the workflow-aware re-anchor remedy. */
  readonly baselineSuspect?: BaselineSuspect;
  /**
   * What this run's ACTIVE allowlist suppressions will do when their windows
   * expire — how many will block, how many will warn, and how soon. REQUIRED so
   * a new surface cannot render the check without the projection existing; it
   * never affects the verdict or the exit code (expiry is already the forcing
   * function, and blaming an author for someone else's lapsing deferral would be
   * a false block). Empty `lapsing` on the overwhelming majority of runs, in
   * which case renderers print nothing. See `src/baseline/expiry-projection.ts`.
   */
  readonly suppressionExpiry: ExpiryProjection;
  /**
   * Baseline findings the CURRENT side never re-verified, aggregated per
   * unobserved check (Rule 19's REMOVED direction, 4.3.2). Their pairs are
   * classified `not_observed` — excluded from the resolved tally and from
   * per-finding tables — and every renderer prints one disclosure line per
   * entry here ("check X skipped (untrusted tree) — N baseline findings not
   * re-verified this run"). REQUIRED so a renderer cannot be written without
   * deciding what to do with it; empty on the overwhelming majority of runs.
   * Never affects the verdict: an unobserved backlog is neither the
   * developer's regression nor their fix.
   */
  readonly notObserved: ReadonlyArray<NotObservedDisclosure>;
  /** Allowlist entries added / removed between the baseline's
   *  commit SHA and the current working tree. Renderers (the PR
   *  comment markdown in particular) surface this so reviewers
   *  see new suppressions being introduced. Absent when the
   *  baseline SHA wasn't reachable to diff against. */
  readonly allowlistDelta: AllowlistDelta;
  /** Kinds dropped from the diff because the resolved mode can't gather
   *  them comparably on the prior side. Populated only in `ref-based`
   *  mode: `duplication` + `test-gap` depend on build artifacts (jscpd's
   *  `node_modules`, the coverage report) that don't exist in a detached
   *  worktree, so the prior side systematically under-produces them and a
   *  naive diff would flag the entire current set as net-new. They're
   *  excluded from BOTH sides instead; this records what was dropped so
   *  renderers can disclose "not gated in ref-based mode — use
   *  committed-full to gate these." Empty in committed modes. */
  readonly refExcludedKinds: ReadonlyArray<{
    readonly kind: BaselineEntry['kind'];
    readonly currentCount: number;
  }>;
  /** Finding classes the committed baseline's capture environment could not
   *  observe (CLAUDE.md Rule 20 applied to capture) — read from
   *  `baseline.deferred`. Non-empty ⇒ the baseline is INCOMPLETE by
   *  construction (a stale mirror couldn't install a scanner, a wrong-host
   *  build gate), so the renderers surface an arming banner ("completing on CI
   *  — not yet gating") rather than certifying a class that never ran. Does NOT
   *  change the exit code: the deferred classes are demoted to warn by the
   *  recall mechanism (Rule 19 — absent/divergent recall), never false-blocked;
   *  this field only makes the incompleteness LOUD instead of silently green
   *  (the incident: a partial baseline that read as fully gated). Empty/absent
   *  in ref-based mode (no committed baseline to complete) and on a complete
   *  capture. */
  readonly deferredCapture?: ReadonlyArray<DeferredCaptureClass>;
  /** The flow integration-gate pass — an additive, fail-open layer that flags
   *  net-new UI→API breakage from a base↔HEAD contract diff. Runs in BOTH
   *  modes (the base commit is the resolved ref in ref-based mode, the
   *  committed baseline's anchor SHA in committed modes); `undefined` only
   *  when no base commit is resolvable at all. Its `blocks` / `warns` are
   *  folded into the top-level verdict above. Renderers surface `findings`
   *  alongside the matched pairs. */
  readonly flowGate?: FlowGateOutcome;
  /** The model-schema drift-gate pass — additive + fail-open like the flow
   *  gate, diffing declared data models across the same base↔HEAD pair.
   *  Opt-in (`.dxkit/policy.json:schema.mode`, default off); `undefined`
   *  when off or when no base commit is resolvable. */
  readonly schemaDriftGate?: SchemaDriftGateOutcome;
  /** The structural-duplicate (seam) gate pass — additive + fail-open like the
   *  flow gate, diffing the duplicate-pair set across the same base↔HEAD pair.
   *  Opt-in (`.dxkit/policy.json:duplication.mode`, default off — it builds the
   *  code graph); `undefined` when off or when no base commit is resolvable. A
   *  lone duplicate only ever warns; convergence (downstream) can escalate. */
  readonly dupGate?: DupGateOutcome;
  /** The paired-change gate pass — additive + fail-open like its three
   *  siblings, evaluating declared "changing X requires also changing Y"
   *  rules (`.dxkit/policy.json:pairedChecks`) against the changed-path set.
   *  Pure (no spawn, no worktree), so it runs on every surface including
   *  untrusted PRs and in ref-based mode. Opt-in (default off — no rules);
   *  `undefined` when off or when no base commit is resolvable. */
  readonly pairedGate?: PairedGateOutcome;
  /**
   * Present when the repo has the PR-comment defer workflow installed
   * (`/dxkit defer …` typed by a reviewer with write access). The markdown
   * renderer reads it to print a copy-pasteable reply hint under blocking
   * dependency advisories — the lane exists precisely for that moment, and a
   * reviewer staring at a blocked PR should not have to know the grammar by
   * heart. Detected through the ONE managed-surface registry (Rule 15), never
   * a second workflow-path literal. Absent ⇒ no hint (a dead hint teaches
   * people commands that do nothing).
   */
  readonly commentDeferInstalled?: true;
  /** Set when the CURRENT dependency-vulnerability scan could not run — the
   *  scanner was absent / timed out / failed — AND the scan was actually
   *  REQUESTED this run (not incrementally skipped because no manifest changed,
   *  and not a stack with nothing to scan). A silent zero dep-vulns then does
   *  NOT mean "no net-new dep vulns", so renderers surface this prominently: the
   *  pass is not a clean bill of dependency health. `undefined` when the audit
   *  ran or was legitimately not requested. */
  readonly depVulnsUnmeasured?: { readonly reason: string };
}
