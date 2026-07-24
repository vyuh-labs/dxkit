/**
 * The TS/JS import-resolution floor (`tsResolutionCheck`) — the check between
 * "compiles" and "bundles" for interpreted stacks. The class it exists for: a
 * lockfile change un-hoists a package that source imports but no manifest
 * declares, and "module not found" appears at build time in files the diff
 * never touched, with no compile stage or live test to see it.
 *
 * Fixture-driven: each case builds a real directory tree, because the check's
 * whole job is reading the installed tree. Bias assertions matter as much as
 * detection: every ambiguous shape (aliases, PnP, missing install, mass
 * unresolved) must be a DISCLOSED skip or a silent pass — never a false block.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { tsResolutionCheck, tsPackageNameOf } from '../src/languages/typescript';

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Build a throwaway repo from a { relPath: content } map ('' = directory). */
function repo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-resfloor-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    if (content === '') {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf8');
    }
  }
  return dir;
}

const ctx = (cwd: string) => ({ cwd, changedFiles: [], scope: 'full' as const });

describe('tsPackageNameOf', () => {
  it('extracts the package a specifier resolves through', () => {
    expect(tsPackageNameOf('form-data')).toBe('form-data');
    expect(tsPackageNameOf('lodash/merge')).toBe('lodash');
    expect(tsPackageNameOf('@scope/pkg')).toBe('@scope/pkg');
    expect(tsPackageNameOf('@scope/pkg/deep/sub')).toBe('@scope/pkg');
    expect(tsPackageNameOf('@')).toBeNull();
    expect(tsPackageNameOf('@scope')).toBeNull();
    expect(tsPackageNameOf('')).toBeNull();
  });
});

describe('tsResolutionCheck', () => {
  it('flags a phantom dependency: imported, undeclared, not on the resolution path', () => {
    // The shipped shape: src imports form-data; it is in NO manifest; the
    // (post-un-hoist) tree has no root node_modules/form-data.
    const cwd = repo({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.0.0' } }),
      'node_modules/axios/package.json': '{"name":"axios"}',
      'src/upload.js': "const FormData = require('form-data');\nmodule.exports = FormData;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved).toEqual([{ specifier: 'form-data', file: 'src/upload.js' }]);
    }
  });

  it('clean when every bare import is installed', () => {
    const cwd = repo({
      'package.json': JSON.stringify({ dependencies: { axios: '^1.0.0' } }),
      'node_modules/axios/package.json': '{"name":"axios"}',
      'src/a.js': "import axios from 'axios';\nimport fs from 'fs';\nexport default axios;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect(r.checkedSpecifiers).toBeGreaterThan(0);
  });

  it('never flags builtins, node:/protocol imports, relative paths, or #-imports', () => {
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'src/a.js': [
        "import fs from 'fs';",
        "import fsp from 'fs/promises';",
        "import path from 'node:path';",
        "import x from './local';",
        "import y from '../up';",
        "import z from '#internal/thing';",
        "import w from 'raw-loader!./styles.css';",
      ].join('\n'),
      'src/local.js': 'export default 1;',
      'up.js': 'export default 2;',
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('a DECLARED but not-installed package is install-state, not broken code (no flag)', () => {
    // `npm install` not run for a newly added dep: the manifest states intent;
    // blocking would blame code for environment.
    const cwd = repo({
      'package.json': JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }),
      'node_modules/': '',
      'src/a.js': "import lp from 'left-pad';\nexport default lp;\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('peer/optional declarations also resolve the question in the code’s favor', () => {
    const cwd = repo({
      'package.json': JSON.stringify({ peerDependencies: { react: '>=18' } }),
      'node_modules/': '',
      'src/a.jsx': "import React from 'react';\nexport default React;\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('walks nested node_modules and ancestors above cwd (workspace hoisting)', () => {
    // Repo nested inside a workspace whose ROOT hosts the hoisted install.
    const outer = repo({
      'node_modules/hoisted-pkg/package.json': '{"name":"hoisted-pkg"}',
      'app/package.json': '{}',
      'app/node_modules/': '',
      'app/src/a.js': "import h from 'hoisted-pkg';\nexport default h;\n",
    });
    expect(tsResolutionCheck(ctx(path.join(outer, 'app'))).kind).toBe('clean');
  });

  it('a tsconfig path alias is resolved internally, and a BROKEN alias is skipped, not flagged', () => {
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { paths: { '@app/*': ['src/*'] } },
      }),
      'src/util.ts': 'export const u = 1;',
      // resolves via the alias:
      'src/a.ts': "import { u } from '@app/util';\nexport default u;\n",
      // alias-shaped but the target is GONE — tsc's error to report, not ours:
      'src/b.ts': "import { g } from '@app/gone';\nexport default g;\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('disclosed skip when dependencies are not installed at all', () => {
    const cwd = repo({
      'package.json': '{}',
      'src/a.js': "import axios from 'axios';\nexport default axios;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('node_modules');
  });

  it('disclosed skip under Yarn Plug’n’Play', () => {
    const cwd = repo({
      'package.json': '{}',
      '.pnp.cjs': 'module.exports = {};',
      'src/a.js': "import axios from 'axios';\nexport default axios;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain("Plug'n'Play");
  });

  it('disclosed skip when a bundler config declares aliases dxkit does not model', () => {
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'vite.config.ts': "export default { resolve: { alias: { phantom: '/src/phantom' } } };\n",
      'src/a.ts': "import p from 'phantom';\nexport default p;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('vite.config.ts');
  });

  it('a bundler config WITHOUT aliases does not disable the check', () => {
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'vite.config.ts': 'export default { build: { sourcemap: true } };\n',
      'src/a.ts': "import p from 'phantom';\nexport default p;\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('unresolved');
  });

  it('declines (disclosed) when implausibly many packages fail to resolve', () => {
    // A mass miss means an unmodeled resolution mechanism, not 12 breaks.
    const imports = Array.from(
      { length: 12 },
      (_, i) => `import x${i} from 'mystery-pkg-${i}';`,
    ).join('\n');
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'src/a.js': `${imports}\nexport default 1;\n`,
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('skipped');
    if (r.kind === 'skipped') expect(r.reason).toContain('12');
  });

  it('declaration files are exempt (type-only imports)', () => {
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'src/types.d.ts': "import type { X } from 'types-only-pkg';\nexport type Y = X;\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });
});
