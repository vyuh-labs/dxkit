/**
 * Java pack — pack-specific tests.
 *
 * RECIPE NOTE: each parser exercised here SHOULD be tested against a
 * REAL fixture file under `test/fixtures/raw/java/`, not a synthetic
 * JSON/XML string. The C# defect lesson (5 months silent, parsers
 * passed unit tests on synthetic JSON but returned 0 findings on real
 * input — fixed in Phase 10h.6.8) is the reason. Capture commands live
 * in `test/fixtures/raw/java/HARVEST.md`.
 *
 * TODO(java): replace the placeholder fixture names below with the
 * actual files you harvest, and the parser names with the actual
 * exports from src/languages/java.ts.
 */

import { describe, it, expect } from 'vitest';
// import * as fs from 'fs';
// import * as path from 'path';
import { java } from '../src/languages/java';
// import {
//   parseJavaLintOutput,
//   parseJavaCoverageOutput,
//   parseJavaDepVulnsOutput,
//   extractJavaImportsRaw,
//   mapJavaSeverity,
// } from '../src/languages/java';

// const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'java');
// function readFixture(name: string): string {
//   return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
// }

describe('java pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(java.id).toBe('java');
    expect(java.displayName).toBe('Java');
  });

  // TODO(java): once capabilities land, assert the providers are wired:
  //   expect(java.capabilities?.depVulns).toBeDefined();
  //   expect(java.capabilities?.lint).toBeDefined();
  //   expect(java.capabilities?.coverage).toBeDefined();
  //   expect(java.capabilities?.imports).toBeDefined();
  //   expect(java.capabilities?.testFramework).toBeDefined();
});

// ─── Parser test stubs — uncomment + fill in once each parser exists ───────
//
// describe('mapJavaSeverity', () => {
//   it('tiers severity strings into dxkit four-tier scheme', () => {
//     // expect(mapJavaSeverity('error')).toBe('high');
//     // expect(mapJavaSeverity('warning')).toBe('medium');
//     // expect(mapJavaSeverity('info')).toBe('low');
//   });
// });
//
// describe('parseJavaLintOutput', () => {
//   it('counts violations in the real fixture by severity tier', () => {
//     const raw = readFixture('lint-output.<ext>');
//     const counts = parseJavaLintOutput(raw);
//     expect(counts.high).toBeGreaterThan(0);
//   });
// });
//
// describe('parseJavaCoverageOutput', () => {
//   it('computes line-level coverage from the real fixture', () => {
//     const raw = readFixture('coverage-output.<ext>');
//     const result = parseJavaCoverageOutput(raw, 'coverage-output.<ext>', '/');
//     expect(result).not.toBeNull();
//     expect(result!.linePercent).toBeGreaterThan(0);
//   });
// });
//
// describe('parseJavaDepVulnsOutput', () => {
//   it('extracts findings from the real tool output', () => {
//     const raw = readFixture('depvulns-output.json');
//     const { findings } = parseJavaDepVulnsOutput(raw);
//     expect(findings.length).toBeGreaterThan(0);
//   });
// });
//
// describe('extractJavaImportsRaw', () => {
//   it('extracts simple imports from source text', () => {
//     // const src = '<sample source>';
//     // expect(extractJavaImportsRaw(src)).toEqual([...]);
//   });
// });
