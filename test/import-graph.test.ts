import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildReachable,
  extractImports,
  extractTsJsImports,
  extractPyImports,
  resolveImport,
} from '../src/analyzers/tests/import-graph';

describe('extractTsJsImports', () => {
  it('captures static imports with "from"', () => {
    const src = `import X from './foo';\nimport { Y } from "./bar";`;
    expect(extractTsJsImports(src)).toEqual(['./foo', './bar']);
  });

  it('captures side-effect imports (import "x")', () => {
    expect(extractTsJsImports(`import "./setup";`)).toEqual(['./setup']);
  });

  it('captures multi-line imports', () => {
    const src = `
      import {
        a,
        b,
        c,
      } from '../lib/thing';
    `;
    expect(extractTsJsImports(src)).toEqual(['../lib/thing']);
  });

  it('captures dynamic imports and require()', () => {
    const src = `
      const m = await import('./dyn');
      const r = require('./common');
    `;
    expect(extractTsJsImports(src).sort()).toEqual(['./common', './dyn']);
  });

  it('ignores imports inside block comments', () => {
    const src = `
      /* import X from './commented'; */
      import Y from './real';
    `;
    expect(extractTsJsImports(src)).toEqual(['./real']);
  });

  it('ignores imports inside line comments', () => {
    const src = `// import X from './commented';\nimport Y from './real';`;
    expect(extractTsJsImports(src)).toEqual(['./real']);
  });
});

describe('extractPyImports', () => {
  it('captures "from X import Y"', () => {
    expect(extractPyImports('from src.foo import bar\nfrom .rel import baz')).toEqual([
      'src.foo',
      '.rel',
    ]);
  });

  it('captures "import X" and aliases', () => {
    expect(extractPyImports('import os\nimport numpy as np')).toEqual(['os', 'numpy']);
  });

  it('splits comma-separated imports', () => {
    expect(extractPyImports('import a, b, c')).toEqual(['a', 'b', 'c']);
  });

  it('ignores comments', () => {
    expect(extractPyImports('# import fake\nimport real')).toEqual(['real']);
  });
});

describe('resolveImport (filesystem)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ig-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves relative TS import with extension appended', () => {
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.writeFileSync(path.join(tmp, 'src/foo.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), "import x from './foo';");
    expect(resolveImport('src/a.ts', './foo', tmp)).toBe('src/foo.ts');
  });

  it('resolves directory import as index.ts', () => {
    fs.mkdirSync(path.join(tmp, 'src/lib'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src/lib/index.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), '');
    expect(resolveImport('src/a.ts', './lib', tmp)).toBe('src/lib/index.ts');
  });

  it('returns null for external packages', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    expect(resolveImport('a.ts', 'lodash', tmp)).toBeNull();
    expect(resolveImport('a.ts', '@scope/pkg', tmp)).toBeNull();
  });

  it('handles parent-relative paths', () => {
    fs.mkdirSync(path.join(tmp, 'src/inner'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src/root.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src/inner/a.ts'), '');
    expect(resolveImport('src/inner/a.ts', '../root', tmp)).toBe('src/root.ts');
  });

  it('resolves Python relative imports', () => {
    fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pkg/__init__.py'), '');
    fs.writeFileSync(path.join(tmp, 'pkg/helper.py'), '');
    fs.writeFileSync(path.join(tmp, 'pkg/test_a.py'), '');
    expect(resolveImport('pkg/test_a.py', '.helper', tmp)).toBe('pkg/helper.py');
  });

  it('resolves Python package.module imports from cwd', () => {
    fs.mkdirSync(path.join(tmp, 'pkg/sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pkg/sub/foo.py'), '');
    fs.writeFileSync(path.join(tmp, 'a.py'), '');
    expect(resolveImport('a.py', 'pkg.sub.foo', tmp)).toBe('pkg/sub/foo.py');
  });

  it('resolves Python package via __init__.py', () => {
    fs.mkdirSync(path.join(tmp, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'pkg/__init__.py'), '');
    fs.writeFileSync(path.join(tmp, 'a.py'), '');
    expect(resolveImport('a.py', 'pkg', tmp)).toBe('pkg/__init__.py');
  });
});

describe('extractImports (dispatch)', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ig2-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns [] for files that cannot be read', () => {
    expect(extractImports('does-not-exist.ts', tmp)).toEqual([]);
  });

  it('picks python extractor for .py files', () => {
    fs.writeFileSync(path.join(tmp, 'a.py'), 'from pkg import x');
    expect(extractImports('a.py', tmp)).toEqual(['pkg']);
  });

  it('picks ts/js extractor for .ts files', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), "import X from './b';");
    expect(extractImports('a.ts', tmp)).toEqual(['./b']);
  });
});

describe('buildReachable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-reach-'));
    fs.mkdirSync(path.join(tmp, 'src'));
    fs.mkdirSync(path.join(tmp, 'test'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('includes direct imports at hop 1', () => {
    fs.writeFileSync(path.join(tmp, 'src/foo.ts'), '');
    fs.writeFileSync(path.join(tmp, 'test/a.test.ts'), "import { x } from '../src/foo';");
    const r = buildReachable(['test/a.test.ts'], tmp, { maxHops: 1 });
    expect(r.has('src/foo.ts')).toBe(true);
  });

  it('follows transitive imports up to maxHops', () => {
    fs.writeFileSync(path.join(tmp, 'src/c.ts'), '');
    fs.writeFileSync(path.join(tmp, 'src/b.ts'), "export * from './c';");
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), "export * from './b';");
    fs.writeFileSync(path.join(tmp, 'test/t.test.ts'), "import '../src/a';");

    // maxHops = 0 means "walk direct imports of the seeds only" (no transitive).
    const h0 = buildReachable(['test/t.test.ts'], tmp, { maxHops: 0 });
    expect([...h0]).toEqual(['src/a.ts']);

    const h1 = buildReachable(['test/t.test.ts'], tmp, { maxHops: 1 });
    expect(new Set(h1)).toEqual(new Set(['src/a.ts', 'src/b.ts']));

    const h2 = buildReachable(['test/t.test.ts'], tmp, { maxHops: 2 });
    expect(new Set(h2)).toEqual(new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']));
  });

  it('does not revisit already-reached files', () => {
    fs.writeFileSync(path.join(tmp, 'src/a.ts'), "export * from './b';");
    fs.writeFileSync(path.join(tmp, 'src/b.ts'), "export * from './a';"); // cycle
    fs.writeFileSync(path.join(tmp, 'test/t.test.ts'), "import '../src/a';");
    const r = buildReachable(['test/t.test.ts'], tmp, { maxHops: 10 });
    expect(new Set(r)).toEqual(new Set(['src/a.ts', 'src/b.ts']));
  });

  it('returns empty set for seeds with no internal imports', () => {
    fs.writeFileSync(path.join(tmp, 'test/t.test.ts'), "import fs from 'fs';");
    const r = buildReachable(['test/t.test.ts'], tmp);
    expect(r.size).toBe(0);
  });
});
