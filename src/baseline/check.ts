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
 *        - scannerVersionDiffers from per-kind tool version compare
 *        - configDiffers from envelope hash compare
 *        - overlapsChangedLines from `git diff base..HEAD` hunks
 *          intersected with the finding's line
 *   5. Run the brownfield policy classifier over every pair.
 *   6. Optionally filter via `--changed-only`: drop pairs whose
 *      locator falls outside the diff. Non-locator pairs (dep-vuln,
 *      license, duplication, etc.) are always kept — their
 *      "semantic" identity doesn't map cleanly to changed lines.
 *   7. Compose a `GuardrailCheckResult` with a deterministic
 *      blocks/warns verdict so the CLI can pick exit code + render.
 *
 * Drift signals come from comparing the baseline's `analysis` /
 * `tools` envelope against the freshly-gathered envelope. Per-kind
 * tool attribution uses the current run's `SecurityAggregate.provenance`
 * — the cleaner alternative to a hardcoded kind→tool table.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { gatherCurrentScan } from './create';
import type { CurrentScan } from './create';
import { DEFAULT_BASELINE_NAME, pathForBaseline, readBaselineFile } from './baseline-file';
import type { BaselineFile } from './baseline-file';
import { entriesToLocated } from './entry-to-located';
import { gitAwareMatch } from './git-aware-match';
import type { LocatedIdentity } from './git-aware-match';
import { classify, DEFAULT_BROWNFIELD_POLICY } from './policy';
import type { BrownfieldPolicy, ClassifyContext, ClassifyResult } from './policy';
import type { BaselineEntry, FindingId, FindingSeverity, MatchPair, MatchResult } from './types';
import type { SecurityAggregate } from '../analyzers/security/aggregator';
import { computeAllowlistDelta, type AllowlistDelta } from '../allowlist/diff';

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
   *  Non-locator findings (dep-vuln, license, duplication, etc.) are
   *  always kept. */
  readonly changedOnly?: boolean;
  /** Path to a `.dxkit/policy.json` override. The on-disk shape
   *  matches `BrownfieldPolicy` (modulo readonly markers); unknown
   *  fields are preserved but not type-checked here — the policy
   *  classifier reads only the fields it knows. When omitted, a
   *  `<cwd>/.dxkit/policy.json` is auto-loaded if it exists; otherwise
   *  the compiled-in defaults apply. */
  readonly policyPath?: string;
  /** Forwarded to the underlying analyzers for per-tool timing logs. */
  readonly verbose?: boolean;
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
  /** True when the anchor entry's line falls inside the diff
   *  between baseline and HEAD. Undefined when the pair has no
   *  line locator (dep-vuln, license, etc.) or when git history
   *  isn't reachable. Drives `--changed-only` filtering and the
   *  `newSevereQualityIssueInChangedFiles` / `newUntestedChangedSource`
   *  block rules. */
  readonly overlapsChangedLines?: boolean;
}

export interface EnvelopeDrift {
  readonly toolchainHashChanged: boolean;
  readonly policyHashChanged: boolean;
  readonly ignoreHashChanged: boolean;
  readonly configHashChanged: boolean;
  readonly dxkitVersionChanged: boolean;
  /** Per-tool version drift. Empty when `tools` maps agree. */
  readonly toolVersionDiffs: ReadonlyArray<{
    readonly tool: string;
    readonly baselineVersion: string | undefined;
    readonly currentVersion: string | undefined;
  }>;
}

export interface GuardrailCheckResult {
  readonly baselinePath: string;
  readonly baseline: BaselineFile;
  readonly current: CurrentScan;
  readonly matchResult: MatchResult;
  readonly pairs: ReadonlyArray<ClassifiedPair>;
  readonly envelopeDrift: EnvelopeDrift;
  readonly policy: BrownfieldPolicy;
  /** True when at least one classified pair blocks. The CLI maps
   *  this to exit code 1. */
  readonly blocks: boolean;
  /** True when at least one pair warns. Informational; doesn't
   *  affect exit code by itself. */
  readonly warns: boolean;
  /** Allowlist entries added / removed between the baseline's
   *  commit SHA and the current working tree. Renderers (the PR
   *  comment markdown in particular) surface this so reviewers
   *  see new suppressions being introduced. Absent when the
   *  baseline SHA wasn't reachable to diff against. */
  readonly allowlistDelta: AllowlistDelta;
}

