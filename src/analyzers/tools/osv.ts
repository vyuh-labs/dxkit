/**
 * OSV.dev severity enrichment.
 *
 * Several dependency scanners (pip-audit, govulncheck) report vulnerabilities
 * without per-finding severity tiers. This module looks up the vulnerability
 * IDs against https://api.osv.dev/v1/vulns/{id} and classifies them into
 * critical/high/medium/low buckets.
 *
 * Offline safety: if the API is unreachable or an ID is unknown, the caller
 * falls back to a default bucket (pip-audit → medium, govulncheck → high).
 * The analyzer must never fail because OSV was slow.
 */

import { parseCvssV4BaseScore } from './cvss-v4';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface OsvVuln {
  id?: string;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: { severity?: string };
  affected?: Array<{
    severity?: Array<{ type: string; score: string }>;
  }>;
}

/** Process-scoped cache so repeated lookups in a session don't re-query. */
const cache = new Map<string, Severity>();

/** NVD CVSS 3.x base-score bands. */
export function scoreToTier(score: number): Severity {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  if (score > 0.0) return 'low';
  return 'unknown';
}

/**
 * Minimal CVSS v3.0/3.1 base-score calculator.
 * Spec: https://www.first.org/cvss/v3.1/specification-document#7-1-Base-Metrics-Equations
 * Returns null if the vector is malformed or missing required metrics.
 */
export function parseCvssV3BaseScore(vector: string): number | null {
  if (!vector.startsWith('CVSS:3.')) return null;
  const parts = new Map<string, string>();
  for (const kv of vector.split('/').slice(1)) {
    const [k, v] = kv.split(':');
    if (k && v) parts.set(k, v);
  }

  // Required base metrics
  const AV = parts.get('AV');
  const AC = parts.get('AC');
  const PR = parts.get('PR');
  const UI = parts.get('UI');
  const S = parts.get('S');
  const C = parts.get('C');
  const I = parts.get('I');
  const A = parts.get('A');
  if (!AV || !AC || !PR || !UI || !S || !C || !I || !A) return null;

  const avWeights: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
  const acWeights: Record<string, number> = { L: 0.77, H: 0.44 };
  const prUnchanged: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
  const prChanged: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
  const uiWeights: Record<string, number> = { N: 0.85, R: 0.62 };
  const ciaWeights: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

  const av = avWeights[AV];
  const ac = acWeights[AC];
  const pr = S === 'C' ? prChanged[PR] : prUnchanged[PR];
  const ui = uiWeights[UI];
  const conf = ciaWeights[C];
  const integ = ciaWeights[I];
  const avail = ciaWeights[A];
  if ([av, ac, pr, ui, conf, integ, avail].some((x) => x === undefined)) return null;

  const iss = 1 - (1 - conf) * (1 - integ) * (1 - avail);
  const impact = S === 'C' ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av * ac * pr * ui;
  const raw = S === 'C' ? 1.08 * (impact + exploitability) : impact + exploitability;
  const base = Math.min(raw, 10);
  // CVSS "round up to one decimal" (ceil to nearest 0.1)
  return Math.ceil(base * 10) / 10;
}

/** Classify a single OSV record. Prefers CVSS vector, then database_specific string. */
export function classifyOsvSeverity(vuln: OsvVuln): Severity {
  // Collect CVSS_V4 + CVSS_V3 entries (top level and inside affected[].severity[]).
  // V4 is preferred when available since modern CVEs (2025+) increasingly use V4 only.
  const v4: string[] = [];
  const v3: string[] = [];
  const collect = (entries?: Array<{ type: string; score: string }>) => {
    for (const s of entries ?? []) {
      if (!s.score) continue;
      if (s.type === 'CVSS_V4') v4.push(s.score);
      else if (s.type === 'CVSS_V3') v3.push(s.score);
    }
  };
  collect(vuln.severity);
  for (const a of vuln.affected ?? []) collect(a.severity);

  let maxScore = -1;
  for (const vec of v4) {
    const score = parseCvssV4BaseScore(vec);
    if (score !== null && score > maxScore) maxScore = score;
  }
  for (const vec of v3) {
    const score = parseCvssV3BaseScore(vec);
    if (score !== null && score > maxScore) maxScore = score;
  }
  if (maxScore >= 0) return scoreToTier(maxScore);

  // Fallback: database_specific.severity string (common on GHSA records)
  const ds = vuln.database_specific?.severity?.toUpperCase();
  if (ds === 'CRITICAL') return 'critical';
  if (ds === 'HIGH') return 'high';
  if (ds === 'MEDIUM' || ds === 'MODERATE') return 'medium';
  if (ds === 'LOW') return 'low';
  return 'unknown';
}

/** Signature of the fetcher — swapped in tests to avoid real network. */
export type OsvFetcher = (id: string) => Promise<OsvVuln | null>;

/**
 * Per-request timeout. Must be generous enough that concurrent analyzer tools
 * (gitleaks, semgrep, cloc) don't starve the fetches — 5s proved too aggressive
 * under full-analyzer load. Unreachable hosts still fail fast via AbortSignal.
 */
const OSV_REQUEST_TIMEOUT_MS = 10000;

const DEFAULT_FETCHER: OsvFetcher = async (id) => {
  try {
    const res = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(OSV_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as OsvVuln;
  } catch (err) {
    if (process.env.DXKIT_DEBUG_OSV) {
      process.stderr.write(`[dxkit-osv] ${id}: ${(err as Error).message}\n`);
    }
    return null;
  }
};

/**
 * Look up severities for a batch of vuln IDs.
 * Runs requests in parallel, session-caches results, returns a map keyed by ID.
 * IDs that fail (network error, 404, unparseable) map to 'unknown' — caller
 * uses a per-scanner default bucket for those.
 */
export async function enrichSeverities(
  ids: string[],
  fetcher: OsvFetcher = DEFAULT_FETCHER,
): Promise<Map<string, Severity>> {
  const result = new Map<string, Severity>();
  const toFetch: string[] = [];
  for (const id of ids) {
    if (cache.has(id)) {
      result.set(id, cache.get(id)!);
    } else if (!toFetch.includes(id)) {
      toFetch.push(id);
    }
  }
  if (toFetch.length === 0) return result;

  const settled = await Promise.allSettled(
    toFetch.map(async (id) => {
      const vuln = await fetcher(id);
      const sev: Severity = vuln ? classifyOsvSeverity(vuln) : 'unknown';
      return [id, sev] as const;
    }),
  );
  for (const p of settled) {
    if (p.status === 'fulfilled') {
      const [id, sev] = p.value;
      cache.set(id, sev);
      result.set(id, sev);
    }
  }
  return result;
}

/** Test-only — reset the process cache between tests. */
export function __clearOsvCache(): void {
  cache.clear();
}
