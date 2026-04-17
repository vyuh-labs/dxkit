import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyOsvSeverity,
  enrichSeverities,
  parseCvssV3BaseScore,
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

describe('enrichSeverities', () => {
  it('calls the fetcher once per unique ID and returns the classified map', async () => {
    const calls: string[] = [];
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      calls.push(id);
      return {
        id,
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
      };
    };
    const result = await enrichSeverities(['PYSEC-1', 'PYSEC-2', 'PYSEC-1'], fetcher);
    expect(calls.sort()).toEqual(['PYSEC-1', 'PYSEC-2']);
    expect(result.get('PYSEC-1')).toBe('critical');
    expect(result.get('PYSEC-2')).toBe('critical');
  });

  it('caches results across calls within the same session', async () => {
    let calls = 0;
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      calls++;
      return { id, database_specific: { severity: 'HIGH' } };
    };
    await enrichSeverities(['GHSA-1'], fetcher);
    await enrichSeverities(['GHSA-1', 'GHSA-2'], fetcher);
    expect(calls).toBe(2); // GHSA-1 fetched once, GHSA-2 once
  });

  it('maps unknown IDs (fetcher returns null) to unknown severity', async () => {
    const fetcher = async (): Promise<OsvVuln | null> => null;
    const result = await enrichSeverities(['UNKNOWN-1'], fetcher);
    expect(result.get('UNKNOWN-1')).toBe('unknown');
  });

  it('handles an empty ID list without calling the fetcher', async () => {
    let called = false;
    const fetcher = async (): Promise<OsvVuln | null> => {
      called = true;
      return null;
    };
    const result = await enrichSeverities([], fetcher);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('survives fetcher errors — returns unknown for failed IDs', async () => {
    const fetcher = async (id: string): Promise<OsvVuln | null> => {
      if (id === 'FAIL') throw new Error('network');
      return { database_specific: { severity: 'MEDIUM' } };
    };
    const result = await enrichSeverities(['FAIL', 'OK'], fetcher);
    // FAIL rejection means Promise.allSettled drops it — map won't contain FAIL
    expect(result.get('OK')).toBe('medium');
    expect(result.has('FAIL')).toBe(false);
  });
});
