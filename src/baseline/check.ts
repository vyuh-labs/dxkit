/**
 * `dxkit guardrail check` orchestrator.
 *
 * The matcher (`gitAwareMatch`) and classifier (`classify`) are pure
 * modules that already exist. This file wires them together with the
 * baseline file format, the producer pipeline, and the per-pair
 * context lookups (severity, drift signals, changed-line overlap)
 * the classifier needs to make policy decisions.
 *
 * Pipeline:
 *
 *   1. Load the prior baseline file.
 *   2. Re-run every analyzer (via `gatherCurrentScan`) to produce the
 *      current side of the diff.
 *   3. Convert both sides to `LocatedIdentity[]` and run the
 *      git-aware matcher.
 *   4. Build per-pair classify context:
 *        - severity from the current security aggregate or per-kind
 *          defaults
 *        - kind from the matched BaselineEntry
 *        - recallDrifted from per-kind recall compare (Rule 19)
 *        - configDiffers from envelope hash compare
 *        - overlapsChangedLines from `git diff base..HEAD` hunks
 *          intersected with the finding's line
 *   5. Run the brownfield policy classifier over every pair.
 *   6. Optionally filter via `--changed-only`: drop pairs whose
 *      locator falls outside the diff. Non-locator pairs (dep-vuln,
 *      duplication, etc.) are always kept — their "semantic"
 *      identity doesn't map cleanly to changed lines.
 *   7. Compose a `GuardrailCheckResult` with a deterministic
 *      blocks/warns verdict so the CLI can pick exit code + render.
 *
 * Drift signals come from comparing the baseline's `analysis` /
 * `tools` envelope against the freshly-gathered envelope.
 *
 * Per-kind attribution (CLAUDE.md Rule 19) compares the producer-declared
 * `recall` contexts, kind by kind: unequal ⇒ that kind's delta has an
 * explanation other than "the developer introduced it", so its net-new
 * findings warn instead of blocking and every renderer says which input moved.
 * This REPLACED a hardcoded kind→tool table here, whose five entries silently
 * excluded every other kind — `custom-check` among them, which is why a lint
 * finding could never be attributed to a tool change no matter how the
 * producer side was fixed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { dxkitCli } from '../self-invocation';
import { isMaliciousAdvisory } from '../analyzers/security/malicious';
import { gatherCurrentScan, scanToBaselineFile } from './create';
import type { CurrentScan } from './create';
import { DEFAULT_BASELINE_NAME, pathForBaseline, readBaselineFile } from './baseline-file';
import type { BaselineFile, DeferredCaptureClass } from './baseline-file';
import { diffCoverage } from './coverage';
import type { CoverageDrift } from './coverage';
import { entriesToLocated } from './entry-to-located';
import { gitAwareMatch } from './git-aware-match';
import type { LocatedIdentity } from './git-aware-match';
import { DEFAULT_ANCHOR_REF, resolveBaselineMode } from './modes';
import type { ResolvedMode } from './modes';
import { resolvePolicy, loadPolicyFromCwd } from './policy';
import { classify } from './classify';
import type { BrownfieldPolicy, BaselineSection } from './policy';
import type { ClassifyContext, ClassifyResult } from './classify';
import { hydrateAnchorFromBranch, loadAnchorFromBranch } from './anchor';
import { gatherFromRef } from './ref-baseline';
import { type GatherScope, FULL_SCOPE, scopeForPolicy, scopeForRefBasedDiff } from './gather-scope';
import { computeChangedFiles, createChangedLineIndex } from './changed-files';
import { changedFilesTouchDependencyManifest, detectActiveLanguages } from '../languages';
import { describeRecallDrift, diffRecall } from './recall';
import type { RecallDrift } from './recall';
import { collectAttributionGaps } from './attribution-gap';
import type { AttributionGap } from './attribution-gap';
import { evaluateFlowGateForGuardrail } from './flow-gate-check';
import type { FlowGateOutcome } from './flow-gate-check';
import { evaluateSchemaDriftGateForGuardrail } from './schema-drift-gate-check';
import type { SchemaDriftGateOutcome } from './schema-drift-gate-check';
import { evaluateDupGateForGuardrail } from './dup-gate-check';
import type { DupGateOutcome } from './dup-gate-check';
import type { DuplicationGateMode } from '../analyzers/duplication/config';
import type { SchemaGateMode } from '../analyzers/model-schema/config';
import type { FlowGateMode } from '../analyzers/flow/config';
import { isSanitized } from './sanitize';
import type { BaselineEntry, FindingId, FindingSeverity, MatchPair, MatchResult } from './types';
import { CURRENT_IDENTITY_SCHEME } from './types';
import type { SecurityAggregate } from '../analyzers/security/aggregator';
import {
  computeAllowlistDelta,
  resolveAllowlistDeltaBase,
  type AllowlistDelta,
} from '../allowlist/diff';
import { resolveEffectiveAllowlist } from '../allowlist/effective';
import {
  allowlistSuppressionFor,
  entryToAllowlistable,
  type AllowlistSuppression,
} from './allowlist-match';

export interface RunGuardrailCheckOptions {
  /** Repo root being checked. Caller should pass an absolute path. */
  readonly cwd: string;
  /** Baseline name to read from `.dxkit/baselines/<name>.json`.
   *  Defaults to `'main'`. */
  readonly name?: string;
  /** Explicit baseline file path. Overrides `name` when supplied —
   *  lets callers diff against a baseline stored outside the default
   *  directory (e.g. an artifact downloaded from CI). */
  readonly baselinePath?: string;
  /** When true, drop pairs whose locator falls outside the diff.
   *  Non-locator findings (dep-vuln, duplication, etc.) are always
   *  kept. */
  readonly changedOnly?: boolean;
  /** Path to a `.dxkit/policy.json` override. The on-disk shape
   *  matches `BrownfieldPolicy` (modulo readonly markers); unknown
   *  fields are preserved but not type-checked here — the policy
   *  classifier reads only the fields it knows. When omitted, a
   *  `<cwd>/.dxkit/policy.json` is auto-loaded if it exists; otherwise
   *  the compiled-in defaults apply. */
  readonly policyPath?: string;
  /** Pre-resolved policy override. When supplied, the orchestrator uses
   *  it verbatim and skips disk resolution (`policyPath` /
   *  `.dxkit/policy.json`). This is the seam the loop Stop-gate uses to
   *  inject its loop-scoped preset policy (see
   *  `src/loop/policy.ts:resolveLoopPolicy`) WITHOUT changing what the
   *  CI guardrail resolves. CI / `baseline check` never set this. */
  readonly policy?: BrownfieldPolicy;
  /** Forwarded to the underlying analyzers for per-tool timing logs. */
  readonly verbose?: boolean;
  /** Pre-resolved baseline mode. When supplied, the orchestrator
   *  skips its own resolution. Callers wanting deterministic
   *  behavior (tests, agents) pass this. */
  readonly resolvedMode?: ResolvedMode;
  /** Explicit CLI flag value for the mode (`--mode=<X>`). Forwarded
   *  to `resolveBaselineMode`. Ignored when `resolvedMode` is
   *  supplied. */
  readonly cliMode?: ResolvedMode['mode'];
  /** Explicit CLI flag value for the ref (`--ref=<R>`). Only
   *  consulted when the resolved mode is `ref-based`. */
  readonly cliRef?: string;
  /**
   * Restrict both sides of the gather to the analyzers a scope needs.
   * Defaults to `FULL_SCOPE`, so CI / `baseline check` gather everything
   * and still render every warning. The loop Stop-gate passes a
   * policy-derived scope (`scopeForPolicy`) so a `security-only` posture
   * skips the analyzers it can never block on. Both the current side and
   * the ref side are scoped identically so the cross-run diff stays
   * balanced. Opt-in by construction: only callers that pass a scope
   * change what is gathered.
   */
  readonly scope?: GatherScope;
  /**
   * Incremental scanning (opt 3): when true, semgrep scans only files that
   * changed vs the comparison base, instead of the whole tree. Sound for a
   * net-new gate (semgrep is intraprocedural — a net-new code finding only
   * appears in a changed file). Scope by mode:
   *   - committed: only the CURRENT side is scoped (the prior side is the
   *     on-disk, already-full baseline), against the baseline's commit.
   *   - ref-based: the changed set is fully computable (`diff(ref, HEAD)`),
   *     so BOTH the ref side and the current side are scoped to the SAME
   *     set, keeping the cross-run diff symmetric. This makes a ref-based
   *     guardrail (CI, pre-push, the hosted PR gate) scale with PR size
   *     rather than repo size.
   * Falls back to a full scan when the changed set can't be computed
   * completely. Opt-in: the loop Stop-gate sets it, and `guardrail check
   * --incremental` exposes it on the CLI; otherwise it stays false so the
   * full report is unaffected.
   */
  readonly incremental?: boolean;
  /**
   * Treat the scanned source as untrusted (a hosted PR gate on
   * attacker-controlled code): dependency audits must not execute it. The
   * Python pack drops `pip-audit .` project mode (its build backend can run
   * code) and audits only a requirements file. Exposed as
   * `guardrail check --untrusted`; off by default (trusted local runs and the
   * loop on your own repo keep full coverage).
   */
  readonly untrusted?: boolean;
  /**
   * Loop-seam override for the flow integration gate's posture (`block` /
   * `warn` / `off`), winning over `.dxkit/policy.json:flow.mode`. The loop
   * Stop-gate derives it from the active preset (`security-only` → `warn`,
   * `full-debt` → `block`) so an unattended loop doesn't wedge on a cross-repo
   * integration false positive, while CI / `guardrail check` (which don't set
   * it) honor the repo's configured mode. The gate runs only in ref-based mode
   * regardless.
   */
  readonly flowMode?: FlowGateMode;
  /**
   * Loop-seam override for the model-schema drift gate's posture, mirroring
   * `flowMode` with one difference: schema defaults to OFF (opt-in), so the
   * override softens/hardens an enabled gate but never activates one the
   * repo did not configure.
   */
  readonly schemaMode?: SchemaGateMode;
  /**
   * Loop-seam override for the structural-duplicate (seam) gate's posture,
   * mirroring `schemaMode`: the seam gate defaults to OFF (opt-in — it builds
   * the code graph), so the override softens/hardens an enabled gate but never
   * activates one the repo did not configure.
   */
  readonly duplicationMode?: DuplicationGateMode;
}

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
  /** Set when the CURRENT dependency-vulnerability scan could not run — the
   *  scanner was absent / timed out / failed — AND the scan was actually
   *  REQUESTED this run (not incrementally skipped because no manifest changed,
   *  and not a stack with nothing to scan). A silent zero dep-vulns then does
   *  NOT mean "no net-new dep vulns", so renderers surface this prominently: the
   *  pass is not a clean bill of dependency health. `undefined` when the audit
   *  ran or was legitimately not requested. */
  readonly depVulnsUnmeasured?: { readonly reason: string };
}

