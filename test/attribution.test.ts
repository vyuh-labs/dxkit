import { describe, it, expect } from 'vitest';
import {
  parseBlamePorcelain,
  formatAttributionCell,
  attributionProvenanceLine,
  type FindingAttribution,
} from '../src/attribution/attribute';

describe('parseBlamePorcelain', () => {
  it('extracts author + email + short commit', () => {
    const out = [
      'a1b2c3d4e5f6 12 12 1',
      'author Jane Doe',
      'author-mail <jane@corp.com>',
      'author-time 1700000000',
      '\tconst x = 1;',
    ].join('\n');
    const bl = parseBlamePorcelain(out);
    expect(bl).toEqual({ author: 'Jane Doe', email: 'jane@corp.com', commit: 'a1b2c3d4' });
  });

  it('returns null when there is no author', () => {
    expect(parseBlamePorcelain('')).toBeNull();
    expect(parseBlamePorcelain('justonewordnoauthor')).toBeNull();
  });
});

describe('formatAttributionCell', () => {
  const base: FindingAttribution = { author: 'Jane', commit: 'abc12345', active: true };

  it('renders an active author by handle', () => {
    expect(formatAttributionCell({ ...base, handle: 'jane' })).toBe('@jane (active)');
  });

  it('falls back to display name when no handle', () => {
    expect(formatAttributionCell(base)).toBe('Jane (active)');
  });

  it('routes an inactive author to the current owner', () => {
    expect(
      formatAttributionCell({
        author: 'Gone',
        commit: 'abc',
        active: false,
        currentOwner: { name: 'Carol', handle: 'carol' },
      }),
    ).toBe('Gone (inactive) → ask @carol');
  });

  it('marks an inactive author with no current owner', () => {
    expect(formatAttributionCell({ author: 'Gone', commit: 'abc', active: false })).toBe(
      'Gone (inactive)',
    );
  });

  it('renders a file-level owner attribution', () => {
    expect(
      formatAttributionCell({ author: 'Owner', handle: 'owner', active: true, fileLevel: true }),
    ).toBe('@owner (owner)');
  });

  it('renders a dash for an unresolved location', () => {
    expect(formatAttributionCell(undefined)).toBe('—');
  });

  it('never renders an email', () => {
    const cell = formatAttributionCell({ ...base, handle: 'jane' });
    expect(cell).not.toContain('@corp.com');
  });
});

describe('attributionProvenanceLine', () => {
  it('states the last-touch honesty caveat + no-emails posture', () => {
    const line = attributionProvenanceLine();
    expect(line).toMatch(/last touched/i);
    expect(line).toMatch(/handle/i);
    expect(line).toMatch(/never emails/i);
  });
});
