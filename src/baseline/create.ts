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
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { VERSION as DXKIT_VERSION } from '../constants';
import {
  BASELINE_SCHEMA_VERSION,
  DEFAULT_BASELINE_NAME,
  pathForBaseline,
  writeBaselineFile,
} from './baseline-file';
import type { BaselineAnalysisMeta, BaselineFile, BaselineRepoState } from './baseline-file';
import { DEFAULT_BROWNFIELD_POLICY } from './policy';
import { PRODUCERS, runProducers } from './producers';
import type { ProducerContext } from './producers';
import { resolveSalt } from './salt';
import type { SaltMode } from './salt';
import type { BaselineEntry } from './types';
import type { SecurityAggregate } from '../analyzers/security/aggregator';

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
}

export interface CreateBaselineResult {
  readonly path: string;
  readonly file: BaselineFile;
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
  readonly findings: ReadonlyArray<BaselineEntry>;
  readonly aggregate: SecurityAggregate;
  readonly repoState: BaselineRepoState;
  readonly saltMode: SaltMode;
  /** Per-tool name → version map for the run that just completed. */
  readonly tools: Readonly<Record<string, string>>;
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

  const producerCtx: ProducerContext = {
    cwd,
    commitSha: repoState.commitSha,
    salt,
    analysisResult,
    testGapsReport,
    hygiene: hygieneMarkers,
    rawSecrets,
  };

  // Dispatch through the canonical producer registry (CLAUDE.md
  // Rule 10). Adding a new identity kind means registering a
  // producer in `src/baseline/producers/index.ts` — never an edit
  // here.
  const findings: BaselineEntry[] = runProducers(producerCtx, PRODUCERS);

  const toolNames = new Set<string>();
  if (aggregate.provenance.secrets.tool) toolNames.add(aggregate.provenance.secrets.tool);
  if (aggregate.provenance.codePatterns.tool) toolNames.add(aggregate.provenance.codePatterns.tool);
  if (aggregate.provenance.depVulns.tool) toolNames.add(aggregate.provenance.depVulns.tool);
  if (aggregate.provenance.tlsBypass.ran) toolNames.add('tls-bypass-registry');
  const tools = buildToolsMap([...toolNames].sort(), cwd);

  const analysisMeta: BaselineAnalysisMeta = {
    ...buildAnalysisMeta(cwd),
    toolchainHash: hashContent(JSON.stringify(tools)),
  };

  return {
    findings,
    aggregate,
    repoState,
    saltMode,
    tools,
    analysisMeta,
    producerCtx,
  };
}

/**
 * Run the baseline-create pipeline. Pure-orchestrator: gather the
 * current scan via the shared step, then write it to disk under the
 * given name.
 */
export async function createBaseline(
  options: CreateBaselineOptions,
): Promise<CreateBaselineResult> {
  const cwd = path.resolve(options.cwd);
  const name = options.name ?? DEFAULT_BASELINE_NAME;
  const filePath = pathForBaseline(cwd, name);
  if (!options.force && fs.existsSync(filePath)) {
    throw new Error(
      `baseline already exists at ${filePath}. Pass force: true to overwrite, ` +
        `or use a different --name to keep both.`,
    );
  }

  const scan = await gatherCurrentScan({ cwd, verbose: options.verbose });

  const file: BaselineFile = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name,
    createdAt: new Date().toISOString(),
    repo: scan.repoState,
    analysis: scan.analysisMeta,
    tools: scan.tools,
    saltMode: scan.saltMode,
    findings: scan.findings,
  };

  writeBaselineFile(filePath, file);
  return { path: filePath, file };
}
