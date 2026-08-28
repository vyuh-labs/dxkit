/**
 * The impact model (impact surface phase 1): finding deltas derived from the
 * EXISTING pair classifications, attribution-honest by construction.
 *
 * The soul of the surface is CLAUDE.md Rule 19: "you fixed N findings" is a
 * cause claim, so the resolved tally may consume only the classifier's
 * verdicts (a `not_observed` or `tooling_drift` pair NEVER counts), and the
 * cap-aware explanation may only carry numbers the spec engine already
 * computed. Both directions are pinned here, plus the parity with the one
 * verdict derivation's `resolved` tally.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveImpact,
  formatImpactCapNote,
  formatImpactExclusions,
  formatImpactHeadline,
  formatImpactQuietLine,
  type ImpactScoreInput,
} from '../../src/baseline/impact';
import { verdictCounts } from '../../src/baseline/check-renderers';
import type { GuardrailCheckResult } from '../../src/baseline/check';
import type { ClassifiedPair } from '../../src/gate/result';
import type { BaselineEntry, FindingSeverity, FindingStatus } from '../../src/baseline/types';

let seq = 0;

/** A synthetic classified pair, the minimum the impact model reads. */
function pair(
  status: FindingStatus,
  over: {
    kind?: BaselineEntry['kind'];
    severity?: FindingSeverity;
    priorId?: string;
    currentId?: string;
  } = {},
): ClassifiedPair {
  seq += 1;
  const matcherStatus = status === 'removed' || status === 'not_observed' ? 'removed' : 'added';
  return {
    pair: {
      ...(matcherStatus === 'removed'
        ? { priorId: over.priorId ?? `prior-${seq}` }
        : { currentId: over.currentId ?? `current-${seq}` }),
      status: matcherStatus,
      confidence: 1,
      reasons: [],
    },
    classification: { status, blocks: status === 'added', warns: false, reasons: [] },
    kind: over.kind ?? 'dep-vuln',
    ...(over.severity !== undefined ? { severity: over.severity } : {}),
  } as unknown as ClassifiedPair;
}

function input(
  pairs: ClassifiedPair[],
  findings: BaselineEntry[] = [],
): { pairs: ClassifiedPair[]; baseline: { findings: BaselineEntry[] } } {
  return { pairs, baseline: { findings } };
}

describe('deriveImpact: the attributable finding delta', () => {
  it('counts resolved pairs by kind and severity', () => {
    const impact = deriveImpact(
      input([
        pair('removed', { kind: 'dep-vuln', severity: 'high' }),
        pair('removed', { kind: 'dep-vuln', severity: 'high' }),
        pair('removed', { kind: 'dep-vuln', severity: 'medium' }),
        pair('removed', { kind: 'secret', severity: 'high' }),
      ]),
    );
    expect(impact.resolved).toBe(4);
    expect(impact.added).toBe(0);
    expect(impact.net).toBe(4);
    expect(impact.resolvedByKind).toEqual([
      {
        kind: 'dep-vuln',
        count: 3,
        bySeverity: [
          { severity: 'high', count: 2 },
          { severity: 'medium', count: 1 },
        ],
      },
      { kind: 'secret', count: 1, bySeverity: [{ severity: 'high', count: 1 }] },
    ]);
    expect(impact.excluded).toEqual([]);
  });

  it('a mixed change counts both directions and nets them', () => {
    const impact = deriveImpact(
      input([
        pair('removed', { kind: 'dep-vuln', severity: 'high' }),
        pair('removed', { kind: 'dep-vuln', severity: 'low' }),
        pair('added', { kind: 'code', severity: 'medium' }),
      ]),
    );
    expect(impact.resolved).toBe(2);
    expect(impact.added).toBe(1);
    expect(impact.net).toBe(1);
  });

  it('a neutral change is all zeros, reported as zeros (never omitted)', () => {
    const impact = deriveImpact(input([pair('persisted'), pair('relocated')]));
    expect(impact).toEqual({
      resolved: 0,
      resolvedByKind: [],
      added: 0,
      net: 0,
      excluded: [],
      capNotes: [],
    });
  });

  it('Rule 19, removed direction: a not_observed pair never counts as resolved', () => {
    const impact = deriveImpact(
      input([
        pair('removed', { kind: 'custom-check' }),
        pair('not_observed', { kind: 'custom-check' }),
      ]),
    );
    expect(impact.resolved).toBe(1);
    expect(impact.excluded).toEqual([{ status: 'not_observed', count: 1 }]);
  });

  it('Rule 19, added direction: a tooling_drift pair never counts as added', () => {
    const impact = deriveImpact(input([pair('tooling_drift', { kind: 'code' })]));
    expect(impact.added).toBe(0);
    expect(impact.net).toBe(0);
    expect(impact.excluded).toEqual([{ status: 'tooling_drift', count: 1 }]);
  });

  it('every unattributable delta status lands in excluded, not in the delta', () => {
    const impact = deriveImpact(
      input([
        pair('config_drift'),
        pair('newly_published_advisory'),
        pair('uncertain'),
        pair('probable_existing'),
      ]),
    );
    expect(impact.added).toBe(0);
    expect(impact.resolved).toBe(0);
    expect(impact.excluded.map((e) => e.status).sort()).toEqual([
      'config_drift',
      'newly_published_advisory',
      'probable_existing',
      'uncertain',
    ]);
  });

  it("resolved severity prefers the prior entry's captured severity over the kind default", () => {
    // The pair carries the kind-default severity (removed pairs have no
    // current-side aggregate entry), but the baseline captured the advisory
    // as critical: the impact breakdown must say critical.
    const prior: BaselineEntry = {
      id: 'prior-x' as BaselineEntry['id'],
      kind: 'dep-vuln',
      package: 'left-pad',
      advisoryId: 'GHSA-xxxx',
      severity: 'critical',
    };
    const impact = deriveImpact(
      input(
        [pair('removed', { kind: 'dep-vuln', severity: 'medium', priorId: 'prior-x' })],
        [prior],
      ),
    );
    expect(impact.resolvedByKind).toEqual([
      { kind: 'dep-vuln', count: 1, bySeverity: [{ severity: 'critical', count: 1 }] },
    ]);
  });

  it("parity: impact.resolved equals the one verdict derivation's resolved tally", () => {
    const pairs = [
      pair('removed'),
      pair('removed'),
      pair('not_observed'),
      pair('tooling_drift'),
      pair('added'),
      pair('persisted'),
    ];
    const impact = deriveImpact(input(pairs));
    const minimal = {
      pairs,
      blocks: true,
      warns: false,
      attributionGaps: [],
      requiredNotObserved: [],
    } as unknown as GuardrailCheckResult;
    expect(impact.resolved).toBe(verdictCounts(minimal).resolved);
  });
});