/**
 * Finding kinds that cannot be gathered comparably from a detached git
 * worktree, so ref-based mode must not diff them. `duplication` runs
 * jscpd, which needs the project's `node_modules`; `test-gap` reads the
 * coverage report — neither exists in a bare `git worktree add` checkout.
 * The prior (worktree) side therefore under-produces these systematically
 * while the current (working-tree) side produces them in full, so a
 * straight diff reports the entire current set as net-new regressions.
 * Confirmed empirically: gathering the SAME commit via cwd vs a worktree
 * differed only here (duplication 15→0, test-gap 44→12). Excluded from
 * both sides in ref-based mode; committed-full (which captures them once
 * from a fully-provisioned tree) is the mode that gates them. (D-G4.)
 *
 * `secret-hmac` joins them for a different reason: it is an internal,
 * locator-less companion to each located `secret`, identified by a
 * salt-based HMAC of the secret value. The salt resolves from
 * `.dxkit/salt` / `DXKIT_BASELINE_SALT` / root-SHA, and on a fresh or
 * shallow checkout the two sides can derive different salts (the ref
 * worktree and the working tree need not share the salt source), so the
 * HMACs don't match across the diff and every companion reads as net-new —
 * a FALSE block, even though the located `secret` twins match fine. The
 * located `secret` kind still gates net-new credentials; the companion
 * exists only for cross-file relocation matching, which a committed salt
 * provides and ref-based does not. So it is matcher-assist only here and is
 * excluded from the ref-based diff.
 *
 * `custom-check` joins them for the same reason as `duplication`: the checks it
 * runs (linters, build-based analyzers, user commands) need the project's
 * toolchain — `node_modules`, a restored `dotnet`/gradle build — which a bare
 * `git worktree add` checkout does not have. The ref side would systematically
 * under-produce (every linter fail-open-skips for a missing binary) while the
 * working-tree side produces in full, so a straight diff would flag the whole
 * current set as net-new. Committed-full mode (which captures custom-check once
 * from a fully-provisioned tree) is the mode that gates it; ref-based excludes
 * it. (The loop Stop-gate + pre-push run in the working tree, so they gate it
 * fine via the committed baseline.)
 */
