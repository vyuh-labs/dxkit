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

import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { gatherAnalysisResultBody } from '../analyzers/health';
import { readOrBuildAnalysisResult } from '../analyzers/cache';
import { gatherHygieneMarkers } from '../analyzers/quality/gather';
import { analyzeTestGaps } from '../analyzers/tests';
import { gatherGitleaksResult } from '../analyzers/tools/gitleaks';
import type { GitleaksRawSecret } from '../analyzers/tools/gitleaks';
import { checkAllTools, findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { detect } from '../detect';
import { coverageFromToolStatuses } from './coverage';
import type { ScanCoverage } from './coverage';
import { VERSION as DXKIT_VERSION } from '../constants';
import {
  BASELINE_SCHEMA_VERSION,
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineAnalysisMeta, BaselineFile, BaselineRepoState } from './baseline-file';
import { resolveBaselineMode } from './modes';
import type { ResolvedMode } from './modes';
import { DEFAULT_BROWNFIELD_POLICY, loadPolicyFromCwd } from './policy';
import { PRODUCERS, runProducers } from './producers';
import type { ProducerContext } from './producers';
import { resolveSalt } from '../analyzers/tools/salt';
import type { SaltMode } from '../analyzers/tools/salt';
import { sanitizeFile } from './sanitize';
import type { RichBaselineEntry } from './types';
import type { SecurityAggregate } from '../analyzers/security/aggregator';
import { gatherInlineAllowlistAnnotations } from '../allowlist/gather';

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
}

/** Outcome of `createBaseline`. `path` and `file` are absent when
 *  mode resolved to `ref-based` — no file is written, and the
 *  `mode` field carries the audit trail so callers can surface
 *  WHY nothing landed on disk. */
export interface CreateBaselineResult {
  readonly mode: ResolvedMode;
  readonly path?: string;
  readonly file?: BaselineFile;
}

/** Hash used for baseline-envelope metadata fields (policy, ignore,
 *  toolchain, config). Distinct concern from finding-identity
 *  fingerprints — these never enter the matcher's identity space. */
function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex').slice(0, 16); // fingerprint-helper-ok: envelope-metadata hash, not finding identity
}

/**
 * Read a small file's text content with the canonical "absent → ''"
 * convention. Treating absent files as the empty string keeps the
 * downstream metadata hash stable across runs where the file is
 * still missing.
 */
function readOptionalFile(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

/** Resolve the absolute commit SHA + branch name of the working tree.
 *  Empty strings when the directory isn't a git repo — the rest of
 *  the orchestrator works fine, only the git-aware matcher loses its
 *  diff anchor on a future check. */
function readRepoState(cwd: string): { commitSha: string; branch: string } {
  const run = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
  return {
    commitSha: run('rev-parse', 'HEAD'),
    branch: run('rev-parse', '--abbrev-ref', 'HEAD'),
  };
}

/** Build the analysis-environment hash bundle from the live repo. */
function buildAnalysisMeta(cwd: string): BaselineAnalysisMeta {
  const policyHash = hashContent(JSON.stringify(DEFAULT_BROWNFIELD_POLICY));
  const ignoreHash = hashContent(readOptionalFile(path.join(cwd, '.dxkit-ignore')));
  const configHash = hashContent(readOptionalFile(path.join(cwd, '.vyuh-dxkit.json')));
  // toolchainHash is filled in by `createBaseline` once the
  // per-tool version map has been resolved (depends on the gather).
  return { dxkitVersion: DXKIT_VERSION, policyHash, ignoreHash, toolchainHash: '', configHash };
}

/** Build the per-tool name → version map from the security
 *  aggregate's provenance. Sparse; only the tools that actually
 *  ran appear. Versions come from each tool's registered
 *  `versionCheck` invocation via `findTool`, so the resulting
 *  `toolchainHash` actually differs when a tool is upgraded —
 *  closing the drift-detection gap that placeholder values left
 *  open. In-process scanners (no external binary) are tagged with
 *  the dxkit version so a dxkit upgrade invalidates the toolchain
 *  hash even when no external tool changed — see
 *  `IN_PROCESS_TOOLS`.
 *
 *  Compound tool names like `'osv-scanner-nuget-direct'` (the
 *  per-pack synthetic names the dep-vuln providers emit) are
 *  resolved by progressively shortening on `-` boundaries until a
 *  matching TOOL_DEFS key is found — so
 *  `'osv-scanner-nuget-direct'` → `'osv-scanner-nuget'` →
 *  `'osv-scanner'` (the canonical key). */
function buildToolsMap(toolNames: ReadonlyArray<string>, cwd: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of toolNames) {
    if (!name) continue;
    out[name] = resolveToolVersion(name, cwd);
  }
  return out;
}

