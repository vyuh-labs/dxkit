import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  findAnnotationAt,
  insertAnnotation,
  parseAnnotation,
  renderAnnotation,
  type InlineAnnotation,
} from '../../src/allowlist/inline';
import { LANGUAGES, getLanguage } from '../../src/languages';
import type { LanguageId, LanguageSupport } from '../../src/languages';

function makeTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-inline-'));
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

const python: LanguageSupport = getLanguage('python')!;
const typescript: LanguageSupport = getLanguage('typescript')!;
const ruby: LanguageSupport = getLanguage('ruby')!;

describe('parseAnnotation', () => {
  it('parses python-style annotation with reason', () => {
    const a = parseAnnotation('# dxkit-allow:test-fixture reason="placeholder"', python);
    expect(a).toEqual({ category: 'test-fixture', reason: 'placeholder' });
  });

  it('parses typescript-style annotation with reason', () => {
    const a = parseAnnotation('// dxkit-allow:false-positive reason="regex match"', typescript);
    expect(a).toEqual({ category: 'false-positive', reason: 'regex match' });
  });

  it('parses same-line annotation appended to source', () => {
    const a = parseAnnotation(
      'api_key = "sk_test"  # dxkit-allow:test-fixture reason="fixture"',
      python,
    );
    expect(a).toEqual({ category: 'test-fixture', reason: 'fixture' });
  });

  it('parses annotation without reason', () => {
    const a = parseAnnotation('# dxkit-allow:test-fixture', python);
    expect(a).toEqual({ category: 'test-fixture', reason: undefined });
  });

  it('returns null for line without comment marker', () => {
    expect(parseAnnotation('api_key = "sk_test"', python)).toBeNull();
  });

  it('returns null for comment without dxkit-allow prefix', () => {
    expect(parseAnnotation('# just a regular comment', python)).toBeNull();
  });

  it('returns null for unknown category', () => {
    expect(parseAnnotation('# dxkit-allow:invented-category reason="x"', python)).toBeNull();
  });

  it('unescapes embedded double-quote in reason', () => {
    const a = parseAnnotation('# dxkit-allow:test-fixture reason="he said \\"hi\\""', python);
    expect(a?.reason).toBe('he said "hi"');
  });

  it('unescapes embedded backslash in reason', () => {
    const a = parseAnnotation('# dxkit-allow:test-fixture reason="path\\\\to\\\\foo"', python);
    expect(a?.reason).toBe('path\\to\\foo');
  });

  it('parses with extra whitespace between marker and prefix', () => {
    const a = parseAnnotation('#   dxkit-allow:test-fixture reason="x"', python);
    expect(a?.category).toBe('test-fixture');
  });

  it('accepts ruby # marker', () => {
    const a = parseAnnotation('# dxkit-allow:mitigated-externally reason="WAF"', ruby);
    expect(a?.category).toBe('mitigated-externally');
  });

  it('accepts each inline-compatible category', () => {
    for (const cat of ['false-positive', 'test-fixture', 'mitigated-externally'] as const) {
      const a = parseAnnotation(`# dxkit-allow:${cat} reason="x"`, python);
      expect(a?.category).toBe(cat);
    }
  });

  it('parses accepted-risk + deferred too (caller decides applicability)', () => {
    // parser does NOT enforce inline-compatibility — it accepts any
    // canonical category. The CALLER (CLI) decides whether to honor
    // it or reject as file-only.
    expect(parseAnnotation('# dxkit-allow:accepted-risk reason="x"', python)?.category).toBe(
      'accepted-risk',
    );
    expect(parseAnnotation('# dxkit-allow:deferred reason="x"', python)?.category).toBe('deferred');
  });

  it('returns null when language has no commentSyntax', () => {
    const bareLang = { id: 'fake' as LanguageId, commentSyntax: undefined } as LanguageSupport;
    expect(parseAnnotation('# dxkit-allow:test-fixture', bareLang)).toBeNull();
  });
});

