/**
 * The declare-dependency recipe: applied (registry version resolved, OSV
 * pre-checked, installed into the section the importers imply, resolution
 * check confirms), the block-tier OSV refusal (the fix-build failure class
 * turned into a $0 refusal), the project-path refusal (a missing file is
 * not a package), the unknown-package refusal, and the ts-only scope.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { executeDeclareDependency } from '../../../src/remediate/recipes/declare-dependency';
import { fakeExec, floorFinding, makeCtx, makeOrder, tempRepo } from './helpers';

const PKG = JSON.stringify({ name: 'fx', version: '1.0.0' });

function importOrder(specifier: string, importingFiles: string[], pack = 'typescript') {
  return makeOrder({
    id: `unresolved-import:${pack}:.`,
    class: 'unresolved-import',
    findings: [
      floorFinding(`${pack}/import-resolution#${specifier}`, pack, 'import-resolution', {
        specifier,
        importingFiles,
      }),
    ],
    envelope: {
      paths: [...importingFiles, 'package.json', 'package-lock.json'],
      manifests: true,
    },
  });
}

/** A fixture whose resolution check sees `src/a.ts` importing left-pad; the
 *  scripted install materializes node_modules/left-pad so the verify pass
 *  reflects what a real install changes. */
function repoImporting(specifier: string): string {
  return tempRepo({
    'package.json': PKG,
    'package-lock.json': '{}',
    'node_modules/.keep': '',
    'src/a.ts': `import x from '${specifier}';\nexport default x;\n`,
  });
}