const KIND_DEFAULT_SEVERITY: Readonly<Record<BaselineEntry['kind'], FindingSeverity>> =
  Object.freeze({
    secret: 'high',
    code: 'medium',
    config: 'medium',
    'dep-vuln': 'medium',
    duplication: 'medium',
    'coverage-gap': 'medium',
    'test-gap': 'medium',
    hygiene: 'low',
    license: 'low',
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
  const baselinePath =
    options.baselinePath ?? pathForBaseline(cwd, options.name ?? DEFAULT_BASELINE_NAME);
  if (!fs.existsSync(baselinePath)) {
    throw new Error(
      `baseline file not found: ${baselinePath}. ` +
        `Run \`vyuh-dxkit baseline create\` first to capture today's state.`,
    );
  }
  const baseline = readBaselineFile(baselinePath);
  const policy = resolvePolicy(options.policyPath, cwd);

  const current = await gatherCurrentScan({ cwd, verbose: options.verbose });

  const priorLocated: ReadonlyArray<LocatedIdentity> = entriesToLocated(baseline.findings);
  const currentLocated: ReadonlyArray<LocatedIdentity> = entriesToLocated(current.findings);

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
  const currentById = indexById(current.findings);
  const severityByCurrentId = buildSeverityIndex(current.aggregate);
  const envelopeDrift = diffEnvelopes(baseline, current);

  // Per-kind tool attribution drives the per-pair
  // scannerVersionDiffers signal. A pair is in drift only when the
  // tools that produced its kind actually changed version between
  // runs — narrower than "any tool drifted globally," which would
  // overstate the drift signal for unrelated kinds.
  const toolsByKind = buildToolsByKind(current.aggregate);

  const changedLineCache = new Map<string, Set<number>>();
  const headSha = readHeadSha(cwd);
  const baseSha = baseline.repo.commitSha;
  const linesChangedFor = (file: string): Set<number> | undefined => {
    if (!baseSha || !headSha) return undefined;
    let cached = changedLineCache.get(file);
    if (cached) return cached;
    cached = readChangedLineSet(cwd, baseSha, headSha, file);
    changedLineCache.set(file, cached);
    return cached;
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
    const overlapsChangedLines =
      file !== undefined && line !== undefined && line > 0
        ? (linesChangedFor(file)?.has(line) ?? false)
        : undefined;

    const scannerVersionDiffers =
      pair.status === 'added' && kindHasDriftingTool(anchorEntry.kind, toolsByKind, envelopeDrift);
    const configDiffers =
      pair.status === 'added' &&
      (envelopeDrift.configHashChanged ||
        envelopeDrift.ignoreHashChanged ||
        envelopeDrift.policyHashChanged);

    const context: ClassifyContext = {
      severity,
      kind: anchorEntry.kind,
      ...(scannerVersionDiffers ? { scannerVersionDiffers: true } : {}),
      ...(configDiffers ? { configDiffers: true } : {}),
      ...(overlapsChangedLines !== undefined ? { overlapsChangedLines } : {}),
    };

    const classification = classify(pair, policy, context);
    if (classification.blocks) blocks = true;
    if (classification.warns) warns = true;

    classifiedPairs.push({
      pair,
      classification,
      severity,
      kind: anchorEntry.kind,
      ...(file !== undefined ? { file } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(overlapsChangedLines !== undefined ? { overlapsChangedLines } : {}),
    });
  }

  const filteredPairs = options.changedOnly
    ? classifiedPairs.filter((p) => keepUnderChangedOnly(p))
    : classifiedPairs;

  // Re-derive the verdict after filtering — a --changed-only run
  // shouldn't be blocked by a pair that the filter just dropped.
  let filteredBlocks = false;
  let filteredWarns = false;
  for (const p of filteredPairs) {
    if (p.classification.blocks) filteredBlocks = true;
    if (p.classification.warns) filteredWarns = true;
  }

  // Allowlist delta between the baseline's anchor SHA and the
  // current working tree. Surfaced in the markdown renderer so
  // PR reviewers see new suppressions being introduced; absent /
  // degenerate when the SHA isn't reachable (shallow clone, etc.)
  // and the renderer treats that as "delta unavailable."
  const allowlistDelta: AllowlistDelta = computeAllowlistDelta(cwd, baseline.repo.commitSha);

  return {
    baselinePath,
    baseline,
    current,
    matchResult,
    pairs: filteredPairs,
    envelopeDrift,
    policy,
    blocks: options.changedOnly ? filteredBlocks : blocks,
    warns: options.changedOnly ? filteredWarns : warns,
    allowlistDelta,
  };
}

/** Conventional location for a per-repo brownfield policy. Loaded
 *  automatically when present; can be overridden with `--policy`. */
const DEFAULT_POLICY_FILENAME = path.join('.dxkit', 'policy.json');

function resolvePolicy(policyPath: string | undefined, cwd: string): BrownfieldPolicy {
  // Resolution order:
  //   1. `--policy <path>` flag (explicit; errors if unreadable)
  //   2. `<cwd>/.dxkit/policy.json` (conventional; silently skipped
  //      when absent so consumers without a policy use the defaults)
  //   3. DEFAULT_BROWNFIELD_POLICY (compiled-in defaults)
  let resolvedPath: string | undefined = policyPath;
  if (!resolvedPath) {
    const conventional = path.join(cwd, DEFAULT_POLICY_FILENAME);
    if (fs.existsSync(conventional)) resolvedPath = conventional;
  }
  if (!resolvedPath) return DEFAULT_BROWNFIELD_POLICY;
  let raw: string;
  try {
    raw = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    throw new Error(`policy file not readable: ${resolvedPath} (${(err as Error).message})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`policy file is not valid JSON: ${resolvedPath} (${(err as Error).message})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`policy file root is not an object: ${resolvedPath}`);
  }
  // Shallow merge over the default. Per-field overrides win; unknown
  // fields are preserved (the classifier reads only the fields it
  // knows so unknowns are harmless).
  const obj = parsed as Partial<BrownfieldPolicy>;
  return {
    ...DEFAULT_BROWNFIELD_POLICY,
    ...obj,
    confidence: { ...DEFAULT_BROWNFIELD_POLICY.confidence, ...(obj.confidence ?? {}) },
    blockRules: { ...DEFAULT_BROWNFIELD_POLICY.blockRules, ...(obj.blockRules ?? {}) },
    block: obj.block ?? DEFAULT_BROWNFIELD_POLICY.block,
    warn: obj.warn ?? DEFAULT_BROWNFIELD_POLICY.warn,
    addedRequiresChangedLines:
      obj.addedRequiresChangedLines ?? DEFAULT_BROWNFIELD_POLICY.addedRequiresChangedLines,
    mode: 'brownfield',
  };
}

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
 * Build a per-kind map of "tools that produced this kind in the
 * current run." Used by the `scannerVersionDiffers` per-pair
 * computation: a pair is in tool drift only when one of the tools
 * that produced its kind has actually drifted version.
 */
function buildToolsByKind(
  aggregate: SecurityAggregate,
): Readonly<Partial<Record<BaselineEntry['kind'], ReadonlySet<string>>>> {
  const secretTool = aggregate.provenance.secrets.tool ?? undefined;
  const codeTool = aggregate.provenance.codePatterns.tool ?? undefined;
  const depTool = aggregate.provenance.depVulns.tool ?? undefined;
  const tlsBypassRan = aggregate.provenance.tlsBypass.ran;

  const codeTools = new Set<string>();
  if (codeTool) codeTools.add(codeTool);
  if (tlsBypassRan) codeTools.add('tls-bypass-registry');

  const secretTools = new Set<string>();
  if (secretTool) secretTools.add(secretTool);

  const depTools = new Set<string>();
  if (depTool) depTools.add(depTool);

  return {
    secret: secretTools,
    code: codeTools,
    config: secretTools, // .env-in-git + private-key files come from the secrets/file pass
    'dep-vuln': depTools,
    'secret-hmac': secretTools,
  };
}

function kindHasDriftingTool(
  kind: BaselineEntry['kind'],
  toolsByKind: Readonly<Partial<Record<BaselineEntry['kind'], ReadonlySet<string>>>>,
  drift: EnvelopeDrift,
): boolean {
  const tools = toolsByKind[kind];
  if (!tools || tools.size === 0) return false;
  for (const diff of drift.toolVersionDiffs) {
    if (tools.has(diff.tool)) return true;
  }
  return false;
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
  return {
    toolchainHashChanged: baseline.analysis.toolchainHash !== current.analysisMeta.toolchainHash,
    policyHashChanged: baseline.analysis.policyHash !== current.analysisMeta.policyHash,
    ignoreHashChanged: baseline.analysis.ignoreHash !== current.analysisMeta.ignoreHash,
    configHashChanged: baseline.analysis.configHash !== current.analysisMeta.configHash,
    dxkitVersionChanged: baseline.analysis.dxkitVersion !== current.analysisMeta.dxkitVersion,
    toolVersionDiffs,
  };
}

function locatorFile(entry: BaselineEntry): string | undefined {
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
    case 'dep-vuln':
    case 'license':
    case 'secret-hmac':
      return undefined;
  }
}

function locatorLine(entry: BaselineEntry): number | undefined {
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
    default:
      return undefined;
  }
}