describe('renderAnnotation', () => {
  it('renders python annotation with hash marker', () => {
    const a: InlineAnnotation = { category: 'test-fixture', reason: 'placeholder' };
    expect(renderAnnotation(a, python)).toBe('# dxkit-allow:test-fixture reason="placeholder"');
  });

  it('renders typescript annotation with slash marker', () => {
    const a: InlineAnnotation = { category: 'false-positive', reason: 'regex match' };
    expect(renderAnnotation(a, typescript)).toBe(
      '// dxkit-allow:false-positive reason="regex match"',
    );
  });

  it('renders without reason when reason undefined', () => {
    const a: InlineAnnotation = { category: 'test-fixture' };
    expect(renderAnnotation(a, python)).toBe('# dxkit-allow:test-fixture');
  });

  it('escapes embedded double-quote in reason', () => {
    const a: InlineAnnotation = { category: 'test-fixture', reason: 'he said "hi"' };
    expect(renderAnnotation(a, python)).toBe(
      '# dxkit-allow:test-fixture reason="he said \\"hi\\""',
    );
  });

  it('renders round-trip: render → parse yields original', () => {
    const a: InlineAnnotation = { category: 'mitigated-externally', reason: 'WAF rule X' };
    const rendered = renderAnnotation(a, python);
    expect(parseAnnotation(rendered, python)).toEqual(a);
  });
});

describe('findAnnotationAt', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  function write(name: string, content: string): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  it('finds same-line annotation', () => {
    const file = write('a.py', 'api_key = "sk_test"  # dxkit-allow:test-fixture reason="x"\n');
    const m = findAnnotationAt(file, 1, python);
    expect(m).toMatchObject({
      annotation: { category: 'test-fixture', reason: 'x' },
      position: 'same-line',
      annotationLine: 1,
    });
  });

  it('finds above-line annotation', () => {
    const file = write('a.py', '# dxkit-allow:test-fixture reason="x"\napi_key = "sk_test"\n');
    const m = findAnnotationAt(file, 2, python);
    expect(m).toMatchObject({
      annotation: { category: 'test-fixture', reason: 'x' },
      position: 'above',
      annotationLine: 1,
    });
  });

  it('returns null when neither position has annotation', () => {
    const file = write('a.py', '# just a comment\napi_key = "sk_test"\n');
    expect(findAnnotationAt(file, 2, python)).toBeNull();
  });

  it('returns null when above-line is NOT a standalone annotation', () => {
    // Above line has code + comment but no annotation prefix
    const file = write('a.py', 'x = 1  # regular comment\napi_key = "sk_test"\n');
    expect(findAnnotationAt(file, 2, python)).toBeNull();
  });

  it('does not pick up annotation two lines above (immediate-prev only)', () => {
    const file = write('a.py', '# dxkit-allow:test-fixture reason="x"\n\napi_key = "sk_test"\n');
    expect(findAnnotationAt(file, 3, python)).toBeNull();
  });

  it('throws on lineNumber < 1', () => {
    const file = write('a.py', 'x\n');
    expect(() => findAnnotationAt(file, 0, python)).toThrow(/lineNumber/);
  });

  it('throws on lineNumber past EOF', () => {
    const file = write('a.py', 'x\n');
    expect(() => findAnnotationAt(file, 99, python)).toThrow(/exceeds file length/);
  });

  it('handles file without trailing newline', () => {
    const file = write('a.py', 'api_key = "x"  # dxkit-allow:test-fixture reason="y"');
    const m = findAnnotationAt(file, 1, python);
    expect(m?.position).toBe('same-line');
  });
});

