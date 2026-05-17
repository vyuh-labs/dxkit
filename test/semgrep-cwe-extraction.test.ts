/**
 * Tests for `extractCwe` — the helper that normalizes semgrep's
 * `metadata.cwe` field across both shapes the upstream tool emits.
 *
 * D094 (2.4.7 Phase C3) is the regression pinned here: on the
 * `bypass-tls-verification` rule (and others), semgrep emits
 * `metadata.cwe` as a SCALAR string (`"CWE-295: ..."`) rather than the
 * array shape the public `p/security-audit` README documents. Pre-fix
 * code did `metadata?.cwe?.[0]` which returned the first *character*
 * of the scalar — hence `**CWE:** C` on platform's report.
 */
import { describe, it, expect } from 'vitest';
import { extractCwe } from '../src/analyzers/tools/semgrep.js';

describe('extractCwe', () => {
  it('handles the array shape (documented format)', () => {
    expect(extractCwe(['CWE-295: Improper Certificate Validation'])).toBe('CWE-295');
  });

  it('handles the scalar string shape (D094 — bypass-tls-verification)', () => {
    expect(extractCwe('CWE-295: Improper Certificate Validation')).toBe('CWE-295');
  });

  it('handles a scalar without colon (bare identifier)', () => {
    expect(extractCwe('CWE-798')).toBe('CWE-798');
  });

  it('handles an array without colon (bare identifier in list)', () => {
    expect(extractCwe(['CWE-798'])).toBe('CWE-798');
  });

  it('returns empty string for undefined metadata', () => {
    expect(extractCwe(undefined)).toBe('');
  });

  it('returns empty string for empty array', () => {
    expect(extractCwe([])).toBe('');
  });

  it('returns empty string for empty scalar', () => {
    expect(extractCwe('')).toBe('');
  });

  it('trims whitespace around the CWE identifier', () => {
    expect(extractCwe('  CWE-89  : SQL Injection')).toBe('CWE-89');
  });

  it('handles a non-string first array element defensively', () => {
    // Rule-authoring mistakes happen — we shouldn't crash.
    expect(extractCwe([null as unknown as string])).toBe('');
  });
});
