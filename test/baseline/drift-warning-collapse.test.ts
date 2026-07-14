import { describe, it, expect } from 'vitest';
import { formatDriftWarningSummary } from '../../src/baseline/check-renderers';
import type { ClassifiedPair } from '../../src/baseline/check';

/**
 * gh #157: the envelope-drift warning WALL collapses to ONE summary line, and
 * names the truer gate-just-enabled cause when it applies — so a policy.json
 * edit or a dxkit upgrade doesn't bury the specific warnings under dozens of
 * `config_drift` lines.
 */

function driftPair(reasonCode: string): ClassifiedPair {
  return {
    classification: {
      status: 'config_drift',
      reasons: [{ code: reasonCode, detail: 'x' }],
      blocks: false,
      warns: true,
    },
  } as unknown as ClassifiedPair;
}

describe('formatDriftWarningSummary', () => {
  it('collapses N drift warnings into a single summary line with the count', () => {
    const out = formatDriftWarningSummary(
      [driftPair('config-drift'), driftPair('config-drift'), driftPair('config-drift')],
      '  ',
    );
    // One headline line + one guidance line — NOT one line per finding.
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('3 findings unmatched after an envelope change');
    expect(out[1]).toContain('--json');
  });

  it('names the gate-just-enabled cause when every drift finding is a new dimension', () => {
    const out = formatDriftWarningSummary(
      [driftPair('dimension-newly-measured'), driftPair('dimension-newly-measured')],
      '  ',
    );
    expect(out[0]).toMatch(/gate\/dimension was newly enabled/);
  });

  it('reports a partial gate-enabled breakdown when mixed with generic drift', () => {
    const out = formatDriftWarningSummary(
      [driftPair('dimension-newly-measured'), driftPair('config-drift')],
      '  ',
    );
    expect(out[0]).toContain('2 findings');
    expect(out[0]).toMatch(/1 from a newly-enabled gate\/dimension/);
  });

  it('falls back to the generic envelope-change cause when none are gate-enabled', () => {
    const out = formatDriftWarningSummary([driftPair('config-drift')], '  ');
    expect(out[0]).toMatch(/dxkit upgrade or policy\/config change/);
    expect(out[0]).toContain('1 finding unmatched');
  });
});
