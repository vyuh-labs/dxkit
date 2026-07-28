import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyOsvSeverity,
  enrichOsv,
  extractOsvFixVersion,
  parseCvssV3BaseScore,
  resolveCvssScores,
  resolveFixVersions,
  selectFixVersion,
  scoreToTier,
  __clearOsvCache,
  type OsvVuln,
} from '../src/analyzers/tools/osv';

beforeEach(() => {
  __clearOsvCache();
});

describe('scoreToTier', () => {
  it('maps 9.0+ to critical', () => {
    expect(scoreToTier(9.0)).toBe('critical');
    expect(scoreToTier(10.0)).toBe('critical');
  });

  it('maps 7.0–8.9 to high', () => {
    expect(scoreToTier(7.0)).toBe('high');
    expect(scoreToTier(8.9)).toBe('high');
  });

  it('maps 4.0–6.9 to medium', () => {
    expect(scoreToTier(4.0)).toBe('medium');
    expect(scoreToTier(6.9)).toBe('medium');
  });

  it('maps >0 to <4.0 to low', () => {
    expect(scoreToTier(0.1)).toBe('low');
    expect(scoreToTier(3.9)).toBe('low');
  });

  it('maps 0 to unknown', () => {
    expect(scoreToTier(0)).toBe('unknown');
  });
});

