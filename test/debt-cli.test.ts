/**
 * `vyuh-dxkit debt` — the composed repair inventory for cleanup agents.
 * Pins the composition rules: baseline provenance per live floor failure
 * (failing-since-baseline vs new-since-baseline), fixed-since-baseline
 * credit, severity-ordered finding groups, and the plan's one hard
 * dependency (build before tests before findings). All floor input is
 * injected — the command's own live-run plumbing is `captureFloorDebt`,
 * covered in test/baseline/floor-debt.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildDebtReport, renderDebtConsole } from '../src/debt-cli';
import type { FloorDebt } from '../src/baseline/floor-debt';

const LIVE: FloorDebt = {
  capturedAtCommit: 'live',
  capturedAt: '2026-07-17T00:00:00.000Z',
  checks: [
    {
      pack: 'ts',
      label: 'typecheck',
      command: 'npx tsc --noEmit',
      status: 'fail',
      output: 'error TS2304: Cannot find name',
    },
    {
      pack: 'ts',
      label: 'affected-tests',
      command: 'vitest run',
      status: 'fail',
      output: '3 failed',
    },
    { pack: 'go', label: 'compile', command: 'go build ./...', status: 'pass' },
    {
      pack: 'kotlin',
      label: 'compile',
      command: './gradlew testClasses',
      status: 'skipped-environment',
      unmet: 'needs the jdk toolchain',
    },
  ],
};

function writeBaseline(dir: string, floorDebt: object | undefined, findings: object[]): void {
  mkdirSync(join(dir, '.dxkit', 'baselines'), { recursive: true });
  writeFileSync(
    join(dir, '.dxkit', 'baselines', 'main.json'),
    JSON.stringify({
      schemaVersion: 'dxkit-baseline/v1',
      name: 'main',
      createdAt: '2026-07-16T00:00:00.000Z',
      repo: { commitSha: 'base', branch: 'main', dirty: false },
      analysis: { dxkitVersion: 'test', toolchainHash: 'x' },
      tools: {},
      saltMode: 'none',
      findings,
      ...(floorDebt ? { floorDebt } : {}),
    }),
  );
}

describe('buildDebtReport', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-debt-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('classifies live failures by baseline provenance and credits fixes', () => {
    writeBaseline(
      dir,
      {
        capturedAtCommit: 'base',
        capturedAt: '2026-07-16T00:00:00.000Z',
        checks: [
          { pack: 'ts', label: 'typecheck', command: 'npx tsc --noEmit', status: 'fail' },
          { pack: 'ts', label: 'affected-tests', command: 'vitest run', status: 'pass' },
          { pack: 'go', label: 'compile', command: 'go build ./...', status: 'fail' },
        ],
      },
      [],
    );
    const r = buildDebtReport(dir, { liveFloor: () => LIVE });
    const byLabel = new Map(r.floor.failures.map((f) => [`${f.pack}:${f.label}`, f]));
    // Failing at baseline AND now → the debt this surface exists for.
    expect(byLabel.get('ts:typecheck')?.sinceBaseline).toBe('baseline');
    // Passing at baseline, failing now → the gate's business, but named.
    expect(byLabel.get('ts:affected-tests')?.sinceBaseline).toBe('new');
    // Failing at baseline, passing now → credited.
    expect(r.floor.fixedSinceBaseline).toEqual(['go compile']);
    // Environment boundary disclosed, never silently absent (Rule 20).
    expect(r.floor.unobservable.some((u) => u.includes('jdk'))).toBe(true);
  });

  it('no baseline envelope → provenance is unknown, never fabricated', () => {
    writeBaseline(dir, undefined, []);
    const r = buildDebtReport(dir, { liveFloor: () => LIVE });
    expect(r.floor.failures.every((f) => f.sinceBaseline === 'unknown')).toBe(true);
  });

  it('groups findings by severity rank and orders the plan build → tests → findings', () => {
    writeBaseline(dir, undefined, [
      { id: 'aaaa000000000001', kind: 'stale-file', file: 'x.bak', suffix: 'bak' },
      { id: 'aaaa000000000002', kind: 'secret', file: 'src/cfg.ts' },
      { id: 'aaaa000000000003', kind: 'secret', file: 'src/env.ts' },
      { id: 'aaaa000000000004', kind: 'dep-vuln', package: 'adm-zip', version: '0.5.17' },
    ]);
    const r = buildDebtReport(dir, { liveFloor: () => LIVE });
    expect(r.findings.total).toBe(4);
    // secret (high) before dep-vuln (medium) before stale-file (low).
    expect(r.findings.groups.map((g) => g.kind)).toEqual(['secret', 'dep-vuln', 'stale-file']);
    expect(r.findings.groups[0].count).toBe(2);
    expect(r.findings.groups[0].samples[0].fingerprint).toBe('aaaa000000000002');
    // The one hard dependency: build first, then tests, then findings.
    expect(r.plan[0]).toContain('Fix the build first');
    expect(r.plan[0]).toContain('npx tsc --noEmit');
    expect(r.plan[1]).toContain('failing tests');
    expect(r.plan[2]).toContain('secret');
  });

  it('renders a console report with repro commands and the suggested order', () => {
    writeBaseline(dir, undefined, []);
    const out = renderDebtConsole(buildDebtReport(dir, { liveFloor: () => LIVE }));
    expect(out).toContain('never gates');
    expect(out).toContain('repro: npx tsc --noEmit');
    expect(out).toContain('SUGGESTED ORDER');
  });

  it('no baseline file at all still inventories the live floor and says what is missing', () => {
    const r = buildDebtReport(dir, { liveFloor: () => LIVE });
    expect(r.baselinePresent).toBe(false);
    expect(r.floor.failures.length).toBeGreaterThan(0);
    const out = renderDebtConsole(r);
    expect(out).toContain('baseline create');
  });
});
