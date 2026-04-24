import { describe, it, expect, beforeEach } from 'vitest';
import { enrichKev, getKevCatalog, __clearKevCache } from '../src/analyzers/tools/kev';

describe('getKevCatalog', () => {
  beforeEach(() => {
    __clearKevCache();
  });

  it('returns the fetched CVE set', async () => {
    const catalog = await getKevCatalog(async () => new Set(['CVE-2021-44228', 'CVE-2023-1234']));
    expect(catalog.size).toBe(2);
    expect(catalog.has('CVE-2021-44228')).toBe(true);
  });

  it('caches across calls — fetcher invoked once', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Set(['CVE-A']);
    };
    await getKevCatalog(fetcher);
    await getKevCatalog(fetcher);
    expect(calls).toBe(1);
  });

  it('caches null result too — failed fetch is not retried', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return null;
    };
    const first = await getKevCatalog(fetcher);
    const second = await getKevCatalog(fetcher);
    expect(calls).toBe(1);
    expect(first.size).toBe(0);
    expect(second.size).toBe(0);
  });
});

describe('enrichKev', () => {
  beforeEach(() => {
    __clearKevCache();
  });

  it('returns the subset of input CVEs present in the catalog', async () => {
    const fetcher = async () => new Set(['CVE-2021-44228', 'CVE-2024-3094']);
    const hits = await enrichKev(['CVE-2021-44228', 'CVE-2999-0000', 'CVE-2024-3094'], fetcher);
    expect(hits.size).toBe(2);
    expect(hits.has('CVE-2021-44228')).toBe(true);
    expect(hits.has('CVE-2024-3094')).toBe(true);
    expect(hits.has('CVE-2999-0000')).toBe(false);
  });

  it('returns empty set when catalog fetch failed', async () => {
    const fetcher = async () => null;
    const hits = await enrichKev(['CVE-2021-44228'], fetcher);
    expect(hits.size).toBe(0);
  });

  it('handles empty input list', async () => {
    const fetcher = async () => new Set(['CVE-A']);
    const hits = await enrichKev([], fetcher);
    expect(hits.size).toBe(0);
  });
});
