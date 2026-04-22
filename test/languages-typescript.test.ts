import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { typescript, extractTsImportsRaw, resolveTsImportRaw } from '../src/languages/typescript';

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

describe('extractTsImportsRaw', () => {
  const run = extractTsImportsRaw;

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

describe('resolveTsImportRaw', () => {
  it('resolves X + extension', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'b.ts'), '');
    expect(resolveTsImportRaw('a.ts', './b', tmp)).toBe('b.ts');
  });

  it('resolves directory + index.ts', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.writeFileSync(path.join(tmp, 'pkg', 'index.ts'), '');
    expect(resolveTsImportRaw('a.ts', './pkg', tmp)).toBe('pkg/index.ts');
  });

  it('resolves .tsx, .mjs, .cjs', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    fs.writeFileSync(path.join(tmp, 'x.tsx'), '');
    fs.writeFileSync(path.join(tmp, 'y.mjs'), '');
    fs.writeFileSync(path.join(tmp, 'z.cjs'), '');
    expect(resolveTsImportRaw('a.ts', './x', tmp)).toBe('x.tsx');
    expect(resolveTsImportRaw('a.ts', './y', tmp)).toBe('y.mjs');
    expect(resolveTsImportRaw('a.ts', './z', tmp)).toBe('z.cjs');
  });

  it('returns null for external packages', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    expect(resolveTsImportRaw('a.ts', 'react', tmp)).toBeNull();
    expect(resolveTsImportRaw('a.ts', '@scope/pkg', tmp)).toBeNull();
  });

  it('returns null for unresolvable relative paths', () => {
    fs.writeFileSync(path.join(tmp, 'a.ts'), '');
    expect(resolveTsImportRaw('a.ts', './missing', tmp)).toBeNull();
  });
});

describe('typescript.capabilities.coverage', () => {
  it('returns null when no artifact exists', async () => {
    expect(await typescript.capabilities!.coverage!.gather(tmp)).toBeNull();
  });

  it('parses coverage-summary.json', async () => {
    fs.mkdirSync(path.join(tmp, 'coverage'));
    const summary = {
      total: { lines: { total: 100, covered: 75, skipped: 0, pct: 75 } },
      [`${tmp}/src/a.ts`]: { lines: { total: 50, covered: 40, skipped: 0, pct: 80 } },
    };
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-summary.json'), JSON.stringify(summary));
    const env = await typescript.capabilities!.coverage!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.coverage.source).toBe('istanbul-summary');
    expect(env!.coverage.linePercent).toBe(75);
  });

  it('prefers coverage-summary.json over coverage-final.json', async () => {
    fs.mkdirSync(path.join(tmp, 'coverage'));
    const summary = {
      total: { lines: { total: 100, covered: 80, skipped: 0, pct: 80 } },
    };
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-summary.json'), JSON.stringify(summary));
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage-final.json'), '{}');
    const env = await typescript.capabilities!.coverage!.gather(tmp);
    expect(env!.coverage.source).toBe('istanbul-summary');
  });
});

describe('typescript registration', () => {
  it('declares TS/JS extensions', () => {
    expect(typescript.sourceExtensions).toEqual(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  });

  it('declares expected tools', () => {
    expect(typescript.tools).toEqual([
      'eslint',
      'npm-audit',
      'vitest-coverage',
      'license-checker-rseidelsohn',
    ]);
  });

  it('declares expected semgrep rulesets', () => {
    expect(typescript.semgrepRulesets).toEqual(['p/javascript', 'p/typescript']);
  });
});

describe('typescript.mapLintSeverity', () => {
  const map = typescript.mapLintSeverity!;

  it('maps security-plugin rules to critical', () => {
    expect(map('security/detect-eval-with-expression')).toBe('critical');
    expect(map('security-node/detect-crlf')).toBe('critical');
  });

  it('maps code-injection built-ins to critical', () => {
    expect(map('no-eval')).toBe('critical');
    expect(map('no-implied-eval')).toBe('critical');
    expect(map('no-new-func')).toBe('critical');
    expect(map('no-script-url')).toBe('critical');
  });

  it('maps @typescript-eslint unsafe-eval to critical', () => {
    expect(map('@typescript-eslint/no-unsafe-eval')).toBe('critical');
  });

  it('maps correctness-bug rules to high', () => {
    expect(map('no-undef')).toBe('high');
    expect(map('no-unreachable')).toBe('high');
    expect(map('no-dupe-keys')).toBe('high');
    expect(map('use-isnan')).toBe('high');
    expect(map('no-cond-assign')).toBe('high');
  });

  it('maps @typescript-eslint/no-unsafe-* family to high', () => {
    expect(map('@typescript-eslint/no-unsafe-assignment')).toBe('high');
    expect(map('@typescript-eslint/no-unsafe-member-access')).toBe('high');
  });

  it('maps react-hooks/rules-of-hooks to high', () => {
    expect(map('react-hooks/rules-of-hooks')).toBe('high');
  });

  it('maps best-practice rules to medium', () => {
    expect(map('no-console')).toBe('medium');
    expect(map('no-debugger')).toBe('medium');
    expect(map('prefer-const')).toBe('medium');
    expect(map('eqeqeq')).toBe('medium');
    expect(map('@typescript-eslint/no-explicit-any')).toBe('medium');
    expect(map('@typescript-eslint/no-unused-vars')).toBe('medium');
    expect(map('react-hooks/exhaustive-deps')).toBe('medium');
  });

  it('maps style/formatting plugin rules to low', () => {
    expect(map('prettier/prettier')).toBe('low');
    expect(map('import/order')).toBe('low');
    expect(map('react/display-name')).toBe('low');
    expect(map('jsx-a11y/alt-text')).toBe('low');
  });

  it('maps unknown and null rules to low', () => {
    expect(map(null)).toBe('low');
    expect(map(undefined)).toBe('low');
    expect(map('some-random-plugin/weird-rule')).toBe('low');
  });
});