/**
 * Scanner names that don't correspond to an external binary — their
 * "version" tracks the dxkit version. Adding a new in-process
 * scanner (e.g. a future regex-based dependency checker) means
 * appending its name here, never special-casing inside
 * `resolveToolVersion`.
 *
 * Drives the `provenance.{secrets,codePatterns,...}.tool` values
 * that surface when external tools are unavailable — gitleaks
 * absent → `grep-secrets` runs the in-process fallback; the
 * TLS-bypass registry is always in-process.
 */
const IN_PROCESS_TOOLS: ReadonlySet<string> = new Set(['tls-bypass-registry', 'grep-secrets']);

/**
 * Per-process cache of resolved tool versions, keyed by `${name}::${cwd}`.
 *
 * Why this exists: `findTool` spawns an `execFileSync` subprocess to
 * run each tool's `versionCheck` command. Under heavy concurrent
 * load (parallel vitest workers, large suites running side-by-side),
 * that subprocess can occasionally complete with empty stdout —
 * `resolveToolVersion`'s `if (status.version) return status.version`
 * branch is skipped, the `return 'present'` fallback fires, and the
 * resulting toolchainHash drifts between two back-to-back gathers
 * within the same process. The matcher's `tooling_drift` gate then
 * fires spuriously.
 *
 * Tool versions don't change mid-process — once we've resolved
 * `gitleaks → 8.24.0` for `cwd`, every subsequent ask in the same
 * process should return the same answer. The cache locks the first
 * probe's outcome and skips later subprocess spawns entirely; same
 * answer always, with the side benefit of faster repeated gathers.
 *
 * NOT applied to `findTool` itself: `tools-cli.ts` runs an install
 * command then immediately re-probes (the install just created the
 * binary, we need fresh state). That callsite must keep getting
 * uncached results. The cache stays local to the toolchain-version
 * resolver here.
 */
const VERSION_CACHE = new Map<string, string>();

function resolveToolVersion(name: string, cwd: string): string {
  const cacheKey = `${name}::${cwd}`;
  const cached = VERSION_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const resolved = resolveToolVersionUncached(name, cwd);
  VERSION_CACHE.set(cacheKey, resolved);
  return resolved;
}

function resolveToolVersionUncached(name: string, cwd: string): string {
  if (IN_PROCESS_TOOLS.has(name)) return `dxkit-${DXKIT_VERSION}`;
  const parts = name.split('-');
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join('-');
    const def = TOOL_DEFS[candidate];
    if (!def) continue;
    // Probe the version a few times — under heavy CPU load (parallel
    // test pools, concurrent scanner runs) the underlying `execSync`
    // subprocess can occasionally return before its `--version`
    // output streams back, leaving us with a bare `'present'` even
    // though the tool itself is fully functional. The per-process
    // VERSION_CACHE then locks that empty result for the lifetime of
    // the run, which is what we want for byte-stable toolchainHashes
    // but is wrong when the empty result was a transient artifact.
    // Three attempts absorb the hiccup without slowing the common
    // path (first probe succeeds → exit immediately).
    for (let attempt = 0; attempt < 3; attempt++) {
      const status = findTool(def, cwd);
      if (status.version) return status.version;
    }
    return 'present';
  }
  return 'unknown';
}

/**
 * Test seam: clear the version cache between test runs so per-test
 * fixtures don't leak resolutions into one another. Production
 * callers never use this — the cache lives for the entire CLI
 * invocation and dies with the process.
 */