const REF_UNRELIABLE_KINDS: ReadonlySet<BaselineEntry['kind']> = new Set([
  'duplication',
  'test-gap',
  'secret-hmac',
  'custom-check',
]);

/**
 * Apply the ref-based-mode kind exclusion to both sides of the diff.
 *
 * In ref-based mode the prior side is gathered from a detached worktree
 * that can't produce the build-artifact-dependent kinds (REF_UNRELIABLE_KINDS),
 * so they're dropped from BOTH sides to keep the comparison symmetric —
 * otherwise the current side's full set has nothing to match against and
 * every one reads as a net-new regression. The dropped current-side counts
 * are returned for disclosure. In committed modes nothing is excluded.
 *
 * Pure + exported so the exclusion behavior is unit-testable without
 * driving the (slow, environment-dependent) gather pipeline.
 */
export function partitionForRefBasedDiff<T extends { readonly kind: BaselineEntry['kind'] }>(
  priorFindings: ReadonlyArray<T>,
  currentFindings: ReadonlyArray<T>,
  isRefBased: boolean,
): {
  diffablePrior: ReadonlyArray<T>;
  diffableCurrent: ReadonlyArray<T>;
  refExcludedKinds: GuardrailCheckResult['refExcludedKinds'];
} {
  if (!isRefBased) {
    return {
      diffablePrior: priorFindings,
      diffableCurrent: currentFindings,
      refExcludedKinds: [],
    };
  }
  const keep = (f: T): boolean => !REF_UNRELIABLE_KINDS.has(f.kind);
  const refExcludedKinds = [...REF_UNRELIABLE_KINDS]
    .map((kind) => ({
      kind,
      currentCount: currentFindings.filter((f) => f.kind === kind).length,
    }))
    .filter((e) => e.currentCount > 0);
  return {
    diffablePrior: priorFindings.filter(keep),
    diffableCurrent: currentFindings.filter(keep),
    refExcludedKinds,
  };
}

/** Canonical per-kind default severity (exported for the debt inventory —
 *  the one severity table, never a second copy). */
