/**
 * `dxkit baseline create` orchestrator.
 *
 * Builds the shared producer context (runs every analyzer once),
 * dispatches through the canonical producer registry (CLAUDE.md
 * Rule 10), captures repo + analysis-environment metadata, and
 * writes the result to `.dxkit/baselines/<name>.json`. The on-disk
 * file is the durable record subsequent `guardrail check` runs diff
 * against.
 *
 * This module is the producer side; the matcher + classifier on the
 * consumer side already exist in `git-aware-match.ts` and
 * `policy.ts`. The two are connected by the file format defined in
 * `baseline-file.ts`.
 *
 * Per-kind producer coverage + deferral rationale live in the
 * registry index (`./producers/index.ts`) — the single discovery
 * surface. Adding a new identity kind or analyzer means
 * registering a producer there, never an edit here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { gatherAnalysisResultBody } from '../analyzers/health';
import { readOrBuildAnalysisResult } from '../analyzers/cache';
import { type GatherScope, FULL_SCOPE, isFullScope } from './gather-scope';
import { gatherScopedProducerInputs } from './scoped-inputs';
import { checkAllTools } from '../analyzers/tools/tool-registry';
import { detect } from '../detect';
import { coverageFromToolStatuses } from './coverage';
import type { ScanCoverage } from './coverage';
import { clearToolVersionCache } from './tool-versions';
export { clearToolVersionCache };
import {
  BASELINE_SCHEMA_VERSION,
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineAnalysisMeta, BaselineFile, BaselineRepoState } from './baseline-file';
import { assessCaptureDeferral, type DeferredCaptureClass } from './deferral';
import { resolveBaselineMode } from './modes';
import type { ResolvedMode } from './modes';
import { loadPolicyFromCwd } from './policy';
import {
  customCheckRecallInputs,
  gatherCustomCheckFindings,
} from '../analyzers/custom-checks/gather';
import { PRODUCERS, runProducers, runRecallContexts } from './producers';
import type { ProducerContext } from './producers';
import { recallInputsUnion } from './recall';
import type { RecallMap } from './recall';
import { resolveSalt } from '../analyzers/tools/salt';
import type { SaltMode } from '../analyzers/tools/salt';
import { sanitizeFile } from './sanitize';
import { resolveEffectiveAllowlist } from '../allowlist/effective';
import { entryToAllowlistable, partitionByActiveAllowlist } from './allowlist-match';
import type { RichBaselineEntry } from './types';
import { CURRENT_IDENTITY_SCHEME } from './types';
import type { SecurityAggregate } from '../analyzers/security/aggregator';
import { captureFloorDebt, type FloorDebt } from './floor-debt';
import { hashContent, readRepoState, buildAnalysisMeta } from './envelope-meta';

export interface CreateBaselineOptions {
  /** Repo root to baseline. Caller should pass an absolute path. */
  readonly cwd: string;
  /** Baseline name (becomes the filename stem under `.dxkit/baselines/`).
   *  Defaults to `'main'`. Different names allow per-branch / per-
   *  environment baselines to coexist on disk. */
  readonly name?: string;
  /** When true, overwrite an existing baseline file at the same path.
   *  When false (default), an existing file makes `createBaseline`
   *  throw — guards against accidentally clobbering a committed
   *  baseline with a fresh capture. */
  readonly force?: boolean;
  /** Forwarded to the underlying analyzer for per-tool timing logs. */
  readonly verbose?: boolean;
  /** Pre-resolved baseline mode. When supplied, the orchestrator
   *  skips its own resolution + policy load. Callers wanting
   *  deterministic behavior (tests, agents) pass this. */
  readonly resolvedMode?: ResolvedMode;
  /** Explicit CLI flag value for the mode (`--mode=<X>`). Forwarded
   *  to `resolveBaselineMode`. Ignored when `resolvedMode` is
   *  supplied. */
  readonly cliMode?: ResolvedMode['mode'];
  /** Explicit CLI flag value for the ref (`--ref=<R>`). Only
   *  consulted when the resolved mode is `ref-based`. */
  readonly cliRef?: string;
  /** Capture the correctness-floor debt envelope (compile + tests, full
   *  scope, bounded per-check). Default ON — cleanup agents rely on the
   *  envelope existing — with two opt-outs: pass `false` (the `--no-floor`
   *  flag) or set DXKIT_BASELINE_NO_FLOOR=1 (the test suite does, so
   *  hundreds of fixture baselines don't each run a floor pass). An
   *  explicit option always wins over the env. */
  readonly floor?: boolean;
}

