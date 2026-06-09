import { describe, it, expect } from 'vitest';
import { parseCodeowners, matchCodeowners, buildSuggestions } from '../src/reviewers-cli';
import type { OwnershipResult, FileOwner } from '../src/analyzers/developer/ownership';

function owner(p: Partial<FileOwner> & { name: string }): FileOwner {
  return {
    email: `${p.name.toLowerCase()}@c.com`,
    commits: 1,
    lastTouched: '2026-06-01',
    active: true,
    score: 1,
    ...p,
  };
}

function ownership(ranked: FileOwner[], busFactor = 1): OwnershipResult {
  return { ranked, busFactor, allInactive: ranked.every((o) => !o.active) };
}

describe('parseCodeowners + matchCodeowners', () => {
  const rules = parseCodeowners(
    ['# comment', '* @org/default', '/src/payments/ @alice @bob', '*.md @docs-team'].join('\n'),
  );

  it('parses pattern + owners, skips comments', () => {
    expect(rules).toHaveLength(3);
    expect(rules[1]).toEqual({ pattern: '/src/payments/', owners: ['@alice', '@bob'] });
  });

  it('last matching rule wins', () => {
    expect(matchCodeowners(rules, 'src/payments/refund.ts')).toEqual(['@alice', '@bob']);
    expect(matchCodeowners(rules, 'README.md')).toEqual(['@docs-team']);
    expect(matchCodeowners(rules, 'src/other/x.ts')).toEqual(['@org/default']);
  });
});

describe('buildSuggestions', () => {
  it('puts CODEOWNERS first (authoritative), then active git owners', () => {
    const out = buildSuggestions(
      ownership([owner({ name: 'Carol', githubHandle: 'carol', score: 5 })]),
      { codeowners: ['@alice'] },
    );
    expect(out.reviewers[0]).toMatchObject({ handle: 'alice', isCodeowner: true });
    expect(out.reviewers[1]).toMatchObject({ handle: 'carol', isCodeowner: false });
  });

  it('drops inactive owners from suggestions but notes the fallback', () => {
    const out = buildSuggestions(ownership([owner({ name: 'Gone', active: false })]));
    expect(out.reviewers).toHaveLength(0);
    expect(out.note).toMatch(/inactive/i);
  });

  it('honors the limit', () => {
    const out = buildSuggestions(
      ownership([
        owner({ name: 'A', githubHandle: 'a', score: 3 }),
        owner({ name: 'B', githubHandle: 'b', score: 2 }),
        owner({ name: 'C', githubHandle: 'c', score: 1 }),
      ]),
      { limit: 2 },
    );
    expect(out.reviewers).toHaveLength(2);
    expect(out.reviewers.map((r) => r.handle)).toEqual(['a', 'b']);
  });

  it('dedupes a CODEOWNER who is also a git owner', () => {
    const out = buildSuggestions(
      ownership([owner({ name: 'alice', githubHandle: 'alice', score: 5 })]),
      { codeowners: ['@alice'] },
    );
    expect(out.reviewers.filter((r) => r.handle === 'alice')).toHaveLength(1);
    expect(out.reviewers[0].isCodeowner).toBe(true);
  });

  it('never renders an email — only name/handle surface', () => {
    const out = buildSuggestions(ownership([owner({ name: 'Dave', githubHandle: 'dave' })]));
    const blob = JSON.stringify(out.reviewers);
    expect(blob).not.toContain('@c.com');
  });
});
