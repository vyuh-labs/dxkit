/**
 * Integration tests for the `@vyuhlabs/create-dxkit` ENTRY POINT — the
 * first command a new user runs (`npm init @vyuhlabs/dxkit`).
 *
 * The pure-helper suite (`create-dxkit.test.ts`) pins decision logic; it
 * structurally CANNOT catch orchestration bugs in the `require.main`
 * block — the shipped Windows EINVAL first-run failure lived
 * exactly there (an un-checked `spawnSync(...).error` read as a phantom
 * "peer-dep conflict"). So this suite runs the REAL shim as a child
 * process against fixture directories, driving every branch:
 *
 *   - home-directory refusal (nothing written, exit 1)
 *   - happy path (fake npm ok → init bin invoked with forwarded args)
 *   - ERESOLVE retry (fails strict, succeeds with --legacy-peer-deps,
 *     persists .npmrc)
 *   - both installs fail (escape hatch by PACKAGE name, debug-log pointer)
 *   - PM spawn failure (honest "never ran" message, no peer-dep story)
 *
 * npm itself is stubbed via `npm_execpath` — the same mechanism the shim
 * uses in production (npm always sets it for processes it launches), so
 * the spawn path exercised here IS the production path, on every OS
 * including Windows (this file runs in the windows first-run smoke job).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ENTRY = path.resolve(__dirname, '..', 'packages', 'create-dxkit', 'index.js');

let tmp: string;
let fixture: string; // the "project" cwd
let stubs: string; // fake npm + logs live here, outside the project

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dxkit-e2e-'));
  fixture = path.join(tmp, 'project');
  stubs = path.join(tmp, 'stubs');
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(stubs, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A scriptable fake npm, pointed at via `npm_execpath`. Behavior comes
 * from FAKE_NPM_MODE:
 *   ok               → append argv to FAKE_NPM_LOG, exit 0
 *   fail-then-ok     → exit 1 with ERESOLVE stderr unless argv contains
 *                      --legacy-peer-deps (then exit 0)
 *   fail             → always exit 1, stderr carries a debug-log pointer
 * Must end in .cjs/.js so the shim's execpath sniff accepts it.
 */
function writeFakeNpm(): string {
  const stubPath = path.join(stubs, 'fake-npm.cjs');
  fs.writeFileSync(
    stubPath,
    `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify(args) + '\\n');
const mode = process.env.FAKE_NPM_MODE || 'ok';
if (mode === 'ok') process.exit(0);
if (mode === 'fail-then-ok') {
  if (args.includes('--legacy-peer-deps')) process.exit(0);
  process.stderr.write('npm error code ERESOLVE\\nnpm error peer dep conflict\\n');
  process.exit(1);
}
process.stderr.write(
  'npm error code E403\\n' +
  'npm error A complete log of this run can be found in: /fake/_logs/2026-07-23-debug-0.log\\n');
process.exit(1);
`,
  );
  return stubPath;
}

/** Plant a fake installed @vyuhlabs/dxkit whose bin records its argv.
 *  `withExports` mirrors the real package: an exports map that does NOT
 *  expose ./package.json (the shape that breaks require.resolve subpath
 *  resolution — the direct-path route must still find the bin). */
function plantInstalledDxkit(withExports = true): string {
  const pkgDir = path.join(fixture, 'node_modules', '@vyuhlabs', 'dxkit');
  fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@vyuhlabs/dxkit',
      version: '0.0.0-test',
      bin: { 'vyuh-dxkit': './dist/index.js' },
      ...(withExports ? { exports: { '.': './dist/index.js' } } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(pkgDir, 'dist', 'index.js'),
    `require('fs').appendFileSync(process.env.FAKE_INIT_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');\n`,
  );
  return pkgDir;
}

interface RunOpts {
  args?: string[];
  cwd?: string;
  mode?: string;
  home?: string;
  extraEnv?: Record<string, string | undefined>;
}

function runShim(opts: RunOpts = {}) {
  const npmLog = path.join(stubs, 'npm-calls.log');
  const initLog = path.join(stubs, 'init-calls.log');
  const result = spawnSync(process.execPath, [ENTRY, ...(opts.args ?? [])], {
    cwd: opts.cwd ?? fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: writeFakeNpm(),
      FAKE_NPM_MODE: opts.mode ?? 'ok',
      FAKE_NPM_LOG: npmLog,
      FAKE_INIT_LOG: initLog,
      // Cover both the POSIX and Windows homedir sources.
      HOME: opts.home ?? path.join(tmp, 'not-home'),
      USERPROFILE: opts.home ?? path.join(tmp, 'not-home'),
      ...(opts.extraEnv ?? {}),
    },
  });
  const readLog = (p: string): string[][] =>
    fs.existsSync(p)
      ? fs
          .readFileSync(p, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { ...result, npmCalls: readLog(npmLog), initCalls: readLog(initLog) };
}