export function clearToolVersionCache(): void {
  VERSION_CACHE.clear();
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
  /** Per-tool name → version map for the run that just completed. */
  readonly tools: Readonly<Record<string, string>>;
  /** Scanner availability snapshot for the run — which finding-
   *  contributing tools were detected vs missing on this machine. */
  readonly coverage: ScanCoverage;
  /** Envelope metadata for the run. `toolchainHash` is already
   *  resolved from `tools`. */
  readonly analysisMeta: BaselineAnalysisMeta;
  /** Echoed back so the guardrail check can attribute per-pair
   *  severity, overlap, and reachable signals without re-gathering. */
  readonly producerCtx: ProducerContext;
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
}): Promise<CurrentScan> {
  const cwd = path.resolve(options.cwd);

  const analysisResult = await readOrBuildAnalysisResult({
    cwd,
    build: (innerCwd) => gatherAnalysisResultBody(innerCwd, { verbose: !!options.verbose }),
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
  // adding another producer-specific block in this function.
  const testGapsReport = await analyzeTestGaps(cwd, { verbose: !!options.verbose });
  const hygieneMarkers = gatherHygieneMarkers(cwd);
  const gitleaksOutcome = gatherGitleaksResult(cwd);
  const rawSecrets: ReadonlyArray<GitleaksRawSecret> =
    gitleaksOutcome.kind === 'success' ? gitleaksOutcome.rawSecrets : [];
  // Inline `dxkit-allow:` annotations gathered from source so the
  // stale-allow producer can flag orphans whose underlying findings
  // are no longer present.
  const inlineAllowlistAnnotations = gatherInlineAllowlistAnnotations(cwd);

  const producerCtx: ProducerContext = {
    cwd,
    commitSha: repoState.commitSha,
    salt,
    analysisResult,
    testGapsReport,
    hygiene: hygieneMarkers,
    rawSecrets,
    inlineAllowlistAnnotations,
  };

  // Dispatch through the canonical producer registry (CLAUDE.md
  // Rule 10). Adding a new identity kind means registering a
  // producer in `src/baseline/producers/index.ts` — never an edit
  // here.
  const findings: RichBaselineEntry[] = runProducers(producerCtx, PRODUCERS);

  const toolNames = new Set<string>();
  // A capability's provenance `tool` is a `uniqueJoin(', ')` of every
  // provider that contributed — e.g. secrets is `'gitleaks, grep-secrets'`
  // when both run. Split it back into individual names so each resolves
  // its own version (gitleaks → semver; grep-secrets → in-process tag)
  // rather than recording the joined string as one unversioned tool.
  const addTools = (joined: string | null | undefined) => {
    if (!joined) return;
    for (const name of joined
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      toolNames.add(name);
    }
  };
  addTools(aggregate.provenance.secrets.tool);
  addTools(aggregate.provenance.codePatterns.tool);
  addTools(aggregate.provenance.depVulns.tool);
  if (aggregate.provenance.tlsBypass.ran) toolNames.add('tls-bypass-registry');
  const tools = buildToolsMap([...toolNames].sort(), cwd);

  const analysisMeta: BaselineAnalysisMeta = {
    ...buildAnalysisMeta(cwd),
    toolchainHash: hashContent(JSON.stringify(tools)),
  };

  // Scanner availability for the active stack. Recorded on the baseline
  // so a later guardrail check can detect when a category was never
  // scanned (tool missing) rather than scanned-and-clean.
  const coverage = coverageFromToolStatuses(checkAllTools(analysisResult.stack.languages, cwd));

  return {
    findings,
    aggregate,
    repoState,
    saltMode,
    tools,
    coverage,
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

  const richFile: BaselineFile = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name,
    createdAt: new Date().toISOString(),
    repo: scan.repoState,
    analysis: scan.analysisMeta,
    tools: scan.tools,
    saltMode: scan.saltMode,
    coverage: scan.coverage,
    findings: scan.findings,
  };

  const file = mode.mode === 'committed-sanitized' ? sanitizeFile(richFile) : richFile;
  writeBaselineFile(filePath, file);
  return { mode, path: filePath, file };
}
