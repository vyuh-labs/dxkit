import { describe, it, expect } from 'vitest';
import {
  inlineCoverage,
  synthesizeInlineEntries,
  augmentAllowlistWithInline,
  type InlineSynthFinding,
} from '../../src/allowlist/inline-synth';
import type { InlineAllowlistOccurrence } from '../../src/allowlist/gather';
import { emptyAllowlistFile } from '../../src/allowlist/file';

const NOW = new Date('2026-01-01T00:00:00.000Z');

const occ = (
  file: string,
  line: number,
  category: string,
  position: 'above' | 'same-line',
): InlineAllowlistOccurrence => ({ file, line, category, position });

const finding = (file: string, line: number, fingerprint?: string): InlineSynthFinding => ({
  file,
  line,
  fingerprint,
  kind: 'secret',
});

describe('inlineCoverage', () => {
  it('same-line annotation covers its own line; above covers the next line', () => {
    const cov = inlineCoverage([
      occ('src/a.ts', 5, 'test-fixture', 'same-line'),
      occ('src/a.ts', 9, 'false-positive', 'above'),
    ]);
    expect(cov.get('src/a.ts:5')).toBe('test-fixture');
    expect(cov.get('src/a.ts:10')).toBe('false-positive'); // above@9 covers 10
    expect(cov.get('src/a.ts:9')).toBeUndefined();
  });

  it('drops categories that are not inline-compatible (accepted-risk is file-only)', () => {
    const cov = inlineCoverage([occ('src/a.ts', 3, 'accepted-risk', 'same-line')]);
    expect(cov.size).toBe(0);
  });

  it('normalizes a leading ./ so occurrence and finding paths align', () => {
    const cov = inlineCoverage([occ('./src/a.ts', 4, 'test-fixture', 'same-line')]);
    expect(cov.get('src/a.ts:4')).toBe('test-fixture');
  });
});

describe('synthesizeInlineEntries', () => {
  it('mints an entry for a finding an annotation covers, keyed on its fingerprint', () => {
    const entries = synthesizeInlineEntries(
      [occ('src/a.ts', 5, 'test-fixture', 'same-line')],
      [finding('src/a.ts', 5, 'fp-abc')],
      NOW,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      fingerprint: 'fp-abc',
      kind: 'secret',
      category: 'test-fixture',
      addedAt: NOW.toISOString(),
    });
  });

  it('does NOT mint for a finding with no annotation at its line', () => {
    const entries = synthesizeInlineEntries(
      [occ('src/a.ts', 5, 'test-fixture', 'same-line')],
      [finding('src/a.ts', 6, 'fp-xyz')],
      NOW,
    );
    expect(entries).toHaveLength(0);
  });

  it('an above-line annotation suppresses the finding beneath it', () => {
    const entries = synthesizeInlineEntries(
      [occ('src/a.ts', 9, 'test-fixture', 'above')],
      [finding('src/a.ts', 10, 'fp-below')],
      NOW,
    );
    expect(entries.map((e) => e.fingerprint)).toEqual(['fp-below']);
  });

  it('skips findings without a fingerprint and dedupes repeats', () => {
    const entries = synthesizeInlineEntries(
      [occ('src/a.ts', 5, 'test-fixture', 'same-line')],
      [
        finding('src/a.ts', 5, undefined),
        finding('src/a.ts', 5, 'dup'),
        finding('src/a.ts', 5, 'dup'),
      ],
      NOW,
    );
    expect(entries.map((e) => e.fingerprint)).toEqual(['dup']);
  });
});

describe('augmentAllowlistWithInline', () => {
  it('returns base unchanged when there are no inline entries', () => {
    const base = emptyAllowlistFile();
    expect(augmentAllowlistWithInline(base, [])).toBe(base);
    expect(augmentAllowlistWithInline(null, [])).toBeNull();
  });

  it('constructs a valid allowlist when base is null but inline entries exist', () => {
    const synth = synthesizeInlineEntries(
      [occ('src/a.ts', 5, 'test-fixture', 'same-line')],
      [finding('src/a.ts', 5, 'fp-abc')],
      NOW,
    );
    const out = augmentAllowlistWithInline(null, synth);
    expect(out).not.toBeNull();
    expect(out!.entries.map((e) => e.fingerprint)).toEqual(['fp-abc']);
    expect(out!.schemaVersion).toBe(emptyAllowlistFile().schemaVersion);
  });

  it('a file-level entry wins over an inline entry with the same fingerprint', () => {
    const base = {
      ...emptyAllowlistFile(),
      entries: [
        {
          fingerprint: 'fp-abc',
          kind: 'secret' as const,
          category: 'accepted-risk' as const,
          addedAt: NOW.toISOString(),
        },
      ],
    };
    const synth = synthesizeInlineEntries(
      [occ('src/a.ts', 5, 'test-fixture', 'same-line')],
      [finding('src/a.ts', 5, 'fp-abc')],
      NOW,
    );
    const out = augmentAllowlistWithInline(base, synth);
    expect(out!.entries).toHaveLength(1);
    expect(out!.entries[0].category).toBe('accepted-risk'); // file-level authoritative
  });
});
