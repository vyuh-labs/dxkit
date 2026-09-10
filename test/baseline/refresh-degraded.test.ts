/**
 * The refresh lane's two pure decisions (4.4.8):
 *   - #388 `assessCaptureDegradation`: which kinds the fresh capture may not
 *     honestly replace the prior's record of, and which drops publish as a
 *     disclosed full clear; `observationFromScan` composes the evidence the
 *     way the gate's removed-direction attribution does.
 *   - #389 `classifyFreshAdvisories`: the "known before the prior capture"
 *     union (prior anchor, carried hold-outs, OSV publication date).
 * The lane-level behavior (refusal, restore, hold-out, decision branch) is
 * covered on a real repo in `refresh-decision.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import {
  assessCaptureDegradation,
  degradedCaptureRefusal,
  describeClearedKind,
  NO_OBSERVATION_RECORD,
  observationFromScan,
  type CaptureObservation,
} from '../../src/baseline/refresh-degraded';
import {
  classifyFreshAdvisories,
  describeDisappeared,
  resolvePublishedDates,
} from '../../src/baseline/refresh-holdout';
import { BASELINE_SCHEMA_VERSION, type BaselineFile } from '../../src/baseline/baseline-file';
import type { CurrentScan } from '../../src/baseline/create';
import type { AllowlistEntry } from '../../src/allowlist/file';

function file(findings: unknown[], createdAt = '2026-07-20T00:00:00.000Z'): BaselineFile {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: 'main',
    createdAt,
    repo: { commitSha: 'a'.repeat(40), branch: 'main', root: '/repo' },
    analysis: {
      dxkitVersion: 'test',
      policyHash: '0'.repeat(16),
      ignoreHash: '0'.repeat(16),
      toolchainHash: '0'.repeat(16),
      configHash: '0'.repeat(16),
    },
    tools: {},
    saltMode: 'deterministic',
    findings: findings as BaselineFile['findings'],
  } as BaselineFile;
}

function dep(id: string, advisoryId = `GHSA-${id}`) {
  return { id, kind: 'dep-vuln' as const, package: `p-${id}`, advisoryId };
}
function secret(id: string) {
  return { id, kind: 'secret' as const, tool: 'gitleaks', rule: 'r', file: 'a.ts', line: 1 };
}

const observedAll: CaptureObservation = { notObservedReason: () => undefined };
const depUnavailable: CaptureObservation = {
  notObservedReason: (kind) =>
    kind === 'dep-vuln' ? 'the dependency scanner could not run' : undefined,
};

describe('assessCaptureDegradation (#388)', () => {
  const prior = file([dep('1'), dep('2'), secret('s1')]);

  it('refuses a kind the fresh side did not observe when the diff touched none of its inputs', () => {
    const out = assessCaptureDegradation({
      prior,
      fresh: file([secret('s1')]),
      changed: ['src.js'],
      manifestTouched: false,
      observation: depUnavailable,
    });
    expect(out.refused).toEqual([
      {
        kind: 'dep-vuln',
        priorCount: 2,
        freshCount: 0,
        provenance: 'the dependency scanner could not run',
      },
    ]);
    expect(out.cleared).toEqual([]);
  });

  it('refuses an unobserved kind even when the fresh side still holds some of it', () => {
    const out = assessCaptureDegradation({
      prior,
      fresh: file([dep('1'), secret('s1')]),
      changed: [],
      manifestTouched: false,
      observation: depUnavailable,
    });
    expect(out.refused.map((d) => [d.kind, d.priorCount, d.freshCount])).toEqual([
      ['dep-vuln', 2, 1],
    ]);
  });

  it('a diff that touched the kind inputs explains the drop: published, disclosed with the provenance', () => {
    const out = assessCaptureDegradation({
      prior,
      fresh: file([secret('s1')]),
      changed: ['package.json'],
      manifestTouched: true,
      observation: depUnavailable,
    });
    expect(out.refused).toEqual([]);
    expect(out.cleared).toHaveLength(1);
    expect(out.cleared[0].kind).toBe('dep-vuln');
    expect(out.cleared[0].explanation).toContain('touched a dependency manifest');
    expect(out.cleared[0].explanation).toContain('the dependency scanner could not run');
  });

  it('for a non-dependency kind, any tracked file change is the diff evidence', () => {
    const secretsOff: CaptureObservation = {
      notObservedReason: (kind) => (kind === 'secret' ? 'no secret scanner ran' : undefined),
    };
    const untouched = assessCaptureDegradation({
      prior,
      fresh: file([dep('1'), dep('2')]),
      changed: [],
      manifestTouched: false,
      observation: secretsOff,
    });
    expect(untouched.refused.map((d) => d.kind)).toEqual(['secret']);
    const touched = assessCaptureDegradation({
      prior,
      fresh: file([dep('1'), dep('2')]),
      changed: ['src.js'],
      manifestTouched: false,
      observation: secretsOff,
    });
    expect(touched.refused).toEqual([]);
    expect(touched.cleared[0].explanation).toContain('touched tracked files');
  });

  it('an observed full clear publishes with the honest explanation; an observed partial drop is silent', () => {
    const clear = assessCaptureDegradation({
      prior,
      fresh: file([dep('1'), dep('2')]),
      changed: [],
      manifestTouched: false,
      observation: observedAll,
    });
    expect(clear.refused).toEqual([]);
    expect(clear.cleared).toEqual([
      {
        kind: 'secret',
        priorCount: 1,
        explanation: 'the fresh capture observed the kind and found none (the repo cleared them)',
      },
    ]);
    expect(describeClearedKind(clear.cleared[0])).toBe(
      'secret: 1 -> 0 published as a full clear (the fresh capture observed the kind and found none (the repo cleared them))',
    );
    const partial = assessCaptureDegradation({
      prior,
      fresh: file([dep('1'), secret('s1')]),
      changed: [],
      manifestTouched: false,
      observation: observedAll,
    });
    expect(partial).toEqual({ refused: [], cleared: [] });
  });

  it('an uncomputable diff carries no evidence: an unobserved kind is refused', () => {
    const out = assessCaptureDegradation({
      prior,
      fresh: file([]),
      changed: null,
      manifestTouched: false,
      observation: NO_OBSERVATION_RECORD,
    });
    expect(out.refused.map((d) => d.kind)).toEqual(['dep-vuln', 'secret']);
    expect(out.refused[0].provenance).toContain('no observation evidence');
  });

  it('the refusal names every kind, both counts, the provenance and the remedy', () => {
    const msg = degradedCaptureRefusal([
      { kind: 'dep-vuln', priorCount: 13, freshCount: 0, provenance: 'scanner could not run' },
      { kind: 'secret', priorCount: 2, freshCount: 0, provenance: 'no secret scanner ran' },
    ]);
    expect(msg).toMatch(/^refusing to refresh: the fresh capture did not observe 2 kinds/);
    expect(msg).toContain(
      'dep-vuln 13 -> 0 (scanner could not run); secret 2 -> 0 (no secret scanner ran)',
    );
    expect(msg).toContain('left untouched');
    expect(msg).toContain('tools list');
    expect(msg).toContain('tools install');
    expect(msg).toContain('baseline create --force');
  });
});

describe('observationFromScan composes the gate evidence (#388)', () => {
  function scan(over: Partial<CurrentScan> = {}): CurrentScan {
    return {
      aggregate: {
        provenance: {
          secrets: { tool: 'gitleaks', ran: true },
          codePatterns: { tool: null, ran: false },
          tlsBypass: { ran: true, patternCount: 1 },
          fileFindings: { ran: true },
          depVulns: {
            tool: null,
            available: false,
            unavailableReason: 'npm audit produced nothing',
          },
        },
      } as unknown as CurrentScan['aggregate'],
      customChecksUnobserved: {
        gathered: true,
        checks: [{ name: 'lint:x', status: 'skipped-unavailable', reason: 'eslint missing' }],
      },
      ...over,
    } as CurrentScan;
  }
  const cc = (check: string) => ({
    id: check,
    kind: 'custom-check' as const,
    check,
    blocking: true,
  });

  it('reads the aggregate per-source provenance through the gate predicate', () => {
    const obs = observationFromScan(scan(), 'committed-full');
    expect(obs.notObservedReason('dep-vuln', [])).toBe(
      'not observed this run (the dependency scanner could not run)',
    );
    expect(obs.notObservedReason('code', [])).toBe(
      'not observed this run (the code-pattern scanner did not run)',
    );
    expect(obs.notObservedReason('secret', [])).toBeUndefined();
    expect(obs.notObservedReason('large-file', [])).toBeUndefined();
  });

  it('reads the custom-check seam record per check the prior recorded', () => {
    const obs = observationFromScan(scan(), 'committed-full');
    expect(obs.notObservedReason('custom-check', [cc('lint:x')])).toBe(
      'every check the prior recorded was skipped (unavailable: eslint missing)',
    );
    // A check that ran is observed; a mix is observed (only a total skip is not).
    expect(obs.notObservedReason('custom-check', [cc('lint:y')])).toBeUndefined();
    expect(obs.notObservedReason('custom-check', [cc('lint:x'), cc('lint:y')])).toBeUndefined();
    const notGathered = observationFromScan(
      scan({ customChecksUnobserved: { gathered: false, reason: 'skipped (untrusted tree)' } }),
      'committed-full',
    );
    expect(notGathered.notObservedReason('custom-check', [cc('lint:x')])).toBe(
      'skipped (untrusted tree)',
    );
  });
});

describe('classifyFreshAdvisories (#389)', () => {
  const carriedEntry: AllowlistEntry = {
    fingerprint: 'b',
    kind: 'dep-vuln',
    category: 'deferred',
    reason: 'r',
    addedBy: 'dxkit-refresh',
    addedAt: '2026-07-22',
    expiresAt: '2026-07-29',
  };

  it('unions the prior anchor, the carried hold-outs and the publication date', () => {
    const out = classifyFreshAdvisories({
      prior: file([dep('a')]),
      fresh: file([dep('a'), dep('b'), dep('c'), dep('d'), dep('e')]),
      carried: new Map([['b', carriedEntry]]),
      published: new Map([
        ['GHSA-c', '2026-01-01T00:00:00Z'],
        ['GHSA-d', '2026-08-01T00:00:00Z'],
        ['GHSA-e', 'garbage'],
      ]),
    });
    expect(out.pending.map((p) => [p.entry.id, p.since])).toEqual([['b', '2026-07-22']]);
    expect(out.disappeared.map((d) => [d.entry.id, d.published])).toEqual([
      ['c', '2026-01-01T00:00:00Z'],
    ]);
    // `d` is genuinely new; `e` has an unparseable date (unknown reads as new,
    // never as old); `a` is in the prior and is not a candidate at all.
    expect(out.newlyPublished.map((e) => e.id)).toEqual(['d', 'e']);
  });

  it('a carried advisory that is also old by date stays pending (it is still awaiting a decision)', () => {
    const out = classifyFreshAdvisories({
      prior: file([]),
      fresh: file([dep('b')]),
      carried: new Map([['b', carriedEntry]]),
      published: new Map([['GHSA-b', '2026-01-01T00:00:00Z']]),
    });
    expect(out.pending).toHaveLength(1);
    expect(out.disappeared).toEqual([]);
  });

  it('a sanitized entry has no advisory id to date and reads as new', () => {
    const out = classifyFreshAdvisories({
      prior: file([]),
      fresh: file([{ id: 'z', kind: 'dep-vuln' }]),
      carried: new Map(),
      published: new Map(),
    });
    expect(out.newlyPublished.map((e) => e.id)).toEqual(['z']);
  });

  it('the anomaly disclosure names the ids and the likely cause', () => {
    const text = describeDisappeared([
      { entry: dep('c'), published: '2026-01-01T00:00:00Z' },
      { entry: dep('f'), published: '2026-02-01T00:00:00Z' },
    ]);
    expect(text).toMatch(/^recorded debt disappeared from the prior anchor: 2 advisories/);
    expect(text).toContain('(GHSA-c, GHSA-f)');
    expect(text).toContain('degraded capture');
    expect(text).toContain('not held out');
  });

  it('resolvePublishedDates is best effort: an unknown id or a failing fetcher yields no date', async () => {
    const dates = await resolvePublishedDates(
      ['GHSA-rpd-1', 'GHSA-rpd-2', 'GHSA-rpd-1'],
      async (id) => (id === 'GHSA-rpd-1' ? { id, published: '2026-05-05T00:00:00Z' } : null),
    );
    expect([...dates]).toEqual([['GHSA-rpd-1', '2026-05-05T00:00:00Z']]);
    const failing = await resolvePublishedDates(['GHSA-rpd-3'], async () => {
      throw new Error('offline');
    });
    expect(failing.size).toBe(0);
    expect((await resolvePublishedDates([])).size).toBe(0);
  });
});
