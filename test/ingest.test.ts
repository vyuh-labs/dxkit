/**
 * Tests for external-findings ingestion (`src/ingest`).
 *
 * All fixtures here are SYNTHETIC — minimal hand-authored SARIF and
 * Snyk-issue shapes. We deliberately do NOT commit any real engine
 * output, both to keep the suite hermetic and because real scans are
 * run against private repos whose paths must not leak into the tree.
 *
 * Coverage:
 *   - SARIF 2.1.0 parse: severity resolution (security-severity →
 *     level fallback), CWE normalization, location skipping, engine
 *     auto-detection + override, rules-by-index.
 *   - Snyk REST issue mapping: severity fold (info→low), CWE from
 *     classes, sourceLocation extraction, no-location skip.
 *   - normalize: engine → tool provenance, identity left to the aggregator.
 *   - snapshot: write → read round-trip + fail-open on a missing dir.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSarif } from '../src/ingest/sarif';
import { snykIssueToFinding } from '../src/ingest/snyk-api';
import { externalToSecurityFindings } from '../src/ingest/normalize';
import { writeSnapshot, readAllSnapshots, snapshotEngines } from '../src/ingest/snapshot';

// ─── SARIF ──────────────────────────────────────────────────────────────────

function sarifWith(results: unknown[], rules: unknown[], driverName = 'CodeQL'): string {
  return JSON.stringify({
    runs: [{ tool: { driver: { name: driverName, rules } }, results }],
  });
}

describe('parseSarif', () => {
  it('parses a CodeQL-style result with security-severity + CWE tag', () => {
    const raw = sarifWith(
      [
        {
          ruleId: 'js/path-injection',
          message: { text: 'Uncontrolled data used in path expression.' },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: 'src/handler.ts' },
                region: { startLine: 42 },
              },
            },
          ],
        },
      ],
      [
        {
          id: 'js/path-injection',
          properties: { 'security-severity': '8.6', tags: ['external/cwe/cwe-023'] },
        },
      ],
    );
    const f = parseSarif(raw);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      engine: 'codeql',
      severity: 'high', // 8.6 → high
      category: 'code',
      cwe: 'CWE-23', // cwe-023 → CWE-23 (leading zeros stripped)
      rule: 'js/path-injection',
      file: 'src/handler.ts',
      line: 42,
    });
  });

  it('maps security-severity bands to four tiers', () => {
    const band = (score: string) =>
      parseSarif(
        sarifWith(
          [{ ruleId: 'r', locations: [loc('a.ts', 1)] }],
          [{ id: 'r', properties: { 'security-severity': score } }],
        ),
      )[0]?.severity;
    expect(band('9.5')).toBe('critical');
    expect(band('7.0')).toBe('high');
    expect(band('4.0')).toBe('medium');
    expect(band('1.0')).toBe('low');
  });

  it('falls back to result level when no security-severity', () => {
    const sev = (level: string) =>
      parseSarif(sarifWith([{ ruleId: 'r', level, locations: [loc('a.ts', 1)] }], [{ id: 'r' }]))[0]
        ?.severity;
    expect(sev('error')).toBe('high');
    expect(sev('warning')).toBe('medium');
    expect(sev('note')).toBe('low');
  });

  it('skips results with no source location', () => {
    const raw = sarifWith([{ ruleId: 'r', message: { text: 'no loc' } }], [{ id: 'r' }]);
    expect(parseSarif(raw)).toHaveLength(0);
  });

  it('auto-detects engine from driver name and honors an override', () => {
    const raw = sarifWith(
      [{ ruleId: 'r', locations: [loc('a.ts', 1)] }],
      [{ id: 'r' }],
      'Snyk Code',
    );
    expect(parseSarif(raw)[0].engine).toBe('snyk-code');
    expect(parseSarif(raw, 'codeql')[0].engine).toBe('codeql');
  });

  it('resolves a rule referenced by index', () => {
    const raw = JSON.stringify({
      runs: [
        {
          tool: { driver: { name: 'CodeQL', rules: [{ id: 'r0' }, { id: 'r1' }] } },
          results: [
            {
              rule: { index: 1 },
              ruleId: 'r1',
              locations: [loc('a.ts', 5)],
            },
          ],
        },
      ],
    });
    const f = parseSarif(raw);
    expect(f).toHaveLength(1);
    expect(f[0].rule).toBe('r1');
  });

  it('returns [] on malformed JSON instead of throwing', () => {
    expect(parseSarif('not json')).toEqual([]);
  });
});

function loc(uri: string, startLine: number) {
  return { physicalLocation: { artifactLocation: { uri }, region: { startLine } } };
}

// ─── Snyk REST issue mapping ──────────────────────────────────────────────────

describe('snykIssueToFinding', () => {
  const baseIssue = (over: Record<string, unknown> = {}) => ({
    id: 'abc-123',
    attributes: {
      title: 'Insecure path access',
      type: 'code',
      effective_severity_level: 'high',
      classes: [{ id: 'CWE-23', source: 'CWE', type: 'weakness' }],
      coordinates: [
        {
          representations: [
            { sourceLocation: { file: 'src/x.ts', region: { start: { line: 9 } } } },
          ],
        },
      ],
      ...over,
    },
  });

  it('maps a code issue to an ExternalFinding', () => {
    expect(snykIssueToFinding(baseIssue())).toEqual({
      engine: 'snyk-code',
      severity: 'high',
      category: 'code',
      cwe: 'CWE-23',
      rule: 'abc-123',
      title: 'Insecure path access',
      file: 'src/x.ts',
      line: 9,
    });
  });

  it('folds info severity to low', () => {
    expect(snykIssueToFinding(baseIssue({ effective_severity_level: 'info' }))?.severity).toBe(
      'low',
    );
  });

  it('skips an issue with no source location', () => {
    expect(snykIssueToFinding(baseIssue({ coordinates: [] }))).toBeNull();
  });
});

// ─── normalize ───────────────────────────────────────────────────────────────

describe('externalToSecurityFindings', () => {
  it('maps engine → tool and preserves the rest (identity is the aggregator’s job)', () => {
    const sf = externalToSecurityFindings([
      {
        engine: 'codeql',
        severity: 'high',
        category: 'code',
        cwe: 'CWE-79',
        rule: 'r',
        title: 't',
        file: 'f.ts',
        line: 3,
      },
    ]);
    expect(sf[0]).toEqual({
      severity: 'high',
      category: 'code',
      cwe: 'CWE-79',
      rule: 'r',
      title: 't',
      file: 'f.ts',
      line: 3,
      tool: 'codeql',
    });
    // No fingerprint field — that is assigned downstream by the aggregator.
    expect('fingerprint' in sf[0]).toBe(false);
  });
});

// ─── snapshot ────────────────────────────────────────────────────────────────

describe('snapshot round-trip', () => {
  it('writes and reads back findings; reports engines', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-snap-'));
    try {
      writeSnapshot(dir, {
        schemaVersion: 1,
        engine: 'codeql',
        generatedAt: '2026-01-01T00:00:00Z',
        findings: [
          {
            engine: 'codeql',
            severity: 'high',
            category: 'code',
            cwe: 'CWE-79',
            rule: 'r',
            title: 't',
            file: 'f.ts',
            line: 1,
          },
        ],
      });
      expect(readAllSnapshots(dir)).toHaveLength(1);
      expect(snapshotEngines(dir)).toEqual(['codeql']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails open (empty) when no external dir exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-empty-'));
    try {
      expect(readAllSnapshots(dir)).toEqual([]);
      expect(snapshotEngines(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