/**
 * `--changed-only` filter predicate. Keeps:
 *   - pairs without a line locator (dep-vuln, license, duplication,
 *     etc.) — their identity isn't line-bound, so changed-line
 *     overlap doesn't apply
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

function readHeadSha(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Compute the set of HEAD-side line numbers modified between
 * `baseSha` and `headSha` for `file`. Used by the per-pair
 * `overlapsChangedLines` signal: a current-side finding at line N
 * overlaps the diff iff N is in this set.
 *
 * Walks `git diff --unified=0` hunks. Returns an empty set on any
 * failure (file missing in either revision, git unavailable, etc.).
 */
function readChangedLineSet(
  cwd: string,
  baseSha: string,
  headSha: string,
  file: string,
): Set<number> {
  const out = new Set<number>();
  let diff: string;
  try {
    diff = execFileSync(
      'git',
      ['diff', '--unified=0', '--no-color', '--find-renames', baseSha, headSha, '--', file],
      { cwd, encoding: 'utf8' },
    );
  } catch {
    return out;
  }
  if (!diff.trim()) return out;
  const hunkRe = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkRe.exec(diff)) !== null) {
    const newStart = parseInt(match[1], 10);
    const newCount = match[2] !== undefined ? parseInt(match[2], 10) : 1;
    if (newCount === 0) {
      // Pure-deletion hunk on the new side — no new-side lines.
      continue;
    }
    for (let i = 0; i < newCount; i++) out.add(newStart + i);
  }
  return out;
}