/** Outcome of `createBaseline`. `path` and `file` are absent when
 *  mode resolved to `ref-based` — no file is written, and the
 *  `mode` field carries the audit trail so callers can surface
 *  WHY nothing landed on disk. */
export interface CreateBaselineResult {
  readonly mode: ResolvedMode;
  readonly path?: string;
  readonly file?: BaselineFile;
  /** How the captured findings split between what was baselined (`live`) and
   *  what an active allowlist entry suppressed and held OUT of the baseline
   *  (`allowlisted`, gh #155). Absent for `ref-based` mode (no file written).
   *  `byCategory` breaks the held-out count down by suppression category so the
   *  CLI can report an honest `N findings baselined (M allowlisted)` line. */
  readonly allowlistSplit?: {
    readonly live: number;
    readonly allowlisted: number;
    readonly byCategory: Readonly<Record<string, number>>;
  };
}

/**
 * Snapshot of one analyzer run, in the exact shape the baseline file
 * and the guardrail-check both need. Built by `gatherCurrentScan`
 * once and consumed by either path.
 *
 * Why this is shared: the guardrail check re-runs every analyzer to
 * produce the "current" side of the diff. Without a shared step, the
 * gather + producer-dispatch logic would have to be duplicated in
 * `check.ts` — exactly the class of duplication CLAUDE.md Rule 2
 * forbids for tool invocation, and the same hazard applies here.
 */
export interface CurrentScan {
  readonly findings: ReadonlyArray<RichBaselineEntry>;
  readonly aggregate: SecurityAggregate;
  readonly repoState: BaselineRepoState;
  readonly saltMode: SaltMode;
  /** Flattened name → version/hash map for the run that just completed.
   *  A DISPLAY projection of `recall` (Rule 19) — `show` renders it and the
   *  envelope hashes it. Never an attribution source: the guardrail compares
   *  `recall` per kind. */
  readonly tools: Readonly<Record<string, string>>;
  /** What each finding kind could SEE on this run (Rule 19). The guardrail
   *  compares this against the baseline's per kind: unequal ⇒ that kind's
   *  delta has an explanation other than the developer, so it reports
   *  "cannot attribute" instead of net-new. */
  readonly recall: RecallMap;
  /** Scanner availability snapshot for the run — which finding-
   *  contributing tools were detected vs missing on this machine. */
  readonly coverage: ScanCoverage;
  /** Finding classes this environment could NOT observe (Rule 20 — see
   *  `deferral.ts`). Non-empty ⇒ partial capture; persisted for the arming banner. */
  readonly deferred: ReadonlyArray<DeferredCaptureClass>;
  /** Envelope metadata for the run. `toolchainHash` is already
   *  resolved from `tools`. */
  readonly analysisMeta: BaselineAnalysisMeta;
  /** Echoed back so the guardrail check can attribute per-pair
   *  severity, overlap, and reachable signals without re-gathering. */
  readonly producerCtx: ProducerContext;
}

/**
 * The ONE conversion from a `CurrentScan` into a `BaselineFile` (CLAUDE.md
 * Rule 2 — one concept, one code path). Both baseline paths use it: the
 * committed write (`createBaseline`) and the ref-based prior side
 * (`loadPriorSide` in `check.ts`). Centralized because the two hand-built
 * constructions DIVERGED — `recall`/`coverage` landed on one and were silently
 * omitted from the other (both optional, so it compiled), making ref-based mode
 * read every kind as `absent-from-baseline` drift — the Rule 2.30 shape.
 *
 * A scan field is now mapped in exactly ONE place. `check-architecture.sh` bans
 * a second `schemaVersion: BASELINE_SCHEMA_VERSION` construction outside this
 * function; `test/baseline/scan-to-baseline.test.ts` asserts every scan field
 * survives. `findings` is a param: the committed write persists the
 * allowlist-filtered `live` set, the ref-based side keeps the full gathered set.
 */
