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
import { spanHash } from '../analyzers/tools/fingerprint';

interface SarifRule {
  id?: string;
  name?: string;
  properties?: {
    'security-severity'?: string | number;
    'problem.severity'?: string;
    tags?: string[];
    /** Snyk Code SARIF puts CWE(s) in a dedicated array here
     *  (e.g. `["CWE-94"]`), not in `tags` like CodeQL does. */
    cwe?: string[];
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
      // `snippet.text` is SARIF's matched-source span — the cross-engine
      // analog of semgrep's `extra.lines`. Used to derive the
      // content-anchored `spanHash` (D-G5) so an ingested finding's
      // identity tracks the matched construct, not its line.
      region?: { startLine?: number; snippet?: { text?: string } };
    };
  }>;
  /** SARIF 2.1.0 suppression state. A result an engine has dismissed —
   *  Snyk Code via the Snyk UI / API, CodeQL via a dismissed alert,
   *  Semgrep Pro via a triage action — carries one or more suppression
   *  entries. `status` defaults to `accepted` when absent (per spec);
   *  `underReview` / `rejected` mean the dismissal is not in effect. */
  suppressions?: Array<{ kind?: string; status?: string; justification?: string }>;
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

/** Normalize any CWE-ish string to canonical `CWE-<n>` (leading zeros
 *  stripped), or '' when none present. */
function normalizeCwe(s: string | undefined): string {
  if (!s) return '';
  const m = /cwe[-/_]?(\d+)/i.exec(s);
  return m ? `CWE-${parseInt(m[1], 10)}` : '';
}

/** Resolve the CWE for a rule across engine conventions:
 *  Snyk Code uses `properties.cwe: ["CWE-94"]`; CodeQL uses
 *  `properties.tags: ["external/cwe/cwe-094"]`. Checks both. */
function cweFromRule(rule: SarifRule | undefined): string {
  const direct = rule?.properties?.cwe;
  if (Array.isArray(direct)) {
    for (const c of direct) {
      const n = normalizeCwe(c);
      if (n) return n;
    }
  }
  for (const tag of rule?.properties?.tags ?? []) {
    const n = normalizeCwe(tag);
    if (n) return n;
  }
  return '';
}

/**
 * Whether a SARIF result has been dismissed upstream. True when it
 * carries at least one suppression whose status is `accepted` — SARIF
 * treats an absent `status` as `accepted`, while `underReview` and
 * `rejected` mean the suppression is NOT yet (or no longer) in effect.
 *
 * Honoring this keeps dxkit's ingest in sync with the engine's own
 * ignore state: a finding a developer dismissed in Snyk / CodeQL does
 * not re-surface here as a fresh active finding. The decision was
 * already reviewed in the engine that owns it, so dxkit drops it rather
 * than re-litigating it.
 */
function isResultSuppressed(res: SarifResult): boolean {
  const s = res.suppressions;
  if (!Array.isArray(s) || s.length === 0) return false;
  return s.some((entry) => entry.status === undefined || entry.status === 'accepted');
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
      // Honor the engine's own dismissal — a finding suppressed in Snyk
      // / CodeQL / Semgrep Pro must not re-surface in dxkit.
      if (isResultSuppressed(res)) continue;

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

      // D-G5 content anchor: hash the matched snippet here at the ingest
      // boundary, so an ingested finding earns the same line-independent
      // identity as a native one (Rule 13). Absent snippet → no anchor →
      // line fallback, exactly like a native source with no span.
      const snippetText = loc?.region?.snippet?.text;

      out.push({
        engine: resolvedEngine,
        severity: resolveSeverity(rule, res.level),
        category: 'code',
        cwe: cweFromRule(rule),
        rule: ruleId || rule?.name || 'unknown',
        title: res.message?.text || rule?.shortDescription?.text || ruleId || 'SAST finding',
        file,
        line,
        ...(typeof snippetText === 'string' && snippetText.trim().length > 0
          ? { spanHash: spanHash(snippetText) }
          : {}),
      });
    }
  }
  return out;
}
