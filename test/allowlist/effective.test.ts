import { describe, it, expect } from 'vitest';
import { resolveEffectiveAllowlist } from '../../src/allowlist/effective';
import {
  entryToAllowlistable,
  partitionByActiveAllowlist,
} from '../../src/baseline/allowlist-match';
import type { AllowlistEntry, AllowlistFile } from '../../src/allowlist/file';
import type { InlineAllowlistOccurrence } from '../../src/allowlist/gather';
import type { BaselineEntry } from '../../src/baseline/types';
import type { IdentityKind } from '../../src/baseline/producers';

/**
 * Seam-level coverage for the ONE effective-allowlist construction
 * (`resolveEffectiveAllowlist`) and the ONE finding-set partition
 * (`partitionByActiveAllowlist`) — the platform pieces every finding-consumer
 * (guardrail check, security score, `baseline create`) now share so an
 * allowlisted finding can't be honored on one surface and ignored on another
 * (gh #155).
 */

const NOW = new Date('2026-06-08T12:00:00Z');

function fileWith(entries: AllowlistEntry[]): AllowlistFile {
  return { schemaVersion: 'dxkit-allowlist/v1', mode: 'full', entries };
}

function entry(
  over: Partial<AllowlistEntry> & { fingerprint: string; kind: IdentityKind },
): AllowlistEntry {
  return {
    category: 'false-positive',
    reason: 'x',
    addedBy: 'test',
    addedAt: '2020-01-01',
    ...over,
  } as AllowlistEntry;
}

function anchor(id: string, kind: IdentityKind): BaselineEntry {
  return { id, kind } as unknown as BaselineEntry;
}

describe('resolveEffectiveAllowlist', () => {
  it('returns the file-level base unchanged when there are no inline annotations', () => {
    const base = fileWith([entry({ fingerprint: 'aaaa', kind: 'secret' })]);
    const out = resolveEffectiveAllowlist({ base, inlineAnnotations: [], findings: [] });
    expect(out).toEqual(base);
  });

  it('returns null when there is neither a file-level allowlist nor inline suppression', () => {
    const out = resolveEffectiveAllowlist({ base: null, inlineAnnotations: [], findings: [] });
    expect(out).toBeNull();
  });

  it('synthesizes an inline entry that suppresses a covered finding (no file-level allowlist)', () => {
    const occ: InlineAllowlistOccurrence = {
      file: 'src/a.ts',
      line: 10,
      category: 'test-fixture',
      position: 'same-line',
    };
    const out = resolveEffectiveAllowlist({
      base: null,
      inlineAnnotations: [occ],
      findings: [{ fingerprint: 'ffff', kind: 'secret', file: 'src/a.ts', line: 10 }],
    });
    expect(out).not.toBeNull();
    expect(out!.entries.some((e) => e.fingerprint === 'ffff')).toBe(true);
  });

  it('requires cwd when base is omitted', () => {
    expect(() => resolveEffectiveAllowlist({ findings: [], inlineAnnotations: [] })).toThrow(
      /'base' was omitted, so 'cwd' is required/,
    );
  });

  it('requires cwd when inlineAnnotations is omitted', () => {
    expect(() => resolveEffectiveAllowlist({ findings: [], base: null })).toThrow(
      /'inlineAnnotations' was omitted, so 'cwd' is required/,
    );
  });
});

describe('partitionByActiveAllowlist', () => {
  it('treats every finding as live when there is no allowlist', () => {
    const findings = [anchor('a', 'secret'), anchor('b', 'code')];
    const out = partitionByActiveAllowlist(findings, null, NOW);
    expect(out.live).toHaveLength(2);
    expect(out.allowlisted).toHaveLength(0);
  });

  it('splits live vs actively-allowlisted and records the suppression', () => {
    const allowlist = fileWith([entry({ fingerprint: 'a', kind: 'secret' })]);
    const out = partitionByActiveAllowlist(
      [anchor('a', 'secret'), anchor('b', 'code')],
      allowlist,
      NOW,
    );
    expect(out.allowlisted.map((e) => e.id)).toEqual(['a']);
    expect(out.live.map((e) => e.id)).toEqual(['b']);
    expect(out.suppressions).toHaveLength(1);
    expect(out.suppressions[0].category).toBe('false-positive');
  });

  it('does NOT suppress via an expired entry (finding stays live)', () => {
    const allowlist = fileWith([
      entry({
        fingerprint: 'a',
        kind: 'secret',
        category: 'accepted-risk',
        expiresAt: '2020-06-01',
      }),
    ]);
    const out = partitionByActiveAllowlist([anchor('a', 'secret')], allowlist, NOW);
    expect(out.live.map((e) => e.id)).toEqual(['a']);
    expect(out.allowlisted).toHaveLength(0);
  });
});

describe('entryToAllowlistable', () => {
  it('projects a located baseline entry into the allowlistable shape', () => {
    const e = {
      id: 'deadbeef',
      kind: 'secret',
      file: 'src/x.ts',
      line: 42,
      tool: 'gitleaks',
      rule: 'generic',
    } as unknown as BaselineEntry;
    expect(entryToAllowlistable(e)).toEqual({
      fingerprint: 'deadbeef',
      kind: 'secret',
      file: 'src/x.ts',
      line: 42,
    });
  });
});