export function scanToBaselineFile(
  scan: CurrentScan,
  opts: {
    readonly name: string;
    readonly findings: ReadonlyArray<RichBaselineEntry>;
    /** Injectable for deterministic tests; defaults to now. */
    readonly createdAt?: string;
    /** Floor-debt envelope (informational — Rule 15; never gates). Only the
     *  committed write supplies it: the ref-based prior side runs in a
     *  throwaway worktree where the floor would mostly skip-unavailable,
     *  and the guardrail never reads the envelope anyway. */
    readonly floorDebt?: FloorDebt;
  },
): BaselineFile {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION, // baseline-file-construction-ok
    name: opts.name,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    repo: scan.repoState,
    analysis: scan.analysisMeta,
    tools: scan.tools,
    saltMode: scan.saltMode,
    identityScheme: CURRENT_IDENTITY_SCHEME,
    recall: scan.recall,
    coverage: scan.coverage,
    // Omitted when empty — a complete capture keeps the pre-4.0.2 authoritative shape.
    ...(scan.deferred.length > 0 ? { deferred: scan.deferred } : {}),
    ...(opts.floorDebt ? { floorDebt: opts.floorDebt } : {}),
    findings: opts.findings,
  };
}

/**
 * Run every analyzer once, dispatch through the producer registry,
 * and return the assembled `CurrentScan`. Used by `createBaseline`
 * to capture today's state and by `runGuardrailCheck` to gather the
 * current side of the cross-run diff.
 *
 * Pure-orchestrator: each step has a single responsibility (analyze
 * → produce entries → resolve envelope metadata).
 */
