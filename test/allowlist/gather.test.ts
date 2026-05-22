import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gatherInlineAllowlistAnnotations } from '../../src/allowlist/gather';
import { clearWalkCache } from '../../src/analyzers/tools/walk-source-files';

function makeTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-gather-allowlist-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function write(dir: string, rel: string, content: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
}

describe('gatherInlineAllowlistAnnotations', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
    // walkSourceFiles is memoized — clear between tests so files
    // written in this test aren't shadowed by a stale cache from
    // a prior test's tmp dir.
    clearWalkCache();
  });
  afterEach(() => {
    rmrf(tmp);
    clearWalkCache();
  });

  it('returns empty array for repo with no source files', () => {
    expect(gatherInlineAllowlistAnnotations(tmp)).toEqual([]);
  });

  it('finds same-line annotation in python', () => {
    write(tmp, 'src/a.py', 'api_key = "x"  # dxkit-allow:test-fixture reason="fix"\n');
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      file: 'src/a.py',
      line: 1,
      category: 'test-fixture',
      position: 'same-line',
    });
  });

  it('finds above-line annotation in typescript', () => {
    write(tmp, 'src/a.ts', '// dxkit-allow:false-positive reason="regex"\nconst x = "y";\n');
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      file: 'src/a.ts',
      line: 1,
      category: 'false-positive',
      position: 'above',
    });
  });

  it('finds multiple annotations in one file', () => {
    write(
      tmp,
      'src/a.py',
      [
        '# dxkit-allow:test-fixture reason="r1"',
        'x = 1',
        'api = "abc"  # dxkit-allow:false-positive reason="r2"',
      ].join('\n'),
    );
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toHaveLength(2);
    expect(out[0].position).toBe('above');
    expect(out[1].position).toBe('same-line');
  });

  it('finds annotations across multiple files in deterministic order', () => {
    write(tmp, 'src/z.py', '# dxkit-allow:test-fixture reason="z"\nx = 1\n');
    write(tmp, 'src/a.py', '# dxkit-allow:test-fixture reason="a"\nx = 1\n');
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toHaveLength(2);
    // walkSourceFiles sorts paths, so 'src/a.py' precedes 'src/z.py'
    expect(out[0].file).toBe('src/a.py');
    expect(out[1].file).toBe('src/z.py');
  });

  it('walks test files by default', () => {
    write(
      tmp,
      'src/__test__/example.test.py',
      'x = "secret"  # dxkit-allow:test-fixture reason="placeholder"\n',
    );
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out.some((o) => o.file.endsWith('example.test.py'))).toBe(true);
  });

  it('skips files without dxkit-allow: substring (fast path)', () => {
    write(tmp, 'src/no-annotation.py', 'x = 1\ny = 2\nz = 3\n');
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toEqual([]);
  });

  it('ignores files with unknown extension (no language pack)', () => {
    write(tmp, 'src/data.xyz', '# dxkit-allow:test-fixture reason="r"\n');
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toEqual([]);
  });

  it('detects annotations across all 8 language packs that have commentSyntax', () => {
    // One annotation per language, mirroring the cross-language
    // matrix from inline.test.ts.
    write(tmp, 'a.py', '# dxkit-allow:test-fixture reason="r"\nx = 1\n');
    write(tmp, 'a.ts', '// dxkit-allow:test-fixture reason="r"\nconst x = 1;\n');
    write(tmp, 'a.go', '// dxkit-allow:test-fixture reason="r"\nvar x = 1\n');
    write(tmp, 'a.rs', '// dxkit-allow:test-fixture reason="r"\nlet x = 1;\n');
    write(tmp, 'a.cs', '// dxkit-allow:test-fixture reason="r"\nvar x = 1;\n');
    write(tmp, 'a.java', '// dxkit-allow:test-fixture reason="r"\nint x = 1;\n');
    write(tmp, 'a.kt', '// dxkit-allow:test-fixture reason="r"\nval x = 1\n');
    write(tmp, 'a.rb', '# dxkit-allow:test-fixture reason="r"\nx = 1\n');

    const out = gatherInlineAllowlistAnnotations(tmp);
    const filesFound = new Set(out.map((o) => o.file));
    expect(filesFound.size).toBe(8);
  });

  it('skips unknown category gracefully (parser returns null)', () => {
    write(tmp, 'src/a.py', '# dxkit-allow:not-a-real-category reason="r"\nx = 1\n');
    const out = gatherInlineAllowlistAnnotations(tmp);
    expect(out).toEqual([]);
  });
});
