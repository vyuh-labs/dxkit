import { describe, expect, it } from 'vitest';
import {
  buildSnykPolicy,
  dxkitIgnoreLinesToSnykExcludes,
  expiryToSnykDatetime,
  SNYK_POLICY_VERSION,
  type SnykIgnore,
} from '../../src/ingest/snyk-policy';

describe('expiryToSnykDatetime', () => {
  it('converts a YYYY-MM-DD date to an ISO datetime', () => {
    expect(expiryToSnykDatetime('2026-12-31')).toBe('2026-12-31T00:00:00.000Z');
  });
  it('returns undefined for a missing date (permanent ignore)', () => {
    expect(expiryToSnykDatetime(undefined)).toBeUndefined();
  });
});

describe('dxkitIgnoreLinesToSnykExcludes', () => {
  it('drops comments, blanks, and negations', () => {
    expect(dxkitIgnoreLinesToSnykExcludes(['# a comment', '', '   ', '!keep/this'])).toEqual([]);
  });

  it('expands directory and bare-name patterns to subtree globs', () => {
    expect(dxkitIgnoreLinesToSnykExcludes(['vendor/', 'generated', 'fixtures/large/'])).toEqual([
      'vendor/**',
      'generated/**',
      'fixtures/large/**',
    ]);
  });

  it('passes through existing globs and strips a leading anchor slash', () => {
    expect(dxkitIgnoreLinesToSnykExcludes(['*.generated.ts', '/build/', 'src/**'])).toEqual([
      '*.generated.ts',
      'build/**',
      'src/**',
    ]);
  });

  it('de-duplicates while preserving order', () => {
    expect(dxkitIgnoreLinesToSnykExcludes(['vendor/', 'vendor', 'legacy'])).toEqual([
      'vendor/**',
      'legacy/**',
    ]);
  });
});

describe('buildSnykPolicy with excludes', () => {
  it('emits an exclude.global block from .dxkit-ignore patterns', () => {
    const out = buildSnykPolicy([], ['vendor/**', '*.generated.ts']);
    expect(out).toContain('exclude:');
    expect(out).toContain('  global:');
    expect(out).toContain("    - 'vendor/**'");
    expect(out).toContain("    - '*.generated.ts'");
  });

  it('omits the exclude block entirely when there are no excludes (stable prior shape)', () => {
    expect(buildSnykPolicy([])).not.toContain('exclude:');
  });

  it('combines ignores and excludes in one policy', () => {
    const out = buildSnykPolicy(
      [{ ruleId: 'r', path: 'src/a.ts', created: '2026-06-09T00:00:00.000Z' }],
      ['vendor/**'],
    );
    expect(out).toContain("'r':");
    expect(out).toContain('exclude:');
    expect(out).toContain("    - 'vendor/**'");
  });
});

describe('buildSnykPolicy', () => {
  it('emits an empty policy when there are no ignores', () => {
    const out = buildSnykPolicy([]);
    expect(out).toContain(`version: ${SNYK_POLICY_VERSION}`);
    expect(out).toContain('ignore: {}');
    expect(out).toContain('patch: {}');
  });

  it('groups by rule id and lists per-path directives', () => {
    const ignores: SnykIgnore[] = [
      {
        ruleId: 'javascript/InsecureTLSConfig',
        path: 'src/b.ts',
        reason: 'accepted risk',
        expires: '2026-12-31T00:00:00.000Z',
        created: '2026-06-09T00:00:00.000Z',
      },
      {
        ruleId: 'javascript/InsecureTLSConfig',
        path: 'src/a.ts',
        reason: 'also accepted',
        created: '2026-06-09T00:00:00.000Z',
      },
    ];
    const out = buildSnykPolicy(ignores);
    // Single rule key, both paths under it, paths sorted (a before b).
    expect(out).toContain("'javascript/InsecureTLSConfig':");
    const aIdx = out.indexOf("'src/a.ts':");
    const bIdx = out.indexOf("'src/b.ts':");
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
    // Reason is double-quoted; expiry present on one, absent on the other.
    expect(out).toContain('reason: "accepted risk"');
    expect(out).toContain('expires: 2026-12-31T00:00:00.000Z');
  });

  it('safely quotes reasons containing special characters', () => {
    const out = buildSnykPolicy([
      {
        ruleId: 'r',
        path: 'p.ts',
        reason: 'has "quotes" and: colons',
        created: '2026-06-09T00:00:00.000Z',
      },
    ]);
    expect(out).toContain('reason: "has \\"quotes\\" and: colons"');
  });
});
