import { describe, it, expect } from 'vitest';
import {
  rankOwners,
  handleFromEmail,
  type CommitTouch,
} from '../../../src/analyzers/developer/ownership';

const NOW = new Date('2026-06-09T00:00:00Z');

function touch(name: string, email: string, daysAgo: number): CommitTouch {
  const d = new Date(NOW.getTime() - daysAgo * 24 * 60 * 60 * 1000);
  return { name, email, dateISO: d.toISOString() };
}

describe('handleFromEmail', () => {
  it('extracts the login from a GitHub noreply email', () => {
    expect(handleFromEmail('octocat@users.noreply.github.com')).toBe('octocat');
    expect(handleFromEmail('12345+octocat@users.noreply.github.com')).toBe('octocat');
  });
  it('returns undefined for a real email', () => {
    expect(handleFromEmail('jane@corp.com')).toBeUndefined();
  });
});

describe('rankOwners', () => {
  it('ranks recent, sustained activity above an old single commit', () => {
    const touches: CommitTouch[] = [
      touch('Old Hand', 'old@c.com', 900), // one ancient commit
      touch('Recent A', 'a@c.com', 10),
      touch('Recent A', 'a@c.com', 20),
      touch('Recent A', 'a@c.com', 30),
    ];
    const active = new Set(['old@c.com', 'a@c.com']);
    const out = rankOwners(touches, active, { now: NOW });
    expect(out.ranked[0].name).toBe('Recent A');
    expect(out.ranked[1].name).toBe('Old Hand');
  });

  it('marks an author who has gone quiet as inactive (departed)', () => {
    const touches: CommitTouch[] = [touch('Gone Dev', 'gone@c.com', 800)];
    const active = new Set<string>(); // not in the recent window
    const out = rankOwners(touches, active, { now: NOW });
    expect(out.ranked).toHaveLength(1);
    expect(out.ranked[0].active).toBe(false);
    expect(out.allInactive).toBe(true);
  });

  it('excludes bots from the ranking', () => {
    const touches: CommitTouch[] = [
      touch('dependabot[bot]', 'dependabot@github.com', 5),
      touch('Real Dev', 'real@c.com', 5),
    ];
    const out = rankOwners(touches, new Set(['real@c.com']), { now: NOW });
    expect(out.ranked.map((o) => o.name)).toEqual(['Real Dev']);
  });

  it('excludes the PR author via excludeEmails (normalized)', () => {
    const touches: CommitTouch[] = [
      touch('Author', 'author@c.com', 5),
      touch('Reviewer', 'rev@c.com', 5),
    ];
    const out = rankOwners(touches, new Set(['author@c.com', 'rev@c.com']), {
      now: NOW,
      excludeEmails: new Set(['author@c.com']),
    });
    expect(out.ranked.map((o) => o.name)).toEqual(['Reviewer']);
  });

  it('clusters aliases that share a normalized email (incl. noreply +digits)', () => {
    const touches: CommitTouch[] = [
      touch('Jane Laptop', 'jane@c.com', 10),
      touch('Jane Corp', '99+jane@c.com', 5), // normalizes to jane@c.com
    ];
    const out = rankOwners(touches, new Set(['jane@c.com']), { now: NOW });
    expect(out.ranked).toHaveLength(1);
    expect(out.ranked[0].commits).toBe(2);
    expect(out.ranked[0].name).toBe('Jane Corp'); // most recent commit's name
  });

  it('resolves a github handle offline from a noreply alias', () => {
    const touches: CommitTouch[] = [touch('Octo', 'octo@users.noreply.github.com', 5)];
    const out = rankOwners(touches, new Set(['octo@users.noreply.github.com']), { now: NOW });
    expect(out.ranked[0].githubHandle).toBe('octo');
    // email is the internal key; handle is the renderable identity
    expect(out.ranked[0].email).toBe('octo@users.noreply.github.com');
  });

  it('computes bus factor over ACTIVE owners only', () => {
    // One dominant active owner → bus factor 1 (single point of failure).
    const touches: CommitTouch[] = [
      ...Array.from({ length: 8 }, (_, i) => touch('Dominant', 'dom@c.com', 5 + i)),
      touch('Minor', 'min@c.com', 5),
    ];
    const out = rankOwners(touches, new Set(['dom@c.com', 'min@c.com']), { now: NOW });
    expect(out.busFactor).toBe(1);
    expect(out.allInactive).toBe(false);
  });

  it('busFactor is 0 and allInactive true when no owner is active', () => {
    const touches: CommitTouch[] = [touch('A', 'a@c.com', 400), touch('B', 'b@c.com', 500)];
    const out = rankOwners(touches, new Set<string>(), { now: NOW });
    expect(out.busFactor).toBe(0);
    expect(out.allInactive).toBe(true);
  });
});
