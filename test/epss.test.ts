import { describe, it, expect, beforeEach } from 'vitest';
import { enrichEpss, extractCveId, __clearEpssCache } from '../src/analyzers/tools/epss';

describe('extractCveId', () => {
  it('returns id when the primary is a CVE', () => {
    expect(extractCveId({ id: 'CVE-2024-1234' })).toBe('CVE-2024-1234');
  });
  it('falls back to the first CVE alias when primary is GHSA', () => {
    expect(
      extractCveId({
        id: 'GHSA-xxxx-yyyy-zzzz',
        aliases: ['GHSA-xxxx-yyyy-zzzz', 'CVE-2024-9999'],
      }),
    ).toBe('CVE-2024-9999');
  });
  it('returns null when neither id nor aliases are CVE', () => {
    expect(extractCveId({ id: 'GHSA-xxx', aliases: ['GHSA-xxx'] })).toBeNull();
    expect(extractCveId({ id: 'RUSTSEC-2024-0001', aliases: [] })).toBeNull();
    expect(extractCveId({ id: 'GO-2024-1234' })).toBeNull();
  });
});

describe('enrichEpss', () => {
  beforeEach(() => {
    __clearEpssCache();
  });

  it('returns a map of cve → score using the injected fetcher', async () => {
    const fetcher = async (ids: ReadonlyArray<string>) => {
      const m = new Map<string, number>();
      if (ids.includes('CVE-2024-1111')) m.set('CVE-2024-1111', 0.42);
      if (ids.includes('CVE-2024-2222')) m.set('CVE-2024-2222', 0.01);
      return m;
    };
    const result = await enrichEpss(['CVE-2024-1111', 'CVE-2024-2222'], fetcher);
    expect(result.get('CVE-2024-1111')).toBe(0.42);
    expect(result.get('CVE-2024-2222')).toBe(0.01);
  });

  it('omits IDs the fetcher had no data for', async () => {
    const fetcher = async () => new Map<string, number>();
    const result = await enrichEpss(['CVE-2024-9999'], fetcher);
    expect(result.has('CVE-2024-9999')).toBe(false);
  });

  it('caches results across calls', async () => {
    let fetchCount = 0;
    const fetcher = async (ids: ReadonlyArray<string>) => {
      fetchCount++;
      return new Map<string, number>(ids.map((id) => [id, 0.5]));
    };
    await enrichEpss(['CVE-A', 'CVE-B'], fetcher);
    await enrichEpss(['CVE-A', 'CVE-B'], fetcher);
    expect(fetchCount).toBe(1); // second call fully cached
  });

  it('caches negative lookups too — unknown CVE is not re-queried', async () => {
    let fetchCount = 0;
    const fetcher = async () => {
      fetchCount++;
      return new Map<string, number>();
    };
    await enrichEpss(['CVE-UNKNOWN'], fetcher);
    await enrichEpss(['CVE-UNKNOWN'], fetcher);
    expect(fetchCount).toBe(1);
  });

  it('deduplicates the input list', async () => {
    const fetcher = async (ids: ReadonlyArray<string>) => {
      expect(ids).toEqual(['CVE-X']); // only one call, not two
      return new Map<string, number>([['CVE-X', 0.1]]);
    };
    await enrichEpss(['CVE-X', 'CVE-X'], fetcher);
  });
});
