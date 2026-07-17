/**
 * `scanToBaselineFile` — the ONE `CurrentScan -> BaselineFile` conversion
 * (CLAUDE.md Rule 2 / 2.30).
 *
 * The class this pins: the conversion existed as two hand-built object literals
 * (the committed write in `createBaseline`, the ref-based prior side in
 * `loadPriorSide`). They diverged — `recall` and `coverage` were added to the
 * committed one and silently dropped from the ref-based one, because both fields
 * are optional on `BaselineFile` so the omission compiled. The consequence:
 * ref-based mode (public-repo default, the loop, `evaluate`, the self-guardrail)
 * compared against a prior side with NO recall and reported spurious
 * "cannot attribute" drift on every run.
 *
 * These tests assert every SCAN-DERIVED field survives the conversion. If a
 * future field is added to `CurrentScan` + `BaselineFile` and the converter
 * forgets it, the completeness test below fails — the field is present on the
 * scan fixture but absent (or wrong) on the converted file.
 */

import { describe, it, expect } from 'vitest';
import { scanToBaselineFile } from '../../src/baseline/create';
import type { CurrentScan } from '../../src/baseline/create';
import { CURRENT_IDENTITY_SCHEME } from '../../src/baseline/types';
import { BASELINE_SCHEMA_VERSION } from '../../src/baseline/baseline-file';

/** A CurrentScan fixture with every scan-derived field set to a distinctive,
 *  non-empty value so a dropped field is unmistakable in the assertion. */
function fixtureScan(): CurrentScan {
  return {
    findings: [
      { id: 'f1', kind: 'secret', file: 'a.ts', line: 1 },
    ] as unknown as CurrentScan['findings'],
    aggregate: {} as CurrentScan['aggregate'],
    repoState: { commitSha: 'deadbeef', branch: 'main', root: '/repo' } as CurrentScan['repoState'],
    saltMode: 'deterministic' as CurrentScan['saltMode'],
    tools: { gitleaks: '8.24.0' },
    recall: {
      secret: { epoch: 1, inputs: { gitleaks: '8.24.0' } },
      'custom-check': { epoch: 2, inputs: { 'lint:x/cmd': 'eslint .' } },
    } as CurrentScan['recall'],
    coverage: {
      tools: [{ tool: 'gitleaks', available: true }],
    } as unknown as CurrentScan['coverage'],
    deferred: [
      { id: 'semgrep', label: 'SAST', reason: 'mirror', cause: 'scanner-missing' },
    ] as CurrentScan['deferred'],
    analysisMeta: {
      dxkitVersion: '3.8.0',
      toolchainHash: 'abc',
      policyHash: 'p',
      ignoreHash: 'i',
      configHash: 'c',
    } as CurrentScan['analysisMeta'],
    producerCtx: {} as CurrentScan['producerCtx'],
  };
}

describe('scanToBaselineFile — every scan-derived field survives the conversion', () => {
  it('carries recall and coverage (the two that were dropped in ref-based mode)', () => {
    const scan = fixtureScan();
    const file = scanToBaselineFile(scan, { name: 'main', findings: scan.findings });
    // The exact bug: these were undefined on the ref-based prior side.
    expect(file.recall).toEqual(scan.recall);
    expect(file.coverage).toEqual(scan.coverage);
    expect(file.recall).toBeDefined();
    expect(file.coverage).toBeDefined();
  });

  it('carries the capture-deferral record (Rule 20 — the arming banner reads it)', () => {
    const scan = fixtureScan();
    const file = scanToBaselineFile(scan, { name: 'main', findings: scan.findings });
    expect(file.deferred).toEqual(scan.deferred);
  });

  it('omits `deferred` entirely on a complete capture (authoritative shape)', () => {
    const scan = { ...fixtureScan(), deferred: [] as CurrentScan['deferred'] };
    const file = scanToBaselineFile(scan, { name: 'main', findings: scan.findings });
    expect('deferred' in file).toBe(false);
  });

  it('carries every other scan-derived field verbatim', () => {
    const scan = fixtureScan();
    const file = scanToBaselineFile(scan, {
      name: 'main',
      findings: scan.findings,
      createdAt: '2026-07-16T00:00:00.000Z',
    });
    expect(file.repo).toEqual(scan.repoState);
    expect(file.analysis).toEqual(scan.analysisMeta);
    expect(file.tools).toEqual(scan.tools);
    expect(file.saltMode).toBe(scan.saltMode);
    expect(file.schemaVersion).toBe(BASELINE_SCHEMA_VERSION);
    expect(file.identityScheme).toBe(CURRENT_IDENTITY_SCHEME);
    expect(file.createdAt).toBe('2026-07-16T00:00:00.000Z');
  });

  it('takes findings from the caller, not the scan (the one legitimate difference)', () => {
    // The committed write persists the allowlist-filtered `live` set; the
    // ref-based prior side keeps the full gathered set. So findings is a param.
    const scan = fixtureScan();
    const filtered: CurrentScan['findings'] = [];
    const file = scanToBaselineFile(scan, { name: 'main', findings: filtered });
    expect(file.findings).toEqual([]);
    expect(file.findings).not.toEqual(scan.findings);
  });

  it('completeness guard: no scan-derived BaselineFile field is left undefined', () => {
    // If a future field is added to CurrentScan + BaselineFile and the converter
    // forgets it, it lands here as `undefined` while the scan fixture set it.
    const scan = fixtureScan();
    const file = scanToBaselineFile(scan, { name: 'main', findings: scan.findings });
    for (const key of [
      'schemaVersion',
      'name',
      'createdAt',
      'repo',
      'analysis',
      'tools',
      'saltMode',
      'identityScheme',
      'recall',
      'coverage',
      'deferred',
      'findings',
    ] as const) {
      expect(file[key], `scanToBaselineFile dropped '${key}'`).toBeDefined();
    }
  });
});