describe('parseCvssV3BaseScore', () => {
  it('computes the canonical CVE-2017-0144 vector (8.1 High)', () => {
    // EternalBlue: AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H → 8.1
    const score = parseCvssV3BaseScore('CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H');
    expect(score).toBe(8.1);
  });

  it('computes a critical vector (9.8)', () => {
    // Typical "full compromise, network, no auth" score
    const score = parseCvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
    expect(score).toBe(9.8);
  });

  it('computes a medium vector (~6)', () => {
    // Network, low complexity, low privs, no UI, low impact on C/I/A → ~6.3
    const score = parseCvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:L/I:L/A:L');
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(4.0);
    expect(score!).toBeLessThan(7.0);
  });

  it('handles scope-changed vectors', () => {
    // Scope change uses different PR weights and 1.08 multiplier
    const score = parseCvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H');
    expect(score).toBe(10.0); // caps at 10
  });

  it('accepts CVSS:3.0 prefix', () => {
    const score = parseCvssV3BaseScore('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H');
    expect(score).toBe(9.8);
  });

  it('returns null for non-CVSS:3.x vectors', () => {
    expect(parseCvssV3BaseScore('CVSS:2.0/AV:N/AC:L/Au:N/C:C/I:C/A:C')).toBeNull();
    expect(parseCvssV3BaseScore('not a vector')).toBeNull();
    expect(parseCvssV3BaseScore('')).toBeNull();
  });

  it('returns null when required metrics are missing', () => {
    // Missing A
    expect(parseCvssV3BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H')).toBeNull();
  });
});

describe('classifyOsvSeverity', () => {
  it('classifies from top-level CVSS_V3 vector', () => {
    const vuln: OsvVuln = {
      id: 'PYSEC-2021-1',
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
    };
    expect(classifyOsvSeverity(vuln)).toBe('critical');
  });

  it('classifies from affected[].severity[]', () => {
    const vuln: OsvVuln = {
      id: 'PYSEC-2021-2',
      affected: [
        {
          severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        },
      ],
    };
    expect(classifyOsvSeverity(vuln)).toBe('high');
  });

  it('takes the max score across multiple CVSS entries', () => {
    const vuln: OsvVuln = {
      severity: [
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N' },
        { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' },
      ],
    };
    expect(classifyOsvSeverity(vuln)).toBe('critical');
  });

  it('falls back to database_specific.severity when no CVSS present', () => {
    expect(classifyOsvSeverity({ database_specific: { severity: 'HIGH' } })).toBe('high');
    expect(classifyOsvSeverity({ database_specific: { severity: 'moderate' } })).toBe('medium');
    expect(classifyOsvSeverity({ database_specific: { severity: 'CRITICAL' } })).toBe('critical');
    expect(classifyOsvSeverity({ database_specific: { severity: 'LOW' } })).toBe('low');
  });

  it('ignores non-CVSS_V3 severity entries', () => {
    const vuln: OsvVuln = {
      severity: [{ type: 'CVSS_V2', score: 'AV:N/AC:L/Au:N/C:C/I:C/A:C' }],
      database_specific: { severity: 'LOW' },
    };
    expect(classifyOsvSeverity(vuln)).toBe('low');
  });

  it('returns unknown when no severity info is available', () => {
    expect(classifyOsvSeverity({ id: 'x' })).toBe('unknown');
    expect(classifyOsvSeverity({ severity: [] })).toBe('unknown');
  });

  it('prefers CVSS over database_specific when both present', () => {
    const vuln: OsvVuln = {
      severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      database_specific: { severity: 'LOW' },
    };
    expect(classifyOsvSeverity(vuln)).toBe('critical');
  });
});

describe('enrichOsv', () => {
  it('calls the fetcher once per unique ID and returns severity + cvssScore', async () => {
    const calls: string[] = [];
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      calls.push(id);
      return {
        id,
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      };
    };
    const result = await enrichOsv(['PYSEC-1', 'PYSEC-2', 'PYSEC-1'], fetcher);
    expect(calls.sort()).toEqual(['PYSEC-1', 'PYSEC-2']);
    expect(result.get('PYSEC-1')?.severity).toBe('critical');
    expect(result.get('PYSEC-1')?.cvssScore).toBeGreaterThan(0);
    expect(result.get('PYSEC-2')?.severity).toBe('critical');
  });

  it('caches results across calls within the same session', async () => {
    let calls = 0;
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      calls++;
      return { id, database_specific: { severity: 'HIGH' } };
    };
    await enrichOsv(['GHSA-1'], fetcher);
    await enrichOsv(['GHSA-1', 'GHSA-2'], fetcher);
    expect(calls).toBe(2); // GHSA-1 fetched once, GHSA-2 once
  });

  it('maps unknown IDs (fetcher returns null) to unknown severity + null score', async () => {
    const fetcher = async (): Promise<OsvVuln | null> => null;
    const result = await enrichOsv(['UNKNOWN-1'], fetcher);
    expect(result.get('UNKNOWN-1')?.severity).toBe('unknown');
    expect(result.get('UNKNOWN-1')?.cvssScore).toBeNull();
  });

  it('returns null cvssScore when the OSV record lacks parseable CVSS vectors', async () => {
    const fetcher = async (id: string): Promise<OsvVuln | null> => ({
      id,
      database_specific: { severity: 'MEDIUM' },
    });
    const result = await enrichOsv(['GHSA-X'], fetcher);
    expect(result.get('GHSA-X')?.severity).toBe('medium');
    expect(result.get('GHSA-X')?.cvssScore).toBeNull();
  });

  it('handles an empty ID list without calling the fetcher', async () => {
    let called = false;
    const fetcher = async (): Promise<OsvVuln | null> => {
      called = true;
      return null;
    };
    const result = await enrichOsv([], fetcher);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('survives fetcher errors — drops failed IDs from the map', async () => {
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      if (id === 'FAIL') throw new Error('network');
      return { database_specific: { severity: 'MEDIUM' } };
    };
    const result = await enrichOsv(['FAIL', 'OK'], fetcher);
    // FAIL rejection means Promise.allSettled drops it — map won't contain FAIL
    expect(result.get('OK')?.severity).toBe('medium');
    expect(result.has('FAIL')).toBe(false);
  });
});

describe('resolveCvssScores', () => {
  const HIGH_VECTOR = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';

  it('returns embedded scores without making any API calls', async () => {
    let called = false;
    const fetcher = async (): Promise<OsvVuln | null> => {
      called = true;
      return null;
    };
    const result = await resolveCvssScores(
      [
        { primaryId: 'GHSA-1', embeddedCvss: 7.5, aliases: ['CVE-1'] },
        { primaryId: 'GHSA-2', embeddedCvss: 9.0, aliases: [] },
      ],
      fetcher,
    );
    expect(called).toBe(false);
    expect(result.get('GHSA-1')).toBe(7.5);
    expect(result.get('GHSA-2')).toBe(9.0);
  });

  it('falls back to OSV.dev primary lookup when embedded score is null', async () => {
    const fetcher = async (id: string): Promise<OsvVuln | null> =>
      id === 'PYSEC-1' ? { id, severity: [{ type: 'CVSS_V3', score: HIGH_VECTOR }] } : null;
    const result = await resolveCvssScores(
      [{ primaryId: 'PYSEC-1', embeddedCvss: null, aliases: [] }],
      fetcher,
    );
    expect(result.get('PYSEC-1')).toBeGreaterThan(0);
  });

  it('falls back to alias lookup when primary lookup yields no score', async () => {
    // GO-XXXX has no severity; its CVE-XXXX alias does
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      // GO-XXXX: no severity, no CVSS — forces alias fallback to CVE-XXXX
      if (id === 'GO-XXXX') return { id };
      if (id === 'CVE-XXXX') return { id, severity: [{ type: 'CVSS_V3', score: HIGH_VECTOR }] };
      return null;
    };
    const result = await resolveCvssScores(
      [{ primaryId: 'GO-XXXX', embeddedCvss: null, aliases: ['CVE-XXXX'] }],
      fetcher,
    );
    expect(result.get('GO-XXXX')).toBeGreaterThan(0);
  });

  it('returns null when neither primary nor any alias yields a score', async () => {
    const fetcher = async (): Promise<OsvVuln | null> => null;
    const result = await resolveCvssScores(
      [{ primaryId: 'UNKNOWN-1', embeddedCvss: null, aliases: ['CVE-NOPE'] }],
      fetcher,
    );
    expect(result.get('UNKNOWN-1')).toBeNull();
  });

  it('batches across many inputs — embedded findings cause no API calls', async () => {
    let calls = 0;
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      calls++;
      return id === 'PYSEC-2' ? { id, severity: [{ type: 'CVSS_V3', score: HIGH_VECTOR }] } : null;
    };
    const result = await resolveCvssScores(
      [
        { primaryId: 'GHSA-1', embeddedCvss: 5.0, aliases: ['CVE-1'] }, // no lookup
        { primaryId: 'GHSA-2', embeddedCvss: 6.0, aliases: [] }, // no lookup
        { primaryId: 'PYSEC-2', embeddedCvss: null, aliases: [] }, // primary lookup hits
      ],
      fetcher,
    );
    // PYSEC-2 needed primary lookup; GHSA-* skipped entirely
    expect(calls).toBe(1);
    expect(result.get('GHSA-1')).toBe(5.0);
    expect(result.get('PYSEC-2')).toBeGreaterThan(0);
  });
});