describe('create-dxkit entry point (child-process integration)', () => {
  it('refuses to run in the home directory and writes NOTHING', () => {
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const r = runShim({ cwd: home, home });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('home directory');
    expect(r.stderr).toContain('cd into the repository');
    // The refusal must come BEFORE the package.json seed — the shipped
    // failure left a stray package.json in the user's home folder.
    expect(fs.existsSync(path.join(home, 'package.json'))).toBe(false);
    expect(r.npmCalls).toHaveLength(0);
  });

  it('happy path: seeds package.json, installs via npm_execpath, runs init with default args', () => {
    plantInstalledDxkit();
    const r = runShim();
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(fixture, 'package.json'))).toBe(true);
    expect(r.npmCalls).toHaveLength(1);
    expect(r.npmCalls[0]).toEqual(['install', '--save-dev', '--no-audit', '@vyuhlabs/dxkit']);
    expect(r.initCalls).toHaveLength(1);
    expect(r.initCalls[0]).toEqual(['init', '--full', '--yes']);
  });

  it('forwards user args to init verbatim', () => {
    plantInstalledDxkit();
    const r = runShim({ args: ['--claude-loop', '--yes'] });
    expect(r.status).toBe(0);
    expect(r.initCalls[0]).toEqual(['init', '--claude-loop', '--yes']);
  });

  it('finds the installed bin even when the package exports map hides ./package.json', () => {
    // The real @vyuhlabs/dxkit has an exports map without "./package.json";
    // a require.resolve-only lookup would throw ERR_PACKAGE_PATH_NOT_EXPORTED
    // and silently fall back. The direct node_modules path must win.
    plantInstalledDxkit(true);
    const r = runShim();
    expect(r.status).toBe(0);
    expect(r.initCalls).toHaveLength(1);
  });

  it('ERESOLVE: retries with --legacy-peer-deps, persists .npmrc, still runs init', () => {
    plantInstalledDxkit();
    const r = runShim({ mode: 'fail-then-ok' });
    expect(r.status).toBe(0);
    expect(r.npmCalls).toHaveLength(2);
    expect(r.npmCalls[1]).toContain('--legacy-peer-deps');
    expect(fs.readFileSync(path.join(fixture, '.npmrc'), 'utf8')).toContain(
      'legacy-peer-deps=true',
    );
    expect(r.initCalls).toHaveLength(1);
    // The retry line no longer asserts a diagnosis npm never made.
    expect(r.stdout).not.toMatch(/Peer-dep conflict detected/);
  });

  it('both installs fail: names the debug log, offers the PACKAGE-form escape hatch, exit 1', () => {
    const r = runShim({ mode: 'fail' });
    expect(r.status).toBe(1);
    expect(r.npmCalls).toHaveLength(2); // strict + legacy retry
    expect(r.stderr).toContain('Full npm error log: /fake/_logs/2026-07-23-debug-0.log');
    expect(r.stderr).toContain('npx -y @vyuhlabs/dxkit init --full --yes');
    expect(r.stderr).not.toMatch(/npx vyuh-dxkit/); // the 404 form, banned
    expect(r.initCalls).toHaveLength(0);
  });

  it('PM spawn failure: says npm never ran — no phantom peer-dep diagnosis, no pointless retry', () => {
    // Strip npm_execpath so the shim must spawn `npm` from PATH — and give it
    // a PATH with no npm. The spawn itself errors (ENOENT), the class that
    // used to be misreported as "Peer-dep conflict detected" with empty
    // stderr. Skipped on win32: shell:true resolution fails differently there
    // (cmd.exe reports through exit code, covered by the both-fail case).
    if (process.platform === 'win32') return;
    const emptyBin = path.join(tmp, 'empty-bin');
    fs.mkdirSync(emptyBin);
    const r = runShim({
      extraEnv: { npm_execpath: undefined, PATH: emptyBin },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Could not launch npm at all');
    expect(r.stderr).toContain('npm never ran');
    expect(r.stderr).not.toMatch(/peer-dep/i);
    expect(r.stderr).toContain('npx -y @vyuhlabs/dxkit init --full --yes');
  });

  it('respects an existing package.json (no reseed) and skips install when dxkit already declared', () => {
    // Already-declared dxkit still goes through npm (npm dedupes fast); the
    // shim's job is only to never CLOBBER the manifest.
    const manifest = JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2);
    fs.writeFileSync(path.join(fixture, 'package.json'), manifest);
    plantInstalledDxkit();
    const r = runShim();
    expect(r.status).toBe(0);
    const after = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
    expect(after.name).toBe('my-app');
  });
});
