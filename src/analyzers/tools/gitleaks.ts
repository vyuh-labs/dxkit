/**
 * Gitleaks integration — secret scanning with 800+ patterns.
 *
 * Exposes one gather helper — `gatherGitleaksResult(cwd)` — returning a
 * typed outcome with either a `SecretsResult` envelope or the reason
 * scanning was skipped. Consumed by the capability provider
 * (`gitleaksProvider`) and by the Layer 2 legacy-field reshape path in
 * `tools/parallel.ts`. Memoized per-cwd so both callers share one
 * invocation per analyzer run.
 */
import { run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { isExcludedPath } from './exclusions';
import { toProjectRelative } from './paths';
import { applySuppressions, loadSuppressions } from './suppressions';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { SecretFinding, SecretsResult } from '../../languages/capabilities/types';

interface GitleaksFinding {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  Secret: string;
}

/**
 * Outcome union mirroring the other capability bridge types in the
 * language packs. The capability provider collapses this to
 * `SecretsResult | null`; the legacy bridge reads the `unavailable`
 * reason so `toolsUnavailable` strings stay stable.
 */
export type SecretsGatherOutcome =
  | { kind: 'success'; envelope: SecretsResult; suppressedCount: number }
  | { kind: 'unavailable'; reason: string };

/**
 * Per-cwd memoization of the gitleaks outcome. Gitleaks is a ~1-5s shell
 * invocation; memoizing ensures the Layer 2 reshape path + the capability
 * dispatcher's `gitleaksProvider` both hit the same computed outcome
 * within one `analyzeHealth` call. Tests can reset via `clearGitleaksCache`.
 *
 * Cache is module-scoped and not invalidated automatically — safe for
 * dxkit's one-shot CLI shape (single cwd per process) and for the one
 * analyzer that exercises two paths to the same cwd (parallel.ts +
 * gatherCapabilityReport). Future long-running modes (diff, daemon)
 * that re-analyze the same cwd should call `clearGitleaksCache(cwd)`
 * between runs.
 */
const gitleaksOutcomeCache = new Map<string, SecretsGatherOutcome>();

/** Reset memoized gitleaks outcomes. Test seam; no production callers. */
export function clearGitleaksCache(cwd?: string): void {
  if (cwd === undefined) gitleaksOutcomeCache.clear();
  else gitleaksOutcomeCache.delete(cwd);
}

/**
 * Single source of truth for secret-scanning via gitleaks. Consumed by
 * `gitleaksProvider` (capability dispatcher) and by the Layer 2 legacy
 * reshape in `tools/parallel.ts` — both paths share the memoized
 * per-cwd outcome so gitleaks shells out at most once per analyzer run.
 */
export function gatherGitleaksResult(cwd: string): SecretsGatherOutcome {
  const cached = gitleaksOutcomeCache.get(cwd);
  if (cached) return cached;
  const outcome = computeGitleaksOutcome(cwd);
  gitleaksOutcomeCache.set(cwd, outcome);
  return outcome;
}

function computeGitleaksOutcome(cwd: string): SecretsGatherOutcome {
  const gitleaksCmd = findGitleaks(cwd);
  if (!gitleaksCmd) return { kind: 'unavailable', reason: 'not installed' };

  // Run gitleaks with JSON report (--no-git scans files, not git history).
  const reportPath = `/tmp/dxkit-gitleaks-${Date.now()}.json`;
  run(
    `${gitleaksCmd} detect --source '${cwd}' --report-format json --report-path '${reportPath}' --no-git --exit-code 0 2>/dev/null`,
    cwd,
    120000,
  );
  const reportRaw = run(`cat '${reportPath}' 2>/dev/null`, cwd);
  run(`rm -f '${reportPath}'`, cwd);

  if (!reportRaw) return { kind: 'unavailable', reason: 'no output' };

  let parsed: GitleaksFinding[];
  try {
    parsed = JSON.parse(reportRaw) as GitleaksFinding[];
  } catch {
    return { kind: 'unavailable', reason: 'parse error' };
  }
  if (!Array.isArray(parsed)) {
    // gitleaks returned non-array JSON (malformed); treat as zero findings.
    const envelope: SecretsResult = {
      schemaVersion: 1,
      tool: 'gitleaks',
      findings: [],
      suppressedCount: 0,
    };
    return { kind: 'success', envelope, suppressedCount: 0 };
  }

  const raw: SecretFinding[] = parsed.map((f) => ({
    file: toProjectRelative(cwd, f.File),
    line: f.StartLine,
    rule: f.RuleID,
    severity: f.RuleID.includes('private-key') ? 'critical' : 'high',
    title: f.Description,
  }));

  // Gitleaks --no-git scans everything on disk (ignores .gitignore), so
  // we re-apply the resolved exclusion set via isExcludedPath().
  const filtered = raw.filter((d) => !isExcludedPath(cwd, d.file));

  // Apply `.dxkit-suppressions.json` so known-false positives don't count.
  const suppressions = loadSuppressions(cwd);
  const { kept, suppressed } = applySuppressions(
    filtered,
    suppressions.gitleaks,
    (d) => d.rule,
    (d) => d.file,
  );

  const envelope: SecretsResult = {
    schemaVersion: 1,
    tool: 'gitleaks',
    findings: kept,
    suppressedCount: suppressed.length,
  };
  return { kind: 'success', envelope, suppressedCount: suppressed.length };
}

/**
 * Capability-shaped provider. Register in
 * `src/languages/capabilities/global.ts:GLOBAL_CAPABILITIES` so the
 * dispatcher picks it up via `providersFor(SECRETS)`.
 */
export const gitleaksProvider: CapabilityProvider<SecretsResult> = {
  source: 'gitleaks',
  async gather(cwd) {
    const outcome = gatherGitleaksResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

function findGitleaks(cwd: string): string | null {
  const status = findTool(TOOL_DEFS.gitleaks, cwd);
  return status.available ? status.path : null;
}
