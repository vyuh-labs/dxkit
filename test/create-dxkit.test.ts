/**
 * Unit tests for the `@vyuhlabs/create-dxkit` shim's pure helpers:
 * arg routing, cwd refusal, package.json seeding, PM detection, the
 * CVE-2024-27980-safe spawn plan, bin resolution, and failure text.
 *
 * The shim's ORCHESTRATION (the `require.main` block) is covered by
 * `create-dxkit-entrypoint.test.ts`, which runs the real entry point
 * as a child process — the layer where the shipped Windows first-run
 * break lived and where pure-helper tests are structurally blind.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// CJS interop: the shim is a CommonJS module living outside src/.
// Vitest tolerates the require — see `packages/create-dxkit/index.js`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const shim = require('../packages/create-dxkit/index.js') as {
  resolveInitArgs: (argv: string[]) => string[];
  refuseCwdReason: (cwd: string, homeDir?: string, platform?: NodeJS.Platform) => string | null;
  ensurePackageJson: (cwd: string, fsMod?: typeof fs, pathMod?: typeof path) => { seeded: boolean };
  persistLegacyPeerDeps: (
    cwd: string,
    fsMod?: typeof fs,
    pathMod?: typeof path,
  ) => { changed: boolean; reason: string };
  extractNpmLogPath: (text: string | null | undefined) => string | null;
  formatInstallFailure: (opts?: {
    stderrChunks?: string[];
    pm?: string;
    spawnError?: Error & { code?: string };
  }) => string;
  detectPackageManager: (cwd: string, fsMod?: typeof fs, pathMod?: typeof path) => string;
  pmBin: (pm: string, platform?: NodeJS.Platform) => string;
  windowsQuoteArg: (arg: string) => string;
  installSpawnPlan: (
    pm: string,
    pmArgs: string[],
    env?: Record<string, string | undefined>,
    platform?: NodeJS.Platform,
  ) => { cmd: string; args: string[]; shell: boolean };
  installArgs: (pm: string) => string[];
  resolveInstalledBin: (
    cwd: string,
    requireResolve?: (id: string, opts?: { paths: string[] }) => string,
    fsMod?: typeof fs,
  ) => string | null;
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dxkit-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('resolveInitArgs', () => {
  it('defaults to --full --yes when no user args are passed', () => {
    expect(shim.resolveInitArgs(['node', 'create-dxkit'])).toEqual(['--full', '--yes']);
  });

  it('forwards user args verbatim when provided', () => {
    expect(shim.resolveInitArgs(['node', 'create-dxkit', '--dx-only', '--yes'])).toEqual([
      '--dx-only',
      '--yes',
    ]);
  });

  it('forwards a single arg too', () => {
    expect(shim.resolveInitArgs(['node', 'create-dxkit', '--help'])).toEqual(['--help']);
  });

  it('does NOT fall back to defaults when user passed flags that happen to look like dxkit defaults', () => {
    // Sanity: defaults only fire on empty args.
    expect(shim.resolveInitArgs(['node', 'create-dxkit', '--full'])).toEqual(['--full']);
  });
});

describe('ensurePackageJson', () => {
  it('seeds a minimal package.json when missing', () => {
    const result = shim.ensurePackageJson(tmp);
    expect(result.seeded).toBe(true);
    const pkgPath = path.join(tmp, 'package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe('0.0.0');
    // Name is derived from the basename, sanitized to lowercase alnum + hyphen.
    expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
  });

  it('preserves an existing package.json unchanged', () => {
    const existing = JSON.stringify({ name: 'existing-app', version: '1.2.3' }, null, 2);
    fs.writeFileSync(path.join(tmp, 'package.json'), existing);

    const result = shim.ensurePackageJson(tmp);
    expect(result.seeded).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'package.json'), 'utf-8')).toBe(existing);
  });

  it('sanitizes weird directory names into valid npm names', () => {
    const weird = fs.mkdtempSync(path.join(os.tmpdir(), 'CREATE_DXKIT-Test.Repo!_'));
    try {
      shim.ensurePackageJson(weird);
      const pkg = JSON.parse(fs.readFileSync(path.join(weird, 'package.json'), 'utf-8'));
      expect(pkg.name).toMatch(/^[a-z0-9-]+$/);
    } finally {
      fs.rmSync(weird, { recursive: true, force: true });
    }
  });
});

describe('persistLegacyPeerDeps', () => {
  it('creates .npmrc when missing', () => {
    const result = shim.persistLegacyPeerDeps(tmp);
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('created');
    const npmrc = fs.readFileSync(path.join(tmp, '.npmrc'), 'utf-8');
    expect(npmrc).toContain('legacy-peer-deps=true');
  });

  it('appends to existing .npmrc without clobbering other settings', () => {
    const existing = 'registry=https://registry.example.com/\nfund=false\n';
    fs.writeFileSync(path.join(tmp, '.npmrc'), existing);

    const result = shim.persistLegacyPeerDeps(tmp);
    expect(result.changed).toBe(true);
    expect(result.reason).toBe('appended');
    const npmrc = fs.readFileSync(path.join(tmp, '.npmrc'), 'utf-8');
    expect(npmrc).toContain('registry=https://registry.example.com/');
    expect(npmrc).toContain('fund=false');
    expect(npmrc).toContain('legacy-peer-deps=true');
  });

  it('is idempotent when the line is already present', () => {
    fs.writeFileSync(path.join(tmp, '.npmrc'), 'legacy-peer-deps=true\n');
    const result = shim.persistLegacyPeerDeps(tmp);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('already-present');
  });

  it('handles existing .npmrc without a trailing newline', () => {
    fs.writeFileSync(path.join(tmp, '.npmrc'), 'fund=false'); // no newline
    const result = shim.persistLegacyPeerDeps(tmp);
    expect(result.changed).toBe(true);
    const npmrc = fs.readFileSync(path.join(tmp, '.npmrc'), 'utf-8');
    // Both settings on separate lines.
    expect(npmrc).toBe('fund=false\nlegacy-peer-deps=true\n');
  });
});

describe('extractNpmLogPath', () => {
  it('returns null for empty / nullish input', () => {
    expect(shim.extractNpmLogPath('')).toBeNull();
    expect(shim.extractNpmLogPath(null)).toBeNull();
    expect(shim.extractNpmLogPath(undefined)).toBeNull();
  });

  it('extracts the modern `npm error` debug-log path', () => {
    const out = [
      'npm error code ERESOLVE',
      'npm error A complete log of this run can be found in: /home/u/.npm/_logs/2026-06-01T06_08_06_595Z-debug-0.log',
    ].join('\n');
    expect(shim.extractNpmLogPath(out)).toBe(
      '/home/u/.npm/_logs/2026-06-01T06_08_06_595Z-debug-0.log',
    );
  });

  it('extracts a Windows-style debug-log path', () => {
    const out =
      'npm error A complete log of this run can be found in: C:\\Users\\R\\AppData\\Local\\npm-cache\\_logs\\2026-06-01T06_08_06_595Z-debug-0.log';
    expect(shim.extractNpmLogPath(out)).toBe(
      'C:\\Users\\R\\AppData\\Local\\npm-cache\\_logs\\2026-06-01T06_08_06_595Z-debug-0.log',
    );
  });

  it('returns the LAST path when multiple are present (npm prints the pointer last)', () => {
    const out = [
      'A complete log of this run can be found in: /first/debug-0.log',
      'A complete log of this run can be found in: /second/debug-0.log',
    ].join('\n');
    expect(shim.extractNpmLogPath(out)).toBe('/second/debug-0.log');
  });

  it('returns null when no pointer line is present', () => {
    expect(shim.extractNpmLogPath('npm error code ERESOLVE\nnpm error something')).toBeNull();
  });
});

describe('formatInstallFailure', () => {
  it('never says "above" and always offers the one-shot npx escape hatch BY PACKAGE NAME', () => {
    const msg = shim.formatInstallFailure({ stderrChunks: [] });
    expect(msg).not.toMatch(/error above/i);
    // The remedy fires precisely when no dxkit install exists, so the binary
    // form (`npx vyuh-dxkit …`) would 404 — the package form must be shown.
    // The previous version of this test PINNED the 404ing string; the break
    // was caught in the field.
    expect(msg).toContain('npx -y @vyuhlabs/dxkit init --full --yes');
    expect(msg).not.toMatch(/npx vyuh-dxkit/);
  });

  it('spawn-level failure: says the PM never ran, skips the peer-dep story, keeps the escape hatch', () => {
    const err = Object.assign(new Error('spawnSync npm.cmd EINVAL'), { code: 'EINVAL' });
    const msg = shim.formatInstallFailure({ pm: 'npm', spawnError: err });
    expect(msg).toContain('Could not launch npm at all (EINVAL)');
    expect(msg).toContain('npm never ran');
    // No fabricated diagnosis: the install-cause list and debug-log pointer
    // describe an npm run that never happened.
    expect(msg).not.toMatch(/peer-dep/i);
    expect(msg).not.toMatch(/debug log/i);
    expect(msg).toContain('npx -y @vyuhlabs/dxkit init --full --yes');
  });

  it('surfaces captured npm stderr when present', () => {
    const msg = shim.formatInstallFailure({
      stderrChunks: ['npm error code ERESOLVE\nnpm error peer react@18 wanted', ''],
    });
    expect(msg).toContain('npm reported:');
    expect(msg).toContain('ERESOLVE');
  });

  it('points at the npm debug log when the pointer is in stderr', () => {
    const msg = shim.formatInstallFailure({
      stderrChunks: [
        'npm error A complete log of this run can be found in: C:\\Users\\R\\npm-cache\\_logs\\x-debug-0.log',
      ],
    });
    expect(msg).toContain('Full npm error log: C:\\Users\\R\\npm-cache\\_logs\\x-debug-0.log');
  });

  it('falls back to a generic log hint when no path was captured', () => {
    const msg = shim.formatInstallFailure({ stderrChunks: [''] });
    expect(msg).toMatch(/debug log/i);
    expect(msg).not.toContain('Full npm error log:');
  });

  it('combines stderr from both attempts', () => {
    const msg = shim.formatInstallFailure({
      stderrChunks: ['ATTEMPT_ONE_ERR', 'ATTEMPT_TWO_ERR'],
    });
    expect(msg).toContain('ATTEMPT_ONE_ERR');
    expect(msg).toContain('ATTEMPT_TWO_ERR');
  });
});

describe('refuseCwdReason', () => {
  it('refuses the home directory', () => {
    const reason = shim.refuseCwdReason('/home/admin', '/home/admin', 'linux');
    expect(reason).toContain('home directory');
    expect(reason).toContain('Nothing was written');
  });

  it('refuses the home directory case-insensitively on win32', () => {
    const reason = shim.refuseCwdReason('C:\\Users\\Admin', 'c:\\users\\admin', 'win32');
    expect(reason).toContain('home directory');
  });

  it('refuses a filesystem root', () => {
    const reason = shim.refuseCwdReason('/', '/home/admin', 'linux');
    expect(reason).toContain('filesystem root');
  });

  it('accepts an ordinary project directory', () => {
    expect(shim.refuseCwdReason(tmp, '/home/admin', 'linux')).toBeNull();
    expect(
      shim.refuseCwdReason('C:\\Users\\Admin\\my-app', 'C:\\Users\\Admin', 'win32'),
    ).toBeNull();
  });
});

describe('installSpawnPlan (the CVE-2024-27980 net)', () => {
  // Spawning a `.cmd` with `shell: false` throws EINVAL on Node ≥ 18.20.2 /
  // 20.12.2 / 21.7.3 — the plan must never produce that combination.
  const npmEnv = { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' };

  it('npm with npm_execpath: runs node on npm-cli.js directly — no shell, no .cmd, any OS', () => {
    for (const platform of ['linux', 'win32', 'darwin'] as const) {
      const plan = shim.installSpawnPlan('npm', ['install', 'x'], npmEnv, platform);
      expect(plan.cmd).toBe(process.execPath);
      expect(plan.args).toEqual([npmEnv.npm_execpath, 'install', 'x']);
      expect(plan.shell).toBe(false);
    }
  });

  it('non-npm PM on win32: .cmd via shell (the only EINVAL-safe way to run a .cmd)', () => {
    const plan = shim.installSpawnPlan('pnpm', ['add', '-D', 'x'], {}, 'win32');
    expect(plan.cmd).toBe('pnpm.cmd');
    expect(plan.shell).toBe(true);
  });

  it('npm WITHOUT npm_execpath on win32 still avoids shell-less .cmd', () => {
    const plan = shim.installSpawnPlan('npm', ['install'], {}, 'win32');
    expect(plan.cmd).toBe('npm.cmd');
    expect(plan.shell).toBe(true);
  });

  it('posix without npm_execpath: plain direct spawn', () => {
    const plan = shim.installSpawnPlan('pnpm', ['add', '-D', 'x'], {}, 'linux');
    expect(plan).toEqual({ cmd: 'pnpm', args: ['add', '-D', 'x'], shell: false });
  });

  it('never yields a .cmd command with shell: false, across PMs and platforms', () => {
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun']) {
      for (const platform of ['linux', 'win32', 'darwin'] as const) {
        for (const env of [{}, npmEnv]) {
          const plan = shim.installSpawnPlan(pm, ['x'], env, platform);
          if (/\.(cmd|bat)$/i.test(plan.cmd)) expect(plan.shell).toBe(true);
        }
      }
    }
  });
});

describe('windowsQuoteArg', () => {
  it('leaves simple args untouched', () => {
    expect(shim.windowsQuoteArg('--save-dev')).toBe('--save-dev');
    expect(shim.windowsQuoteArg('@vyuhlabs/dxkit')).toBe('@vyuhlabs/dxkit');
  });

  it('quotes args with spaces or shell metacharacters', () => {
    expect(shim.windowsQuoteArg('a b')).toBe('"a b"');
    expect(shim.windowsQuoteArg('a&b')).toBe('"a&b"');
    expect(shim.windowsQuoteArg('a"b')).toBe('"a""b"');
  });
});

describe('resolveInstalledBin', () => {
  it('resolves the installed package bin to an absolute JS path', () => {
    const pkgDir = path.join(tmp, 'node_modules', '@vyuhlabs', 'dxkit');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@vyuhlabs/dxkit', bin: { 'vyuh-dxkit': './dist/index.js' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'dist', 'index.js'), '');
    const bin = shim.resolveInstalledBin(tmp);
    expect(bin).toBe(path.join(pkgDir, 'dist', 'index.js'));
  });

  it('returns null when the package is not installed', () => {
    expect(shim.resolveInstalledBin(tmp)).toBeNull();
  });

  it('returns null when the bin entry is missing or its file does not exist', () => {
    const pkgDir = path.join(tmp, 'node_modules', '@vyuhlabs', 'dxkit');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@vyuhlabs/dxkit', bin: { 'vyuh-dxkit': './dist/index.js' } }),
    );
    // bin declared but dist/index.js absent
    expect(shim.resolveInstalledBin(tmp)).toBeNull();
  });
});

describe('detectPackageManager (shim self-contained copy)', () => {
  it('detects each PM from its lockfile', () => {
    const cases: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['package-lock.json', 'npm'],
    ];
    for (const [lockfile, pm] of cases) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dxkit-pm-'));
      fs.writeFileSync(path.join(d, lockfile), '');
      expect(shim.detectPackageManager(d), lockfile).toBe(pm);
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('reads the packageManager field when no lockfile, else defaults to npm', () => {
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9' }));
    expect(shim.detectPackageManager(tmp)).toBe('pnpm');
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'create-dxkit-pm-'));
    expect(shim.detectPackageManager(bare)).toBe('npm');
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

describe('installArgs / pmBin (shim)', () => {
  it('builds the right dev-dep add args per PM', () => {
    expect(shim.installArgs('npm')).toEqual([
      'install',
      '--save-dev',
      '--no-audit',
      '@vyuhlabs/dxkit',
    ]);
    expect(shim.installArgs('pnpm')).toEqual(['add', '-D', '@vyuhlabs/dxkit']);
    expect(shim.installArgs('yarn')).toEqual(['add', '-D', '@vyuhlabs/dxkit']);
    expect(shim.installArgs('bun')).toEqual(['add', '-d', '@vyuhlabs/dxkit']);
  });

  it('pmBin is plain on posix and .cmd/.exe on win32', () => {
    expect(shim.pmBin('pnpm', 'linux')).toBe('pnpm');
    expect(shim.pmBin('pnpm', 'win32')).toBe('pnpm.cmd');
    expect(shim.pmBin('bun', 'win32')).toBe('bun.exe');
  });
});

describe('formatInstallFailure — PM-aware', () => {
  it('names the actual PM and omits the npm debug-log guidance for non-npm', () => {
    const pnpm = shim.formatInstallFailure({ stderrChunks: ['ERR_PNPM'], pm: 'pnpm' });
    expect(pnpm).toContain('pnpm reported:');
    expect(pnpm).not.toMatch(/npm cache `_logs`/);
    const npm = shim.formatInstallFailure({ stderrChunks: ['ERESOLVE'], pm: 'npm' });
    expect(npm).toContain('npm reported:');
  });
});
