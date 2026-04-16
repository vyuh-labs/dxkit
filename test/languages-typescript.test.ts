import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { typescript } from '../src/languages/typescript';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ts-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('typescript.detect', () => {
  it('detects via package.json', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    expect(typescript.detect(tmp)).toBe(true);
  });

  it('returns false without package.json', () => {
    expect(typescript.detect(tmp)).toBe(false);
  });
});

describe('typescript.extractImports', () => {
  const run = typescript.extractImports!;

  it('captures static imports (with and without default/named)', () => {
    const src = `
      import foo from './foo';
      import { a, b } from './bar';
      import 'side-effect';
    `;
    expect(run(src)).toEqual(['./foo', './bar', 'side-effect']);
  });

  it('captures re-exports', () => {
    expect(run(`export { a } from './a';\nexport * from './b';`)).toEqual(['./a', './b']);
  });

  it('captures dynamic imports', () => {
    expect(run(`const x = await import('./dyn');`)).toEqual(['./dyn']);
  });

  it('captures CommonJS require', () => {
    expect(run(`const x = require('./cjs');`)).toEqual(['./cjs']);
  });

  it('ignores commented-out imports (// and /* */)', () => {
    const src = `
      // import bogus from 'nope';
      /* import bogus2 from 'nope2'; */
      import real from './real';
    `;
    expect(run(src)).toEqual(['./real']);
  });

  it('does not misfire on import.meta', () => {
    expect(run(`const u = import.meta.url;`)).toEqual([]);
  });
});

describe('typescript.resolveImport', () => {
  it('resolves X + extension', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'b.ts'), '');
    expect(typescript.resolveImport!('a.ts', './b', tmp)).toBe('b.ts');
  });

  it('resolves directory + index.ts', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.writeFileSync(path.join(tmp, 'pkg', 'index.ts'), '');
    expect(typescript.resolveImport!('a.ts', './pkg', tmp)).toBe('pkg/index.ts');
  });

  it('resolves .tsx, .mjs, .cjs', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'x.tsx'), '');
    fs.writeFileSync(path.join(tmp, 'y.mjs'), '');
    fs.writeFileSync(path.join(tmp, 'z.cjs'), '');
    expect(typescript.resolveImport!('a.ts', './x', tmp)).toBe('x.tsx');
    expect(typescript.resolveImport!('a.ts', './y', tmp)).toBe('y.mjs');
    expect(typescript.resolveImport!('a.ts', './z', tmp)).toBe('z.cjs');
  });

  it('returns null for external packages', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    expect(typescript.resolveImport!('a.ts', 'react', tmp)).toBeNull();
    expect(typescript.resolveImport!('a.ts', '@scope/pkg', tmp)).toBeNull();
  });

  it('returns null for unresolvable relative paths', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    expect(typescript.resolveImport!('a.ts', './missing', tmp)).toBeNull();
  });
});

describe('typescript.parseCoverage', () => {
  it('returns null when no artifact exists', () => {
    expect(typescript.parseCoverage!(tmp)).toBeNull();
  });

  it('parses coverage-summary.json', () => {
    fs.mkdirSync(path.join(tmp, 'coverage'));
    const summary = {
      total: { lines: { total: 100, covered: 75, skipped: 0, pct: 75 } },
      [`${tmp}/src/a.ts`]: { lines: { total: 50, covered: 40, skipped: 0, pct: 80 } },
    };
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-summary.json'), JSON.stringify(summary));
    const cov = typescript.parseCoverage!(tmp);
    expect(cov).not.toBeNull();
    expect(cov!.source).toBe('istanbul-summary');
    expect(cov!.linePercent).toBe(75);
  });

  it('prefers coverage-summary.json over coverage-final.json', () => {
    fs.mkdirSync(path.join(tmp, 'coverage'));
    const summary = {
      total: { lines: { total: 100, covered: 80, skipped: 0, pct: 80 } },
    };
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-summary.json'), JSON.stringify(summary));
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-final.json'), '{}');
    const cov = typescript.parseCoverage!(tmp);
    expect(cov!.source).toBe('istanbul-summary');
  });
});

describe('typescript registration', () => {
  it('declares TS/JS extensions', () => {
    expect(typescript.sourceExtensions).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  });

  it('declares expected tools', () => {
    expect(typescript.tools).toEqual(['eslint', 'npm-audit', 'vitest-coverage']);
  });

  it('declares expected semgrep rulesets', () => {
    expect(typescript.semgrepRulesets).toEqual(['p/javascript', 'p/typescript']);
  });
});
