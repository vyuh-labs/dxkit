import { describe, it, expect } from 'vitest';
import {
  renderFloorVerification,
  renderGuardrailVerdict,
} from '../../src/lanes/verification-render';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { ImpactSummary } from '../../src/baseline/impact';

/**
 * The shared floor-verification block renders the ACTUAL scope the run
 * executed at (the verification floor runs `affected`, escalating on
 * manifests) — a hardcoded "full scope" misstated what was verified. Older
 * serialized floors without the field render as full (they were).
 */

function floor(over: Partial<CorrectnessFloorResult> = {}): CorrectnessFloorResult {
  return { ran: true, checks: [], blocks: false, ...over };
}

describe('renderFloorVerification scope line', () => {
  it('renders the recorded affected scope', () => {
    const lines = renderFloorVerification(floor({ scope: 'affected' }), [], 'the entry run');
    expect(lines[0]).toContain('(affected scope, attributed vs the entry run)');
  });

  it('renders the recorded full scope', () => {
    const lines = renderFloorVerification(floor({ scope: 'full' }), [], 'the entry run');
    expect(lines[0]).toContain('(full scope,');
  });

  it('a scope-less legacy floor renders as full (what it was)', () => {
    const lines = renderFloorVerification(floor(), [], 'the entry run');
    expect(lines[0]).toContain('(full scope,');
  });

  it('a pass note (tolerated condition) rides the check line', () => {
    const lines = renderFloorVerification(
      floor({
        checks: [
          {
            pack: 'typescript',
            label: 'lockfile-sync',
            bin: 'npm',
            status: 'pass',
            note: 'peer conflict tolerated',
          },
        ],
      }),
      [],
      'the entry run',
    );
    expect(lines.join('\n')).toContain('lockfile-sync: pass (peer conflict tolerated)');
  });
});

/**
 * The lane ledgers' Impact line (impact surface phase 1): BOTH lanes render
 * the guardrail verdict through this one composer, so the finding-delta
 * grammar lands beside the verdict in the dep-bump ledger and the remediate
 * ledger from one insertion point. Non-zero gets the headline (plus cap
 * notes and the Rule 19 exclusion disclosure); a run that resolved nothing
 * gets the one quiet line; a run with no impact summary (an injected seam
 * that reports only a verdict string, or a check that never ran) renders
 * exactly what it always did.
 */

function impact(over: Partial<ImpactSummary> = {}): ImpactSummary {
  return {
    attributable: true,
    resolved: 0,
    resolvedByKind: [],
    added: 0,
    net: 0,
    excluded: [],
    capNotes: [],
    ...over,
  };
}

describe('renderGuardrailVerdict impact line', () => {
  it("renders a resolving run's headline, cap note, and exclusions beside the verdict", () => {
    const lines = renderGuardrailVerdict(
      'PASSED',
      impact({
        resolved: 3,
        net: 3,
        resolvedByKind: [
          {
            kind: 'dep-vuln',
            count: 3,
            bySeverity: [
              { severity: 'high', count: 2 },
              { severity: 'medium', count: 1 },
            ],
          },
        ],
        excluded: [{ status: 'tooling_drift', count: 2 }],
        capNotes: [
          {
            dimension: 'security',
            score: 40,
            ceiling: 40,
            reason: '8 baseline secrets committed',
            unlocksUpTo: 65,
          },
        ],
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('Guardrail: **PASSED**');
    expect(text).toContain(
      'Impact: -3 findings resolved (dep-vuln: 2 high, 1 medium) · +0 added by this change',
    );
    expect(text).toContain('security stays 40, capped by 8 baseline secrets committed');
    expect(text).toContain(
      'Not counted (cannot attribute to this change): 2 demoted to tooling drift.',
    );
  });

  it('a run that resolved nothing gets the one quiet line', () => {
    const text = renderGuardrailVerdict('PASSED', impact()).join('\n');
    expect(text).toContain(
      'Impact: No debt impact: this change neither resolves nor adds findings.',
    );
  });

  it('a refused run (not attributable) gets the one-liner, never a resolved claim', () => {
    const lines = renderGuardrailVerdict(
      'CANNOT GATE',
      impact({
        attributable: false,
        resolved: 3,
        net: 3,
        resolvedByKind: [
          { kind: 'dep-vuln', count: 3, bySeverity: [{ severity: 'high', count: 3 }] },
        ],
      }),
    );
    const text = lines.join('\n');
    expect(text).toContain('Guardrail: **CANNOT GATE**');
    expect(text).toContain('Impact: Impact not attributable this run');
    expect(text).not.toContain('findings resolved');
  });

  it('no impact summary renders the verdict line alone (backward compatible)', () => {
    expect(renderGuardrailVerdict('PASSED')).toEqual(['Guardrail: **PASSED**', '']);
  });

  it('no verdict renders nothing, impact or not', () => {
    expect(renderGuardrailVerdict(undefined, impact({ resolved: 5 }))).toEqual([]);
  });
});
