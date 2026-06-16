/**
 * Semgrep integration — static code-pattern scanning.
 *
 * The `semgrepProvider` is registered in `GLOBAL_CAPABILITIES.codePatterns`
 * (src/languages/capabilities/global.ts). Semgrep runs once per repo with
 * a union of rulesets from every active language pack's `semgrepRulesets`
 * declaration plus the baseline `p/security-audit` OWASP ruleset.
 *
 * The provider does not run if no rulesets resolve (pure C# or similar
 * repos today — their pack declares `semgrepRulesets: []`). Adding
 * rulesets in future is purely declarative: a pack lists them, this
 * provider picks them up via `detectActiveLanguages(cwd)`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectActiveLanguages } from '../../languages';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { CodePatternFinding, CodePatternsResult } from '../../languages/capabilities/types';
import { getSemgrepExcludeFlags } from './exclusions';
import { spanHash } from './fingerprint';
import { toProjectRelative } from './paths';
import { runDetached } from './runner';
import { applySuppressions, loadSuppressions } from './suppressions';
import { findTool, TOOL_DEFS } from './tool-registry';

interface SemgrepRawFinding {
  check_id: string;
  path: string;
  start: { line: number };
  extra: {
    message: string;
    severity: string;
    /** The matched source span. Semgrep's JSON reporter populates
     *  `extra.lines` with the exact text of the matched region. Used to
     *  derive the content-anchored `spanHash` (D-G5) so a finding's
     *  identity tracks the matched construct, not its line number. May be
     *  absent / `requires login` on some rule sources; the gather treats
     *  a missing span as "no anchor" and falls back to line identity. */
    lines?: string;
    metadata?: {
      // semgrep rules emit `cwe` as either string OR string[] depending
      // on how the rule's YAML metadata block is written. Both shapes
      // appear in the public `p/security-audit` ruleset.
      cwe?: string | string[];
      confidence?: string;
      impact?: string;
    };
  };
}

interface SemgrepReport {
  results: SemgrepRawFinding[];
}

/**
 * Outcome union — same discriminated-kind shape as the other wrappers.
 * Lets the capability provider collapse to `CodePatternsResult | null`
 * and lets future report decompositions show meaningful
 * `toolsUnavailable` reasons.
 */
export type CodePatternsGatherOutcome =
  | { kind: 'success'; envelope: CodePatternsResult }
  | { kind: 'unavailable'; reason: string };

/**
 * Map semgrep's severity + impact to the project's four-tier model.
 * Priority: rule metadata `impact` (most meaningful — rule authors
 * tier by business impact) → fall back to semgrep's `severity`.
 */
/**
 * Normalize semgrep's `metadata.cwe` into a single CWE identifier.
 *
 * Why: semgrep rule authors write `cwe:` in YAML as either a scalar
 * (`cwe: "CWE-295: Improper Certificate Validation"`) or a list
 * (`cwe: ["CWE-295: ..."]`). Both shapes pass through semgrep's JSON
 * output unchanged. Pre-fix this code did `metadata?.cwe?.[0]` which
 * silently returned the first *character* of the scalar form (e.g.
 * "C" for "CWE-295: ..."). D094 surfaced this on `bypass-tls-
 * verification` rule output.
 */
export function extractCwe(cwe: string | string[] | undefined): string {
  if (!cwe) return '';
  const raw = Array.isArray(cwe) ? cwe[0] : cwe;
  if (typeof raw !== 'string') return '';
  return raw.split(':')[0].trim();
}

function mapSemgrepSeverity(sgSeverity: string, impact?: string): CodePatternFinding['severity'] {
  const imp = (impact || '').toUpperCase();
  if (imp === 'HIGH') return sgSeverity === 'ERROR' ? 'critical' : 'high';
  if (imp === 'MEDIUM') return 'medium';
  if (imp === 'LOW') return 'low';
  if (sgSeverity === 'ERROR') return 'high';
  if (sgSeverity === 'WARNING') return 'medium';
  return 'low';
}

/**
 * Collect semgrep rulesets to invoke for this repo.
 *
 * Base `p/security-audit` covers OWASP Top 10 across all languages.
 * Each active pack contributes its own rulesets declaratively via
 * `LanguageSupport.semgrepRulesets` — the provider unions them and
 * deduplicates so switching a pack's rulesets is a one-line edit.
 */
function collectRulesets(cwd: string): string[] {
  const rulesets = new Set<string>(['p/security-audit']);
  for (const pack of detectActiveLanguages(cwd)) {
    for (const r of pack.semgrepRulesets) rulesets.add(r);
  }
  return [...rulesets];
}

/**
 * Single source of truth for the semgrep invocation. Consumed by
 * `semgrepProvider` (capability dispatcher).
 *
 * Failure-mode honesty: when semgrep doesn't produce a parseable
 * report, the returned `reason` distinguishes between:
 *   - timeout (we hit our wall-clock budget — the customer probably
 *     wants to install nothing and instead either prune the scan
 *     scope via `.dxkit-ignore` or bump the timeout)
 *   - non-zero exit with a captured stderr first line (semgrep
 *     itself complained — surface its complaint)
 *   - the historical fallback "no output" (rare now; means stderr
 *     was empty AND exit was zero AND the report file was missing)
 *
 * Pre-fix every failure collapsed to "no output," masking
 * resource-contention deaths (parallel jscpd + graphify + semgrep
 * on a 700-file repo OOM-killing the youngest), timeouts, and
 * config-parse errors with the same useless string. Switched to
 * runDetached so we capture stderr + exit code + timeout signal
 * separately, and so the wall-clock-deadline kill cleans up
 * grandchildren (semgrep's internal worker pool).
 */