describe('declare-dependency recipe', () => {
  it('applies: npm view resolves the version, install lands it, the resolution check confirms', async () => {
    const cwd = repoImporting('left-pad');
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') return { output: '1.3.0\n' };
      if (cmd.args[0] === 'install' && cmd.args[1] === 'left-pad@1.3.0') {
        fs.mkdirSync(path.join(cwd, 'node_modules', 'left-pad'), { recursive: true });
        fs.writeFileSync(
          path.join(cwd, 'node_modules', 'left-pad', 'package.json'),
          '{"name":"left-pad"}',
        );
      }
      return undefined;
    });
    const outcome = await executeDeclareDependency(
      importOrder('left-pad', ['src/a.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('applied');
    // Production importer: plain dependency (npm --save-prod).
    const install = calls.find((c) => c.cmd.args[0] === 'install');
    expect(install?.cmd.args).toContain('--save-prod');
  });

  it('a package imported ONLY from test files installs as a devDependency', async () => {
    const cwd = tempRepo({
      'package.json': PKG,
      'package-lock.json': '{}',
      'node_modules/.keep': '',
      'test/a.test.ts': "import x from 'left-pad';\n",
    });
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') return { output: '1.3.0\n' };
      if (cmd.args[0] === 'install') {
        fs.mkdirSync(path.join(cwd, 'node_modules', 'left-pad'), { recursive: true });
      }
      return undefined;
    });
    const outcome = await executeDeclareDependency(
      importOrder('left-pad', ['test/a.test.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('applied');
    const install = calls.find((c) => c.cmd.args[0] === 'install');
    expect(install?.cmd.args).toContain('--save-dev');
  });

  it('REFUSES at $0, advisory named, when the candidate carries a block-tier vuln', async () => {
    const cwd = repoImporting('evil-pkg');
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') return { output: '9.9.9\n' };
      return undefined;
    });
    const outcome = await executeDeclareDependency(
      importOrder('evil-pkg', ['src/a.ts']),
      makeCtx(cwd, {
        exec,
        queryOsv: async () => [{ id: 'GHSA-evil', database_specific: { severity: 'CRITICAL' } }],
      }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('GHSA-evil');
    // The refusal happened BEFORE any install: only the registry probe ran.
    expect(calls.every((c) => c.cmd.args[0] === 'view')).toBe(true);
  });

  it('REFUSES a flag-shaped specifier before any argv exists (Rule 11 argument-injection rail)', async () => {
    const cwd = repoImporting('left-pad');
    const { exec, calls } = fakeExec();
    const outcome = await executeDeclareDependency(
      importOrder('--registry=https://evil.example', ['src/a.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.reason).toContain('--registry=https://evil.example');
      expect(outcome.reason).toContain('not a valid npm package name');
    }
    // The refusal happened BEFORE any command: not even the registry probe ran.
    expect(calls).toHaveLength(0);
  });

  it('verifies at the OWNING ROOT: a nested-workspace install resolves against its own tree', async () => {
    const cwd = tempRepo({
      'package.json': '{"name":"umbrella"}',
      'packages/app/package.json': PKG,
      'packages/app/package-lock.json': '{}',
      'packages/app/node_modules/.keep': '',
      'packages/app/src/a.ts': "import x from 'left-pad';\nexport default x;\n",
    });
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') return { output: '1.3.0\n' };
      if (cmd.args[0] === 'install') {
        fs.mkdirSync(path.join(cwd, 'packages/app/node_modules/left-pad'), { recursive: true });
      }
      return undefined;
    });
    const order = makeOrder({
      id: 'unresolved-import:typescript:packages/app',
      class: 'unresolved-import',
      findings: [
        floorFinding('typescript/import-resolution#left-pad', 'typescript', 'import-resolution', {
          specifier: 'left-pad',
          importingFiles: ['packages/app/src/a.ts'],
        }),
      ],
      envelope: {
        paths: [
          'packages/app/src/a.ts',
          'packages/app/package.json',
          'packages/app/package-lock.json',
        ],
        manifests: true,
      },
    });
    const outcome = await executeDeclareDependency(order, makeCtx(cwd, { exec }));
    // The repo ROOT has no node_modules at all: only a root-anchored verify
    // would read "dependencies are not installed" and fail a correct install.
    expect(outcome.kind).toBe('applied');
    // Both the registry probe and the install ran at the owning root.
    for (const c of calls) expect(c.cwd).toBe(path.join(cwd, 'packages/app'));
  });

  it('refuses a project-path identity (a missing file is not a package)', async () => {
    const cwd = repoImporting('left-pad');
    const { exec, calls } = fakeExec();
    const outcome = await executeDeclareDependency(
      importOrder('./src/missing', ['src/a.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('./src/missing');
    expect(calls).toHaveLength(0);
  });

  it('refuses a specifier the registry does not know (typo or private package)', async () => {
    const cwd = repoImporting('no-such-pkg');
    const { exec } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') return { code: 1, output: 'npm error 404' };
      return undefined;
    });
    const outcome = await executeDeclareDependency(
      importOrder('no-such-pkg', ['src/a.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('no-such-pkg');
  });

  it('refuses orders from a pack whose declaration is an exemption, with the declared reason', async () => {
    const cwd = repoImporting('left-pad');
    const { exec } = fakeExec();
    const outcome = await executeDeclareDependency(
      importOrder('github.com/x/y', ['main.go'], 'go'),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('go');
  });

  it('applies on a python root: the alias-mapped distribution resolves, uv adds it, the resolution check confirms', async () => {
    // `import yaml` in a uv-managed root: the probe and install must target
    // the DISTRIBUTION (pyyaml), and the verify is the python pack's own
    // resolution check reading the declared manifest after the install.
    const cwd = tempRepo({
      'pyproject.toml': '[project]\nname = "fx"\nversion = "0.1.0"\ndependencies = []\n',
      'uv.lock': 'version = 1\n',
      'app.py': 'import yaml\n',
      // A provisioned project venv: the resolution check declines without
      // one, and the declared-manifest read is what confirms the install.
      '.venv/lib/python3.12/site-packages/.keep': '',
    });
    const { exec, calls } = fakeExec((cmd) => {
      if (cmd.bin === 'uv' && cmd.args[0] === 'pip') {
        return {
          output: 'Resolved 1 package in 49ms\nWould install 1 package\n + pyyaml==6.0.2\n',
        };
      }
      if (cmd.bin === 'uv' && cmd.args[0] === 'add') {
        fs.writeFileSync(
          path.join(cwd, 'pyproject.toml'),
          '[project]\nname = "fx"\nversion = "0.1.0"\ndependencies = ["pyyaml==6.0.2"]\n',
        );
      }
      return undefined;
    });
    const order = makeOrder({
      id: 'unresolved-import:python:.',
      class: 'unresolved-import',
      findings: [
        floorFinding('python/import-resolution#yaml', 'python', 'import-resolution', {
          specifier: 'yaml',
          importingFiles: ['app.py'],
        }),
      ],
      envelope: { paths: ['app.py', 'pyproject.toml', 'uv.lock'], manifests: true },
      constraints: { install: { bin: 'uv', args: ['sync', '--locked'] }, forbidden: [] },
    });
    const outcome = await executeDeclareDependency(order, makeCtx(cwd, { exec }));
    expect(outcome).toEqual({
      kind: 'applied',
      changedFiles: ['pyproject.toml', 'uv.lock'],
    });
    // Probe and install both name the distribution, never the import, and
    // a uv root probes through uv itself (its venvs ship without pip).
    expect(calls.map((c) => [c.cmd.bin, ...c.cmd.args].join(' '))).toEqual([
      'uv pip install --dry-run --no-deps pyyaml',
      'uv add pyyaml==6.0.2',
    ]);
  });

  it('an infrastructure-shaped probe failure is a named failure, never a typo refusal', async () => {
    // An old pip without the `index` subcommand: the specifier gets no
    // verdict, the order stays open for the agent tier.
    const cwd = repoImporting('left-pad');
    const { exec } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') {
        return { code: 1, output: 'ERROR: unknown command "index"' };
      }
      return undefined;
    });
    const outcome = await executeDeclareDependency(
      importOrder('left-pad', ['src/a.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.step).toBe('resolve-version');
      expect(outcome.output).toContain('cannot answer a version probe');
    }
  });

  it('the pack-declared infrastructure shape classifies too (uv without a venv)', async () => {
    const cwd = tempRepo({
      'pyproject.toml': '[project]\nname = "fx"\nversion = "0.1.0"\ndependencies = []\n',
      'uv.lock': 'version = 1\n',
      'app.py': 'import yaml\n',
    });
    const { exec } = fakeExec((cmd) => {
      if (cmd.bin === 'uv' && cmd.args[0] === 'pip') {
        return {
          code: 2,
          output: 'error: No virtual environment found; run `uv venv` to create an environment',
        };
      }
      return undefined;
    });
    const order = makeOrder({
      id: 'unresolved-import:python:.',
      class: 'unresolved-import',
      findings: [
        floorFinding('python/import-resolution#yaml', 'python', 'import-resolution', {
          specifier: 'yaml',
          importingFiles: ['app.py'],
        }),
      ],
      envelope: { paths: ['app.py', 'pyproject.toml', 'uv.lock'], manifests: true },
      constraints: { install: { bin: 'uv', args: ['sync', '--locked'] }, forbidden: [] },
    });
    const outcome = await executeDeclareDependency(order, makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.step).toBe('resolve-version');
      expect(outcome.output).toContain('cannot answer a version probe');
      expect(outcome.output).toContain('No virtual environment');
    }
  });

  it('fails verify when the specifier still does not resolve after the install', async () => {
    const cwd = repoImporting('left-pad');
    const { exec } = fakeExec((cmd) => {
      if (cmd.args[0] === 'view') return { output: '1.3.0\n' };
      // install "succeeds" but materializes nothing
      return undefined;
    });
    const outcome = await executeDeclareDependency(
      importOrder('left-pad', ['src/a.ts']),
      makeCtx(cwd, { exec }),
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.step).toBe('verify-resolution');
      expect(outcome.output).toContain('left-pad');
    }
  });
});
