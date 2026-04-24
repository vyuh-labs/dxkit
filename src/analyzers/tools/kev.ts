/**
 * CISA Known Exploited Vulnerabilities (KEV) enrichment.
 *
 * CISA publishes a catalog of CVEs the US-federal-agency ISAC has
 * confirmed are being actively exploited in the wild (different from
 * EPSS's *probability of* exploitation). A KEV hit is the strongest
 * "fix this now" signal we can attach to a finding.
 *
 * Feed: `https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json`
 *
 * Shape (we only read `vulnerabilities[].cveID`):
 *   {
 *     "catalogVersion": "...",
 *     "dateReleased": "...",
 *     "count": 1200-ish,
 *     "vulnerabilities": [
 *       { "cveID": "CVE-2021-44228", "vendorProject": "Apache", ... }
 *     ]
 *   }
 *
 * Unlike EPSS (per-CVE lookup), KEV is a bulk download + local
 * lookup — one HTTP call per session, search is a `Set.has`.
 *
 * Design mirrors `osv.ts` / `epss.ts`:
 *   - Session-scoped cache so the catalog is fetched at most once
 *     per process (it's ~1300 entries, ~200KB).
 *   - AbortSignal.timeout prevents stalls.
 *   - Fetcher injectable for tests.
 *   - Graceful degradation: if the catalog is unreachable, every
 *     finding's `kev` stays unset (treated as "no data", not
 *     "confirmed not KEV").
 */

/** Cached CVE set for the process lifetime. `null` means "tried and failed". */
let cachedCatalog: Set<string> | null | undefined = undefined;

/** Shape of the fetcher — swapped in tests to avoid real network. */
export type KevFetcher = () => Promise<Set<string> | null>;

/** Per-request timeout. The CISA feed is usually fast but can stall under load. */
const KEV_REQUEST_TIMEOUT_MS = 10000;

interface KevCatalog {
  vulnerabilities?: Array<{ cveID?: string }>;
}

/** Production fetcher: downloads the CISA catalog and builds a CVE set. */
const DEFAULT_FETCHER: KevFetcher = async () => {
  try {
    const res = await fetch(
      'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json',
      { signal: AbortSignal.timeout(KEV_REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as KevCatalog;
    const set = new Set<string>();
    for (const row of body.vulnerabilities ?? []) {
      if (row.cveID) set.add(row.cveID);
    }
    return set;
  } catch (err) {
    if (process.env.DXKIT_DEBUG_KEV) {
      process.stderr.write(`[dxkit-kev] catalog fetch failed: ${(err as Error).message}\n`); // slop-ok
    }
    return null;
  }
};

/**
 * Fetch (or return cached) KEV catalog as a Set of CVE IDs. Returns
 * an empty set on network failure so callers can treat "KEV lookup
 * succeeded but CVE X is not listed" and "KEV fetch failed" the
 * same way — both collapse to "no KEV flag on this finding". The
 * distinction is preserved in logs via DXKIT_DEBUG_KEV.
 */
export async function getKevCatalog(fetcher: KevFetcher = DEFAULT_FETCHER): Promise<Set<string>> {
  if (cachedCatalog === undefined) {
    cachedCatalog = await fetcher();
  }
  return cachedCatalog ?? new Set();
}

/**
 * Enrich `cves` with KEV membership. Returns the subset of input
 * CVE IDs that appear in the catalog. Empty result is safe —
 * callers interpret absence from the result set as "not KEV"
 * (true negative; caller should set `kev: false`).
 */
export async function enrichKev(
  cves: ReadonlyArray<string>,
  fetcher: KevFetcher = DEFAULT_FETCHER,
): Promise<Set<string>> {
  const catalog = await getKevCatalog(fetcher);
  const hits = new Set<string>();
  for (const cve of cves) {
    if (catalog.has(cve)) hits.add(cve);
  }
  return hits;
}

/** Test-only — reset the process cache between tests. */
export function __clearKevCache(): void {
  cachedCatalog = undefined;
}
