import { describe, it, expect } from 'vitest';
import {
  assessLanguageToolchains,
  primaryLanguageUnmeasured,
} from '../../src/languages/toolchain-coverage';
import type { LanguageSupport } from '../../src/languages/types';

/**
 * The pack-driven "is the primary language toolchain present" signal — the ONE
 * source doctor's per-language check and the init finish-arc honesty both read,
 * so a partial baseline can't be presented as full coverage on one surface
 * while the other tells the truth (the unprovisioned-toolchain class).
 */

function pack(id: string, displayName: string, cliBinaries?: string[]): LanguageSupport {
  return { id, displayName, cliBinaries } as unknown as LanguageSupport;
}

describe('assessLanguageToolchains', () => {
  it('reports a gap when an active pack cliBinary is absent from PATH', () => {
    // A binary that cannot exist on PATH → guaranteed gap.
    const gaps = assessLanguageToolchains([pack('csharp', 'C#', ['dxkit-nonexistent-binary-xyz'])]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      language: 'csharp',
      displayName: 'C#',
      missingBinaries: ['dxkit-nonexistent-binary-xyz'],
    });
    expect(primaryLanguageUnmeasured(gaps)).toBe(true);
  });

  it('reports no gap for a pack whose toolchain resolves (node is always present in CI)', () => {
    const gaps = assessLanguageToolchains([pack('typescript', 'TypeScript', ['node'])]);
    expect(gaps).toHaveLength(0);
    expect(primaryLanguageUnmeasured(gaps)).toBe(false);
  });

  it('ignores packs that declare no cliBinaries', () => {
    expect(assessLanguageToolchains([pack('x', 'X', undefined)])).toHaveLength(0);
    expect(assessLanguageToolchains([pack('x', 'X', [])])).toHaveLength(0);
  });

  it('only reports the binaries that are actually missing', () => {
    const gaps = assessLanguageToolchains([
      pack('mixed', 'Mixed', ['node', 'dxkit-nonexistent-binary-xyz']),
    ]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].missingBinaries).toEqual(['dxkit-nonexistent-binary-xyz']);
  });
});
