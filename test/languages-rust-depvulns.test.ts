import { describe, it, expect } from 'vitest';
import { parseCargoAuditOutput, buildRustTopLevelDepIndex } from '../src/languages/rust';

// Fixture JSONs mirror the cargo-audit --json schema documented at
// https://docs.rs/rustsec/latest/rustsec/advisory/struct.Advisory.html.
// Used in lieu of a real Rust toolchain on the dev machine; full
// pipeline validation runs at 10h.5 release time on equipped machine.

describe('parseCargoAuditOutput', () => {
  it('returns null for malformed JSON', () => {
    expect(parseCargoAuditOutput('not json')).toBeNull();
    expect(parseCargoAuditOutput('')).toBeNull();
  });

  it('returns null when the vulnerabilities key is absent', () => {
    expect(parseCargoAuditOutput(JSON.stringify({ database: {} }))).toBeNull();
  });

  it('returns empty findings + zero counts when list is empty', () => {
    const raw = JSON.stringify({ vulnerabilities: { found: 0, count: 0, list: [] } });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings).toEqual([]);
    expect(parsed.counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('extracts a complete advisory with textual severity', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        found: 1,
        count: 1,
        list: [
          {
            advisory: {
              id: 'RUSTSEC-2023-0019',
              package: 'openssl',
              title: 'use-after-free in openssl crate',
              description: 'Long description here',
              date: '2023-08-30',
              url: 'https://rustsec.org/advisories/RUSTSEC-2023-0019',
              severity: 'high',
              aliases: ['CVE-2023-12345'],
              cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
            },
            versions: { patched: ['>=0.10.55'], unaffected: [] },
            package: { name: 'openssl', version: '0.10.50' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.counts).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
    expect(parsed.findings).toHaveLength(1);
    const f = parsed.findings[0];
    expect(f.id).toBe('RUSTSEC-2023-0019');
    expect(f.package).toBe('openssl');
    expect(f.installedVersion).toBe('0.10.50');
    expect(f.tool).toBe('cargo-audit');
    expect(f.severity).toBe('high');
    expect(f.cvssScore).toBe(9.8); // critical-band CVSS
    expect(f.fixedVersion).toBe('0.10.55'); // comparator stripped
    expect(f.aliases).toEqual(['CVE-2023-12345']);
    expect(f.summary).toBe('use-after-free in openssl crate');
    expect(f.references).toContain('https://rustsec.org/advisories/RUSTSEC-2023-0019');
  });

  it('promotes severity from CVSS when textual severity is missing', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: 'RUSTSEC-2024-0001',
              cvss: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', // 9.8 → critical
            },
            versions: {},
            package: { name: 'foo', version: '1.0.0' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings[0].severity).toBe('critical');
    expect(parsed.findings[0].cvssScore).toBe(9.8);
    // Counts must agree with the upgraded per-finding severity
    expect(parsed.counts).toEqual({ critical: 1, high: 0, medium: 0, low: 0 });
  });

  it('falls back to RUSTSEC URL when references is absent', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          {
            advisory: { id: 'RUSTSEC-2024-0002', severity: 'medium' },
            versions: {},
            package: { name: 'bar', version: '2.0.0' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings[0].references).toEqual([
      'https://rustsec.org/advisories/RUSTSEC-2024-0002.html',
    ]);
  });

  it('uses description when title is absent', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: 'RUSTSEC-2024-0003',
              description: 'A subtle bug',
              severity: 'low',
            },
            versions: {},
            package: { name: 'baz', version: '0.1.0' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings[0].summary).toBe('A subtle bug');
  });

  it('skips entries without an advisory id', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          { advisory: { severity: 'high' }, versions: {}, package: { name: 'no-id' } },
          {
            advisory: { id: 'RUSTSEC-2024-0004', severity: 'high' },
            versions: {},
            package: { name: 'has-id', version: '1.0.0' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0].id).toBe('RUSTSEC-2024-0004');
  });

  it('strips empty aliases', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          {
            advisory: {
              id: 'RUSTSEC-2024-0005',
              severity: 'high',
              aliases: ['', 'CVE-2024-1', ''],
            },
            versions: {},
            package: { name: 'qux', version: '1.0.0' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings[0].aliases).toEqual(['CVE-2024-1']);
  });

  it('handles aliases as undefined → no aliases field', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          {
            advisory: { id: 'RUSTSEC-2024-0006', severity: 'medium' },
            versions: {},
            package: { name: 'no-aliases', version: '1.0.0' },
          },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.findings[0].aliases).toBeUndefined();
  });

  it('counts each severity bucket correctly across mixed advisories', () => {
    const raw = JSON.stringify({
      vulnerabilities: {
        list: [
          { advisory: { id: 'A1', severity: 'critical' }, package: { name: 'a' } },
          { advisory: { id: 'A2', severity: 'critical' }, package: { name: 'b' } },
          { advisory: { id: 'A3', severity: 'high' }, package: { name: 'c' } },
          { advisory: { id: 'A4', severity: 'medium' }, package: { name: 'd' } },
          { advisory: { id: 'A5', severity: 'medium' }, package: { name: 'e' } },
          { advisory: { id: 'A6', severity: 'low' }, package: { name: 'f' } },
          // Unrecognized severity falls through to low.
          { advisory: { id: 'A7', severity: 'informational' }, package: { name: 'g' } },
        ],
      },
    });
    const parsed = parseCargoAuditOutput(raw)!;
    expect(parsed.counts).toEqual({ critical: 2, high: 1, medium: 2, low: 2 });
    expect(parsed.findings).toHaveLength(7);
  });
});