export async function gatherCurrentScan(options: {
  readonly cwd: string;
  readonly verbose?: boolean;
  /** Restrict the gather to the analyzers a scope needs (defaults to
   *  `FULL_SCOPE`). Only the loop Stop-gate passes a policy-derived scope;
   *  `createBaseline` / CI gather everything. See `gather-scope.ts`. */
  readonly scope?: GatherScope;
  /** Incremental scanning (opt 3): semgrep scans ONLY these changed files.
   *  Loop Stop-gate's current side only; the ref side stays full. Sound by
   *  semgrep's intraprocedural nature (a net-new code finding only appears
   *  in a changed file). */
  readonly incrementalFiles?: ReadonlyArray<string>;
  readonly skipRemediation?: boolean; // gate-only; see `DepVulnGatherOptions`
  readonly untrusted?: boolean; // gate-only: untrusted source (no project builds)
}): Promise<CurrentScan> {
  const cwd = path.resolve(options.cwd);
  const scope = options.scope ?? FULL_SCOPE;
  // A scoped OR incrementally-scanned result is partial — it must never
  // enter the shared cache where a later full `health` read would consume
  // an incomplete codePatterns set.
  const partial = !isFullScope(scope) || options.incrementalFiles !== undefined;

  const analysisResult = await readOrBuildAnalysisResult({
    cwd,
    build: (innerCwd) =>
      gatherAnalysisResultBody(innerCwd, {
        verbose: !!options.verbose,
        scope,
        incrementalFiles: options.incrementalFiles,
        skipRemediation: options.skipRemediation,
        untrusted: options.untrusted,
      }),
    opts: { partial },
  });
  const aggregate = analysisResult.capabilities.securityAggregate;
  if (!aggregate) {
    throw new Error(
      'baseline scan: cached AnalysisResult missing securityAggregate ' +
        '(expected to be populated by gatherAnalysisResultBody).',
    );
  }

  const repoState: BaselineRepoState = {
    ...readRepoState(cwd),
    root: cwd,
  };

  // Salt resolves once; threaded into every producer that needs to
  // compute HMACs. The mode lands on the baseline file so the
  // matcher can re-derive the same salt at check time (or warn when
  // it can't).
  const { mode: saltMode, salt } = resolveSalt(cwd);

  // Build the producer context once. Every analyzer's gather runs
  // here (or earlier inside readOrBuildAnalysisResult) so producers
  // can be pure or near-pure consumers — adding a new producer
  // means extending this context with one more input, never
  // adding another producer-specific block in this function. The
  // scope-aware analyzer inputs (test-gaps, hygiene, raw secrets,
  // inline annotations) come from one helper that skips the gathers a
  // scope can't block on (see scoped-inputs.ts).
  const { testGapsReport, hygiene, rawSecrets, inlineAllowlistAnnotations } =
    await gatherScopedProducerInputs(cwd, scope, !!options.verbose);

  // Custom-check findings (user-declared checks + built-in lint). Gathered ONLY
  // when the scope can carry them AND the repo opted in (policy.checks /
  // lint.enabled) — `gatherCustomCheckFindings` no-ops (no spawn) otherwise, so
  // a repo without custom checks pays nothing. Scoped out of gathers that a
  // policy can't block on (the loop Stop-gate's fast path), matching the other
  // producer inputs.
  const policy = loadPolicyFromCwd(cwd);
  const customCheckFindings = scope.customChecks ? gatherCustomCheckFindings({ cwd, policy }) : [];
  // Recall inputs are resolved even when the scope skipped the RUN: the kind's
  // context describes what the checks WOULD see, and a scope that can't block
  // on custom checks still records honest metadata. Pure string work + a
  // manifest read — no command executes here.
  const customCheckRecall = customCheckRecallInputs({ cwd, policy });

  const producerCtx: ProducerContext = {
    cwd,
    commitSha: repoState.commitSha,
    salt,
    analysisResult,
    testGapsReport,
    hygiene,
    rawSecrets,
    inlineAllowlistAnnotations,
    customCheckFindings,
    customCheckRecall,
  };

  // Dispatch through the canonical producer registry (CLAUDE.md
  // Rule 10). Adding a new identity kind means registering a
  // producer in `src/baseline/producers/index.ts` — never an edit
  // here.
  const findings: RichBaselineEntry[] = runProducers(producerCtx, PRODUCERS);

  // What each kind can SEE this run, declared per kind by the producer that
  // owns it (CLAUDE.md Rule 19). This REPLACED a hardcoded union of three
  // provenance tools: the union silently covered three kinds and missed every
  // kind added since, which is why a lint finding could never be attributed to
  // a tool change. Registry-driven, so a new producer's inputs land here with
  // no edit — proven by the producer playbook.
  const recall = runRecallContexts(producerCtx, PRODUCERS);

  // `tools` + `toolchainHash` are now a flattened DISPLAY projection of the
  // recall map, not a second source of truth. Nothing attributes off them —
  // the guardrail's per-kind compare reads `recall` directly.
  const tools = recallInputsUnion(recall);

  const analysisMeta: BaselineAnalysisMeta = {
    ...buildAnalysisMeta(cwd),
    toolchainHash: hashContent(JSON.stringify(tools)),
  };

  // Scanner availability for the active stack (so a later check can tell "never
  // scanned, tool missing" from "scanned and clean"). The same probed statuses
  // feed the capture-deferral partition — no second probe.
  const toolStatuses = checkAllTools(analysisResult.stack.languages, cwd);
  const coverage = coverageFromToolStatuses(toolStatuses);
  const { deferred } = assessCaptureDeferral(cwd, { statuses: toolStatuses });

  return {
    findings,
    aggregate,
    repoState,
    saltMode,
    tools,
    recall,
    coverage,
    deferred,
    analysisMeta,
    producerCtx,
  };
}

/**
 * Scanner-availability snapshot for `cwd`, independent of a full scan.
 *
 * Cheap pre-flight used by the CLI to warn — before paying for the
 * gather — when finding-contributing scanners are missing on this
 * machine, so a developer isn't surprised by a silently-incomplete
 * baseline. Detects the stack and probes each required tool.
 */
