import { describe, expect, it } from 'vitest';

import {
  evaluateSpec,
  formatTopActionLine,
  formatTopActionsBlock,
  type DimensionScoringSpec,
} from '../src/scoring';

interface Toy {
  errors: number;
  hasSecret: boolean;
  highOpen: boolean;
  count: number;
}

const TOY: DimensionScoringSpec<Toy> = {
  dimension: 'toy',
  methodology: 'test-only',
  baseline: 100,
  penalties: [
    {
      id: 'errors',
      describe: (i) => `${i.errors} error(s) detected`,
      applies: (i) => i.errors > 0,
      delta: (i) => -Math.min(50, i.errors * 5),
    },
    {
      id: 'unbounded',
      describe: () => 'unbounded penalty',
      applies: (i) => i.count > 0,
      delta: (i) => -i.count * 10,
    },
  ],
  caps: [
    {
      id: 'secret',
      tier: 'trust-broken',
      describe: () => 'secret committed to source',
      applies: (i) => i.hasSecret,
    },
    {
      id: 'high-open',
      tier: 'fixable-finding',
      describe: () => 'an open HIGH+ finding',
      applies: (i) => i.highOpen,
    },
  ],
};

function inp(overrides: Partial<Toy> = {}): Toy {
  return { errors: 0, hasSecret: false, highOpen: false, count: 0, ...overrides };
}

describe('formatTopActionLine', () => {
  it('returns empty string when the dimension has no actionable items', () => {
    const r = evaluateSpec(TOY, inp());
    expect(formatTopActionLine(r)).toBe('');
  });

  it('formats the highest-uplift deduction with score and rating transition', () => {
    const r = evaluateSpec(TOY, inp({ errors: 3 }));
    // -15 → score 85 (A); fixing returns to 100 (A). No transition.
    expect(formatTopActionLine(r)).toBe('3 error(s) detected +15');
  });

  it('annotates rating transition when uplift would cross a band', () => {
    const r = evaluateSpec(TOY, inp({ highOpen: true }));
    // Fixable-finding cap binds at 79 (B); fix lifts to 100 (A).
    const line = formatTopActionLine(r);
    expect(line).toContain('an open HIGH+ finding');
    expect(line).toContain('(B → A)');
  });
});

describe('formatTopActionsBlock', () => {
  it('returns an empty array when nothing is actionable', () => {
    const r = evaluateSpec(TOY, inp());
    expect(formatTopActionsBlock(r)).toEqual([]);
  });

  it('surfaces a binding cap separately from the action list', () => {
    const r = evaluateSpec(TOY, inp({ hasSecret: true, errors: 2 }));
    const block = formatTopActionsBlock(r);
    // Cap line is the first non-empty line.
    expect(block.some((l) => l.includes('Rating cap'))).toBe(true);
    expect(block.some((l) => l.includes('secret committed'))).toBe(true);
  });

  it('discloses severe debt when rawScore drops below 0', () => {
    const r = evaluateSpec(TOY, inp({ count: 20 }));
    const block = formatTopActionsBlock(r);
    expect(block.some((l) => l.includes('Severe'))).toBe(true);
    expect(block.some((l) => l.includes('raw penalty'))).toBe(true);
  });

  it('respects the limit parameter', () => {
    const r = evaluateSpec(TOY, inp({ errors: 3, count: 5 }));
    const block = formatTopActionsBlock(r, 1);
    const bulletLines = block.filter((l) => l.startsWith('- '));
    expect(bulletLines.length).toBe(1);
  });
});
