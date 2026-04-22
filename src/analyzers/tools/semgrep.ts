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

import { detectActiveLanguages } from '../../languages';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { CodePatternFinding, CodePatternsResult } from '../../languages/capabilities/types';
import { getSemgrepExcludeFlags } from './exclusions';
import { toProjectRelative } from './paths';
import { run } from './runner';
import { applySuppressions, loadSuppressions } from './suppressions';
import { findTool, TOOL_DEFS } from './tool-registry';

interface SemgrepRawFinding {
  check_id: string;
  path: string;
  start: { line: number };
  extra: {
    message: string;
    severity: string;
    metadata?: {
      cwe?: string[];
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
 */
export function gatherSemgrepResult(cwd: string): CodePatternsGatherOutcome {
  const status = findTool(TOOL_DEFS.semgrep, cwd);
  if (!status.available || !status.path) return { kind: 'unavailable', reason: 'not installed' };

  const rulesets = collectRulesets(cwd);
  if (rulesets.length === 0) return { kind: 'unavailable', reason: 'no rulesets' };

  const configs = rulesets.map((r) => `--config ${r}`).join(' ');
  const excludes = getSemgrepExcludeFlags(cwd);
  const reportPath = `/tmp/dxkit-semgrep-${Date.now()}.json`;

  run(
    `${status.path} scan ${configs} --json --quiet --output '${reportPath}' ${excludes} '${cwd}' 2>/dev/null`,
    cwd,
    300000,
  );
  const raw = run(`cat '${reportPath}' 2>/dev/null`, cwd);
  run(`rm -f '${reportPath}'`, cwd);

  if (!raw) return { kind: 'unavailable', reason: 'no output' };

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
      cwe: r.extra.metadata?.cwe?.[0]?.split(':')[0] || '',
      file: toProjectRelative(cwd, r.path),
      line: r.start.line,
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
export const semgrepProvider: CapabilityProvider<CodePatternsResult> = {
  source: 'semgrep',
  async gather(cwd) {
    const outcome = gatherSemgrepResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};