// D042 (2.4.7) — patch-version surfacing from OSV records.
describe('extractOsvFixVersion', () => {
  it('returns the first `fixed` event from affected[].ranges[].events[]', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-test',
      affected: [
        {
          ranges: [
            {
              events: [{ introduced: '0.0.0' }, { fixed: '13.0.1' }],
            },
          ],
        },
      ],
    };
    expect(extractOsvFixVersion(vuln)).toBe('13.0.1');
  });

  it('walks multiple affected entries; first non-empty fixed wins', () => {
    // Advisory may list multiple affected version branches (e.g.,
    // 1.x and 2.x). Document-order traversal returns the first patch.
    const vuln: OsvVuln = {
      id: 'GHSA-multi',
      affected: [
        { ranges: [{ events: [{ introduced: '0.0.0' }] }] },
        { ranges: [{ events: [{ introduced: '1.0.0' }, { fixed: '1.5.2' }] }] },
        { ranges: [{ events: [{ fixed: '2.1.0' }] }] },
      ],
    };
    expect(extractOsvFixVersion(vuln)).toBe('1.5.2');
  });

  it('returns undefined when no `fixed` event exists (patch unreleased)', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-no-fix',
      affected: [
        {
          ranges: [{ events: [{ introduced: '0.0.0' }] }],
        },
      ],
    };
    expect(extractOsvFixVersion(vuln)).toBeUndefined();
  });

  it('returns undefined for empty affected / ranges / events arrays', () => {
    expect(extractOsvFixVersion({ id: 'x' })).toBeUndefined();
    expect(extractOsvFixVersion({ id: 'x', affected: [] })).toBeUndefined();
    expect(extractOsvFixVersion({ id: 'x', affected: [{}] })).toBeUndefined();
    expect(extractOsvFixVersion({ id: 'x', affected: [{ ranges: [] }] })).toBeUndefined();
    expect(extractOsvFixVersion({ id: 'x', affected: [{ ranges: [{}] }] })).toBeUndefined();
    expect(
      extractOsvFixVersion({ id: 'x', affected: [{ ranges: [{ events: [] }] }] }),
    ).toBeUndefined();
  });

  it('skips empty-string `fixed` values', () => {
    const vuln: OsvVuln = {
      id: 'GHSA-empty-fix',
      affected: [
        {
          ranges: [{ events: [{ fixed: '' }, { fixed: '3.2.1' }] }],
        },
      ],
    };
    expect(extractOsvFixVersion(vuln)).toBe('3.2.1');
  });
});

