import { describe, it, expect } from 'vitest';
import { licensesToBaselineEntries } from '../../../src/baseline/producers/licenses';
import { identityFor } from '../../../src/baseline/finding-identity';
import type { LicenseFinding, LicensesResult } from '../../../src/languages/capabilities/types';

function lic(over: Partial<LicenseFinding> = {}): LicenseFinding {
  return {
    package: 'lodash',
    version: '4.17.20',
    licenseType: 'MIT',
    ...over,
  };
}

function envelope(over: Partial<LicensesResult> = {}): LicensesResult {
  return {
    schemaVersion: 1,
    tool: 'license-checker',
    findings: [],
    ...over,
  };
}

describe('licensesToBaselineEntries', () => {
  it('emits nothing for an absent envelope', () => {
    expect(licensesToBaselineEntries(undefined)).toEqual([]);
  });

  it('emits nothing for an empty findings list', () => {
    expect(licensesToBaselineEntries(envelope())).toEqual([]);
  });

  it('emits one entry per package + version + license triple', () => {
    const entries = licensesToBaselineEntries(
      envelope({
        findings: [lic(), lic({ package: 'react', version: '18.0.0', licenseType: 'Apache-2.0' })],
      }),
    );
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === 'license')).toBe(true);
  });

  it('uses canonical identityFor for the id', () => {
    const f = lic();
    const [e] = licensesToBaselineEntries(envelope({ findings: [f] }));
    if (e.kind !== 'license') throw new Error('shape');
    expect(e.id).toBe(
      identityFor({
        kind: 'license',
        package: f.package,
        version: f.version,
        licenseType: f.licenseType,
      }),
    );
  });

  it('normalizes an empty licenseType to the literal UNKNOWN so identity stays stable', () => {
    const [e] = licensesToBaselineEntries(envelope({ findings: [lic({ licenseType: '' })] }));
    if (e.kind !== 'license') throw new Error('shape');
    expect(e.licenseType).toBe('UNKNOWN');
  });

  it('preserves an explicit UNKNOWN license type', () => {
    const [e] = licensesToBaselineEntries(
      envelope({ findings: [lic({ licenseType: 'UNKNOWN' })] }),
    );
    if (e.kind !== 'license') throw new Error('shape');
    expect(e.licenseType).toBe('UNKNOWN');
  });

  it('produces a different identity when the license type changes on the same pin', () => {
    const [a] = licensesToBaselineEntries(envelope({ findings: [lic({ licenseType: 'MIT' })] }));
    const [b] = licensesToBaselineEntries(
      envelope({ findings: [lic({ licenseType: 'GPL-3.0' })] }),
    );
    expect(a.id).not.toBe(b.id);
  });
});
