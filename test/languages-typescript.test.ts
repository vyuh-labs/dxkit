import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  typescript,
  extractTsImportsRaw,
  resolveTsImportRaw,
  buildTsTopLevelDepIndex,
} from '../src/languages/typescript';

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

describe('typescript depVulns — lockfile-aware scanner selection (#15)', () => {
  const depVulns = typescript.capabilities!.depVulns!;

  it('no package.json → no-manifest', async () => {
    const out = await depVulns.gatherOutcome!(tmp);
    expect(out.kind).toBe('no-manifest');
  });

  it('package.json but NO lockfile → unavailable with a lockfile hint, never an npm-audit run', async () => {
    // The pre-fix path ran `npm audit` unconditionally and collapsed to a parse
    // error. Now selection routes on the present lockfile: none → an honest
    // "generate a lockfile", not a misleading npm-audit failure.
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    const out = await depVulns.gatherOutcome!(tmp);
    expect(out.kind).toBe('unavailable');
    if (out.kind === 'unavailable') {
      expect(out.reason).toMatch(/no lockfile/i);
      expect(out.reason).not.toMatch(/npm audit/i);
    }
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
      'osv-scanner',
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

describe('buildTsTopLevelDepIndex', () => {
  it('returns empty map for missing/invalid input', () => {
    expect(buildTsTopLevelDepIndex(null).size).toBe(0);
    expect(buildTsTopLevelDepIndex({}).size).toBe(0);
    expect(buildTsTopLevelDepIndex({ packages: {} }).size).toBe(0);
  });

  it('attributes a direct dep to itself', () => {
    const lock = {
      packages: {
        '': { dependencies: { axios: '^1.0.0' } },
        'node_modules/axios': { dependencies: { follow: '1.0.0' } },
        'node_modules/follow': {},
      },
    };
    const idx = buildTsTopLevelDepIndex(lock);
    expect(idx.get('axios')).toEqual(['axios']);
    expect(idx.get('follow')).toEqual(['axios']);
  });

  it('attributes a transitive dep to its top-level ancestor', () => {
    const lock = {
      packages: {
        '': { dependencies: { '@loopback/cli': '^1.0.0' } },
        'node_modules/@loopback/cli': { dependencies: { tar: '^7.0.0' } },
        'node_modules/tar': { dependencies: { minipass: '*' } },
        'node_modules/minipass': {},
      },
    };
    const idx = buildTsTopLevelDepIndex(lock);
    expect(idx.get('@loopback/cli')).toEqual(['@loopback/cli']);
    expect(idx.get('tar')).toEqual(['@loopback/cli']);
    expect(idx.get('minipass')).toEqual(['@loopback/cli']);
  });

  it('unions attributions when a package is reachable from multiple top-levels', () => {
    const lock = {
      packages: {
        '': {
          dependencies: { '@loopback/cli': '^1.0.0', '@loopback/repository': '^1.0.0' },
          devDependencies: { 'dev-tool': '^1.0.0' },
        },
        'node_modules/@loopback/cli': { dependencies: { lodash: '*' } },
        'node_modules/@loopback/repository': { dependencies: { lodash: '*' } },
        'node_modules/dev-tool': { dependencies: { lodash: '*' } },
        'node_modules/lodash': {},
      },
    };
    const idx = buildTsTopLevelDepIndex(lock);
    expect(idx.get('lodash')).toEqual(['@loopback/cli', '@loopback/repository', 'dev-tool']);
  });

  it('follows nested node_modules duplicates when building the graph', () => {
    // @loopback/cli ships its own tar@6 nested; root has no tar. The
    // nested copy's `dependencies` still contribute child attribution.
    const lock = {
      packages: {
        '': { dependencies: { '@loopback/cli': '^1.0.0' } },
        'node_modules/@loopback/cli': { dependencies: { tar: '^6.0.0' } },
        'node_modules/@loopback/cli/node_modules/tar': { dependencies: { yallist: '*' } },
        'node_modules/@loopback/cli/node_modules/yallist': {},
      },
    };
    const idx = buildTsTopLevelDepIndex(lock);
    expect(idx.get('tar')).toEqual(['@loopback/cli']);
    expect(idx.get('yallist')).toEqual(['@loopback/cli']);
  });

  it('handles cycles without infinite looping', () => {
    const lock = {
      packages: {
        '': { dependencies: { a: '*' } },
        'node_modules/a': { dependencies: { b: '*' } },
        'node_modules/b': { dependencies: { a: '*' } },
      },
    };
    const idx = buildTsTopLevelDepIndex(lock);
    expect(idx.get('a')).toEqual(['a']);
    expect(idx.get('b')).toEqual(['a']);
  });
});

describe('typescript.correctness', () => {
  /** Write a fake `node_modules/.bin/<bin>` shim so `hasLocalBin` sees it. */
  function installBin(bin: string): void {
    const dir = path.join(tmp, 'node_modules', '.bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\n');
  }

  const ctx = (over: Partial<{ changedFiles: string[]; scope: 'affected' | 'full' }> = {}) => ({
    cwd: tmp,
    changedFiles: over.changedFiles ?? ['src/a.ts'],
    scope: over.scope ?? ('affected' as const),
  });

  it('syntaxCheck runs tsc --noEmit --skipLibCheck when tsconfig + tsc are present', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
    installBin('tsc');
    const cmd = typescript.correctness!.syntaxCheck(ctx());
    expect(cmd).toEqual({
      label: 'typecheck',
      bin: 'npx',
      args: ['--no-install', 'tsc', '--noEmit', '--skipLibCheck'],
    });
  });

  it('syntaxCheck prefers the project typecheck script', () => {
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc -b' } }),
    );
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
    installBin('tsc');
    const cmd = typescript.correctness!.syntaxCheck(ctx());
    expect(cmd).toEqual({ label: 'typecheck', bin: 'npm', args: ['run', 'typecheck'] });
  });

  it('syntaxCheck skips without a tsconfig (pure JS)', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"x"}');
    installBin('tsc');
    expect(typescript.correctness!.syntaxCheck(ctx())).toBeNull();
  });

  it('syntaxCheck skips (fail-open) when tsc is not installed', () => {
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}');
    expect(typescript.correctness!.syntaxCheck(ctx())).toBeNull();
  });

  it('affectedTests: vitest related on the affected surface', () => {
    installBin('vitest');
    const cmd = typescript.correctness!.affectedTests(
      ctx({ changedFiles: ['src/a.ts', 'README.md'] }),
    );
    expect(cmd).toEqual({
      label: 'affected-tests',
      bin: 'npx',
      args: ['--no-install', 'vitest', 'related', '--run', '--passWithNoTests', 'src/a.ts'],
    });
  });

  it('affectedTests: vitest full suite at full scope', () => {
    installBin('vitest');
    const cmd = typescript.correctness!.affectedTests(ctx({ scope: 'full' }));
    expect(cmd).toEqual({
      label: 'affected-tests',
      bin: 'npx',
      args: ['--no-install', 'vitest', 'run', '--passWithNoTests'],
    });
  });

  it('affectedTests: full suite when the diff is undeterminable (empty changedFiles)', () => {
    installBin('vitest');
    const cmd = typescript.correctness!.affectedTests(ctx({ changedFiles: [], scope: 'affected' }));
    expect(cmd?.args).toEqual(['--no-install', 'vitest', 'run', '--passWithNoTests']);
  });

  it('affectedTests: skips when no TS/JS file changed on the affected surface', () => {
    installBin('vitest');
    expect(typescript.correctness!.affectedTests(ctx({ changedFiles: ['README.md'] }))).toBeNull();
  });

  it('affectedTests: jest --findRelatedTests with the file list last', () => {
    installBin('jest');
    const cmd = typescript.correctness!.affectedTests(ctx({ changedFiles: ['src/a.ts'] }));
    expect(cmd).toEqual({
      label: 'affected-tests',
      bin: 'npx',
      args: ['--no-install', 'jest', '--passWithNoTests', '--findRelatedTests', 'src/a.ts'],
    });
  });

  it('affectedTests: prefers vitest over jest when both installed', () => {
    installBin('vitest');
    installBin('jest');
    const cmd = typescript.correctness!.affectedTests(ctx());
    expect(cmd?.args).toContain('vitest');
  });

  it('affectedTests: skips (fail-open) when no runner is installed', () => {
    expect(typescript.correctness!.affectedTests(ctx())).toBeNull();
  });
});