describe('selectFixVersion — minimal safe move per installed version', () => {
  it('picks the smallest fixed event above the installed version (backport branch, not a surprise major)', () => {
    expect(selectFixVersion(['2.0.5', '1.4.7'], '1.4.0')).toBe('1.4.7');
    expect(selectFixVersion(['1.4.7', '2.0.5'], '1.9.0')).toBe('2.0.5');
  });

  it('unknown installed version falls back to the smallest fixed event', () => {
    expect(selectFixVersion(['2.0.5', '1.4.7'], undefined)).toBe('1.4.7');
  });

  it('never proposes a downgrade; empty events yield undefined', () => {
    expect(selectFixVersion(['1.4.7'], '2.1.0')).toBeUndefined();
    expect(selectFixVersion([], '1.0.0')).toBeUndefined();
  });
});

describe('resolveFixVersions — the resolveCvssScores sibling', () => {
  const RECORD: OsvVuln = {
    id: 'GHSA-fix-1',
    affected: [
      { ranges: [{ events: [{ introduced: '0' }, { fixed: '1.8.2' }] }] },
      { ranges: [{ events: [{ introduced: '2.0.0' }, { fixed: '2.3.1' }] }] },
    ],
  };

  it('resolves via the primary id and selects for the installed version', async () => {
    const fetcher = async (id: string): Promise<OsvVuln | null> =>
      id === 'GHSA-fix-1' ? RECORD : null;
    const out = await resolveFixVersions(
      [{ primaryId: 'GHSA-fix-1', aliases: [], installedVersion: '1.7.0' }],
      fetcher,
    );
    expect(out.get('GHSA-fix-1')).toBe('1.8.2');
  });

  it('falls back through aliases when the primary record has no fixed events', async () => {
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      if (id === 'CVE-2026-0001') return RECORD;
      if (id === 'GO-2026-1234') return { id }; // record exists, no events
      return null;
    };
    const out = await resolveFixVersions(
      [{ primaryId: 'GO-2026-1234', aliases: ['CVE-2026-0001'], installedVersion: '2.1.0' }],
      fetcher,
    );
    expect(out.get('GO-2026-1234')).toBe('2.3.1');
  });

  it('no resolvable target stays undefined — the caller never guesses', async () => {
    const out = await resolveFixVersions(
      [{ primaryId: 'GHSA-none', aliases: [], installedVersion: '1.0.0' }],
      async () => null,
    );
    expect(out.get('GHSA-none')).toBeUndefined();
  });
});
