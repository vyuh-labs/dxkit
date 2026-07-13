import { describe, it, expect } from 'vitest';
import {
  parseCommitSubject,
  parseCommits,
  bucketCommits,
  dominantType,
  dominantScope,
  suggestTitle,
} from '../../src/pr/commits';

describe('parseCommitSubject', () => {
  it('parses a conventional commit with scope', () => {
    const c = parseCommitSubject('feat(auth): add refresh-token rotation');
    expect(c.type).toBe('feat');
    expect(c.scope).toBe('auth');
    expect(c.subject).toBe('add refresh-token rotation');
    expect(c.breaking).toBe(false);
  });

  it('parses without a scope', () => {
    const c = parseCommitSubject('fix: handle empty diff');
    expect(c.type).toBe('fix');
    expect(c.scope).toBeUndefined();
    expect(c.subject).toBe('handle empty diff');
  });

  it('flags a breaking change via bang', () => {
    const c = parseCommitSubject('feat(api)!: drop v1 endpoints');
    expect(c.breaking).toBe(true);
    expect(c.scope).toBe('api');
  });

  it('flags a breaking change via BREAKING CHANGE footer text', () => {
    expect(parseCommitSubject('feat: x BREAKING CHANGE later').breaking).toBe(true);
  });

  it('keeps a non-conventional subject as type other, never dropped', () => {
    const c = parseCommitSubject('Merge branch main into feature');
    expect(c.type).toBe('other');
    expect(c.subject).toBe('Merge branch main into feature');
  });

  it('maps an unknown type token to other', () => {
    expect(parseCommitSubject('wip(x): scratch').type).toBe('other');
  });
});

describe('dominantType', () => {
  it('picks the type with the most commits', () => {
    const commits = parseCommits(['fix: a', 'fix: b', 'feat: c']);
    expect(dominantType(commits)).toBe('fix');
  });

  it('breaks a count tie by headline priority (feat over fix)', () => {
    const commits = parseCommits(['fix: a', 'feat: b']);
    expect(dominantType(commits)).toBe('feat');
  });

  it('returns other for an empty list', () => {
    expect(dominantType([])).toBe('other');
  });
});

describe('dominantScope', () => {
  it('picks the most common scope among the given type', () => {
    const commits = parseCommits(['feat(pr): a', 'feat(pr): b', 'feat(flow): c', 'fix(x): d']);
    expect(dominantScope(commits, 'feat')).toBe('pr');
  });

  it('returns undefined when no commit of that type carries a scope', () => {
    expect(dominantScope(parseCommits(['feat: a']), 'feat')).toBeUndefined();
  });
});

describe('bucketCommits', () => {
  it('groups into ordered display buckets, dropping empties', () => {
    const buckets = bucketCommits(
      parseCommits(['feat: a', 'fix: b', 'refactor: c', 'perf: d', 'chore: e', 'docs: f']),
    );
    const labels = buckets.map((b) => b.label);
    expect(labels).toEqual(['Features', 'Fixes', 'Refactors', 'Docs', 'Chore']);
    // perf rolls into Refactors alongside refactor
    expect(buckets.find((b) => b.label === 'Refactors')!.commits).toHaveLength(2);
  });
});

describe('suggestTitle', () => {
  it('uses a single commit verbatim', () => {
    expect(suggestTitle(parseCommits(['feat(auth): add rotation']))).toBe(
      'feat(auth): add rotation',
    );
  });

  it('synthesizes type(scope): headline for a multi-commit branch', () => {
    const title = suggestTitle(
      parseCommits(['feat(pr): reviewer surface', 'feat(pr): checklist engine', 'test: cover it']),
    );
    expect(title).toBe('feat(pr): reviewer surface');
  });

  it('adds a breaking bang when any commit is breaking', () => {
    const title = suggestTitle(parseCommits(['feat(api)!: drop v1', 'test: cover']));
    expect(title.startsWith('feat(api)!:')).toBe(true);
  });

  it('returns empty for no commits', () => {
    expect(suggestTitle([])).toBe('');
  });
});
