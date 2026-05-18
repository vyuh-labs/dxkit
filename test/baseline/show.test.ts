import { describe, it, expect } from 'vitest';
import {
  BASELINE_SHOW_SCHEMA,
  FILTER_KINDS,
  parseKindFilter,
  renderJson,
  renderKind,
  renderSummary,
} from '../../src/baseline/show';
import { BASELINE_SCHEMA_VERSION, DEFAULT_BASELINE_NAME } from '../../src/baseline/baseline-file';
import type { BaselineFile } from '../../src/baseline/baseline-file';
import type { BaselineEntry } from '../../src/baseline/types';

function makeFile(findings: BaselineEntry[]): BaselineFile {
  return {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    name: DEFAULT_BASELINE_NAME,
    createdAt: '2026-05-18T09:45:42.357Z',
    repo: {
      commitSha: '9cac8729ae95b45b511b2413d7ba7c32bbee915b',
      branch: 'feat/phase-2.5.0',
      root: '/fixture',
    },
    analysis: {
      dxkitVersion: '2.4.8',
      policyHash: 'ph',
      ignoreHash: 'ih',
      toolchainHash: 'tch',
      configHash: 'ch',
    },
    tools: { gitleaks: '8.24.0', semgrep: '1.161.0' },
    saltMode: 'deterministic',
    findings,
  };
}

describe('parseKindFilter', () => {
  it('accepts every BaselineEntry kind', () => {
    for (const k of FILTER_KINDS) expect(parseKindFilter(k)).toBe(k);
  });
  it('rejects unknown kinds', () => {
    expect(parseKindFilter('unknown')).toBeNull();
    expect(parseKindFilter('SECRET')).toBeNull();
    expect(parseKindFilter('')).toBeNull();
  });
});

describe('renderSummary', () => {
  it('renders header + per-kind counts in descending order', () => {
    const file = makeFile([
      { id: 'a1', kind: 'large-file', file: 'big.ts' },
      { id: 'a2', kind: 'large-file', file: 'big2.ts' },
      { id: 'a3', kind: 'large-file', file: 'big3.ts' },
      { id: 'b1', kind: 'stale-file', file: '.foo.swp', suffix: 'swp' },
      { id: 'c1', kind: 'license', package: 'lodash', version: '4.0', licenseType: 'MIT' },
    ]);
    const out = renderSummary(file);
    expect(out).toContain("Baseline 'main'");
    expect(out).toContain('9cac8729');
    expect(out).toContain('Findings: 5 total');
    // Descending count order: large-file (3) > stale-file (1) = license (1)
    const largeIdx = out.indexOf('large-file');
    const staleIdx = out.indexOf('stale-file');
    expect(largeIdx).toBeGreaterThan(0);
    expect(largeIdx).toBeLessThan(staleIdx);
  });

  it('omits the count table when there are no findings', () => {
    const file = makeFile([]);
    const out = renderSummary(file);
    expect(out).toContain('Findings: 0 total');
    expect(out).not.toContain('Filter to one kind');
  });

  it('shows tools when present', () => {
    const out = renderSummary(makeFile([]));
    expect(out).toContain('gitleaks@8.24.0');
    expect(out).toContain('semgrep@1.161.0');
  });
});

describe('renderKind', () => {
  it('lists matching entries with identity prefix + locator', () => {
    const file = makeFile([
      {
        id: 'abcdef1234567890',
        kind: 'secret',
        tool: 'gitleaks',
        rule: 'aws-token',
        file: 'src/keys.ts',
        line: 42,
      },
      { id: 'other', kind: 'large-file', file: 'big.ts' },
    ]);
    const out = renderKind(file, 'secret');
    expect(out).toContain('1 secret entry');
    expect(out).toContain('abcdef123456');
    expect(out).toContain('src/keys.ts:42');
    expect(out).toContain('[gitleaks/aws-token]');
    expect(out).not.toContain('big.ts'); // filtered out
  });

  it('renders a friendly empty notice when no entries match', () => {
    const file = makeFile([{ id: 'a', kind: 'large-file', file: 'x.ts' }]);
    const out = renderKind(file, 'secret');
    expect(out).toContain("(no entries of kind 'secret')");
  });

  it('renders the correct locator for each kind', () => {
    const file = makeFile([
      {
        id: '1',
        kind: 'dep-vuln',
        package: 'lodash',
        installedVersion: '4.0',
        advisoryId: 'GHSA-x',
      },
      {
        id: '2',
        kind: 'duplication',
        fileA: 'a.ts',
        fileB: 'b.ts',
        lines: 10,
        startLineA: 5,
        startLineB: 25,
      },
      { id: '3', kind: 'license', package: 'foo', version: '1.0', licenseType: 'GPL-3.0' },
      { id: '4', kind: 'test-gap', file: 'svc.ts', risk: 'critical' },
      { id: '5', kind: 'stale-file', file: '.x.bak', suffix: 'bak' },
      {
        id: '6',
        kind: 'secret-hmac',
        tool: 'gitleaks',
        rule: 'aws-token',
        hmac: 'deadbeefcafebabe',
      },
    ]);
    expect(renderKind(file, 'dep-vuln')).toContain('lodash@4.0  [GHSA-x]');
    expect(renderKind(file, 'duplication')).toContain('a.ts:5 <-> b.ts:25  (10 lines)');
    expect(renderKind(file, 'license')).toContain('foo@1.0  [GPL-3.0]');
    expect(renderKind(file, 'test-gap')).toContain('svc.ts  [risk: critical]');
    expect(renderKind(file, 'stale-file')).toContain('.x.bak  [.bak]');
    expect(renderKind(file, 'secret-hmac')).toContain('hmac:deadbeefcafe');
  });
});

describe('renderJson', () => {
  it('wraps the file with a schema banner + summary', () => {
    const file = makeFile([
      { id: 'a', kind: 'large-file', file: 'big.ts' },
      { id: 'b', kind: 'large-file', file: 'big2.ts' },
    ]);
    const out = renderJson(file);
    expect(out.schema).toBe(BASELINE_SHOW_SCHEMA);
    expect(out.filter).toBeNull();
    expect(out.baseline.findings).toHaveLength(2);
    expect(out.summary.total).toBe(2);
    expect(out.summary.byKind['large-file']).toBe(2);
  });

  it('filters findings when a kind is supplied', () => {
    const file = makeFile([
      { id: 'a', kind: 'large-file', file: 'big.ts' },
      { id: 'b', kind: 'stale-file', file: '.x.bak', suffix: 'bak' },
    ]);
    const out = renderJson(file, { kind: 'large-file' });
    expect(out.filter).toEqual({ kind: 'large-file' });
    expect(out.baseline.findings).toHaveLength(1);
    expect(out.summary.total).toBe(1);
    expect(out.summary.byKind['large-file']).toBe(1);
    expect(out.summary.byKind['stale-file']).toBeUndefined();
  });

  it('does not mutate the input file', () => {
    const findings: BaselineEntry[] = [{ id: 'a', kind: 'large-file', file: 'big.ts' }];
    const file = makeFile(findings);
    renderJson(file, { kind: 'large-file' });
    expect(file.findings).toBe(findings); // reference preserved
    expect(file.findings).toHaveLength(1);
  });

  it('round-trips through JSON.stringify', () => {
    const out = renderJson(makeFile([{ id: 'a', kind: 'large-file', file: 'big.ts' }]));
    const round = JSON.parse(JSON.stringify(out));
    expect(round.schema).toBe(BASELINE_SHOW_SCHEMA);
    expect(round.baseline.findings[0].file).toBe('big.ts');
  });
});
