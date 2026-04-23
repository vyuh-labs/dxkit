import { describe, it, expect, beforeEach } from 'vitest';
import { enrichReleaseDates, __clearNpmRegistryCache } from '../src/analyzers/tools/npm-registry';

describe('enrichReleaseDates', () => {
  beforeEach(() => {
    __clearNpmRegistryCache();
  });

  it('returns a map keyed by package@version → ISO date', async () => {
    const fetcher = async (pkg: string) => {
      if (pkg === 'lodash') {
        return new Map([
          ['4.17.21', '2021-02-20T08:53:38.000Z'],
          ['modified', '2024-01-15T00:00:00.000Z'],
        ]);
      }
      return null;
    };
    const result = await enrichReleaseDates([{ package: 'lodash', version: '4.17.21' }], fetcher);
    expect(result.get('lodash@4.17.21')).toBe('2021-02-20T08:53:38.000Z');
  });

  it('falls back to time.modified when the exact version is missing', async () => {
    const fetcher = async () =>
      new Map([
        ['modified', '2024-06-15T12:00:00.000Z'],
        ['2.0.0', '2024-05-01T00:00:00.000Z'],
      ]);
    const result = await enrichReleaseDates([{ package: 'pkg', version: '99.0.0' }], fetcher);
    expect(result.get('pkg@99.0.0')).toBe('2024-06-15T12:00:00.000Z');
  });

  it('omits packages the fetcher failed on', async () => {
    const fetcher = async () => null;
    const result = await enrichReleaseDates(
      [{ package: 'unreachable', version: '1.0.0' }],
      fetcher,
    );
    expect(result.has('unreachable@1.0.0')).toBe(false);
  });

  it('calls fetcher once per unique package even when many versions share it', async () => {
    let calls = 0;
    const fetcher = async (pkg: string) => {
      calls++;
      return new Map([
        ['1.0.0', '2024-01-01T00:00:00.000Z'],
        ['2.0.0', '2024-02-01T00:00:00.000Z'],
        ['3.0.0', '2024-03-01T00:00:00.000Z'],
        ['modified', '2024-03-15T00:00:00.000Z'],
      ]);
      expect(pkg).toBe('shared-pkg');
    };
    const pairs = [
      { package: 'shared-pkg', version: '1.0.0' },
      { package: 'shared-pkg', version: '2.0.0' },
      { package: 'shared-pkg', version: '3.0.0' },
    ];
    const result = await enrichReleaseDates(pairs, fetcher, 5);
    expect(calls).toBe(1);
    expect(result.size).toBe(3);
    expect(result.get('shared-pkg@1.0.0')).toBe('2024-01-01T00:00:00.000Z');
  });

  it('caches results across invocations', async () => {
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Map([['1.0.0', '2024-01-01T00:00:00.000Z']]);
    };
    await enrichReleaseDates([{ package: 'cached', version: '1.0.0' }], fetcher);
    await enrichReleaseDates([{ package: 'cached', version: '1.0.0' }], fetcher);
    expect(calls).toBe(1);
  });
});
