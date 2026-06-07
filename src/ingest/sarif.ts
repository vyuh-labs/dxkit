/**
 * SARIF 2.1.0 → `ExternalFinding[]`.
 *
 * SARIF is the lingua franca of SAST: CodeQL, Snyk Code (`snyk code
 * test --sarif`), Semgrep Pro, and Bearer all emit it. Parsing it once
 * here means every current and future interprocedural engine funnels
 * into dxkit through the same door — the engine-agnostic core of the
 * deep-SAST tier.
 *
 * Severity resolution prefers the numeric `security-severity` property
 * (a CVSS-style 0–10 score most security rules carry) and falls back to
 * the SARIF result `level`. CWE comes from the rule's `tags`
 * (`external/cwe/cwe-022` → `CWE-22`). Rules can live on the driver or
 * on a tool extension (CodeQL puts the query pack's rules under
 * `extensions`), so we index both.
 *
 * Pure + defensive: a malformed run, a result with no location, or a
 * missing rule never throws — it's skipped or filled with a safe
 * default, because ingestion runs against third-party output we don't
 * control.
 */
import type { SourceEngine, ExternalFinding } from './types';
import type { Severity } from '../analyzers/security/types';

interface SarifRule {
  id?: string;
  name?: string;
  properties?: {
    'security-severity'?: string | number;
    'problem.severity'?: string;
    tags?: string[];
  };
  shortDescription?: { text?: string };
}

interface SarifResult {
  ruleId?: string;
  rule?: { id?: string; index?: number };
  level?: string;
  message?: { text?: string };
  locations?: Array<{
    physicalLocation?: {
      artifactLocation?: { uri?: string };
      region?: { startLine?: number };
    };
  }>;
}

interface SarifRun {
  tool?: {
    driver?: { name?: string; rules?: SarifRule[] };
    extensions?: Array<{ rules?: SarifRule[] }>;
  };
  results?: SarifResult[];
}

interface SarifLog {
  runs?: SarifRun[];
}

/** Map a SARIF tool driver name to a known engine, when the caller
 *  didn't pass one explicitly. Unknown drivers fall back to the generic
 *  `sarif` engine so attribution is still honest. */
function engineFromDriver(name: string | undefined): SourceEngine {
  const n = (name || '').toLowerCase();
  if (n.includes('codeql')) return 'codeql';
  if (n.includes('snyk')) return 'snyk-code';
  if (n.includes('semgrep')) return 'semgrep-pro';
  return 'sarif';
}

/** `external/cwe/cwe-022` (or `CWE-022`) → `CWE-22`. Returns '' when no
 *  CWE tag is present. Leading zeros are stripped so the id matches the
 *  canonical `CWE-<n>` form used elsewhere in dxkit. */
function cweFromTags(tags: string[] | undefined): string {
  if (!tags) return '';
  for (const tag of tags) {
    const m = /cwe[-/_]?(\d+)/i.exec(tag);
    if (m) return `CWE-${parseInt(m[1], 10)}`;
  }
  return '';
}

/** Resolve four-tier severity. Prefer numeric `security-severity`
 *  (CVSS-like 0–10); else the rule's `problem.severity`; else the
 *  result `level`. */
function resolveSeverity(rule: SarifRule | undefined, level: string | undefined): Severity {
  const num = rule?.properties?.['security-severity'];
  if (num !== undefined && num !== null && num !== '') {
    const score = typeof num === 'number' ? num : parseFloat(String(num));
    if (!Number.isNaN(score)) {
      if (score >= 9.0) return 'critical';
      if (score >= 7.0) return 'high';
      if (score >= 4.0) return 'medium';
      return 'low';
    }
  }
  const ps = rule?.properties?.['problem.severity'];
  if (ps === 'error') return 'high';
  if (ps === 'warning' || ps === 'recommendation') return 'medium';
  // SARIF result level is the last resort.
  if (level === 'error') return 'high';
  if (level === 'note') return 'low';
  if (level === 'warning') return 'medium';
  return 'medium';
}

/**
 * Parse a SARIF 2.1.0 document. `engine` overrides the auto-detected
 * driver name (callers usually know which engine produced the file);
 * pass `undefined` to infer from the SARIF tool driver.
 */
export function parseSarif(raw: string, engine?: SourceEngine): ExternalFinding[] {
  let log: SarifLog;
  try {
    log = JSON.parse(raw) as SarifLog;
  } catch {
    return [];
  }
  const out: ExternalFinding[] = [];
  for (const run of log.runs || []) {
    const driverName = run.tool?.driver?.name;
    const resolvedEngine = engine ?? engineFromDriver(driverName);

    // Index rules by id from driver + every extension.
    const rulesById = new Map<string, SarifRule>();
    const ruleLists: SarifRule[][] = [];
    if (run.tool?.driver?.rules) ruleLists.push(run.tool.driver.rules);
    for (const ext of run.tool?.extensions || []) {
      if (ext.rules) ruleLists.push(ext.rules);
    }
    const flatRules: SarifRule[] = [];
    for (const list of ruleLists) {
      for (const r of list) {
        flatRules.push(r);
        if (r.id) rulesById.set(r.id, r);
      }
    }

    for (const res of run.results || []) {
      const ruleId = res.ruleId || res.rule?.id;
      // Rule can be referenced by id or by index into the (flattened) list.
      let rule: SarifRule | undefined = ruleId ? rulesById.get(ruleId) : undefined;
      if (!rule && typeof res.rule?.index === 'number') rule = flatRules[res.rule.index];

      const loc = res.locations?.[0]?.physicalLocation;
      const file = loc?.artifactLocation?.uri;
      const line = loc?.region?.startLine;
      // A finding with no source location can't be fingerprinted or
      // fixed — skip rather than emit a phantom at line 0.
      if (!file || !line) continue;

      out.push({
        engine: resolvedEngine,
        severity: resolveSeverity(rule, res.level),
        category: 'code',
        cwe: cweFromTags(rule?.properties?.tags),
        rule: ruleId || rule?.name || 'unknown',
        title: res.message?.text || rule?.shortDescription?.text || ruleId || 'SAST finding',
        file,
        line,
      });
    }
  }
  return out;
}
