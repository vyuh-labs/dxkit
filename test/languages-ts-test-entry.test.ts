/**
 * The TS pack's test entry-point resolution (src/languages/ts-test-entry.ts,
 * #377): the order of evidence, the native vs through-the-script routing,
 * and the disclosed cannot-start cases. Each case builds a throwaway repo
 * from package.json + shims; nothing spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTsTestEntryPoint, tsAffectedTestsInvocation } from '../src/languages/ts-test-entry';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ts-entry-'));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function pkg(json: Record<string, unknown>): void {
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(json));
}
function installBin(bin: string): void {
  const dir = path.join(tmp, 'node_modules', '.bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, bin), '#!/bin/sh\n');
}
const AFFECTED = ['src/a.ts'];

describe('order of evidence', () => {
  it('1. the test script decides, even when another runner is declared and installed', () => {
    pkg({ scripts: { test: 'vitest' }, devDependencies: { jest: '1', vitest: '1' } });
    installBin('jest');
    installBin('vitest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind === 'entry' && r.entry).toMatchObject({
      evidence: 'test-script',
      runner: 'vitest',
      via: 'native',
    });
  });

  it('2. a declared dependency beats an installed-but-undeclared runner (jest declared, vitest hoisted)', () => {
    pkg({ devDependencies: { jest: '1' } });
    installBin('jest');
    installBin('vitest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind === 'entry' && r.entry).toMatchObject({
      evidence: 'declared-dependency',
      runner: 'jest',
    });
  });

  it('2. react-scripts declared with no test script is the CRA entry point', () => {
    pkg({ dependencies: { 'react-scripts': '5' } });
    installBin('react-scripts');
    installBin('jest');
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toEqual({
      bin: 'npx',
      args: [
        '--no-install',
        'react-scripts',
        'test',
        '--watchAll=false',
        '--ci',
        '--passWithNoTests',
        '--findRelatedTests',
        'src/a.ts',
      ],
    });
  });

  it('2. a runner config file is evidence when nothing is declared', () => {
    pkg({ name: 'x' });
    fs.writeFileSync(path.join(tmp, 'jest.config.js'), 'module.exports = {};');
    installBin('jest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind === 'entry' && r.entry).toMatchObject({
      evidence: 'config-file',
      runner: 'jest',
    });
  });

  it('2. a `jest` key in package.json is evidence', () => {
    pkg({ jest: { testEnvironment: 'node' } });
    installBin('jest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind === 'entry' && r.entry).toMatchObject({
      evidence: 'config-file',
      runner: 'jest',
    });
  });

  it('3. an installed-only runner (the hoisted jest) is a disclosed cannot-start, with the command tried', () => {
    pkg({ dependencies: { 'react-scripts': '5' } });
    // react-scripts declared but its shim absent, jest hoisted: the tree the
    // pre-fix floor ran bare jest on. Declared-but-missing is reported first.
    installBin('jest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind).toBe('cannot-start');
    if (r.kind === 'cannot-start') {
      expect(r.reason).toContain('react-scripts is declared');
      expect(r.reason).toContain('install dependencies');
      expect(r.tried).toEqual({ bin: 'npx', args: ['--no-install', 'react-scripts'] });
    }
  });

  it('3. an installed-only runner with nothing declared or configured is a cannot-start naming it', () => {
    pkg({ name: 'x' });
    installBin('jest');
    const inv = tsAffectedTestsInvocation(tmp, AFFECTED);
    expect(inv?.cannotStart).toContain('jest is installed only transitively');
    expect(inv?.cannotStart).toContain('declare a `test` script');
    expect([inv?.bin, ...(inv?.args ?? [])]).toEqual(['npx', '--no-install', 'jest']);
  });

  it('4. no script, no declaration, no runner: nothing to run', () => {
    pkg({ name: 'x' });
    expect(resolveTsTestEntryPoint(tmp)).toEqual({ kind: 'none' });
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toBeNull();
    fs.rmSync(path.join(tmp, 'package.json'));
    expect(resolveTsTestEntryPoint(tmp)).toEqual({ kind: 'none' });
  });

  it('the npm scaffold placeholder counts as no test script', () => {
    pkg({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      devDependencies: { vitest: '1' },
    });
    installBin('vitest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind === 'entry' && r.entry.evidence).toBe('declared-dependency');
  });
});

describe('a test script that names a known runner', () => {
  it('runs natively with the script’s own flags carried, files last for jest', () => {
    pkg({ scripts: { test: 'jest --config jest.unit.js' } });
    installBin('jest');
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)?.args).toEqual([
      '--no-install',
      'jest',
      '--config',
      'jest.unit.js',
      '--passWithNoTests',
      '--findRelatedTests',
      'src/a.ts',
    ]);
  });

  it('vitest: the related subcommand leads, the script’s flags follow, the full suite carries them too', () => {
    pkg({ scripts: { test: 'vitest --coverage' } });
    installBin('vitest');
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)?.args).toEqual([
      '--no-install',
      'vitest',
      'related',
      '--run',
      '--passWithNoTests',
      '--coverage',
      'src/a.ts',
    ]);
    expect(tsAffectedTestsInvocation(tmp, null)?.args).toEqual([
      '--no-install',
      'vitest',
      'run',
      '--passWithNoTests',
      '--coverage',
    ]);
  });

  it('never inherits an interactive flag from the script', () => {
    pkg({ scripts: { test: 'jest --watch' } });
    installBin('jest');
    expect(tsAffectedTestsInvocation(tmp, null)?.args).toEqual([
      '--no-install',
      'jest',
      '--passWithNoTests',
    ]);
  });

  it('CRA with extra script flags keeps them before the non-interactive selection', () => {
    pkg({ scripts: { test: 'react-scripts test --env=jsdom' } });
    installBin('react-scripts');
    expect(tsAffectedTestsInvocation(tmp, null)?.args).toEqual([
      '--no-install',
      'react-scripts',
      'test',
      '--env=jsdom',
      '--watchAll=false',
      '--ci',
      '--passWithNoTests',
    ]);
  });

  it('reached through an env prefix: runs THROUGH the script via the package manager, selection forwarded', () => {
    pkg({ scripts: { test: 'cross-env NODE_ENV=test jest --config x.js' } });
    installBin('jest');
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toEqual({
      bin: 'npm',
      args: ['run', 'test', '--', '--passWithNoTests', '--findRelatedTests', 'src/a.ts'],
    });
    // The repo's own package manager phrases the forwarding (Rule 5).
    fs.writeFileSync(path.join(tmp, 'pnpm-lock.yaml'), '');
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toEqual({
      bin: 'pnpm',
      args: ['run', 'test', '--passWithNoTests', '--findRelatedTests', 'src/a.ts'],
    });
  });

  it('a CRA script under an env prefix still gets the non-interactive flags through the script', () => {
    pkg({ scripts: { test: 'CI=true react-scripts test' } });
    installBin('react-scripts');
    expect(tsAffectedTestsInvocation(tmp, null)).toEqual({
      bin: 'npm',
      args: ['run', 'test', '--', '--watchAll=false', '--ci', '--passWithNoTests'],
    });
  });

  it('a compound script runs through the script; a vitest script reached that way runs the full suite non-interactively', () => {
    pkg({ scripts: { test: 'npm run build && vitest run' } });
    installBin('vitest');
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toEqual({
      bin: 'npm',
      args: ['run', 'test', '--', '--run', '--passWithNoTests'],
    });
  });

  it('positional arguments in the script route it through the script', () => {
    pkg({ scripts: { test: 'jest src/unit' } });
    installBin('jest');
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind === 'entry' && r.entry.via).toBe('script');
  });

  it('named but not installed: a disclosed cannot-start with the remedy', () => {
    pkg({ scripts: { test: 'react-scripts test' } });
    const inv = tsAffectedTestsInvocation(tmp, AFFECTED);
    expect(inv?.cannotStart).toContain('node_modules/.bin/react-scripts is missing');
    expect(inv?.cannotStart).toContain('install dependencies');
  });
});

describe('a test script that is a different wrapper', () => {
  it('runs as the script through the package manager, full suite, no guessed binary', () => {
    pkg({ scripts: { test: 'mocha --recursive' } });
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toEqual({ bin: 'npm', args: ['run', 'test'] });
    for (const script of ['node --test', 'bun test', 'deno test', './scripts/test.sh']) {
      pkg({ scripts: { test: script } });
      const r = resolveTsTestEntryPoint(tmp);
      expect(r.kind === 'entry' && r.entry, script).toMatchObject({ runner: null, via: 'script' });
    }
  });

  it('needs the dependency tree: without node_modules it is a disclosed cannot-start', () => {
    pkg({ scripts: { test: 'mocha' } });
    const inv = tsAffectedTestsInvocation(tmp, AFFECTED);
    expect(inv?.cannotStart).toContain('node_modules is missing');
  });

  it('a script that runs no runner at all (`echo "no tests"`) is a disclosed cannot-start', () => {
    pkg({ scripts: { test: 'echo "no tests"' } });
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    const r = resolveTsTestEntryPoint(tmp);
    expect(r.kind).toBe('cannot-start');
    if (r.kind === 'cannot-start') expect(r.reason).toContain('runs no test runner');
  });

  it('"runs no runner" is a verdict on the whole script: `jest && echo done` still runs jest', () => {
    pkg({ scripts: { test: 'jest && echo done' } });
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    // The runner is not the last command, so no selection can be forwarded;
    // the script runs as itself, full suite.
    expect(tsAffectedTestsInvocation(tmp, AFFECTED)).toEqual({ bin: 'npm', args: ['run', 'test'] });
  });
});
