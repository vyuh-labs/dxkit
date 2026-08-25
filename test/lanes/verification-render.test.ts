import { describe, it, expect } from 'vitest';
import { renderFloorVerification } from '../../src/lanes/verification-render';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';

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