export async function gatherSemgrepResult(cwd: string): Promise<CodePatternsGatherOutcome> {
  const status = findTool(TOOL_DEFS.semgrep, cwd);
  if (!status.available || !status.path) return { kind: 'unavailable', reason: 'not installed' };

  const rulesets = collectRulesets(cwd);
  if (rulesets.length === 0) return { kind: 'unavailable', reason: 'no rulesets' };

  const reportPath = path.join(os.tmpdir(), `dxkit-semgrep-${Date.now()}.json`);
  const args = ['scan'];
  for (const r of rulesets) args.push('--config', r);
  args.push('--json', '--quiet', '--output', reportPath);
  // getSemgrepExcludeFlags returns a single space-separated string
  // shaped for execSync (`--exclude foo --exclude bar`). Split it
  // into the array form runDetached expects.
  const excludeFlagString = getSemgrepExcludeFlags(cwd);
  if (excludeFlagString) {
    for (const tok of excludeFlagString.split(/\s+/).filter((t) => t.length > 0)) {
      args.push(tok);
    }
  }
  args.push(cwd);

  const outcome = await runDetached(status.path, args, { cwd, timeoutMs: 300000 });
  let raw: string;
  try {
    raw = fs.readFileSync(reportPath, 'utf-8');
  } catch {
    raw = '';
  }
  // Cleanup: best-effort; failure here is non-fatal.
  try {
    fs.unlinkSync(reportPath);
  } catch {
    /* file already gone or never written — fine */
  }

  if (!raw) {
    if (outcome.timedOut) {
      return {
        kind: 'unavailable',
        reason: 'timed out at 300s (try narrowing scan scope via .dxkit-ignore)',
      };
    }
    const stderrFirstLine = outcome.stderr
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (outcome.code !== 0 && outcome.code !== null) {
      const ctx = stderrFirstLine ? ` (stderr: ${stderrFirstLine})` : '';
      return { kind: 'unavailable', reason: `exit code ${outcome.code}${ctx}` };
    }
    if (stderrFirstLine) {
      return { kind: 'unavailable', reason: `no output (stderr: ${stderrFirstLine})` };
    }
    return { kind: 'unavailable', reason: 'no output' };
  }

  let data: SemgrepReport;
  try {
    data = JSON.parse(raw) as SemgrepReport;
  } catch {
    return { kind: 'unavailable', reason: 'parse error' };
  }
  if (!Array.isArray(data.results)) {
    const envelope: CodePatternsResult = {
      schemaVersion: 1,
      tool: 'semgrep',
      findings: [],
      suppressedCount: 0,
    };
    return { kind: 'success', envelope };
  }

  const raw_findings: CodePatternFinding[] = data.results
    // Skip LOW confidence (high false-positive rate); preserves the
    // pre-10e behaviour exactly.
    .filter((r) => (r.extra.metadata?.confidence || '').toUpperCase() !== 'LOW')
    .map((r) => ({
      severity: mapSemgrepSeverity(r.extra.severity, r.extra.metadata?.impact),
      rule: r.check_id.split('.').slice(-1)[0],
      title: r.extra.message.split('\n')[0].slice(0, 200),
      cwe: extractCwe(r.extra.metadata?.cwe),
      file: toProjectRelative(cwd, r.path),
      line: r.start.line,
      // D-G5 content anchor: hash the matched span here at the gather
      // boundary and carry only the digest. A missing / placeholder span
      // ("requires login") yields no anchor → line-based fallback.
      ...(typeof r.extra.lines === 'string' && r.extra.lines.trim().length > 0
        ? { spanHash: spanHash(r.extra.lines) }
        : {}),
    }));

  // Apply `.dxkit-suppressions.json` so known false positives can be
  // dropped without editing the ruleset.
  const suppressions = loadSuppressions(cwd);
  const { kept, suppressed } = applySuppressions(
    raw_findings,
    suppressions.semgrep,
    (f) => f.rule,
    (f) => f.file,
  );

  const envelope: CodePatternsResult = {
    schemaVersion: 1,
    tool: 'semgrep',
    findings: kept,
    suppressedCount: suppressed.length,
  };
  return { kind: 'success', envelope };
}

/**
 * Capability-shaped provider. Registered in
 * `src/languages/capabilities/global.ts:GLOBAL_CAPABILITIES.codePatterns`.
 */
// Exposes the underlying outcome via `gatherOutcome` so the dispatcher
// captures semgrep's actual failure reason (timeout / exit code /
// stderr first line) into `DispatchOutcome.skipReasons`. Without it,
// every failure modes collapses to the same generic "attempted but
// produced no output" prose at the renderer layer.
export const semgrepProvider: CapabilityProvider<CodePatternsResult> & {
  gatherOutcome(cwd: string): Promise<CodePatternsGatherOutcome>;
} = {
  source: 'semgrep',
  async gather(cwd) {
    const outcome = await gatherSemgrepResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherSemgrepResult(cwd);
  },
};