describe('deriveImpact: the cap-aware explanation (spec-engine numbers, never recomputed)', () => {
  const cappedScore: ImpactScoreInput = {
    dimension: 'security',
    score: 40,
    capsApplied: [
      {
        id: 'secrets-cap',
        tier: 'trust-broken',
        ceiling: 40,
        reason: '8 baseline secrets committed',
        upliftIfRemoved: 25,
      },
    ],
    topActions: [
      {
        source: 'cap',
        id: 'secrets-cap',
        reason: 'rotate and remove the committed secrets',
        upliftIfFixed: 25,
      },
    ],
  };

  it('a capped dimension yields a cap note with the unlock from the spec engine', () => {
    const impact = deriveImpact(input([pair('removed', { severity: 'high' })]), [cappedScore]);
    expect(impact.capNotes).toEqual([
      {
        dimension: 'security',
        score: 40,
        ceiling: 40,
        reason: '8 baseline secrets committed',
        unlocksUpTo: 65,
        largestUplift: { reason: 'rotate and remove the committed secrets', uplift: 25 },
      },
    ]);
  });

  it('an uncapped dimension yields no cap note (score projection is phase 2)', () => {
    const impact = deriveImpact(input([pair('removed')]), [
      { dimension: 'quality', score: 72, capsApplied: [], topActions: [] },
    ]);
    expect(impact.capNotes).toEqual([]);
  });

  it('no score input means no cap note: the section carries the finding delta alone', () => {
    expect(deriveImpact(input([pair('removed')])).capNotes).toEqual([]);
  });
});

describe('the one impact phrasing', () => {
  it('headline: findings first, resolved detail, added count', () => {
    const impact = deriveImpact(
      input([
        pair('removed', { kind: 'dep-vuln', severity: 'high' }),
        pair('removed', { kind: 'dep-vuln', severity: 'high' }),
        pair('removed', { kind: 'dep-vuln', severity: 'medium' }),
      ]),
    );
    expect(formatImpactHeadline(impact)).toBe(
      '-3 findings resolved (dep-vuln: 2 high, 1 medium) · +0 added by this change',
    );
  });

  it('cap note: names the cap, the unlock, and the largest uplift', () => {
    const line = formatImpactCapNote({
      dimension: 'security',
      score: 40,
      ceiling: 40,
      reason: '8 baseline secrets committed',
      unlocksUpTo: 65,
      largestUplift: { reason: 'rotate and remove the committed secrets', uplift: 25 },
    });
    expect(line).toBe(
      'security stays 40, capped by 8 baseline secrets committed (clearing that unlocks ' +
        'up to 65). Largest available uplift: rotate and remove the committed secrets (+25)',
    );
  });

  it('exclusions line names each unattributable status; null when nothing was excluded', () => {
    const impact = deriveImpact(
      input([pair('removed'), pair('not_observed'), pair('tooling_drift'), pair('tooling_drift')]),
    );
    expect(formatImpactExclusions(impact)).toBe(
      'Not counted (cannot attribute to this change): 1 not re-verified this run, 2 tooling drift.',
    );
    expect(formatImpactExclusions(deriveImpact(input([pair('removed')])))).toBeNull();
  });

  it('quiet line: neutral, and the added-only variant that defers to the findings', () => {
    expect(formatImpactQuietLine(deriveImpact(input([])))).toBe(
      'No debt impact: this change neither resolves nor adds findings.',
    );
    expect(formatImpactQuietLine(deriveImpact(input([pair('added'), pair('added')])))).toBe(
      'No findings resolved by this change; the +2 it adds are reported with the guardrail findings.',
    );
  });
});
