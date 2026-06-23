import { describe, it, expect } from 'vitest';
import { partitionForRefBasedDiff } from '../../src/baseline/check';
import type { BaselineEntry } from '../../src/baseline/types';

/**
 * Unit tests for the ref-based-mode kind exclusion (D-G4).
 *
 * ref-based mode gathers the prior side from a detached git worktree that
 * can't produce the build-artifact-dependent kinds — `duplication` (jscpd
 * needs node_modules) and `test-gap` (needs the coverage report). Without
 * excluding them, the current side's full set has nothing to match against
 * and every one reads as a net-new regression. The exclusion keeps the
 * diff symmetric; committed modes are untouched.
 */

type F = { readonly kind: BaselineEntry['kind']; readonly tag: string };
const f = (kind: BaselineEntry['kind'], tag: string): F => ({ kind, tag });

describe('partitionForRefBasedDiff', () => {
  it('committed mode (isRefBased=false): passes both sides through untouched, nothing excluded', () => {
    const prior = [f('secret', 'p1'), f('duplication', 'p2'), f('test-gap', 'p3')];
    const current = [f('secret', 'c1'), f('duplication', 'c2')];
    const out = partitionForRefBasedDiff(prior, current, false);
    expect(out.diffablePrior).toEqual(prior);
    expect(out.diffableCurrent).toEqual(current);
    expect(out.refExcludedKinds).toEqual([]);
  });

  it('ref-based mode: drops duplication + test-gap from BOTH sides, keeps everything else', () => {
    const prior = [f('secret', 'p1'), f('duplication', 'p2'), f('test-gap', 'p3'), f('code', 'p4')];
    const current = [f('secret', 'c1'), f('duplication', 'c2'), f('test-gap', 'c3')];
    const out = partitionForRefBasedDiff(prior, current, true);
    expect(out.diffablePrior.map((x) => x.tag)).toEqual(['p1', 'p4']);
    expect(out.diffableCurrent.map((x) => x.tag)).toEqual(['c1']);
  });

  it('ref-based mode: drops secret-hmac too (salt non-comparable across worktree), keeps located secret', () => {
    // secret-hmac is the locator-less companion to each `secret`. On a fresh/
    // shallow ref worktree the two sides can derive different salts, so the
    // HMAC companions never match and read as net-new — a FALSE block. The
    // located `secret` still gates the credential; the companion is dropped.
    const prior = [f('secret', 'p1'), f('secret-hmac', 'p2')];
    const current = [f('secret', 'c1'), f('secret-hmac', 'c2')];
    const out = partitionForRefBasedDiff(prior, current, true);
    expect(out.diffablePrior.map((x) => x.tag)).toEqual(['p1']);
    expect(out.diffableCurrent.map((x) => x.tag)).toEqual(['c1']);
  });

  it('committed mode: secret-hmac is NOT dropped (salt is consistent there)', () => {
    const prior = [f('secret', 'p1'), f('secret-hmac', 'p2')];
    const current = [f('secret', 'c1'), f('secret-hmac', 'c2')];
    const out = partitionForRefBasedDiff(prior, current, false);
    expect(out.diffablePrior.map((x) => x.tag)).toEqual(['p1', 'p2']);
    expect(out.diffableCurrent.map((x) => x.tag)).toEqual(['c1', 'c2']);
  });

  it('ref-based mode: a worktree-unreliable kind on BOTH sides never reaches the diff (the bug it fixes)', () => {
    // The original bug: 15 duplication on current, 0 on prior (worktree
    // produced none) → all 15 flagged net-new. After exclusion neither side
    // carries them, so the matcher can never mint a phantom add/resolve.
    const prior: F[] = []; // worktree gathered no duplication
    const current = [f('duplication', 'c1'), f('duplication', 'c2'), f('test-gap', 'c3')];
    const out = partitionForRefBasedDiff(prior, current, true);
    expect(out.diffableCurrent).toEqual([]);
    expect(out.diffablePrior).toEqual([]);
  });

  it('ref-based mode: discloses the dropped current-side counts per kind', () => {
    const current = [
      f('duplication', 'c1'),
      f('duplication', 'c2'),
      f('test-gap', 'c3'),
      f('secret', 'c4'),
    ];
    const out = partitionForRefBasedDiff([], current, true);
    expect(out.refExcludedKinds).toEqual([
      { kind: 'duplication', currentCount: 2 },
      { kind: 'test-gap', currentCount: 1 },
    ]);
  });

  it('ref-based mode: omits a kind from the disclosure when the current side has none of it', () => {
    const current = [f('test-gap', 'c1')]; // no duplication
    const out = partitionForRefBasedDiff([], current, true);
    expect(out.refExcludedKinds).toEqual([{ kind: 'test-gap', currentCount: 1 }]);
  });
});
