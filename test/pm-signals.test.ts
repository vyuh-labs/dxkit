import { describe, it, expect } from 'vitest';
import { effortEstimate, licenseClass, stalenessTier } from '../src/analyzers/bom/pm-signals';
import type { BomEntry } from '../src/analyzers/bom/types';
import type { DepVulnFinding } from '../src/languages/capabilities/types';

describe('licenseClass', () => {
  it('classifies common permissive licenses', () => {
    expect(licenseClass('MIT')).toBe('permissive');
    expect(licenseClass('Apache-2.0')).toBe('permissive');
    expect(licenseClass('BSD-3-Clause')).toBe('permissive');
    expect(licenseClass('ISC')).toBe('permissive');
    expect(licenseClass('0BSD')).toBe('permissive');
    expect(licenseClass('MIT-0')).toBe('permissive');
    expect(licenseClass('Artistic-2.0')).toBe('permissive');
  });

  it('classifies strong copyleft', () => {
    expect(licenseClass('GPL-3.0')).toBe('copyleft-strong');
    expect(licenseClass('AGPL-3.0')).toBe('copyleft-strong');
  });

  it('classifies weak copyleft', () => {
    expect(licenseClass('LGPL-2.1')).toBe('copyleft-weak');
    expect(licenseClass('MPL-2.0')).toBe('copyleft-weak');
  });

  it('flags proprietary', () => {
    expect(licenseClass('UNLICENSED')).toBe('proprietary');
    expect(licenseClass('SEE LICENSE IN LICENSE.txt')).toBe('proprietary');
  });

  it('returns unknown for UNKNOWN / empty / null', () => {
    expect(licenseClass('UNKNOWN')).toBe('unknown');
    expect(licenseClass('')).toBe('unknown');
    expect(licenseClass(undefined)).toBe('unknown');
    expect(licenseClass('CC-BY-4.0')).toBe('unknown'); // not a software license — PM reviews
  });

  it('handles "MIT license" and "Apache 2.0 license" suffixes', () => {
    expect(licenseClass('MIT license')).toBe('permissive');
    expect(licenseClass('Apache 2.0 license')).toBe('permissive');
  });

  it('normalises parenthesised compound expressions', () => {
    expect(licenseClass('(Apache-2.0 OR UPL-1.0)')).toBe('permissive');
    expect(licenseClass('[MIT]')).toBe('permissive');
  });

  it('takes the strictest class in compound expressions', () => {
    // MIT OR GPL-3.0 is effectively GPL-encumbered if the project picks GPL;
    // classifier conservatively returns the stricter class.
    expect(licenseClass('MIT OR GPL-3.0')).toBe('copyleft-strong');
    expect(licenseClass('MIT OR LGPL-2.1')).toBe('copyleft-weak');
  });
});

describe('stalenessTier', () => {
  const now = new Date('2026-04-24T00:00:00Z');

  it('returns fresh for releases within a year', () => {
    expect(stalenessTier('2025-10-01T00:00:00Z', now)).toBe('fresh');
    expect(stalenessTier('2026-04-23T00:00:00Z', now)).toBe('fresh');
  });

  it('returns aging for 1–3 year-old releases', () => {
    expect(stalenessTier('2024-06-01T00:00:00Z', now)).toBe('aging');
    expect(stalenessTier('2023-05-01T00:00:00Z', now)).toBe('aging');
  });

  it('returns stale for ≥3 year-old releases', () => {
    expect(stalenessTier('2022-01-01T00:00:00Z', now)).toBe('stale');
    expect(stalenessTier('2019-01-01T00:00:00Z', now)).toBe('stale');
  });

  it('returns unknown for missing / unparseable dates', () => {
    expect(stalenessTier(undefined, now)).toBe('unknown');
    expect(stalenessTier('not-a-date', now)).toBe('unknown');
  });
});

describe('effortEstimate', () => {
  function entry(version: string, vulns: DepVulnFinding[]): BomEntry {
    return {
      package: 'p',
      version,
      licenseType: 'MIT',
      vulns,
      maxSeverity: 'high',
      upgradeAdvice: '',
      joinedFromBoth: true,
    };
  }
  function vuln(fixed?: string): DepVulnFinding {
    return { id: 'CVE-X', package: 'p', tool: 't', severity: 'high', fixedVersion: fixed };
  }

  it('returns blocked when any vuln has no fix', () => {
    expect(effortEstimate(entry('1.2.3', [vuln('1.2.4'), vuln()]))).toBe('blocked');
  });

  it('returns trivial for patch-only bumps', () => {
    expect(effortEstimate(entry('1.2.3', [vuln('1.2.4'), vuln('1.2.9')]))).toBe('trivial');
  });

  it('returns moderate for minor bumps', () => {
    expect(effortEstimate(entry('1.2.3', [vuln('1.3.0')]))).toBe('moderate');
  });

  it('returns major for major bumps', () => {
    expect(effortEstimate(entry('1.2.3', [vuln('2.0.0')]))).toBe('major');
  });

  it('escalates to worst effort across multiple vulns', () => {
    // patch + minor → moderate; patch + major → major
    expect(effortEstimate(entry('1.2.3', [vuln('1.2.4'), vuln('1.3.0')]))).toBe('moderate');
    expect(effortEstimate(entry('1.2.3', [vuln('1.2.4'), vuln('2.0.0')]))).toBe('major');
  });

  it('handles Go-style v-prefixed versions', () => {
    expect(effortEstimate(entry('v1.2.3', [vuln('v1.3.0')]))).toBe('moderate');
  });
});
