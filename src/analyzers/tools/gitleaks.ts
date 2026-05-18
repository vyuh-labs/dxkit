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
import * as fs from 'fs';
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
 * Per-finding raw value carried alongside the public envelope. Stays
 * out of `SecretsResult` (and therefore out of `SecurityAggregate`,
 * `SecurityReport`, the dashboard, JSON outputs) so the secret value
 * never leaks through the normal reporting surfaces. The only legit
 * consumer is the baseline-side secret-HMAC producer, which immediately
 * HMACs the value and discards it.
 *
 * Lives in this outcome rather than fetched separately so the memoized
 * gitleaks invocation (`gatherGitleaksResult` runs at most once per
 * cwd) covers both the public envelope path and the HMAC path.
 */
export interface GitleaksRawSecret {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  /** The matched secret value as reported by gitleaks. Process-only;
   *  callers MUST NOT write this to disk, log it, or include it in
   *  any output payload. */
  readonly secret: string;
}

/**
 * Outcome union used by `gatherGitleaksResult`. The capability provider
 * collapses this to `SecretsResult | null`; the Layer 2 reshape in
 * `tools/parallel.ts` reads `unavailable.reason` so the
 * `toolsUnavailable` strings carry install-missing vs parse-failure
 * detail. The `rawSecrets` field is read only by the baseline-side
 * secret-HMAC producer; other consumers ignore it.
 */
export type SecretsGatherOutcome =
  | {
      kind: 'success';
      envelope: SecretsResult;
      suppressedCount: number;
      rawSecrets: ReadonlyArray<GitleaksRawSecret>;
    }
  | { kind: 'unavailable'; reason: string };

/**
 * Per-cwd memoization of the gitleaks outcome. Gitleaks is a ~1-5s shell
 * invocation; memoizing ensures the Layer 2 reshape path + the capability
 * dispatcher's `gitleaksProvider` both hit the same computed outcome
 * within one `analyzeHealth` call.
 *
 * Cache is module-scoped and not invalidated automatically — safe for
 * dxkit's one-shot CLI shape (single cwd per process) and for the one
 * analyzer that exercises two paths to the same cwd (parallel.ts +
 * gatherCapabilityReport). Future long-running modes (diff, daemon)
 * that re-analyze the same cwd will need a clear-cache seam here.
 */
const gitleaksOutcomeCache = new Map<string, SecretsGatherOutcome>();

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
  // Read the report file directly. Pre-fix this used `run('cat
  // <path>')` which routed through execSync — large reports on
  // enterprise codebases would exceed the 1MB default maxBuffer and
  // silently return empty (same bug class as jscpd.ts). Direct file
  // read sidesteps the buffer entirely; gitleaks reports on
  // enterprise repos can reach MB-range when many findings are
  // surfaced.
  let reportRaw: string;
  try {
    reportRaw = fs.readFileSync(reportPath, 'utf-8');
  } catch {
    reportRaw = '';
  }
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
    return { kind: 'success', envelope, suppressedCount: 0, rawSecrets: [] };
  }

  // Carry the raw `Secret` value alongside each `SecretFinding` through
  // filter + suppression so the surviving entries pair 1:1 with their
  // captured value. The raw value never enters the public envelope.
  type Combined = { finding: SecretFinding; secret: string };
  const combined: Combined[] = parsed.map((f) => ({
    finding: {
      file: toProjectRelative(cwd, f.File),
      line: f.StartLine,
      rule: f.RuleID,
      severity: f.RuleID.includes('private-key') ? 'critical' : 'high',
      title: f.Description,
    },
    secret: f.Secret,
  }));

  // Gitleaks --no-git scans everything on disk (ignores .gitignore), so
  // we re-apply the resolved exclusion set via isExcludedPath().
  const filteredCombined = combined.filter((c) => !isExcludedPath(cwd, c.finding.file));

  // Apply `.dxkit-suppressions.json` so known-false positives don't count.
  const suppressions = loadSuppressions(cwd);
  const { kept, suppressed } = applySuppressions(
    filteredCombined,
    suppressions.gitleaks,
    (c) => c.finding.rule,
    (c) => c.finding.file,
  );

  const envelope: SecretsResult = {
    schemaVersion: 1,
    tool: 'gitleaks',
    findings: kept.map((c) => c.finding),
    suppressedCount: suppressed.length,
  };
  const rawSecrets: GitleaksRawSecret[] = kept.map((c) => ({
    file: c.finding.file,
    line: c.finding.line,
    rule: c.finding.rule,
    secret: c.secret,
  }));
  return { kind: 'success', envelope, suppressedCount: suppressed.length, rawSecrets };
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
