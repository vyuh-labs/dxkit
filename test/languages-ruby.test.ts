/**
 * Ruby pack — pack-specific tests.
 *
 * RECIPE NOTE: each parser exercised here SHOULD be tested against a
 * REAL fixture file under `test/fixtures/raw/ruby/`, not a synthetic
 * JSON/XML string. The C# defect lesson (5 months silent, parsers
 * passed unit tests on synthetic JSON but returned 0 findings on real
 * input — fixed in Phase 10h.6.8) is the reason. Capture commands live
 * in `test/fixtures/raw/ruby/HARVEST.md`.
 *
 * TODO(ruby): replace the placeholder fixture names below with the
 * actual files you harvest, and the parser names with the actual
 * exports from src/languages/ruby.ts.
 */

import { describe, it, expect } from 'vitest';
// import * as fs from 'fs';
// import * as path from 'path';
import { ruby } from '../src/languages/ruby';
// import {
//   parseRubyLintOutput,
//   parseRubyCoverageOutput,
//   parseRubyDepVulnsOutput,
//   extractRubyImportsRaw,
//   mapRubySeverity,
// } from '../src/languages/ruby';

// const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'ruby');
// function readFixture(name: string): string {
//   return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
// }

describe('ruby pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(ruby.id).toBe('ruby');
    expect(ruby.displayName).toBe('Ruby');
  });

  // TODO(ruby): once capabilities land, assert the providers are wired:
  //   expect(ruby.capabilities?.depVulns).toBeDefined();
  //   expect(ruby.capabilities?.lint).toBeDefined();
  //   expect(ruby.capabilities?.coverage).toBeDefined();
  //   expect(ruby.capabilities?.imports).toBeDefined();
  //   expect(ruby.capabilities?.testFramework).toBeDefined();
});

// ─── Parser test stubs — uncomment + fill in once each parser exists ───────
//
// describe('mapRubySeverity', () => {
//   it('tiers severity strings into dxkit four-tier scheme', () => {
//     // expect(mapRubySeverity('error')).toBe('high');
//     // expect(mapRubySeverity('warning')).toBe('medium');
//     // expect(mapRubySeverity('info')).toBe('low');
//   });
// });
//
// describe('parseRubyLintOutput', () => {
//   it('counts violations in the real fixture by severity tier', () => {
//     const raw = readFixture('lint-output.<ext>');
//     const counts = parseRubyLintOutput(raw);
//     expect(counts.high).toBeGreaterThan(0);
//   });
// });
//
// describe('parseRubyCoverageOutput', () => {
//   it('computes line-level coverage from the real fixture', () => {
//     const raw = readFixture('coverage-output.<ext>');
//     const result = parseRubyCoverageOutput(raw, 'coverage-output.<ext>', '/');
//     expect(result).not.toBeNull();
//     expect(result!.linePercent).toBeGreaterThan(0);
//   });
// });
//
// describe('parseRubyDepVulnsOutput', () => {
//   it('extracts findings from the real tool output', () => {
//     const raw = readFixture('depvulns-output.json');
//     const { findings } = parseRubyDepVulnsOutput(raw);
//     expect(findings.length).toBeGreaterThan(0);
//   });
// });
//
// describe('extractRubyImportsRaw', () => {
//   it('extracts simple imports from source text', () => {
//     // const src = '<sample source>';
//     // expect(extractRubyImportsRaw(src)).toEqual([...]);
//   });
// });
