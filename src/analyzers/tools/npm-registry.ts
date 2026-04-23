/**
 * npm registry per-package metadata fetch.
 *
 * Populates `LicenseFinding.releaseDate` (xlsx col 10 — Component
 * Release Date, D006) by querying
 *   `GET https://registry.npmjs.org/<pkg>`
 * and reading the `time[<version>]` ISO-8601 string for the exact
 * installed version. Falls back to `time.modified` when the exact
 * version isn't listed (extremely rare; usually means the installed
 * version is a legacy tag the registry re-hoisted).
 *
 * Design mirrors `osv.ts` / `epss.ts`:
 *   - Session-scoped cache keyed on package name (one HTTP call per
 *     package regardless of how many versions are installed).
 *   - AbortSignal.timeout keeps the analyzer from hanging.
 *   - Fetcher injectable for tests.
 *   - Graceful degradation — every IO failure maps to "no date",
 *     and `releaseDate` stays unset on the finding.
 *
 * Concurrency: `enrichReleaseDates` runs per-package fetches with a
 * bounded pool so a 1700-package bom doesn't fire 1700 simultaneous
 * sockets. Default pool size is tuned for the npm CDN's behavior.
 */

/** Session cache. Key: package name, value: map of version → ISO date, or null on lookup failure. */
const cache = new Map<string, Map<string, string> | null>();

/** Shape of the fetcher — swapped in tests to avoid real network. */
export type NpmRegistryFetcher = (pkg: string) => Promise<Map<string, string> | null>;

/** Per-request timeout. npm CDN is usually fast but some long-tail packages stall. */
const NPM_REQUEST_TIMEOUT_MS = 10000;

/** Max concurrent fetches. npm allows generous parallelism but we keep it polite. */
const NPM_CONCURRENCY = 20;

interface NpmPackageMetadata {
  time?: Record<string, string>;
}

/** Production fetcher: issues one GET per package, parses `time` map. */
const DEFAULT_FETCHER: NpmRegistryFetcher = async (pkg) => {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkg).replace('%40', '@')}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(NPM_REQUEST_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as NpmPackageMetadata;
    const time = body.time;
    if (!time) return null;
    const out = new Map<string, string>();
    for (const [key, value] of Object.entries(time)) {
      if (typeof value === 'string') out.set(key, value);
    }
    return out;
  } catch (err) {
    if (process.env.DXKIT_DEBUG_NPM_REGISTRY) {
      process.stderr.write(`[dxkit-npm-registry] ${pkg}: ${(err as Error).message}\n`); // slop-ok
    }
    return null;
  }
};

/**
 * Fetch release dates for a set of `(package, version)` pairs from
 * the npm registry. Returns a map keyed by `package@version` →
 * ISO-8601 date string. Missing entries (unknown package, version
 * not in registry's `time`, network failure) are absent from the
 * map — callers treat absence as "date unknown" and leave
 * `releaseDate` unset on the LicenseFinding.
 *
 * Caches per-package responses so multiple versions of the same
 * package cost one HTTP call.
 */
export async function enrichReleaseDates(
  pairs: ReadonlyArray<{ package: string; version: string }>,
  fetcher: NpmRegistryFetcher = DEFAULT_FETCHER,
  concurrency: number = NPM_CONCURRENCY,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const uniquePackages = new Set<string>();
  for (const p of pairs) uniquePackages.add(p.package);

  const toFetch: string[] = [];
  for (const pkg of uniquePackages) {
    if (!cache.has(pkg)) toFetch.push(pkg);
  }

  // Bounded-concurrency pool. Each worker pulls the next package
  // from a shared index until the list is drained.
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, toFetch.length) }, async () => {
    while (idx < toFetch.length) {
      const i = idx++;
      const pkg = toFetch[i];
      cache.set(pkg, await fetcher(pkg));
    }
  });
  await Promise.all(workers);

  for (const { package: pkg, version } of pairs) {
    const times = cache.get(pkg);
    if (!times) continue;
    const exact = times.get(version);
    const fallback = times.get('modified');
    const iso = exact ?? fallback;
    if (iso) result.set(`${pkg}@${version}`, iso);
  }
  return result;
}

/** Test-only — reset the process cache between tests. */
export function __clearNpmRegistryCache(): void {
  cache.clear();
}