export const KIND_DEFAULT_SEVERITY: Readonly<Record<BaselineEntry['kind'], FindingSeverity>> =
  Object.freeze({
    secret: 'high',
    code: 'medium',
    config: 'medium',
    'dep-vuln': 'medium',
    duplication: 'medium',
    'coverage-gap': 'medium',
    'test-gap': 'medium',
    hygiene: 'low',
    'test-file-degradation': 'medium',
    'god-file': 'medium',
    'stale-file': 'low',
    'large-file': 'medium',
    'secret-hmac': 'high',
    // Stale-allow is a self-detected dxkit hygiene finding (orphaned
    // allowlist annotation). Low severity — it's a maintenance signal,
    // not an active risk; the underlying suppressed finding is already
    // gone.
    'stale-allow': 'low',
    // A net-new broken integration (a UI call that no longer resolves to a
    // served route, or a served route a consumer still binds to that a PR
    // removed). High severity — it is a runtime breakage the gate proves
    // statically, on par with a security regression.
    'flow-binding': 'high',
    // Net-new breaking schema drift (a field removed / type changed /
    // requiredness tightened on a declared data model). High severity — a
    // statically proven contract break, the same tier as flow-binding. The
    // additive/info classes never reach the guardrail as findings, so this
    // default speaks only for the breaking ones.
    'model-schema-drift': 'high',
    // A structural code-reimplementation (two functions the graph shows to be
    // the same routine written twice). Low severity — it is a maintainability /
    // slop signal surfaced warn-tier, not a correctness or security defect; its
    // block confidence comes only from seam CONVERGENCE (dup ∩ reliably-dead),
    // never from this default alone.
    'code-reimplementation': 'low',
    // A custom-check / lint failure. Severity is a neutral default — a custom
    // check's block intent is user/pack-declared (`entry.blocking`), NOT
    // severity-derived, so severity only feeds the confidence-threshold logic
    // for persisted pairs here, never the block decision.
    'custom-check': 'medium',
  });

/**
 * Run the guardrail-check pipeline. Pure-orchestrator: loads the
 * baseline, gathers current state, runs the matcher + classifier,
 * and returns a structured result. Renderers + CLI are downstream.
 */
