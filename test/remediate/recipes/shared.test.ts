/**
 * The shared owning-root derivation: pack-declared basenames drive it, and
 * when a pack declares SEVERAL basenames that sit at one root, the
 * first-declared one wins deterministically (declaration order is the
 * provider contract's preference order); envelope order never decides.
 * The class this pins ahead of the multi-manifest pack fills: a python
 * provider declaring ['pyproject.toml', 'requirements.txt'] must report
 * the same file whichever order the planner listed the envelope in.
 */
import { describe, it, expect } from 'vitest';
import { owningManifestEntry, owningManifestRoot } from '../../../src/remediate/recipes/shared';
import { makeOrder } from './helpers';

function orderWithPaths(paths: string[]) {
  return makeOrder({
    id: 'dep-advisory:x',
    class: 'dep-advisory',
    envelope: { paths, manifests: true },
  });
}

describe('owningManifestEntry (pack-declared basenames, declaration-order preference)', () => {
  const FILES = ['pyproject.toml', 'requirements.txt'];

  it('two declared basenames at ONE root resolve to the first-declared, regardless of envelope order', () => {
    const forward = orderWithPaths(['pyproject.toml', 'requirements.txt']);
    const reversed = orderWithPaths(['requirements.txt', 'pyproject.toml']);
    expect(owningManifestEntry(forward, FILES)).toEqual({ dir: '', file: 'pyproject.toml' });
    expect(owningManifestEntry(reversed, FILES)).toEqual({ dir: '', file: 'pyproject.toml' });
    // Nested root, same rule.
    const nested = orderWithPaths(['app/requirements.txt', 'app/pyproject.toml']);
    expect(owningManifestEntry(nested, FILES)).toEqual({ dir: 'app', file: 'pyproject.toml' });
  });

  it('only the second-declared basename present still resolves (preference, not exclusion)', () => {
    const order = orderWithPaths(['requirements.txt', 'src/a.py']);
    expect(owningManifestEntry(order, FILES)).toEqual({ dir: '', file: 'requirements.txt' });
  });

  it('two distinct roots stay ambiguous (null), whatever basenames matched', () => {
    const order = orderWithPaths(['pyproject.toml', 'sub/requirements.txt']);
    expect(owningManifestEntry(order, FILES)).toBeNull();
    expect(owningManifestRoot(order, FILES)).toBeNull();
  });
});
