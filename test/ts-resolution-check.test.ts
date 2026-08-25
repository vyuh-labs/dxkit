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
import {
  tsResolutionCheck,
  tsPackageNameOf,
  unresolvedRelativeTarget,
} from '../src/languages/typescript';

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

  it('the framework static-asset dir is exempt (vendored UMD bundles are not app modules)', () => {
    // Mirror-validated shape: a browserify-wrapped vendored file under
    // public/ carries an internal require() the app bundler never resolves.
    const cwd = repo({
      'package.json': '{}',
      'node_modules/': '',
      'public/vendor/leaflet-thing.js':
        "var queue = require('d3-queue').queue;\nmodule.exports = queue;\n",
      'src/a.js': 'export default 1;\n',
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
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

/**
 * Relative imports (4.4.5). The class: a change adds `import x from
 * './categoryIcon'` to two files and never commits `categoryIcon.js`. No
 * manifest can explain it, so the bare-specifier floor reported nothing and
 * only an opt-in lint rule saw the build break. A missing relative target is
 * the repo tree's to answer, with the same false-negative bias: anything a
 * loader might serve (an asset extension, a sibling with ANY extension, a
 * directory) is never a finding.
 */
describe('tsResolutionCheck: relative imports', () => {
  const installed = { 'package.json': '{}', 'node_modules/': '' };

  it('flags a relative import whose target is not in the tree, once per target', () => {
    const cwd = repo({
      ...installed,
      'src/components/Card.tsx':
        "import { CategoryIcon } from './categoryIcon';\nexport default 1;\n",
      'src/components/List.tsx':
        "import { CategoryIcon } from './categoryIcon';\nexport default 2;\n",
      'src/pages/Home.tsx':
        "import { CategoryIcon } from '../components/categoryIcon';\nexport default 3;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      // ONE identity for the missing module, however many files import it,
      // keyed by the repo-relative target (not the per-file specifier text).
      expect(r.unresolved).toEqual([
        { specifier: './src/components/categoryIcon', file: 'src/components/Card.tsx' },
      ]);
    }
  });

  it('resolves an omitted extension to .tsx / .js / an index barrel (clean)', () => {
    const cwd = repo({
      ...installed,
      'src/Icon.tsx': 'export const Icon = 1;',
      'src/legacy.js': 'module.exports = 1;',
      'src/widgets/index.ts': 'export const w = 1;',
      'src/a.ts':
        "import { Icon } from './Icon';\nimport legacy from './legacy';\nimport { w } from './widgets';\nexport default [Icon, legacy, w];\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('clean');
    if (r.kind === 'clean') expect(r.checkedSpecifiers).toBe(3);
  });

  it("resolves TypeScript's ESM './x.js' convention to the .ts / .tsx source (clean)", () => {
    const cwd = repo({
      ...installed,
      'src/util.ts': 'export const u = 1;',
      'src/View.tsx': 'export const V = 1;',
      'src/a.ts':
        "import { u } from './util.js';\nimport { V } from './View.jsx';\nexport default [u, V];\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('never judges a non-code import (css, scss, json, svg, png, vue) or a target with ANY sibling', () => {
    const cwd = repo({
      ...installed,
      'src/styles.module.css': '.a{}',
      'src/data.json': '{}',
      'src/a.ts': [
        "import './missing.css';",
        "import './missing.scss';",
        "import logo from './missing.svg';",
        "import png from './missing.png';",
        "import cfg from './missing.json';",
        "import App from './Missing.vue';",
        // extension-less, but a sibling with a non-code extension exists:
        "import styles from './styles.module';",
        "import data from './data';",
        'export default 1;',
      ].join('\n'),
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('a directory target (a package with its own main) is never a finding', () => {
    const cwd = repo({
      ...installed,
      'src/lib/package.json': '{"main":"./dist/lib.js"}',
      'src/a.ts': "import lib from './lib';\nexport default lib;\n",
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('a relative path that escapes the repo, a glob, or a template fragment is not judged', () => {
    const cwd = repo({
      ...installed,
      'src/a.ts': [
        "import x from '../../outside-the-repo/x';",
        "const pages = import.meta.glob('./pages/*');",
        "const m = require('./' + name);",
        'export default [x, pages, m];',
      ].join('\n'),
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });

  it('the tsconfig alias behavior is unchanged alongside relative resolution', () => {
    const cwd = repo({
      ...installed,
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'] } } }),
      'src/util.ts': 'export const u = 1;',
      'src/a.ts':
        "import { u } from '@/util';\nimport { g } from '@/gone';\nexport default [u, g];\n",
      'src/b.ts': "import { v } from './vanished';\nexport default v;\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved).toEqual([{ specifier: './src/vanished', file: 'src/b.ts' }]);
    }
  });

  it('a bare phantom and a relative miss are distinct findings in one result', () => {
    const cwd = repo({
      ...installed,
      'src/a.js':
        "const f = require('form-data');\nconst g = require('./gone');\nmodule.exports = [f, g];\n",
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved.map((u) => u.specifier)).toEqual(['form-data', './src/gone']);
    }
  });

  it('declines the relative class (disclosed) when implausibly many reach nothing, keeping the package verdict', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `import m${i} from './mods/m${i}';`);
    const cwd = repo({
      ...installed,
      'src/a.ts': `${lines.join('\n')}\nimport f from 'form-data';\nexport default [f];\n`,
    });
    const r = tsResolutionCheck(ctx(cwd));
    expect(r.kind).toBe('unresolved');
    if (r.kind === 'unresolved') {
      expect(r.unresolved.map((u) => u.specifier)).toEqual(['form-data']);
      expect(r.disclosures?.join('\n')).toContain('60 relative imports');
    }
  });

  it('a generated-output path and an import inside a template literal are never judged', () => {
    const cwd = repo({
      ...installed,
      'src/a.ts': [
        "import { Q } from './__generated__/graphql';",
        "import { S } from './schema.generated';",
        "import { T } from '../gen/types';",
        "export const tpl = `import { x } from './embedded-template-only';`;",
        'export default [Q, S, T];',
      ].join('\n'),
    });
    expect(tsResolutionCheck(ctx(cwd)).kind).toBe('clean');
  });
});

describe('unresolvedRelativeTarget', () => {
  it('returns the project-path identity of a missing code target only', () => {
    const cwd = repo({ 'src/x.ts': 'export const x = 1;' });
    expect(unresolvedRelativeTarget('src/a.ts', './x', cwd)).toBeNull();
    expect(unresolvedRelativeTarget('src/a.ts', './x.js', cwd)).toBeNull();
    expect(unresolvedRelativeTarget('src/a.ts', './y', cwd)).toBe('./src/y');
    expect(unresolvedRelativeTarget('src/a.ts', './y.ts', cwd)).toBe('./src/y');
    expect(unresolvedRelativeTarget('src/deep/a.ts', '../y', cwd)).toBe('./src/y');
    expect(unresolvedRelativeTarget('src/a.ts', './y.css', cwd)).toBeNull();
  });
});