export function gatherScanCoverage(cwd: string): ScanCoverage {
  const resolved = path.resolve(cwd);
  return coverageFromToolStatuses(checkAllTools(detect(resolved).languages, resolved));
}

/**
 * Run the baseline-create pipeline. Pure-orchestrator: resolve
 * the baseline mode, gather the current scan, then either:
 *
 *   - `committed-full` → write rich entries to disk (today's
 *     behavior).
 *   - `committed-sanitized` → sanitize every entry, then write.
 *     The cross-run matching contract is preserved; locator
 *     fields are stripped.
 *   - `ref-based` → no file write. The guardrail check will
 *     recompute the prior side from a git ref instead.
 *
 * In all three cases the returned `CreateBaselineResult` carries
 * `resolvedMode` so callers can log WHY a given mode was picked
 * (CLI flag / policy file / visibility auto-detect).
 */
export async function createBaseline(
  options: CreateBaselineOptions,
): Promise<CreateBaselineResult> {
  const cwd = path.resolve(options.cwd);
  const name = options.name ?? DEFAULT_BASELINE_NAME;
  const mode =
    options.resolvedMode ??
    (() => {
      const policy = loadPolicyFromCwd(cwd);
      return resolveBaselineMode({
        cwd,
        cliMode: options.cliMode,
        cliRef: options.cliRef,
        policyMode: policy.baseline?.mode,
        policyRef: policy.baseline?.ref,
      });
    })();

  if (mode.mode === 'ref-based') {
    // Ref-based mode keeps no committed baseline. We still run no
    // gather here — the guardrail check does it on demand against
    // the configured ref. Returning the resolved mode lets the CLI
    // surface a clear "ref-based mode active; no file written" log.
    return { mode };
  }

  const filePath = pathForBaseline(cwd, name);
  if (!options.force && fs.existsSync(filePath)) {
    throw new Error(
      `baseline already exists at ${filePath}. Pass force: true to overwrite, ` +
        `or use a different --name to keep both.`,
    );
  }

  const scan = await gatherCurrentScan({ cwd, verbose: options.verbose });

  // Exclude actively-allowlisted findings from the captured set so a
  // reviewed-and-accepted finding never grandfathers into the baseline as
  // `persisted` (gh #155). Grandfathering an allowlisted finding double-
  // suppresses it AND defeats its expiry — a `persisted` finding never blocks,
  // so an accepted-risk entry that later lapsed would silently stay suppressed.
  // Held OUT of the baseline, the allowlist (with its expiry) is the single
  // source of suppression: an active entry keeps the finding suppressed today,
  // and when it lapses the finding resurfaces as net-new on the next check.
  // Resolved through the ONE effective-allowlist constructor + the ONE active-
  // suppression predicate, so create sees the identical suppression set the
  // guardrail check and the security score do (Rule 2).
  const effectiveAllowlist = resolveEffectiveAllowlist({
    cwd,
    findings: scan.findings.map(entryToAllowlistable),
    inlineAnnotations: scan.producerCtx.inlineAllowlistAnnotations,
  });
  const { live, suppressions } = partitionByActiveAllowlist(
    scan.findings,
    effectiveAllowlist,
    new Date(),
  );
  const byCategory: Record<string, number> = {};
  for (const s of suppressions) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;

  // Floor-debt inventory (T2.3 follow-through): record the pre-existing
  // build/test state WITH details so cleanup agents can prioritize and fix
  // it (`vyuh-dxkit debt`). Bounded; never gates; explicit option beats env.
  const captureFloor = options.floor ?? process.env.DXKIT_BASELINE_NO_FLOOR !== '1';
  const floorDebt = captureFloor ? (captureFloorDebt(cwd) ?? undefined) : undefined;

  const richFile = scanToBaselineFile(scan, { name, findings: live, floorDebt });

  const file = mode.mode === 'committed-sanitized' ? sanitizeFile(richFile) : richFile;
  writeBaselineFile(filePath, file);
  return {
    mode,
    path: filePath,
    file,
    allowlistSplit: { live: live.length, allowlisted: suppressions.length, byCategory },
  };
}
