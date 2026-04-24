import { describe, it, expect } from 'vitest';
import { isMajorBump } from '../src/analyzers/tools/semver-bump';

describe('isMajorBump', () => {
  it('flags major-version upgrade as breaking', () => {
    expect(isMajorBump('1.2.3', '2.0.0')).toBe(true);
  });

  it('flags pre-1.x minor bump as breaking (0.x convention)', () => {
    // 0.x lines are considered unstable; any minor bump is potentially breaking.
    expect(isMajorBump('0.5.0', '0.6.0')).toBe(true);
  });

  it('does not flag same-major patch bump as breaking', () => {
    expect(isMajorBump('1.2.3', '1.2.4')).toBe(false);
    expect(isMajorBump('2.0.0', '2.5.1')).toBe(false);
  });

  it('does not flag pre-1.x patch-level bump as breaking', () => {
    expect(isMajorBump('0.5.0', '0.5.1')).toBe(false);
  });

  it('flags pre-1.x → 1.0 as breaking (crosses stability boundary)', () => {
    expect(isMajorBump('0.9.5', '1.0.0')).toBe(true);
  });

  it('returns false when either input is unparseable', () => {
    expect(isMajorBump('', '1.0.0')).toBe(false);
    expect(isMajorBump('1.0.0', 'not-semver')).toBe(false);
    expect(isMajorBump('x.y.z', '1.0.0')).toBe(false);
  });

  it('handles version strings with fewer than three segments', () => {
    // The TS/Python/Rust packs sometimes hand in two-segment versions
    // (e.g. `0.5`) pulled from pyproject/Cargo.toml.
    expect(isMajorBump('1', '2')).toBe(true);
    expect(isMajorBump('0.5', '0.6')).toBe(true);
    expect(isMajorBump('1.2', '1.3')).toBe(false);
  });
});
