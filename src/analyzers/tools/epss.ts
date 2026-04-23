/**
 * EPSS (Exploit Prediction Scoring System) enrichment.
 *
 * EPSS is maintained by FIRST.org and scores each CVE 0.0–1.0 for the
 * probability of exploitation in the wild within the next 30 days.
 * We join it onto `DepVulnFinding.epssScore` so renders can surface
 * "this one's getting hit right now" alongside CVSS (which only
 * measures severity if exploited, not likelihood).
 *
 * API: `GET https://api.first.org/data/v1/epss?cve=CVE-1,CVE-2,...`
 * Response shape (we only read `data[]`):
 *   {
 *     "status": "OK",
 *     "data": [
 *       { "cve": "CVE-2022-1234", "epss": "0.00042",
 *         "percentile": "0.06523", "date": "2026-04-23" }
 *     ]
 *   }
 *
 * Design mirrors `osv.ts`:
 *   - Session-scoped Map cache so repeated runs in one process don't
 *     re-query the same CVE.
 *   - AbortSignal.timeout keeps the analyzer from hanging behind a
 *     slow/unreachable EPSS endpoint.
 *   - Fetcher is injectable for unit tests that must avoid real network.
 *   - Graceful degradation: every IO failure maps to "no score", which
 *     callers treat as "don't render an EPSS column for this finding".
 *
 * Only CVE IDs are scoreable — GHSA/RUSTSEC/GO-YYYY-NNNN records need
 * a CVE alias to get an EPSS score. Callers pull CVEs from both
 * `DepVulnFinding.id` and `aliases[]` before enrichment.
 */

/** Session cache. Key: CVE id, value: EPSS score (0.0–1.0) or null when unknown. */
const cache = new Map<string, number | null>();

/** Signature of the fetcher — swapped in tests to avoid real network. */
export type EpssFetcher = (ids: ReadonlyArray<string>) => Promise<Map<string, number>>;

/** Per-request timeout. Matches osv.ts's 10s; EPSS endpoint is usually fast. */
const EPSS_REQUEST_TIMEOUT_MS = 10000;

/** Max CVE IDs per batch — FIRST.org's docs recommend ≤100 per call. */
const EPSS_BATCH_SIZE = 100;

interface EpssResponseRow {
  cve?: string;
  epss?: string;
}
interface EpssResponse {
  data?: EpssResponseRow[];
}

/**
 * Production fetcher: issues one or more GET requests to
 * `api.first.org` in batches of `EPSS_BATCH_SIZE`. Returns a map of
 * `cve → epssScore`; CVEs not present in any response are absent
 * from the map (distinct from "present but null", which the wrapper
 * uses to cache negative lookups).
 */
const DEFAULT_FETCHER: EpssFetcher = async (ids) => {
  const result = new Map<string, number>();
  for (let i = 0; i < ids.length; i += EPSS_BATCH_SIZE) {
    const batch = ids.slice(i, i + EPSS_BATCH_SIZE);
    const url = `https://api.first.org/data/v1/epss?cve=${batch.join(',')}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(EPSS_REQUEST_TIMEOUT_MS) });
      if (!res.ok) continue;
      const body = (await res.json()) as EpssResponse;
      for (const row of body.data ?? []) {
        if (!row.cve || !row.epss) continue;
        const n = parseFloat(row.epss);
        if (Number.isFinite(n)) result.set(row.cve, n);
      }
    } catch (err) {
      if (process.env.DXKIT_DEBUG_EPSS) {
        process.stderr.write(
          `[dxkit-epss] batch ${i / EPSS_BATCH_SIZE}: ${(err as Error).message}\n`,
        ); // slop-ok
      }
      // Keep going — one bad batch shouldn't poison the rest.
    }
  }
  return result;
};

/**
 * Extract the CVE ID from a DepVulnFinding-ish input. Returns the
 * primary `id` if it's already a CVE, otherwise the first CVE alias,
 * or null when none exists. GHSA/RUSTSEC/GO/PYSEC primaries rely on
 * aliases to pick up a CVE.
 */
export function extractCveId(finding: {
  id: string;
  aliases?: ReadonlyArray<string>;
}): string | null {
  if (finding.id.startsWith('CVE-')) return finding.id;
  for (const a of finding.aliases ?? []) {
    if (a.startsWith('CVE-')) return a;
  }
  return null;
}

/**
 * Enrich `ids` with EPSS scores. Consults the session cache first;
 * batches everything else via the fetcher. Returns a map keyed by
 * CVE id — IDs with no score (not in EPSS dataset, or all batches
 * failed) are absent from the result map. Callers should treat
 * absence as "no data available".
 */
export async function enrichEpss(
  ids: ReadonlyArray<string>,
  fetcher: EpssFetcher = DEFAULT_FETCHER,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const toFetch: string[] = [];
  for (const id of ids) {
    if (cache.has(id)) {
      const v = cache.get(id);
      if (v !== null && v !== undefined) result.set(id, v);
    } else if (!toFetch.includes(id)) {
      toFetch.push(id);
    }
  }
  if (toFetch.length === 0) return result;

  const fetched = await fetcher(toFetch);
  for (const id of toFetch) {
    const v = fetched.get(id);
    if (v !== undefined) {
      cache.set(id, v);
      result.set(id, v);
    } else {
      // Negative-cache so we don't re-query the same unknown CVE next pass.
      cache.set(id, null);
    }
  }
  return result;
}

/** Test-only — reset the process cache between tests. */
export function __clearEpssCache(): void {
  cache.clear();
}
