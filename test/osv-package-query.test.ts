/**
 * queryOsvPackage (4.4.5, the recipe tier's pre-check): the /v1/query call
 * shape, the vulns extraction, and the honesty contract that ANY failure
 * (network, non-OK, malformed) reads as null, never as "no advisories".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryOsvPackage } from '../src/analyzers/tools/osv';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Partial<Response>>) {
  vi.stubGlobal('fetch', impl as unknown as typeof fetch);
}

describe('queryOsvPackage', () => {
  it('POSTs the package + version to /v1/query and returns the vulns array', async () => {
    let seenBody: unknown;
    stubFetch(async (url, init) => {
      expect(url).toBe('https://api.osv.dev/v1/query');
      seenBody = JSON.parse(String(init?.body));
      return { ok: true, json: async () => ({ vulns: [{ id: 'GHSA-x' }] }) };
    });
    const vulns = await queryOsvPackage('left-pad', '1.3.0', 'npm');
    expect(vulns).toEqual([{ id: 'GHSA-x' }]);
    expect(seenBody).toEqual({
      package: { name: 'left-pad', ecosystem: 'npm' },
      version: '1.3.0',
    });
  });

  it('an empty result body is an EMPTY list (a real "no known advisories")', async () => {
    stubFetch(async () => ({ ok: true, json: async () => ({}) }));
    expect(await queryOsvPackage('left-pad', '1.3.0', 'npm')).toEqual([]);
  });

  it('a non-OK response or a thrown fetch reads as null (disclosed unknown), never as clean', async () => {
    stubFetch(async () => ({ ok: false, json: async () => ({}) }));
    expect(await queryOsvPackage('left-pad', '1.3.0', 'npm')).toBeNull();
    stubFetch(async () => {
      throw new Error('offline');
    });
    expect(await queryOsvPackage('left-pad', '1.3.0', 'npm')).toBeNull();
  });
});