export async function runGuardrailCheck(
  options: RunGuardrailCheckOptions,
): Promise<GuardrailCheckResult> {
  const cwd = path.resolve(options.cwd);
  // A pre-resolved `policy` (loop Stop-gate path) wins over disk
  // resolution; otherwise resolve from `--policy` / `.dxkit/policy.json`.
  const policy = options.policy ?? resolvePolicy(options.policyPath, cwd);
  const mode =
    options.resolvedMode ??
    resolveBaselineMode({
      cwd,
      cliMode: options.cliMode,
      cliRef: options.cliRef,
      policyMode: policy.baseline?.mode,
      policyRef: policy.baseline?.ref,
    });

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
  if (mode.mode === 'ref-based') {
    const adjusted = scopeForRefBasedDiff(gatherScope);
    gatherScope = adjusted.scope;
    refScopeSkippedKinds = adjusted.skippedKinds;
  }

  // Load the prior side. Committed modes read from the baseline
  // file on disk; ref-based mode recomputes prior state by checking
  // out a git ref into a temporary worktree. Both paths produce a
  // `BaselineFile`-shaped value so the matcher / classifier
  // downstream stay mode-agnostic.
  const { baseline, baselinePath, anchorSource } = await loadPriorSide(
    cwd,
    mode,
    options,
    refIncrementalFiles,
    gatherScope,
  );

  // A committed baseline minted under an older identity scheme cannot be
  // meaningfully diffed against the current one — every finding's id
  // changed, so the matcher would report all pre-existing findings as
  // net-new. Stop with an actionable message instead of that confusing
  // churn. (ref-based re-gathers the prior side with the current dxkit, so
  // it is always current-scheme and exempt; a baseline written before this
  // field existed reads as the original 'v1'.)
  if (mode.mode !== 'ref-based') {
    const baselineScheme = baseline.identityScheme ?? 'v1';
    if (baselineScheme !== CURRENT_IDENTITY_SCHEME) {
      throw new Error(
        `Baseline "${baseline.name}" was captured under finding-identity scheme ` +
          `${baselineScheme}, but this dxkit mints ${CURRENT_IDENTITY_SCHEME}. The identity ` +
          `scheme changed between versions; diffing across schemes would flag every existing ` +
          `finding as net-new. Run \`${dxkitCli('update')}\` to migrate the baseline + allowlist ` +
          `automatically, or \`${dxkitCli('baseline create --force')}\` to re-anchor manually.`,
      );
    }
  }

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
      : options.incremental && baseline.repo.commitSha
        ? (computeChangedFiles(cwd, baseline.repo.commitSha) ?? undefined)
        : undefined;
  const current = await gatherCurrentScan({
    cwd,
    verbose: options.verbose,
    scope,
    incrementalFiles,
    // The guardrail verdict never reads dep `upgradePlan` (it's excluded from
    // finding identity), so skip the Tier-2 remediation enrichment that runs
    // the package manager — pure cost here, and unsafe on untrusted PR code.
    skipRemediation: true,
    // Hosted PR gates set --untrusted so dep audits never execute the scanned
    // source (e.g. Python skips `pip-audit .` project-build).
    untrusted: options.untrusted,
  });

  // In ref-based mode the prior side came from a detached worktree that
  // can't gather the build-artifact-dependent kinds; drop them from both
  // sides so the diff stays symmetric (see partitionForRefBasedDiff).
  const partitioned = partitionForRefBasedDiff(
    baseline.findings,
    current.findings,
    mode.mode === 'ref-based',
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
  const envelopeDrift = diffEnvelopes(baseline, current);

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
      ...(malicious ? { malicious } : {}),
      ...(reachable ? { reachable } : {}),
      // Only asked for added dep-vuln pairs, so a run with none never pays the
      // git diff (and other kinds never see the flag).
      ...(anchorEntry.kind === 'dep-vuln' && pair.status === 'added' && manifestUntouched()
        ? { manifestUntouched: true }
        : {}),
    };

    // `classify` is kind-agnostic; fold in the custom-check block INTENT (a
    // net-new finding from a `blocking: false` check warns instead of blocks)
    // into the ONE classification object, so the main verdict below AND the
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
        ? allowlistSuppressionFor(allowlist, anchorEntry, now)
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
  const flowBaseRef = mode.mode === 'ref-based' ? mode.ref : baseline.repo.commitSha;
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
    ...(options.untrusted !== undefined ? { untrusted: options.untrusted } : {}),
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

  const baseBlocks = options.changedOnly ? filteredBlocks : blocks;
  const baseWarns = options.changedOnly ? filteredWarns : warns;

  // Attribution gaps: block-rule-class findings recall drift demoted out of
  // block-rule reach. Computed from the SAME pair set the verdict reads
  // (post --changed-only filter), so a filtered-out pair can neither block
  // nor refuse. The verdict derivation (`verdictCounts`) consumes these —
  // while one exists the run cannot render PASSED.
  const attributionGaps = collectAttributionGaps(filteredPairs, envelopeDrift.recallDrift);

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
    blocks: baseBlocks || flowGate.blocks || schemaDriftGate.blocks || dupGate.blocks,
    warns: baseWarns || flowGate.warns || schemaDriftGate.warns || dupGate.warns,
    attributionGaps,
    allowlistDelta,
    refExcludedKinds,
    // Capture-deferral (Rule 20): classes the committed baseline could not
    // observe at capture. Committed modes only — ref-based has no committed
    // baseline to complete, so the "completing on CI" framing does not apply.
    ...(mode.mode !== 'ref-based' && baseline.deferred && baseline.deferred.length > 0
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

// `resolvePolicy` moved to `./policy.ts` so `createBaseline` and
// `runGuardrailCheck` share one canonical loader.

function indexById(entries: ReadonlyArray<BaselineEntry>): Map<FindingId, BaselineEntry> {
  const out = new Map<FindingId, BaselineEntry>();
  for (const e of entries) out.set(e.id, e);
  return out;
}

/**
 * Severity-by-fingerprint index built from the current run's
 * security aggregate. CodeFindings carry `fingerprint` (computed via
 * `computeCodeFingerprint` — the same hash `identityFor` produces
 * for secret/code/config kinds), and DepVulnFindings carry
 * `fingerprint` (computed via `computeFingerprint` — same as
 * identityFor for dep-vulns). For other kinds the lookup misses and
 * the caller falls back to `KIND_DEFAULT_SEVERITY`.
 */
function buildSeverityIndex(aggregate: SecurityAggregate): Map<FindingId, FindingSeverity> {
  const out = new Map<FindingId, FindingSeverity>();
  for (const f of aggregate.findingsByCategory.secret) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  for (const f of aggregate.findingsByCategory.code) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  for (const f of aggregate.findingsByCategory.config) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  for (const f of aggregate.findingsByCategory.dependency) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  return out;
}

/**
 * Fingerprints of current-scan dependency findings whose advisory reports
 * the package itself as malicious code — the `newMaliciousDependency`
 * block rule's signal. Computed from the CURRENT side only: block rules
 * fire on `added` pairs, which always carry a currentId, so the committed
 * baseline needs no schema change. Classification comes from the one
 * canonical predicate (`src/analyzers/security/malicious.ts`).
 */
function buildMaliciousIndex(aggregate: SecurityAggregate): Set<FindingId> {
  const out = new Set<FindingId>();
  for (const f of aggregate.findingsByCategory.dependency) {
    if (f.fingerprint && isMaliciousAdvisory(f)) out.add(f.fingerprint);
  }
  return out;
}

/**
 * Fingerprints of current-scan dependency findings the import graph marks
 * REACHABLE — the `newHighReachableDependencyVulnerability` block rule's
 * evidence. Mirror of `buildMaliciousIndex` (current side only, same
 * rationale). `f.reachable` is annotated by the ONE entry point
 * (`annotateReachability`) on both the standalone and the guardrail
 * gather paths; when reachability was not computed (no imports gathered)
 * the field is unset and the index stays empty — the rule then simply
 * has no evidence, it never fabricates `false` or `true` (T1.2).
 * Exported for the rule-liveness test.
 */
export function buildReachableIndex(aggregate: SecurityAggregate): Set<FindingId> {
  const out = new Set<FindingId>();
  for (const f of aggregate.findingsByCategory.dependency) {
    if (f.fingerprint && f.reachable === true) out.add(f.fingerprint);
  }
  return out;
}

function diffEnvelopes(baseline: BaselineFile, current: CurrentScan): EnvelopeDrift {
  const toolVersionDiffs: Array<{
    tool: string;
    baselineVersion: string | undefined;
    currentVersion: string | undefined;
  }> = [];
  const names = new Set<string>([...Object.keys(baseline.tools), ...Object.keys(current.tools)]);
  for (const tool of [...names].sort()) {
    const baselineVersion = baseline.tools[tool];
    const currentVersion = current.tools[tool];
    if (baselineVersion !== currentVersion) {
      toolVersionDiffs.push({ tool, baselineVersion, currentVersion });
    }
  }
  // Per-kind recall attribution (CLAUDE.md Rule 19) — the ONE comparison that
  // decides whether a kind's delta may be blamed on the developer. Filtered to
  // the kinds this run actually has findings for: a kind with nothing on either
  // side has nothing to misattribute, so reporting its drift would be noise
  // that trains readers to ignore the signal.
  const kindsInPlay = new Set<BaselineEntry['kind']>([
    ...baseline.findings.map((e) => e.kind),
    ...current.findings.map((e) => e.kind),
  ]);
  const recallDrift = diffRecall(baseline.recall, current.recall).filter((d) =>
    kindsInPlay.has(d.kind),
  );

  return {
    toolchainHashChanged: baseline.analysis.toolchainHash !== current.analysisMeta.toolchainHash,
    policyHashChanged: baseline.analysis.policyHash !== current.analysisMeta.policyHash,
    ignoreHashChanged: baseline.analysis.ignoreHash !== current.analysisMeta.ignoreHash,
    configHashChanged: baseline.analysis.configHash !== current.analysisMeta.configHash,
    dxkitVersionChanged: baseline.analysis.dxkitVersion !== current.analysisMeta.dxkitVersion,
    toolVersionDiffs,
    recallDrift,
    coverageDrift: diffCoverage(baseline.coverage, current.coverage),
  };
}

/**
 * Human location descriptor for a finding table — kind-aware, computed once.
 * Located kinds render `file:line` (or `file`); a dep-vuln has no file:line, so
 * it renders its own identity `package@version · advisory-id` (the fix for the
 * `Location: —` rows). Returns `''` for a genuinely location-less kind with no
 * meaningful descriptor (e.g. a sanitized entry). Extend the dep-vuln branch's
 * shape here — never re-derive location text in a renderer — so a future
 * locator-less kind supplies a descriptor instead of regressing to `—`.
 */
export function describeEntryLocation(entry: BaselineEntry): string {
  if (!isSanitized(entry) && entry.kind === 'dep-vuln') {
    const ver = entry.installedVersion ? `@${entry.installedVersion}` : '';
    // The ADVISORY id, not `entry.id` (the fingerprint — a naming collision:
    // `DepVulnIdentityInput.id` means advisory id, `BaselineEntry.id` means
    // finding id). Reading the fingerprint made ten same-package rows repeat
    // the Fingerprint column and read as duplicates with contradictory
    // severities (severity is per-advisory). Fallback covers pre-advisoryId
    // baselines.
    const advisoryId = entry.advisoryId ?? entry.id;
    const adv = advisoryId ? ` · ${advisoryId}` : '';
    return `${entry.package}${ver}${adv}`;
  }
  if (!isSanitized(entry) && entry.kind === 'custom-check') {
    // Lead with the check name — a binary (whole-command) check has no file, so
    // without this the row would read a bare `custom-check` with no clue which
    // one failed. Located findings append `check/rule · file:line`.
    const rule = entry.rule ? `/${entry.rule}` : '';
    const loc =
      entry.file !== undefined
        ? ` · ${entry.file}${entry.line !== undefined && entry.line > 0 ? `:${entry.line}` : ''}`
        : '';
    return `${entry.check}${rule}${loc}`;
  }
  const file = locatorFile(entry);
  if (file === undefined) return '';
  const line = locatorLine(entry);
  return line !== undefined && line > 0 ? `${file}:${line}` : file;
}

/**
 * Whether a net-new custom-check finding blocks. Reads the user/pack-declared
 * `blocking` flag off the entry. A sanitized entry (compliance mode) stripped
 * the flag, so it defaults to blocking=true — the conservative choice. Non-
 * custom-check kinds never call this.
 */
function customCheckIsBlocking(entry: BaselineEntry): boolean {
  if (isSanitized(entry)) return true;
  return entry.kind === 'custom-check' ? entry.blocking : true;
}

/**
 * Fold the custom-check block INTENT into a classification. Custom-check block
 * intent is user/pack-declared per check (`entry.blocking`), NOT derived from
 * severity or matcher status — so a net-new finding from a `blocking: false`
 * check (a warn-only user check, or lint left at its default) is demoted
 * block→warn here even though its `added` status is in the policy's block list.
 * Pure + exported so the demotion is unit-tested directly (not only via a full
 * guardrail run). A no-op for every non-custom-check kind and for a custom-check
 * that already doesn't block.
 */
export function applyCustomCheckIntent(entry: BaselineEntry, c: ClassifyResult): ClassifyResult {
  if (isSanitized(entry) || entry.kind !== 'custom-check' || !c.blocks) return c;
  if (customCheckIsBlocking(entry)) return c;
  return {
    ...c,
    blocks: false,
    warns: true,
    reasons: [
      ...c.reasons,
      {
        code: 'non-blocking-check',
        detail: 'custom check declared blocking:false — reported as a warning, not a block',
      },
    ],
  };
}

function locatorFile(entry: BaselineEntry): string | undefined {
  if (isSanitized(entry)) return undefined;
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
    case 'hygiene':
    case 'test-gap':
    case 'test-file-degradation':
    case 'god-file':
    case 'stale-file':
    case 'large-file':
      return entry.file;
    case 'coverage-gap':
      return entry.file;
    case 'duplication':
      return entry.fileA;
    case 'custom-check':
      // Located variant carries a file; binary variant does not.
      return entry.file;
    case 'dep-vuln':
    case 'secret-hmac':
      return undefined;
  }
}

function locatorLine(entry: BaselineEntry): number | undefined {
  if (isSanitized(entry)) return undefined;
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
    case 'hygiene':
      return entry.line;
    case 'duplication':
      return entry.startLineA;
    case 'coverage-gap':
      return entry.lineRange?.[0];
    case 'custom-check':
      return entry.line;
    default:
      return undefined;
  }
}

