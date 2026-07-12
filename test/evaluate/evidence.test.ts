import { describe, it, expect } from 'vitest';
import type { GuardrailJsonPayload } from '../../src/baseline/check-renderers';
import {
  ANACHRONISM_NOTE,
  buildCosts,
  buildEvidenceDoc,
  seamVisibilityFrom,
  EVALUATE_EVIDENCE_SCHEMA,
  type EvaluateRunEvidence,
} from '../../src/evaluate/evidence';
import { renderEvaluateText } from '../../src/evaluate/render';

/** A minimal guardrail payload carrying only the fields evidence/render
 *  read. Narrow test-fixture cast; the real payload is produced by
 *  `renderJson` and exercised by the zero-write integration test. */
export function fakePayload(findingsCount: number): GuardrailJsonPayload {
  return {
    schema: 'dxkit.guardrail-check.v1',
    verdict: { blocks: false, warns: false, exitCode: 0 },
    baseline: {
      name: 'main',
      createdAt: '2026-07-12T00:00:00Z',
      commitSha: 'a'.repeat(40),
      branch: 'main',
      findingsCount,
      mode: { value: 'ref-based', source: 'cli', explanation: 'test' },
    },
    current: { commitSha: 'b'.repeat(40), branch: 'main', findingsCount },
    matcher: { gitAware: true },
    envelopeDrift: {},
    policy: { mode: 'strict', block: [], warn: [], confidence: {}, blockRules: {} },
    summary: { pairs: 0, blocking: 0, suppressed: 0, warning: 0, persisted: 0, resolved: 0 },
    pairs: [],
  } as unknown as GuardrailJsonPayload;
}

export function fakeRun(over: Partial<EvaluateRunEvidence> = {}): EvaluateRunEvidence {
  return {
    label: '#1',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    verdict: { blocks: false, warns: false },
    blocking: [],
    warningCount: 0,
    refExcludedKinds: [],
    coverage: { scanners: [{ tool: 'gitleaks', available: true, source: 'path' }] },
    toolVersions: { base: {}, head: {} },
    matcher: { gitAware: true },
    guardrail: fakePayload(3),
    durationMs: 1000,
    ...over,
  };
}

function docWith(runs: EvaluateRunEvidence[]) {
  return buildEvidenceDoc({
    branch: 'main',
    ref: 'HEAD',
    preset: 'security-only',
    presetSource: 'default',
    policyBase: 'defaults',
    incremental: true,
    untrusted: false,
    runs,
  });
}

describe('evaluate evidence schema freeze', () => {
  it('pins the schema id', () => {
    expect(EVALUATE_EVIDENCE_SCHEMA).toBe('dxkit.evaluate-evidence.v1');
  });

  it('pins the v1 top-level field set (additions require review; removals require a v2)', () => {
    const doc = docWith([fakeRun()]);
    expect(Object.keys(doc).sort()).toEqual(
      [
        'schema',
        'generatedAt',
        'dxkitVersion',
        'repo',
        'policy',
        'options',
        'zeroWrite',
        'runs',
        'totals',
        'notes',
        'costs',
      ].sort(),
    );
    expect(doc.zeroWrite).toBe(true);
  });

  it('carries the optional seam-visibility lane when provided (reviewed addition)', () => {
    const inv = {
      duplicates: [
        {
          anchors: [
            { file: 'src/api/ctrl.ts', symbol: 'listTeams' },
            { file: 'src/api/ctrl.ts', symbol: 'listTeamsLegacy' },
          ] as const,
          score: 0.9,
        },
      ],
      dead: {
        crossRepoConsumersVisible: true,
        byTier: { removable: 1, likely: 0, expected: 2 },
      },
      converged: [
        {
          route: { method: 'GET', path: '/teams-legacy', file: 'src/api/ctrl.ts' },
          duplicate: { anchors: [{ symbol: 'listTeams' }, { symbol: 'listTeamsLegacy' }] as const },
        },
      ],
    };
    const seams = seamVisibilityFrom(inv);
    expect(seams.duplicates).toBe(1);
    expect(seams.dead).toEqual({ removable: 1, likely: 0, expected: 2 });
    expect(seams.converged[0]).toEqual({
      method: 'GET',
      path: '/teams-legacy',
      file: 'src/api/ctrl.ts',
      twin: ['listTeams', 'listTeamsLegacy'],
    });
    const doc = buildEvidenceDoc({
      branch: 'main',
      ref: 'HEAD',
      preset: 'security-only',
      presetSource: 'default',
      policyBase: 'defaults',
      incremental: true,
      untrusted: false,
      runs: [fakeRun()],
      seams,
    });
    expect(doc.seams).toEqual(seams);
    // The visibility lane renders the convergence story in the human output.
    const text = renderEvaluateText(doc);
    expect(text).toContain('What dxkit sees beyond the gate');
    expect(text).toContain('converged');
    expect(text).toContain('/teams-legacy');
  });
});

describe('buildEvidenceDoc', () => {
  it('computes totals across clean, warned, blocked, and errored landings', () => {
    const doc = docWith([
      fakeRun(),
      fakeRun({ verdict: { blocks: false, warns: true }, warningCount: 2 }),
      fakeRun({
        verdict: { blocks: true, warns: false },
        blocking: [{ kind: 'secret' }],
      }),
      fakeRun({ error: { message: 'unreachable ref' } }),
    ]);
    expect(doc.totals).toEqual({ landings: 4, blocked: 1, warned: 1, clean: 1, errored: 1 });
  });

  it('discloses ref-excluded kinds and the dep-advisory anachronism only when they apply', () => {
    const clean = docWith([fakeRun()]);
    expect(clean.notes).toHaveLength(0);

    const disclosed = docWith([
      fakeRun({
        verdict: { blocks: true, warns: false },
        blocking: [{ kind: 'dep-vuln', severity: 'critical' }],
        refExcludedKinds: [{ kind: 'test-gap', currentCount: 4 }],
      }),
    ]);
    expect(disclosed.notes.some((n) => n.includes('test-gap'))).toBe(true);
    expect(disclosed.notes).toContain(ANACHRONISM_NOTE);
  });

  it('never discloses the internal secret-hmac companion as an unwatched class', () => {
    const doc = docWith([
      fakeRun({ refExcludedKinds: [{ kind: 'secret-hmac', currentCount: 2 }] }),
    ]);
    expect(doc.notes).toHaveLength(0);
    // Fidelity preserved in the per-run data.
    expect(doc.runs[0].refExcludedKinds[0].kind).toBe('secret-hmac');
  });
});

describe('buildCosts', () => {
  it('measures latency percentiles, interruption rate, warn noise, and missing scanners', () => {
    const costs = buildCosts([
      fakeRun({ durationMs: 1000 }),
      fakeRun({ durationMs: 2000, warningCount: 3 }),
      fakeRun({
        durationMs: 9000,
        verdict: { blocks: true, warns: false },
        coverage: {
          scanners: [
            { tool: 'gitleaks', available: true, source: 'path' },
            { tool: 'semgrep', available: false, source: 'missing' },
          ],
        },
      }),
      fakeRun({ durationMs: 50, error: { message: 'x' } }), // excluded from stats
    ]);
    expect(costs.gateReplayMs.median).toBe(2000);
    expect(costs.gateReplayMs.max).toBe(9000);
    expect(costs.interruptions).toEqual({ blockedLandings: 1, landings: 3 });
    expect(costs.warnNoise).toBe(3);
    expect(costs.setup.missingScanners).toEqual(['semgrep']);
    expect(costs.setup.writes.length).toBeGreaterThan(0);
  });
});
