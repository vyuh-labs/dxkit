/**
 * Unit tests for the `@vyuhlabs/create-dxkit` shim's pure helpers.
 *
 * The shim itself shells out to `npm install` and `npx vyuh-dxkit
 * init` — those legs aren't unit-testable without network/install
 * machinery. The decision logic (arg routing, package.json seeding,
 * platform-aware binary names) lives in three exported helpers and
 * IS unit-testable; that's what this file covers.
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
  ensurePackageJson: (cwd: string, fsMod?: typeof fs, pathMod?: typeof path) => { seeded: boolean };
  npmBin: (platform?: NodeJS.Platform) => string;
  npxBin: (platform?: NodeJS.Platform) => string;
  persistLegacyPeerDeps: (
    cwd: string,
    fsMod?: typeof fs,
    pathMod?: typeof path,
  ) => { changed: boolean; reason: string };
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

describe('npmBin / npxBin', () => {
  it('returns plain names on linux', () => {
    expect(shim.npmBin('linux')).toBe('npm');
    expect(shim.npxBin('linux')).toBe('npx');
  });

  it('returns .cmd-suffixed names on win32', () => {
    expect(shim.npmBin('win32')).toBe('npm.cmd');
    expect(shim.npxBin('win32')).toBe('npx.cmd');
  });

  it('returns plain names on darwin', () => {
    expect(shim.npmBin('darwin')).toBe('npm');
    expect(shim.npxBin('darwin')).toBe('npx');
  });
});
