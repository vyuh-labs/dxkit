import { describe, expect, it } from 'vitest';
import { staleAllowToBaselineEntries } from '../../../src/baseline/producers/stale-allow';
import type { InlineAllowlistOccurrence } from '../../../src/allowlist/gather';
import type { CodeFinding, SecurityAggregate } from '../../../src/analyzers/security/aggregator';

function makeOccurrence(
  partial: Partial<InlineAllowlistOccurrence> & { file: string; line: number },
): InlineAllowlistOccurrence {
  return {
    category: 'test-fixture',
    position: 'same-line',
    ...partial,
  };
}

function makeFinding(file: string, line: number, severity: 'high' = 'high'): CodeFinding {
  return {
    severity,
    category: 'secret',
    cwe: '',
    rule: 'gitleaks/private-key',
    title: '',
    file,
    line,
    tool: 'gitleaks',
    fingerprint: 'fp',
    canonicalRule: 'gitleaks/private-key',
    producedBy: ['gitleaks'],
  };
}

function makeAggregate(
  opts: {
    secrets?: CodeFinding[];
    code?: CodeFinding[];
    config?: CodeFinding[];
  } = {},
): SecurityAggregate {
  return {
    codeBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    depBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    secretsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableCodeBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableSecretsBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    scoreableDepBySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    findingsByCategory: {
      secret: opts.secrets ?? [],
      code: opts.code ?? [],
      config: opts.config ?? [],
      dependency: [],
    },
    dependencyAdvisoryUniqueCount: 0,
    dependencyFindingsRawCount: 0,
    dedupCollisions: [],
    provenance: {
      secrets: { tool: null },
      codePatterns: { tool: null },
      depVulns: { tool: null },
    } as unknown as SecurityAggregate['provenance'],
  };
}

describe('staleAllowToBaselineEntries', () => {
  it('returns empty array when annotations list is empty', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [],
      aggregate: makeAggregate(),
    });
    expect(out).toEqual([]);
  });

  it('returns empty array when aggregate is null (cannot determine staleness)', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 1 })],
      aggregate: null,
    });
    expect(out).toEqual([]);
  });

  it('emits stale-allow entry for orphaned annotation', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate(),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'stale-allow',
      file: 'src/a.ts',
      line: 42,
      category: 'test-fixture',
    });
    expect(out[0].id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('does NOT emit when annotation has matching secret finding at same line', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate({ secrets: [makeFinding('src/a.ts', 42)] }),
    });
    expect(out).toEqual([]);
  });

  it('does NOT emit when annotation has matching code finding at same line', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate({ code: [makeFinding('src/a.ts', 42)] }),
    });
    expect(out).toEqual([]);
  });

  it('does NOT emit when annotation has matching config finding at same line', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'config.ts', line: 5 })],
      aggregate: makeAggregate({ config: [makeFinding('config.ts', 5)] }),
    });
    expect(out).toEqual([]);
  });

  it('matches within the 3-line window (annotation at 42, finding at 44 → active)', () => {
    // lineWindowFor(42) and lineWindowFor(44) both → 42
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate({ secrets: [makeFinding('src/a.ts', 44)] }),
    });
    expect(out).toEqual([]);
  });

  it('flags as stale when annotation is in a different file from finding', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate({ secrets: [makeFinding('src/different.ts', 42)] }),
    });
    expect(out).toHaveLength(1);
  });

  it('flags as stale when annotation is outside the line window', () => {
    // lineWindowFor(41) → 39; lineWindowFor(42) → 42 — different windows
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 41 })],
      aggregate: makeAggregate({ secrets: [makeFinding('src/a.ts', 42)] }),
    });
    expect(out).toHaveLength(1);
  });

  it('partitions a mixed input correctly', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [
        makeOccurrence({ file: 'src/a.ts', line: 10 }), // active
        makeOccurrence({ file: 'src/b.ts', line: 20 }), // stale
        makeOccurrence({ file: 'src/c.ts', line: 30 }), // active (matches code)
      ],
      aggregate: makeAggregate({
        secrets: [makeFinding('src/a.ts', 10)],
        code: [makeFinding('src/c.ts', 30)],
      }),
    });
    expect(out).toHaveLength(1);
    expect(out[0].kind === 'stale-allow' && out[0].file).toBe('src/b.ts');
  });

  it('preserves the annotation category in the emitted entry', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 10, category: 'false-positive' })],
      aggregate: makeAggregate(),
    });
    expect(out[0].kind === 'stale-allow' && out[0].category).toBe('false-positive');
  });

  it('produces stable identities for the same input (determinism)', () => {
    const a = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate(),
    });
    const b = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 42 })],
      aggregate: makeAggregate(),
    });
    expect(a[0].id).toBe(b[0].id);
  });

  it('an ABOVE-line annotation is NOT stale when the finding sits on the line it covers', () => {
    // Annotation comment on line 2, finding on line 3 (the line the annotation
    // covers). Historically this checked the annotation's OWN line and, when 2
    // and 3 fell in different line-windows, wrongly reported the annotation
    // orphaned — spawning a net-new stale-allow block from a working inline
    // suppression. It must use the covered line (Rule 2: same rule as the synth).
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 2, position: 'above' })],
      aggregate: makeAggregate({ secrets: [makeFinding('src/a.ts', 3)] }),
    });
    expect(out).toHaveLength(0);
  });

  it('an ABOVE-line annotation IS stale when the covered line has no finding', () => {
    const out = staleAllowToBaselineEntries({
      annotations: [makeOccurrence({ file: 'src/a.ts', line: 2, position: 'above' })],
      aggregate: makeAggregate({ secrets: [makeFinding('src/a.ts', 20)] }),
    });
    expect(out).toHaveLength(1);
  });
});
