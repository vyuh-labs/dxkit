/**
 * Layer 2 orchestrator — populates the legacy `HealthMetrics` fields that
 * live outside the per-pack `gatherMetrics` channel (cloc line counts,
 * gitleaks secret counts, graphify AST stats).
 *
 * Phase 10e.C.3: rewritten from a child-process + bash orchestration into
 * direct in-process calls to the memoized outcome helpers
 * (`gatherGitleaksResult`, `gatherGraphifyResult`) + the synchronous
 * `gatherClocMetrics`. Gitleaks and graphify are memoized per-cwd at the
 * helper level, so the capability dispatcher's later `SECRETS` /
 * `STRUCTURAL` calls in `gatherCapabilityReport` hit cached outcomes —
 * each tool runs exactly once per analyzer run rather than twice (the
 * pre-C.3 state shelled out once here via a child process and again from
 * the dispatcher's provider).
 *
 * Tradeoff: we lose the OS-level parallelism the old bash `&` + `wait`
 * scheme gave us. For dxkit-sized repos the heavy tool is graphify
 * (~10-30s); cloc and gitleaks add a second or two on top. The three are
 * now serial in one process. 10f will reintroduce parallelism via async
 * runners when the underlying tool invocations themselves are
 * event-loop-safe — the current blocking `execSync` calls defeat any
 * `Promise.all` scheme without an out-of-process scheduler.
 *
 * Keeps the sync signature — callers in `analyzers/health.ts` wrap with
 * `timed()`, not `timedAsync()`. Legacy field shape is byte-identical to
 * pre-C.3, including the exact `toolsUnavailable` phrasings.
 */
import { HealthMetrics } from '../types';
import { gatherClocMetrics } from './cloc';
import { gatherGitleaksResult, SecretsGatherOutcome } from './gitleaks';
import { gatherGraphifyResult, StructuralGatherOutcome } from './graphify';

export function gatherLayer2Parallel(cwd: string, _verbose = false): Partial<HealthMetrics> {
  const clocPartial = gatherClocMetrics(cwd);
  const gitleaksOutcome = gatherGitleaksResult(cwd);
  const graphifyOutcome = gatherGraphifyResult(cwd);

  const merged: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };
  mergePartial(merged, clocPartial);
  mergePartial(merged, reshapeGitleaks(gitleaksOutcome));
  mergePartial(merged, reshapeGraphify(graphifyOutcome));
  return merged;
}

/**
 * Merge a sub-result into the accumulator. Arrays (`toolsUsed`,
 * `toolsUnavailable`) are appended; every other non-null field
 * overwrites. Non-null-only rule matches the pre-C.3 parent-process
 * merger behavior exactly.
 */
function mergePartial(merged: Partial<HealthMetrics>, partial: Partial<HealthMetrics>): void {
  for (const [key, value] of Object.entries(partial)) {
    if (value === null || value === undefined) continue;
    if (key === 'toolsUsed' && Array.isArray(value)) {
      (merged.toolsUsed as string[]).push(...(value as string[]));
    } else if (key === 'toolsUnavailable' && Array.isArray(value)) {
      (merged.toolsUnavailable as string[]).push(...(value as string[]));
    } else {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
}

/**
 * Reshape a gitleaks outcome into the legacy `HealthMetrics` subset.
 * Preserves the exact pre-C.3 strings for `toolsUnavailable`:
 *   - `gitleaks` when not installed
 *   - `gitleaks (<reason>)` for every other failure mode.
 */
function reshapeGitleaks(outcome: SecretsGatherOutcome): Partial<HealthMetrics> {
  if (outcome.kind === 'unavailable') {
    const label = outcome.reason === 'not installed' ? 'gitleaks' : `gitleaks (${outcome.reason})`;
    return { toolsUnavailable: [label] };
  }
  return {
    secretFindings: outcome.envelope.findings.length,
    secretDetails: outcome.envelope.findings.map((f) => ({
      file: f.file,
      line: f.line,
      rule: f.rule,
      severity: f.severity,
    })),
    secretSuppressed: outcome.suppressedCount,
    toolsUsed: ['gitleaks'],
  };
}

/**
 * Reshape a graphify outcome into the legacy `HealthMetrics` subset.
 * Preserves the exact pre-C.3 `toolsUnavailable` strings:
 * `graphify (not installed)`, `graphify (failed to run)`,
 * `graphify (no JSON output)`, `graphify (parse error)`, etc.
 */
function reshapeGraphify(outcome: StructuralGatherOutcome): Partial<HealthMetrics> {
  if (outcome.kind === 'unavailable') {
    return { toolsUnavailable: [`graphify (${outcome.reason})`] };
  }
  const e = outcome.envelope;
  return {
    functionCount: e.functionCount,
    classCount: e.classCount,
    maxFunctionsInFile: e.maxFunctionsInFile,
    maxFunctionsFilePath: e.maxFunctionsFilePath,
    godNodeCount: e.godNodeCount,
    communityCount: e.communityCount,
    avgCohesion: e.avgCohesion,
    orphanModuleCount: e.orphanModuleCount,
    deadImportCount: e.deadImportCount,
    commentedCodeRatio: e.commentedCodeRatio,
    toolsUsed: ['graphify'],
  };
}
