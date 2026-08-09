import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { abap, parseAbaplintJson } from '../src/languages/abap';

/**
 * ABAP pack (4.4.0 / P1-5). One adopted tool — abaplint — fills both the
 * lint gate and the syntax floor (docs/decisions/abap-tooling.md), so the
 * parser surface is exactly ONE function, tested against REAL harvested
 * bytes (test/fixtures/raw/abap/ — the C# raw-bytes discipline: the
 * fixture is actual `abaplint -f json` output from the pinned 2.120.19
 * over a truncated class, path-prefix neutralized only).
 */

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'raw', 'abap');
function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf-8');
}

describe('abap pack — metadata', () => {
  it('declares its id and displayName', () => {
    expect(abap.id).toBe('abap');
    expect(abap.displayName).toBe('ABAP');
  });

  it('adopts abaplint as its ONE registered tool (the decision record)', () => {
    expect(abap.tools).toEqual(['abaplint']);
    expect(abap.cliBinaries).toEqual(['abaplint']);
  });

  it('deliberately declines depVulns/coverage capabilities (no offline ecosystem exists)', () => {
    expect(abap.capabilities?.depVulns).toBeUndefined();
    expect(abap.capabilities?.coverage).toBeUndefined();
  });

  it('the floor permanently declines test execution (needs a live SAP system)', () => {
    expect(
      abap.correctness.affectedTests({ cwd: '/x', changedFiles: [], scope: 'full' }),
    ).toBeNull();
  });
});

describe('parseAbaplintJson (real harvested bytes)', () => {
  const raw = () => readFixture('abaplint-findings.json');

  it('maps the pinned 2.120.19 output shape: file, 1-based row, rule key, message', () => {
    const findings = parseAbaplintJson(raw());
    expect(findings.length).toBeGreaterThanOrEqual(2);
    const keys = findings.map((f) => f.rule);
    expect(keys).toContain('structure');
    expect(keys).toContain('parser_error');
    const structure = findings.find((f) => f.rule === 'structure')!;
    // Absolute path preserved HERE — relativization is the seam
    // boundary's job (validateLocated → toRepoRelativePosix), never the
    // parser's.
    expect(structure.file).toBe('/home/ci/work/repo/src/zcl_trunc.clas.abap');
    expect(structure.line).toBe(1);
    expect(structure.message).toContain('Expected ENDMETHOD');
  });

  it('is TOTAL: garbage in, [] out — never a throw', () => {
    expect(parseAbaplintJson('')).toEqual([]);
    expect(parseAbaplintJson('not-json')).toEqual([]);
    expect(parseAbaplintJson('{"an":"object"}')).toEqual([]);
    expect(parseAbaplintJson('[{"no":"file"}]')).toEqual([]);
    expect(parseAbaplintJson('[null, 1, "x"]')).toEqual([]);
  });

  it('extracts the array from combined-stream noise (banner text around the JSON)', () => {
    const noisy = `abaplint 2.120.19\n${raw()}\ntrailing note\n`;
    const findings = parseAbaplintJson(noisy);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });
});
