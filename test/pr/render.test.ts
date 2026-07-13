import { describe, it, expect } from 'vitest';
import { renderPrBody, renderPrJson, type PrData } from '../../src/pr/render';
import { parseCommits, bucketCommits } from '../../src/pr/commits';
import type { DuplicateGroup } from '../../src/analyzers/duplication/findings';
import type { ReviewersResult } from '../../src/reviewers-cli';

const reviewers: ReviewersResult = {
  touchedFiles: ['src/a.ts'],
  reviewers: [
    {
      name: 'Alice',
      handle: 'alice',
      active: true,
      isCodeowner: false,
      reason: 'owns 2/2 files',
      score: 9,
    },
    {
      name: '@team/core',
      handle: 'team/core',
      active: true,
      isCodeowner: true,
      reason: 'listed in CODEOWNERS',
      score: Infinity,
    },
  ],
  busFactor: 2,
};

const seams: DuplicateGroup[] = [
  {
    added: { symbol: 'createLeagueButton', file: 'src/ui/league.tsx', line: 10 },
    twins: [
      {
        anchor: { symbol: 'createDivisionButton', file: 'src/ui/division.tsx', line: 8 },
        score: 0.96,
        id: 'abc123',
        bothAdded: false,
      },
    ],
    topScore: 0.96,
  },
];

function baseData(overrides: Partial<PrData> = {}): PrData {
  return {
    title: 'feat(pr): reviewer surface',
    buckets: bucketCommits(parseCommits(['feat(pr): reviewer surface', 'test: cover it'])),
    receiptMarkdown: '## Guardrail: PASSED\n\nNo net-new findings.',
    reviewers,
    seams,
    checklist: ['Change matches the description', 'No secrets, keys, or tokens in the diff'],
    base: 'origin/main',
    ...overrides,
  };
}

describe('renderPrBody', () => {
  it('renders every section in order', () => {
    const body = renderPrBody(baseData());
    expect(body).toContain('# feat(pr): reviewer surface');
    expect(body).toContain('## What & why');
    expect(body).toContain('## Changes');
    expect(body).toContain('### Features');
    expect(body).toContain('## dxkit signals');
    expect(body).toContain('## Guardrail: PASSED');
    expect(body).toContain('## Suggested reviewers');
    expect(body).toContain('@alice');
    expect(body).toContain('[CODEOWNERS]');
    expect(body).toContain('## Structural review (dxkit)');
    expect(body).toContain('`createLeagueButton`');
    expect(body).toContain('96% similar');
    expect(body).toContain('## Reviewer checklist');
    expect(body).toContain('- [ ] No secrets');
    expect(body).toContain('computed against `origin/main`');
  });

  it('falls back to <title> when no title computed', () => {
    expect(renderPrBody(baseData({ title: '' }))).toContain('# <title>');
  });

  it('omits the signals section when the receipt could not run', () => {
    const body = renderPrBody(baseData({ receiptMarkdown: null }));
    expect(body).not.toContain('## dxkit signals');
  });

  it('omits the structural-review section when there are no seams', () => {
    const body = renderPrBody(baseData({ seams: [] }));
    expect(body).not.toContain('## Structural review');
  });

  it('surfaces a bus-factor-1 warning', () => {
    const solo: ReviewersResult = { ...reviewers, busFactor: 1 };
    expect(renderPrBody(baseData({ reviewers: solo }))).toContain('Bus factor 1');
  });

  it('shows the note when reviewers has no suggestions', () => {
    const none: ReviewersResult = {
      touchedFiles: [],
      reviewers: [],
      busFactor: 0,
      note: 'No signal',
    };
    expect(renderPrBody(baseData({ reviewers: none }))).toContain('No signal');
  });
});

describe('renderPrJson', () => {
  it('projects the computed fields with the schema tag', () => {
    const json = renderPrJson(baseData()) as Record<string, unknown>;
    expect(json.schema).toBe('pr.v1');
    expect(json.title).toBe('feat(pr): reviewer surface');
    expect((json.structuralDuplicates as unknown[]).length).toBe(1);
    expect((json.checklist as unknown[]).length).toBe(2);
    expect(typeof json.markdown).toBe('string');
  });
});
