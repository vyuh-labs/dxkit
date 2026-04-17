import { describe, it, expect } from 'vitest';
import { parseCvssV4BaseScore } from '../src/analyzers/tools/cvss-v4';

describe('parseCvssV4BaseScore — canonical vectors', () => {
  it('computes 10.0 for maximum-impact scope-unchanged (MV 000000)', () => {
    const score = parseCvssV4BaseScore(
      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H',
    );
    expect(score).toBe(10);
  });

  it('computes 0 when all impact metrics are None', () => {
    // Explicit shortcut: no CIA impact on either system → 0.0
    const score = parseCvssV4BaseScore(
      'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N',
    );
    expect(score).toBe(0);
  });

  it('integrity-only network attack is high', () => {
    const score = parseCvssV4BaseScore(
      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:H/VA:N/SC:N/SI:N/SA:N',
    );
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(7.0);
    expect(score!).toBeLessThan(9.0);
  });

  it('physical-access low-impact vector tiers to low', () => {
    const score = parseCvssV4BaseScore(
      'CVSS:4.0/AV:P/AC:H/AT:P/PR:H/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N',
    );
    expect(score).not.toBeNull();
    expect(score!).toBeLessThan(4.0);
  });
});

describe('parseCvssV4BaseScore — real-world CVEs', () => {
  it('CVE-2025-8869 (pip tar symlink extraction) — medium 5.9', () => {
    // Observed live at OSV: https://api.osv.dev/v1/vulns/CVE-2025-8869
    const vector =
      'CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:A/VC:N/VI:H/VA:N/SC:N/SI:N/SA:N/E:X/CR:X/IR:X/AR:X/MAV:X/MAC:X/MAT:X/MPR:X/MUI:X/MVC:X/MVI:X/MVA:X/MSC:X/MSI:X/MSA:X/S:X/AU:X/R:X/V:X/RE:X/U:X';
    const score = parseCvssV4BaseScore(vector);
    expect(score).not.toBeNull();
    // NVD reports 5.9 for this CVE; upstream calculator confirms.
    expect(score).toBe(5.9);
  });

  it('handles X-valued (not-defined) environmental metrics correctly', () => {
    // E:X should default to A, CR/IR/AR:X default to H.
    const withX = parseCvssV4BaseScore(
      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:X/CR:X/IR:X/AR:X',
    );
    const withDefaults = parseCvssV4BaseScore(
      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:A/CR:H/IR:H/AR:H',
    );
    expect(withX).toBe(withDefaults);
  });
});

describe('parseCvssV4BaseScore — rejects malformed input', () => {
  it('returns null for non-CVSS:4.x prefix', () => {
    expect(parseCvssV4BaseScore('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBeNull();
    expect(parseCvssV4BaseScore('')).toBeNull();
    expect(parseCvssV4BaseScore('not a vector')).toBeNull();
  });

  it('returns null when any required base metric is missing', () => {
    // Missing SA
    expect(
      parseCvssV4BaseScore('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N'),
    ).toBeNull();
    // Missing AT
    expect(
      parseCvssV4BaseScore('CVSS:4.0/AV:N/AC:L/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N'),
    ).toBeNull();
  });
});

describe('parseCvssV4BaseScore — score refinement', () => {
  it('applies severity-distance refinement to reduce base score for less-severe vectors', () => {
    // Maximum severity MV 000000 → base score 10.0 verbatim.
    const max = parseCvssV4BaseScore(
      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H',
    );
    // Same MV (000000) but slightly weaker AC → refinement should bring it below 10.
    const refined = parseCvssV4BaseScore(
      'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H/E:P',
    );
    expect(max).toBe(10);
    // E:P shifts to MV 000010 → 9.8 per lookup, with further refinement for distance
    expect(refined!).toBeLessThan(10);
  });

  it('returns values within [0, 10] and rounded to 1 decimal', () => {
    const score = parseCvssV4BaseScore(
      'CVSS:4.0/AV:L/AC:H/AT:P/PR:H/UI:A/VC:L/VI:L/VA:L/SC:L/SI:L/SA:L/E:U',
    );
    expect(score).not.toBeNull();
    expect(score!).toBeGreaterThanOrEqual(0);
    expect(score!).toBeLessThanOrEqual(10);
    expect(score! * 10).toBeCloseTo(Math.round(score! * 10), 5);
  });
});