describe('insertAnnotation', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  function write(name: string, content: string): string {
    const p = path.join(tmp, name);
    fs.writeFileSync(p, content, 'utf8');
    return p;
  }

  it('appends same-line for short target line', () => {
    const file = write('a.py', 'x = "y"\n');
    const r = insertAnnotation(file, 1, { category: 'test-fixture', reason: 'fix' }, python);
    expect(r.position).toBe('same-line');
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toBe('x = "y"  # dxkit-allow:test-fixture reason="fix"\n');
  });

  it('inserts above for long target line', () => {
    const longLine = 'x = "' + 'a'.repeat(100) + '"';
    const file = write('a.py', longLine + '\n');
    const r = insertAnnotation(file, 1, { category: 'test-fixture', reason: 'fix' }, python);
    expect(r.position).toBe('above');
    const after = fs.readFileSync(file, 'utf8');
    expect(after.split('\n')[0]).toBe('# dxkit-allow:test-fixture reason="fix"');
    expect(after.split('\n')[1]).toBe(longLine);
  });

  it('preserves indentation when inserting above', () => {
    const longLine = '    x = "' + 'a'.repeat(100) + '"';
    const file = write('a.py', longLine + '\n');
    insertAnnotation(file, 1, { category: 'test-fixture', reason: 'fix' }, python);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.split('\n')[0]).toBe('    # dxkit-allow:test-fixture reason="fix"');
  });

  it('preserves indentation with tab-based source', () => {
    const longLine = '\t\tx = "' + 'a'.repeat(100) + '"';
    const file = write('a.go', longLine + '\n');
    insertAnnotation(file, 1, { category: 'test-fixture', reason: 'fix' }, getLanguage('go')!);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.split('\n')[0]).toBe('\t\t// dxkit-allow:test-fixture reason="fix"');
  });

  it('preserves file without trailing newline', () => {
    const file = write('a.py', 'x = "y"');
    insertAnnotation(file, 1, { category: 'test-fixture', reason: 'x' }, python);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.endsWith('\n')).toBe(false);
  });

  it('preserves trailing newline', () => {
    const file = write('a.py', 'x = "y"\n');
    insertAnnotation(file, 1, { category: 'test-fixture', reason: 'x' }, python);
    const after = fs.readFileSync(file, 'utf8');
    expect(after.endsWith('\n')).toBe(true);
  });

  it('preserves CRLF line endings', () => {
    const file = write('a.ts', 'const x = "y";\r\nconst z = 1;\r\n');
    insertAnnotation(file, 1, { category: 'test-fixture', reason: 'x' }, typescript);
    const after = fs.readFileSync(file, 'utf8');
    expect(after).toContain('\r\n');
    expect(after.split('\r\n')[0]).toBe('const x = "y";  // dxkit-allow:test-fixture reason="x"');
  });

  it('rejects accepted-risk category', () => {
    const file = write('a.py', 'x\n');
    expect(() =>
      insertAnnotation(file, 1, { category: 'accepted-risk', reason: 'x' }, python),
    ).toThrow(/file-only/);
  });

  it('rejects deferred category', () => {
    const file = write('a.py', 'x\n');
    expect(() => insertAnnotation(file, 1, { category: 'deferred', reason: 'x' }, python)).toThrow(
      /file-only/,
    );
  });

  it('round-trips: insert → find returns the same annotation', () => {
    const file = write('a.py', 'x = "y"\n');
    const inserted: InlineAnnotation = { category: 'test-fixture', reason: 'r' };
    insertAnnotation(file, 1, inserted, python);
    const found = findAnnotationAt(file, 1, python);
    expect(found?.annotation).toEqual(inserted);
  });

  it('round-trips with embedded quote in reason', () => {
    const file = write('a.py', 'x = "y"\n');
    const inserted: InlineAnnotation = { category: 'test-fixture', reason: 'he said "hi"' };
    insertAnnotation(file, 1, inserted, python);
    const found = findAnnotationAt(file, 1, python);
    expect(found?.annotation.reason).toBe('he said "hi"');
  });

  it('configurable threshold takes effect', () => {
    const file = write('a.py', 'x = "y"\n');
    // Force above-line by setting threshold to 0
    const r = insertAnnotation(file, 1, { category: 'test-fixture', reason: 'x' }, python, {
      sameLineThreshold: 0,
    });
    expect(r.position).toBe('above');
  });

  it('throws on lineNumber < 1', () => {
    const file = write('a.py', 'x\n');
    expect(() =>
      insertAnnotation(file, 0, { category: 'test-fixture', reason: 'x' }, python),
    ).toThrow(/lineNumber/);
  });

  it('throws on lineNumber past EOF', () => {
    const file = write('a.py', 'x\n');
    expect(() =>
      insertAnnotation(file, 99, { category: 'test-fixture', reason: 'x' }, python),
    ).toThrow(/exceeds file length/);
  });
});

describe('cross-language matrix', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    rmrf(tmp);
  });

  // Every shipped pack should support full round-trip of an inline
  // annotation through its own commentSyntax. Catches the case where
  // we added a pack but forgot to populate commentSyntax (the
  // contract test catches this too, but exercising it through real
  // insert+parse is the integration-level guarantee).
  for (const lang of LANGUAGES) {
    it(`${lang.id}: insert + find round-trip`, () => {
      const ext = lang.sourceExtensions[0];
      const file = path.join(tmp, `a${ext}`);
      fs.writeFileSync(file, 'x = 1\n', 'utf8');
      const annotation: InlineAnnotation = {
        category: 'test-fixture',
        reason: `pack-${lang.id}-fixture`,
      };
      insertAnnotation(file, 1, annotation, lang);
      const found = findAnnotationAt(file, 1, lang);
      expect(found, `${lang.id}: round-trip failed`).not.toBeNull();
      expect(found!.annotation).toEqual(annotation);
    });
  }
});
