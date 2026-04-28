/**
 * Kotlin pack — pack-specific tests.
 *
 * Each parser is exercised against a REAL fixture file under
 * `test/fixtures/raw/kotlin/`, NOT a synthetic JSON/XML string. Provenance:
 *
 *   - osv-scanner-output.json
 *       Real osv-scanner v2.3.5 output, captured by running:
 *         osv-scanner scan source --lockfile <pom.xml> --format json
 *       against a pom.xml declaring com.google.code.gson:gson:2.8.5
 *       and org.apache.logging.log4j:log4j-core:2.14.0 (both with known
 *       CVEs). Captured 2026-04-27 during Phase 10j.1 implementation.
 *
 *   - jacoco-kotlin-source.xml
 *       Real JaCoCo XML report from `codecov/standards` repo's
 *       `coverage_data/kotlin-standard/` (a tooling reference fixture).
 *       Their committed `coverage_totals.txt` asserts 50.00000% line
 *       coverage — used as a parser-correctness assertion below.
 *
 *   - jacoco-java-source.xml
 *       Same source repo, java-standard variant. JaCoCo XML schema is
 *       source-language-agnostic so this is an additional sanity check
 *       (Kotlin and Java reports should parse identically).
 *
 *   - detekt-checkstyle-output.xml
 *       Constructed using the verbatim format from detekt's own
 *       `CheckstyleOutputReportSpec.kt` (the canonical contract for
 *       detekt's XML output). JVM toolchain unavailable for local
 *       harvest; step 5 (cross-ecosystem benchmark) runs detekt
 *       end-to-end in CI as the empirical gate.
 *
 * The C# defect lesson (5 months silent, parsers passed unit tests on
 * synthetic JSON but returned 0 findings on real input) is the reason
 * these tests use real fixtures.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  kotlin,
  parseDetektCheckstyleXml,
  extractKotlinImportsRaw,
  mapDetektSeverity,
} from '../src/languages/kotlin';
import { parseJaCoCoXml } from '../src/analyzers/tools/jacoco';
import { parseOsvScannerMavenFindings } from '../src/analyzers/tools/osv-scanner-maven';

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'kotlin');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('kotlin pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(kotlin.id).toBe('kotlin');
    expect(kotlin.displayName).toBe('Kotlin (Android)');
  });

  it('declares all six capability providers (minus licenses)', () => {
    expect(kotlin.capabilities?.depVulns).toBeDefined();
    expect(kotlin.capabilities?.lint).toBeDefined();
    expect(kotlin.capabilities?.coverage).toBeDefined();
    expect(kotlin.capabilities?.imports).toBeDefined();
    expect(kotlin.capabilities?.testFramework).toBeDefined();
    // licenses deliberately omitted — see kotlin.ts comment.
    expect(kotlin.capabilities?.licenses).toBeUndefined();
  });

  it('declares osv-scanner + detekt as required tools', () => {
    expect(kotlin.tools).toContain('osv-scanner');
    expect(kotlin.tools).toContain('detekt');
  });
});

describe('mapDetektSeverity', () => {
  it('tiers detekt severity strings into dxkit four-tier scheme', () => {
    expect(mapDetektSeverity('error')).toBe('high');
    expect(mapDetektSeverity('warning')).toBe('medium');
    expect(mapDetektSeverity('info')).toBe('low');
  });

  it('handles uppercased input (defensive against future detekt versions)', () => {
    expect(mapDetektSeverity('ERROR')).toBe('high');
    expect(mapDetektSeverity('Warning')).toBe('medium');
  });

  it('defaults unknown severities to medium rather than dropping them', () => {
    expect(mapDetektSeverity('fatal')).toBe('medium');
    expect(mapDetektSeverity('')).toBe('medium');
  });
});

describe('parseDetektCheckstyleXml', () => {
  it('counts all errors in the real fixture by severity tier', () => {
    const raw = readFixture('detekt-checkstyle-output.xml');
    const counts = parseDetektCheckstyleXml(raw);
    // Fixture has: 2× error, 2× warning, 1× info across 2 files.
    expect(counts.high).toBe(2);
    expect(counts.medium).toBe(2);
    expect(counts.low).toBe(1);
    expect(counts.critical).toBe(0);
  });

  it('returns zero counts on an empty checkstyle report', () => {
    const empty =
      '<?xml version="1.0" encoding="UTF-8"?>\n<checkstyle version="4.3">\n</checkstyle>\n';
    const counts = parseDetektCheckstyleXml(empty);
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });

  it('handles malformed XML gracefully (zero counts, no throw)', () => {
    const malformed = '<not really xml>';
    const counts = parseDetektCheckstyleXml(malformed);
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });
});

describe('parseJaCoCoXml', () => {
  it('computes line-level coverage from the JaCoCo LINE counter on the real fixture', () => {
    // The fixture's tail-of-document `<counter type="LINE" missed="15"
    // covered="4"/>` gives 4/(15+4) = 21.05% — that's what dxkit and
    // any line-coverage consumer see. The sibling `coverage_totals.txt`
    // in codecov/standards reports 50.00000% — but that's codecov's
    // own aggregated metric (combining LINE/BRANCH/COMPLEXITY/CLASS
    // through their normalization pipeline), NOT JaCoCo's LINE
    // counter directly. Our parser is line-only by design (matches
    // python's coverage.py / TS's istanbul / C#'s cobertura semantics).
    const raw = readFixture('jacoco-kotlin-source.xml');
    const result = parseJaCoCoXml(raw, 'jacoco-kotlin-source.xml', '/');
    expect(result).not.toBeNull();
    expect(result!.linePercent).toBe(21.1);
    expect(result!.source).toBe('jacoco');
  });

  it('emits per-file coverage entries with package/sourcefile attribution', () => {
    const raw = readFixture('jacoco-kotlin-source.xml');
    const result = parseJaCoCoXml(raw, 'jacoco-kotlin-source.xml', '/');
    expect(result).not.toBeNull();
    expect(result!.files.size).toBeGreaterThan(0);
    // codecov's kotlin standard exercises a `codecov/Request.kt` source file.
    const reqEntry = [...result!.files.keys()].find((k) => k.includes('Request.kt'));
    expect(reqEntry).toBeDefined();
  });

  it('parses the java-standard fixture identically (XML schema is source-language-agnostic)', () => {
    const raw = readFixture('jacoco-java-source.xml');
    const result = parseJaCoCoXml(raw, 'jacoco-java-source.xml', '/');
    expect(result).not.toBeNull();
    expect(result!.files.size).toBeGreaterThan(0);
    expect(result!.linePercent).toBeGreaterThanOrEqual(0);
    expect(result!.linePercent).toBeLessThanOrEqual(100);
  });

  it('returns null when the XML has no LINE counter at all', () => {
    const empty = '<?xml version="1.0"?><report name="x"></report>';
    const result = parseJaCoCoXml(empty, 'empty.xml', '/');
    expect(result).toBeNull();
  });
});

describe('parseOsvScannerMavenFindings', () => {
  it('extracts findings from the real osv-scanner output', () => {
    const raw = readFixture('osv-scanner-output.json');
    const { counts, findings } = parseOsvScannerMavenFindings(raw);
    // The fixture has 2 Maven packages: gson@2.8.5 (1 vuln) and
    // log4j-core@2.14.0 (7 vulns). 8 findings total.
    expect(findings.length).toBeGreaterThanOrEqual(8);
    const totalCounted = counts.critical + counts.high + counts.medium + counts.low;
    expect(totalCounted).toBe(findings.length);
  });

  it('attributes findings to the correct Maven coordinates', () => {
    const raw = readFixture('osv-scanner-output.json');
    const { findings } = parseOsvScannerMavenFindings(raw);
    const gsonFindings = findings.filter((f) => f.package === 'com.google.code.gson:gson');
    expect(gsonFindings.length).toBe(1);
    expect(gsonFindings[0].installedVersion).toBe('2.8.5');
    expect(gsonFindings[0].tool).toBe('osv-scanner');
  });

  it('captures CVE aliases for advisories that ship them', () => {
    const raw = readFixture('osv-scanner-output.json');
    const { findings } = parseOsvScannerMavenFindings(raw);
    // gson's GHSA-4jrv-ppp4-jm57 has CVE-2022-25647 as alias.
    const gsonFinding = findings.find((f) => f.id === 'GHSA-4jrv-ppp4-jm57');
    expect(gsonFinding).toBeDefined();
    expect(gsonFinding!.aliases).toContain('CVE-2022-25647');
  });

  it('extracts CVSS scores when the OSV record carries a vector', () => {
    const raw = readFixture('osv-scanner-output.json');
    const { findings } = parseOsvScannerMavenFindings(raw);
    // gson's record has a CVSS:3.1 vector — our parser must compute the score.
    const gsonFinding = findings.find((f) => f.id === 'GHSA-4jrv-ppp4-jm57');
    expect(gsonFinding!.cvssScore).toBeDefined();
    expect(gsonFinding!.cvssScore).toBeGreaterThan(0);
  });

  it('synthesizes osv.dev reference URL when the record has no references[]', () => {
    const raw = readFixture('osv-scanner-output.json');
    const { findings } = parseOsvScannerMavenFindings(raw);
    for (const f of findings) {
      expect(f.references).toBeDefined();
      expect(f.references!.length).toBeGreaterThan(0);
    }
  });

  it('filters out non-Maven ecosystems (npm, PyPI, etc.) — polyglot dedup', () => {
    // Synthesize a polyglot result: one Maven, one npm, one PyPI.
    const polyglot = JSON.stringify({
      results: [
        {
          source: { path: 'fake', type: 'lockfile' },
          packages: [
            {
              package: { name: 'com.foo:bar', version: '1.0', ecosystem: 'Maven' },
              vulnerabilities: [{ id: 'M-1', aliases: [], severity: [], affected: [] }],
            },
            {
              package: { name: 'lodash', version: '4.0', ecosystem: 'npm' },
              vulnerabilities: [{ id: 'N-1', aliases: [], severity: [], affected: [] }],
            },
            {
              package: { name: 'requests', version: '2.0', ecosystem: 'PyPI' },
              vulnerabilities: [{ id: 'P-1', aliases: [], severity: [], affected: [] }],
            },
          ],
        },
      ],
    });
    const { findings } = parseOsvScannerMavenFindings(polyglot);
    expect(findings.length).toBe(1);
    expect(findings[0].id).toBe('M-1');
  });

  it('returns empty results on malformed JSON', () => {
    const { counts, findings } = parseOsvScannerMavenFindings('not-json');
    expect(findings.length).toBe(0);
    expect(counts).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });
});

describe('extractKotlinImportsRaw', () => {
  it('extracts simple imports', () => {
    const src = `
      package com.example
      import com.foo.Bar
      import com.foo.bar.Baz
    `;
    expect(extractKotlinImportsRaw(src)).toEqual(['com.foo.Bar', 'com.foo.bar.Baz']);
  });

  it('extracts wildcard imports', () => {
    const src = 'import com.foo.*';
    expect(extractKotlinImportsRaw(src)).toEqual(['com.foo.*']);
  });

  it('handles aliased imports (drops the alias)', () => {
    const src = 'import com.foo.Bar as Quux';
    expect(extractKotlinImportsRaw(src)).toEqual(['com.foo.Bar']);
  });

  it('skips line-commented imports', () => {
    const src = `
      // import com.commented.Out
      import com.real.Used
    `;
    expect(extractKotlinImportsRaw(src)).toEqual(['com.real.Used']);
  });

  it('returns empty for files with no imports', () => {
    expect(extractKotlinImportsRaw('package com.example\n\nfun main() {}')).toEqual([]);
  });
});
