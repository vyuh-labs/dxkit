/**
 * G_v4_7 (2.4.7): unit tests for the canonical source-file walker +
 * line-match counter. Builds a synthetic fixture tree with the same
 * intentional traps that surfaced on dpl-studio / platform / web-client
 * (autogen basename glob, autogen header marker, multi-segment ignore
 * path, test files, minified-style content) and verifies each filter
 * step in the pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  walkSourceFiles,
  countLineMatches,
  clearWalkCache,
} from '../src/analyzers/tools/walk-source-files';
import { clearExclusionsCache } from '../src/analyzers/tools/exclusions';

let tmp: string;

function write(rel: string, content = ''): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-walk-'));
  clearExclusionsCache();
  clearWalkCache();
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  clearExclusionsCache();
  clearWalkCache();
});

describe('walkSourceFiles — basic enumeration', () => {
  it('returns nothing on an empty tree', () => {
    expect(walkSourceFiles(tmp)).toEqual([]);
  });

  it('returns nothing for a non-existent root', () => {
    expect(walkSourceFiles(path.join(tmp, 'nope'))).toEqual([]);
  });

  it('walks recursive directories and finds source files', () => {
    write('src/a.ts', 'export const a = 1;');
    write('src/nested/b.ts', 'export const b = 2;');
    write('lib/c.py', 'pass');
    const out = walkSourceFiles(tmp);
    expect(out).toEqual(['lib/c.py', 'src/a.ts', 'src/nested/b.ts']);
  });

  it('returns sorted relative POSIX paths with no leading "./"', () => {
    write('z.ts');
    write('a.ts');
    write('m/q.ts');
    const out = walkSourceFiles(tmp);
    expect(out).toEqual(['a.ts', 'm/q.ts', 'z.ts']);
    expect(out.every((p) => !p.startsWith('./'))).toBe(true);
  });
});

describe('walkSourceFiles — extension filter', () => {
  it('defaults to the union of registry extensions', () => {
    write('a.ts');
    write('a.py');
    write('a.go');
    write('a.rs');
    write('a.cs');
    write('a.kt');
    write('a.java');
    write('a.rb');
    write('a.txt'); // not a source extension
    write('a.md'); // not a source extension
    const out = walkSourceFiles(tmp);
    expect(out).toContain('a.ts');
    expect(out).toContain('a.py');
    expect(out).toContain('a.go');
    expect(out).toContain('a.rs');
    expect(out).toContain('a.cs');
    expect(out).toContain('a.kt');
    expect(out).toContain('a.java');
    expect(out).toContain('a.rb');
    expect(out).not.toContain('a.txt');
    expect(out).not.toContain('a.md');
  });

  it('honours explicit `extensions` opt', () => {
    write('a.ts');
    write('a.py');
    write('a.go');
    const out = walkSourceFiles(tmp, { extensions: ['.ts'] });
    expect(out).toEqual(['a.ts']);
  });

  it('accepts extensions with or without leading dot', () => {
    write('a.ts');
    write('a.js');
    const out = walkSourceFiles(tmp, { extensions: ['ts'] });
    expect(out).toEqual(['a.ts']);
  });

  it('scopes to packId.sourceExtensions when packId given without extensions', () => {
    write('a.ts');
    write('a.tsx');
    write('a.py');
    write('a.go');
    const out = walkSourceFiles(tmp, { packId: 'typescript' });
    expect(out).toContain('a.ts');
    expect(out).toContain('a.tsx');
    expect(out).not.toContain('a.py');
    expect(out).not.toContain('a.go');
  });
});

describe('walkSourceFiles — exclusion (.gitignore + .dxkit-ignore + defaults)', () => {
  it('skips bundled-default dirs (node_modules, dist)', () => {
    write('src/a.ts');
    write('node_modules/dep/x.ts');
    write('dist/build.ts');
    const out = walkSourceFiles(tmp);
    expect(out).toEqual(['src/a.ts']);
  });

  it('honours project .gitignore single-segment dir', () => {
    write('.gitignore', 'build/\n');
    write('src/a.ts');
    write('build/gen.ts');
    const out = walkSourceFiles(tmp);
    expect(out).toEqual(['src/a.ts']);
  });

  it('honours .dxkit-ignore multi-segment path', () => {
    write('.dxkit-ignore', 'Dev/Addons/SAPB1/\n');
    write('src/a.ts');
    write('Dev/Addons/SAPB1/wrapped.ts');
    write('Dev/Other/keep.ts');
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/a.ts');
    expect(out).toContain('Dev/Other/keep.ts');
    expect(out).not.toContain('Dev/Addons/SAPB1/wrapped.ts');
  });

  it('honours file-pattern globs from .gitignore (e.g. *.min.js)', () => {
    write('.gitignore', '*.min.js\n');
    write('src/a.js');
    write('public/vendor.min.js');
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/a.js');
    expect(out).not.toContain('public/vendor.min.js');
  });

  it('respectIgnore: false bypasses every exclusion layer', () => {
    write('node_modules/dep/x.ts');
    write('src/a.ts');
    const out = walkSourceFiles(tmp, { respectIgnore: false });
    expect(out).toContain('node_modules/dep/x.ts');
    expect(out).toContain('src/a.ts');
  });

  it('skips dot-directories unconditionally (.git, .vscode, .dxkit…)', () => {
    write('.git/HEAD');
    write('.vscode/settings.json');
    write('.dxkit/config.yml');
    write('src/a.ts');
    const out = walkSourceFiles(tmp);
    expect(out).toEqual(['src/a.ts']);
  });
});

describe('walkSourceFiles — autogen filtering', () => {
  it('skips files matching autogen basename glob (*.designer.cs)', () => {
    write('src/Form.designer.cs');
    write('src/Form.cs', 'class Form {}');
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/Form.cs');
    expect(out).not.toContain('src/Form.designer.cs');
  });

  it('skips files with auto-generated header marker', () => {
    write('src/handwritten.ts', 'export const a = 1;\n');
    write(
      'src/sapwrapper.cs',
      '// <auto-generated>\n//   This code was generated by a tool.\n// </auto-generated>\nclass X {}',
    );
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/handwritten.ts');
    expect(out).not.toContain('src/sapwrapper.cs');
  });

  it('skips files with `@generated` marker (Facebook convention)', () => {
    write('src/normal.ts', 'export const a = 1;');
    write('src/gen.ts', '// @generated SignedSource<<deadbeef>>\nexport const x = 2;');
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/normal.ts');
    expect(out).not.toContain('src/gen.ts');
  });

  it('skips Go protobuf-style `Code generated by` marker', () => {
    write('proto/normal.go', 'package proto');
    write(
      'proto/gen.go',
      '// Code generated by protoc-gen-go. DO NOT EDIT.\n// source: api.proto\npackage proto',
    );
    const out = walkSourceFiles(tmp);
    expect(out).toContain('proto/normal.go');
    expect(out).not.toContain('proto/gen.go');
  });

  it('includeAutogen: true bypasses both basename + header filters', () => {
    write('src/Form.designer.cs', 'class X {}');
    write('src/gen.ts', '// @generated\nexport const x = 1;');
    write('src/normal.ts', 'export const y = 2;');
    const out = walkSourceFiles(tmp, { includeAutogen: true });
    expect(out).toContain('src/Form.designer.cs');
    expect(out).toContain('src/gen.ts');
    expect(out).toContain('src/normal.ts');
  });
});

describe('walkSourceFiles — test-file filter', () => {
  it('skips basename-style test files by default (*.test.ts)', () => {
    write('src/a.ts');
    write('src/a.test.ts');
    write('src/b.spec.ts');
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('src/a.test.ts');
    expect(out).not.toContain('src/b.spec.ts');
  });

  it('skips path-anchored test patterns (tests/*.rs)', () => {
    write('src/main.rs');
    write('tests/integration.rs');
    const out = walkSourceFiles(tmp);
    expect(out).toContain('src/main.rs');
    expect(out).not.toContain('tests/integration.rs');
  });

  it('includeTests: true returns test files too', () => {
    write('src/a.ts');
    write('src/a.test.ts');
    write('tests/b.rs');
    const out = walkSourceFiles(tmp, { includeTests: true });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('src/a.test.ts');
    expect(out).toContain('tests/b.rs');
  });
});

describe('walkSourceFiles — memoization', () => {
  it('returns same array reference on repeated identical calls', () => {
    write('src/a.ts');
    const a = walkSourceFiles(tmp);
    const b = walkSourceFiles(tmp);
    expect(a).toBe(b);
  });

  it('distinct cache entries for different opts', () => {
    write('src/a.ts');
    write('src/a.test.ts');
    const noTests = walkSourceFiles(tmp);
    const withTests = walkSourceFiles(tmp, { includeTests: true });
    expect(noTests).not.toBe(withTests);
    expect(noTests).toEqual(['src/a.ts']);
    expect(withTests).toEqual(['src/a.test.ts', 'src/a.ts']);
  });

  it('clearWalkCache() forces re-walk', () => {
    write('src/a.ts');
    const first = walkSourceFiles(tmp);
    write('src/b.ts');
    const second = walkSourceFiles(tmp); // cached → stale
    expect(second).toEqual(first);
    clearWalkCache();
    const third = walkSourceFiles(tmp);
    expect(third).toContain('src/b.ts');
  });
});

describe('countLineMatches — basic counting', () => {
  it('returns 0 / 0 on empty input', () => {
    const r = countLineMatches(tmp, [], ['anything']);
    expect(r).toEqual({ lines: 0, files: 0, perFile: [] });
  });

  it('returns 0 / 0 when no patterns match', () => {
    write('src/a.ts', 'export const a = 1;\nexport const b = 2;\n');
    const files = walkSourceFiles(tmp);
    const r = countLineMatches(tmp, files, ['nonsense\\b']);
    expect(r.lines).toBe(0);
    expect(r.files).toBe(0);
  });

  it('counts matches in `lines` mode (default)', () => {
    write('src/a.ts', 'console.log(1);\nconsole.log(2);\nconsole.log(3);\nconst x = 1;\n'); // slop-ok
    write('src/b.ts', 'console.log(only);\nconst y = 2;\n'); // slop-ok
    const files = walkSourceFiles(tmp);
    const r = countLineMatches(tmp, files, ['console\\.(log|error|warn)']);
    expect(r.lines).toBe(4);
    expect(r.files).toBe(2);
  });

  it('counts files in `files` mode (one per file regardless of #matches)', () => {
    write('src/a.ts', 'console.log(1);\nconsole.log(2);\n'); // slop-ok
    write('src/b.ts', 'console.log(only);\n'); // slop-ok
    write('src/c.ts', 'const z = 1;\n');
    const files = walkSourceFiles(tmp);
    const r = countLineMatches(tmp, files, ['console\\.(log|error|warn)'], {
      mode: 'files',
    });
    expect(r.lines).toBe(2); // mode=files → `lines` field carries file count
    expect(r.files).toBe(2);
  });

  it('returns top-N offenders when perFileTopN > 0', () => {
    write('src/a.ts', 'console.log(1);\nconsole.log(2);\nconsole.log(3);\n'); // slop-ok
    write('src/b.ts', 'console.log(only);\n'); // slop-ok
    write('src/c.ts', 'const z = 1;\n');
    const files = walkSourceFiles(tmp);
    const r = countLineMatches(tmp, files, ['console\\.'], { perFileTopN: 5 });
    expect(r.perFile).toEqual([
      { file: 'src/a.ts', count: 3 },
      { file: 'src/b.ts', count: 1 },
    ]);
  });

  it('accepts pre-compiled RegExp instances', () => {
    write('src/a.ts', 'eval(x);\neval(y);\n');
    const files = walkSourceFiles(tmp);
    const r = countLineMatches(tmp, files, [/\beval\(/]);
    expect(r.lines).toBe(2);
  });
});

describe('countLineMatches — skipComments (D074 closure)', () => {
  it('skips `//` and `/*` lines for .ts files', () => {
    write(
      'src/a.ts',
      [
        'console.log(active);', // slop-ok
        '// console.log(commented);', // slop-ok
        '/* console.log(block); */', // slop-ok
        ' * console.log(jsdoc);', // slop-ok
        'console.log(active2);', // slop-ok
      ].join('\n'),
    );
    const files = walkSourceFiles(tmp);
    const without = countLineMatches(tmp, files, ['console\\.log']);
    const withFilter = countLineMatches(tmp, files, ['console\\.log'], {
      skipComments: true,
    });
    expect(without.lines).toBe(5);
    expect(withFilter.lines).toBe(2);
  });

  it('skips `#` lines for .py files', () => {
    write(
      'src/a.py',
      ['print(active)', '# print(commented)', '  # print(indented_comment)', 'print(active2)'].join(
        '\n',
      ),
    );
    const files = walkSourceFiles(tmp);
    const withFilter = countLineMatches(tmp, files, ['\\bprint\\('], {
      skipComments: true,
    });
    expect(withFilter.lines).toBe(2);
  });

  it('uses the right syntax per file even in one walk', () => {
    write('src/a.ts', '// console.log(x);\nconsole.log(y);\n'); // slop-ok
    write('src/a.py', '# print(x)\nprint(y)\n');
    const files = walkSourceFiles(tmp);
    const r = countLineMatches(tmp, files, ['console\\.log', '\\bprint\\('], {
      skipComments: true,
    });
    expect(r.lines).toBe(2);
  });

  it('falls through (no filter) for unknown extensions', () => {
    // .xyz isn't a known source ext anyway — to test, force it via extensions opt
    write('src/a.xyz', '// match line\nmatch line 2\n');
    const out = walkSourceFiles(tmp, { extensions: ['.xyz'] });
    const r = countLineMatches(tmp, out, ['match'], { skipComments: true });
    // `none` comment syntax → both lines counted
    expect(r.lines).toBe(2);
  });
});

describe('integration — walker + counter pipeline (D082/D083 simulation)', () => {
  it('curated walk + in-process count never touches excluded files', () => {
    // Simulate the web-client failure mode: large minified `.min.js`
    // content that would have blown grep's maxBuffer. The walker
    // excludes it by file-pattern, the counter never reads it.
    write('.gitignore', '*.min.js\n');
    write('src/app.js', 'console.log(real);\n'); // slop-ok
    // Create a "minified" file far larger than what grep -r could
    // produce as stdout. The walker MUST prune it.
    const minified = 'a'.repeat(100_000) + ';console.log(noise);\n'; // slop-ok
    write('public/vendor.min.js', minified);
    const files = walkSourceFiles(tmp);
    expect(files).toEqual(['src/app.js']);
    const r = countLineMatches(tmp, files, ['console\\.log']);
    expect(r.lines).toBe(1);
  });
});