/**
 * `--changed-only` filter predicate. Keeps:
 *   - pairs without a line locator (dep-vuln, duplication, etc.) —
 *     their identity isn't line-bound, so changed-line overlap
 *     doesn't apply
 *   - prior-side pairs (persisted / relocated / removed) — they
 *     represent existing state, not newly-introduced findings, so
 *     they pass regardless of where they live in the diff
 *   - new-side pairs whose anchor line is inside the diff
 *
 * Drops new-side pairs (added / tooling_drift / config_drift /
 * newly_detected) whose locator IS known but doesn't overlap any
 * changed line. That's the exact scope a pre-commit / pre-push hook
 * wants — "only flag what this developer just touched."
 */
/**
 * Whether a classified pair contributes a BLOCK to the verdict. Folds
 * the classifier's verdict together with allowlist suppression: a pair
 * the classifier would block but an active allowlist entry accepted
 * does not block. Single chokepoint so the main verdict, the
 * post-`--changed-only` re-derivation, and the verdict cache's
 * blocking-finding projection can't drift. Exported for the cache.
 */
export function pairBlocks(p: ClassifiedPair): boolean {
  return p.classification.blocks && p.suppressedByAllowlist === undefined;
}

/**
 * Resolve the active allowlist suppression for an anchor finding, or
 * `undefined` when none applies. Matches by fingerprint AND kind — the
 * fingerprint alone is identity, but pinning kind too rules out a
 * cross-kind hash collision waiving the wrong finding. Expired entries
 * are skipped so the finding re-blocks once its window lapses.
 *
 * Robust matching: the candidate fingerprints are the finding's
 * representative id PLUS any `absorbedFingerprints` the aggregator
 * recorded when it collapsed a cross-tool / neighbor-bucket / CWE-bridge
 * finding into this one. A suppression keyed on a contributing
 * fingerprint (e.g. allowlisted from a run where a different engine was
 * the representative) still matches the merged finding, so dedup
 * nondeterminism between runs can't silently orphan it.
 *
 * Exported for unit testing: the expiry, kind-guard, and absorbed-
 * fingerprint branches are exercised directly here so the (expensive)
 * integration test only has to prove the verdict wiring flips.
 */
