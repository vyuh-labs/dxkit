/**
 * The prohibited-license producer (pure half) + the ONE SPDX matcher +
 * the `newProhibitedLicense` block rule. Pins:
 *   - only prohibited MATCHES become entries (the inventory never does);
 *   - the matcher's compound-expression + prefix semantics;
 *   - UNKNOWN never matches unless explicitly listed (false-negative bias);
 *   - version-free dedupe (two versions of one package = one entry);
 *   - the block rule fires on an added `license` finding and only there.
 */

import { describe, it, expect } from 'vitest';
import { prohibitedLicensesToBaselineEntries } from '../../../src/baseline/producers/licenses';
import { licenseMatchesAny } from '../../../src/analyzers/licenses/detailed';
import { prohibitedLicensePatterns } from '../../../src/baseline/policy';
import { classify } from '../../../src/baseline/classify';
import { DEFAULT_BROWNFIELD_POLICY } from '../../../src/baseline/policy';
import type { LicenseFinding } from '../../../src/languages/capabilities/types';
import type { MatchPair } from '../../../src/baseline/types';

function lic(pkg: string, licenseType: string, version = '1.0.0'): LicenseFinding {
  return { package: pkg, version, licenseType };
}

describe('licenseMatchesAny — the ONE SPDX matcher', () => {
  it('prefix-matches families and exact ids', () => {
    expect(licenseMatchesAny('GPL-3.0', ['GPL-'])).toBe(true);
    expect(licenseMatchesAny('AGPL-3.0-only', ['AGPL-3.0'])).toBe(true);
    expect(licenseMatchesAny('MIT', ['GPL-'])).toBe(false);
  });

  it('splits compound expressions so a dual-licensed package matches', () => {
    expect(licenseMatchesAny('GPL-3.0 OR MIT', ['GPL-'])).toBe(true);
    expect(licenseMatchesAny('MIT AND Apache-2.0', ['Apache-'])).toBe(true);
  });
});

describe('prohibitedLicensePatterns — the ONE list normalizer', () => {
  it('drops non-strings and blanks, dedupes, sorts (recall byte-stability)', () => {
    expect(
      prohibitedLicensePatterns({
        licenses: { prohibited: ['GPL-', ' AGPL-3.0 ', '', 'GPL-', 42 as unknown as string] },
      }),
    ).toEqual(['AGPL-3.0', 'GPL-']);
  });

  it('absent/malformed reads as empty — the rule is inert by default', () => {
    expect(prohibitedLicensePatterns({})).toEqual([]);
    expect(
      prohibitedLicensePatterns({ licenses: { prohibited: 'GPL-' as unknown as string[] } }),
    ).toEqual([]);
  });
});

describe('prohibitedLicensesToBaselineEntries', () => {
  const inventory = [
    lic('copyleft-lib', 'GPL-3.0'),
    lic('fine-lib', 'MIT'),
    lic('unresolved-lib', 'UNKNOWN'),
    lic('dual-lib', 'AGPL-3.0 OR MIT'),
  ];

  it('mints entries only for matches, with version as display metadata', () => {
    const entries = prohibitedLicensesToBaselineEntries(inventory, ['GPL-', 'AGPL-']);
    expect(entries.map((e) => (e.kind === 'license' ? e.package : ''))).toEqual([
      'copyleft-lib',
      'dual-lib',
    ]);
    const first = entries[0];
    expect(first.kind).toBe('license');
    if (first.kind === 'license') {
      expect(first.licenseType).toBe('GPL-3.0');
      expect(first.version).toBe('1.0.0');
      expect(first.id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('UNKNOWN never matches a family prefix — an unresolvable license is a disclosure problem, not a violation', () => {
    expect(prohibitedLicensesToBaselineEntries(inventory, ['GPL-']).some((e) => e.kind === 'license' && e.package === 'unresolved-lib')).toBe(false);
    // ...unless the repo explicitly lists it.
    const explicit = prohibitedLicensesToBaselineEntries(inventory, ['UNKNOWN']);
    expect(explicit).toHaveLength(1);
  });

  it('an empty prohibited list (the default) emits nothing', () => {
    expect(prohibitedLicensesToBaselineEntries(inventory, [])).toHaveLength(0);
  });

  it('dedupes on version-free identity — two versions of one package, one entry', () => {
    const entries = prohibitedLicensesToBaselineEntries(
      [lic('copyleft-lib', 'GPL-3.0', '1.0.0'), lic('copyleft-lib', 'GPL-3.0', '2.0.0')],
      ['GPL-'],
    );
    expect(entries).toHaveLength(1);
  });
});

describe('newProhibitedLicense block rule', () => {
  const addedPair: MatchPair = {
    currentId: 'ffffffffffffffff',
    status: 'added',
    confidence: 1,
    reasons: [{ code: 'exact-id', detail: 'test' }],
  };

  it('an added license finding blocks under the default policy', () => {
    const result = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, {
      kind: 'license',
      severity: 'high',
    });
    expect(result.blocks).toBe(true);
    expect(JSON.stringify(result.reasons)).toContain('newProhibitedLicense');
  });

  it('disarming the rule demotes to the generic added handling', () => {
    const policy = {
      ...DEFAULT_BROWNFIELD_POLICY,
      block: [],
      warn: ['added' as const],
      blockRules: { ...DEFAULT_BROWNFIELD_POLICY.blockRules, newProhibitedLicense: false },
    };
    const result = classify(addedPair, policy, { kind: 'license', severity: 'high' });
    expect(result.blocks).toBe(false);
    expect(result.warns).toBe(true);
  });

  it('recall drift outranks the rule — a widened prohibited list never blames the next PR', () => {
    const result = classify(addedPair, DEFAULT_BROWNFIELD_POLICY, {
      kind: 'license',
      recallDrifted: true,
    });
    expect(result.status).toBe('tooling_drift');
    expect(result.blocks).toBe(false);
  });
});