describe('buildRustTopLevelDepIndex', () => {
  it('returns empty map on malformed input', () => {
    expect(buildRustTopLevelDepIndex('not json').size).toBe(0);
    expect(buildRustTopLevelDepIndex('').size).toBe(0);
    expect(buildRustTopLevelDepIndex('{}').size).toBe(0);
  });

  it('returns empty map when resolve.root is missing', () => {
    const raw = JSON.stringify({ packages: [], resolve: { nodes: [] } });
    expect(buildRustTopLevelDepIndex(raw).size).toBe(0);
  });

  it('attributes a direct dep to itself', () => {
    const raw = JSON.stringify({
      packages: [
        { id: 'root 0.1 (path)', name: 'my-crate' },
        { id: 'serde 1.0 (registry)', name: 'serde' },
      ],
      resolve: {
        root: 'root 0.1 (path)',
        nodes: [
          { id: 'root 0.1 (path)', dependencies: ['serde 1.0 (registry)'] },
          { id: 'serde 1.0 (registry)', dependencies: [] },
        ],
      },
    });
    const idx = buildRustTopLevelDepIndex(raw);
    expect(idx.get('serde')).toEqual(['serde']);
  });

  it('attributes transitives to their top-level ancestor', () => {
    const raw = JSON.stringify({
      packages: [
        { id: 'root 0.1 (path)', name: 'my-crate' },
        { id: 'tokio 1.0 (registry)', name: 'tokio' },
        { id: 'mio 1.0 (registry)', name: 'mio' },
      ],
      resolve: {
        root: 'root 0.1 (path)',
        nodes: [
          { id: 'root 0.1 (path)', dependencies: ['tokio 1.0 (registry)'] },
          { id: 'tokio 1.0 (registry)', dependencies: ['mio 1.0 (registry)'] },
          { id: 'mio 1.0 (registry)', dependencies: [] },
        ],
      },
    });
    const idx = buildRustTopLevelDepIndex(raw);
    expect(idx.get('tokio')).toEqual(['tokio']);
    expect(idx.get('mio')).toEqual(['tokio']);
  });

  it('unions attributions across multiple top-level deps', () => {
    const raw = JSON.stringify({
      packages: [
        { id: 'root 0.1 (path)', name: 'my-crate' },
        { id: 'tokio 1.0 (registry)', name: 'tokio' },
        { id: 'reqwest 0.11 (registry)', name: 'reqwest' },
        { id: 'bytes 1.0 (registry)', name: 'bytes' },
      ],
      resolve: {
        root: 'root 0.1 (path)',
        nodes: [
          {
            id: 'root 0.1 (path)',
            dependencies: ['tokio 1.0 (registry)', 'reqwest 0.11 (registry)'],
          },
          { id: 'tokio 1.0 (registry)', dependencies: ['bytes 1.0 (registry)'] },
          { id: 'reqwest 0.11 (registry)', dependencies: ['bytes 1.0 (registry)'] },
          { id: 'bytes 1.0 (registry)', dependencies: [] },
        ],
      },
    });
    const idx = buildRustTopLevelDepIndex(raw);
    expect(idx.get('bytes')).toEqual(['reqwest', 'tokio']);
  });
});

// `isMajorBump` shared helper moved to src/analyzers/tools/semver-bump.ts
// in Phase 10h.6.4; full test coverage lives in test/semver-bump.test.ts.