function keepUnderChangedOnly(p: ClassifiedPair): boolean {
  if (p.file === undefined || p.line === undefined) return true;
  const isNewSide =
    p.classification.status === 'added' ||
    p.classification.status === 'tooling_drift' ||
    p.classification.status === 'config_drift' ||
    p.classification.status === 'newly_detected';
  if (!isNewSide) return true;
  return p.overlapsChangedLines === true;
}

/**
 * Load the prior side of the guardrail diff. Dispatches on
 * `mode.mode`:
 *
 *   - `committed-full` / `committed-sanitized` → read the on-disk
 *     baseline file. The path is `options.baselinePath` when
 *     supplied, otherwise the conventional
 *     `.dxkit/baselines/<name>.json`.
 *   - `ref-based` → run the full gather pipeline against a git
 *     worktree of `mode.ref`, then project the resulting
 *     `CurrentScan` into a synthetic `BaselineFile`. The matcher
 *     downstream doesn't care which path produced the value.
 *
 * The synthetic `BaselineFile` for ref-based mode carries the ref-
 * scan's envelope unchanged — including its `repo.commitSha`,
 * `tools`, `analysis` hashes, and `saltMode`. That's exactly what
 * the matcher needs to compute git-aware diffs + envelope drift
 * against the current scan.
 */
/** Best-effort read of the `baseline` policy section (for the anchor transport);
 *  undefined when the policy is absent/unreadable. */
function safeBaselineSection(cwd: string): BaselineSection | undefined {
  try {
    return loadPolicyFromCwd(cwd).baseline;
  } catch {
    return undefined;
  }
}

async function loadPriorSide(
  cwd: string,
  mode: ResolvedMode,
  options: RunGuardrailCheckOptions,
  incrementalFiles?: ReadonlyArray<string>,
  scope: GatherScope = FULL_SCOPE,
): Promise<{
  baseline: BaselineFile;
  baselinePath?: string;
  anchorSource?: AnchorSourceDisclosure;
}> {
  if (mode.mode !== 'ref-based') {
    const baselinePath =
      options.baselinePath ?? pathForBaseline(cwd, options.name ?? DEFAULT_BASELINE_NAME);
    const section = safeBaselineSection(cwd);
    const anchorRef = section?.anchorRef ?? DEFAULT_ANCHOR_REF;
    // Scoped to the `branch` anchor transport: the source-of-truth anchor lives
    // on the side branch (the refresh only updates that, so a committed tree copy
    // goes stale). Read it from there — read-only, into a temp file — so a LOCAL
    // check matches CI instead of gating against a stale tree copy. Returns null
    // for `tree` (the tree copy IS the source of truth) and `cache` (CI-only, no
    // local side branch), and when the side branch isn't created yet / we're
    // offline — all of which fall through to the on-disk copy below.
    const fromBranch = loadAnchorFromBranch(cwd, baselinePath, section);
    if (fromBranch) {
      // Keep `baselinePath` as the logical tree path for display; read the fresh
      // side-branch anchor from the temp file.
      return {
        baseline: readBaselineFile(fromBranch),
        baselinePath,
        anchorSource: {
          used: 'anchor',
          anchorRef,
          note: `baseline read from the '${anchorRef}' side branch (anchor transport)`,
        },
      };
    }
    if (!fs.existsSync(baselinePath)) {
      // No on-disk copy: materialize a `branch` anchor at the tree path if we can
      // (a bootstrap where the side branch became reachable between the two
      // calls, or a non-'branch' transport with a genuinely missing file).
      const hydrated = hydrateAnchorFromBranch(cwd, baselinePath, section);
      if (!hydrated) {
        throw new Error(
          `baseline file not found: ${baselinePath}. ` +
            `Run \`${dxkitCli('baseline create')}\` first to capture today's state.`,
        );
      }
    }
    // D4d disclosure: with the `branch` transport, reaching this line means the
    // side branch could NOT be read and the check gates against the tree copy —
    // possibly stale (the refresh only updates the side branch). Fail-open, but
    // never silent: the incident's footer cited the stale tree SHA with nothing
    // saying the anchor read failed.
    const anchorSource: AnchorSourceDisclosure | undefined =
      section?.anchor === 'branch'
        ? {
            used: 'tree-fallback',
            anchorRef,
            note:
              `anchor transport 'branch': the '${anchorRef}' side branch could not be read ` +
              `(not created yet, offline, or unfetchable) — gating against the committed tree ` +
              `copy, which may be STALE. If this repo's refresh publishes the anchor, ` +
              `investigate with \`${dxkitCli('doctor')}\`.`,
          }
        : undefined;
    return {
      baseline: readBaselineFile(baselinePath),
      baselinePath,
      ...(anchorSource ? { anchorSource } : {}),
    };
  }

  if (!mode.ref) {
    // Defensive: the resolver always populates `ref` for ref-based
    // mode. A missing ref here would be a programming error.
    throw new Error('ref-based baseline mode requires a resolved ref; got undefined.');
  }
  const refScan = await gatherFromRef({
    cwd,
    ref: mode.ref,
    verbose: options.verbose,
    // Same policy-derived scope as the current side (opt 1), so the cross-run
    // diff stays balanced and the ref side skips the same non-blockable
    // analyzers.
    scope,
    // Symmetric incremental scoping: when the caller scoped the current side
    // to the changed files, scope the ref side to the SAME set (see the
    // `refIncrementalFiles` computation in `runGuardrailCheck`).
    incrementalFiles,
    // Match the current side: skip the dep remediation enrichment (the gate
    // never reads `upgradePlan`; the enrichment runs the package manager).
    skipRemediation: true,
    // Match the current side: never execute untrusted source during the audit.
    untrusted: options.untrusted,
  });
  // The ref-based prior side goes through the ONE `CurrentScan -> BaselineFile`
  // converter, so it carries `recall` + `coverage` exactly like the committed
  // write does. Hand-building it here is what dropped recall and made ref-based
  // mode drift on every run (Rule 2.30) — never reconstruct it inline.
  const baseline = scanToBaselineFile(refScan, {
    name: options.name ?? DEFAULT_BASELINE_NAME,
    findings: refScan.findings,
  });
  return { baseline };
}
