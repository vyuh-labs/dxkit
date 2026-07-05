import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  detectPackageManager,
  detectLockfile,
  addDevPrefix,
  addDevCommand,
  provisionCommand,
  pmAwareDevInstall,
} from '../src/package-manager';

describe('detectPackageManager', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-pm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('detects each PM from its lockfile', () => {
    const cases: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lockb', 'bun'],
      ['bun.lock', 'bun'],
      ['package-lock.json', 'npm'],
    ];
    for (const [lockfile, pm] of cases) {
      const d = mkdtempSync(join(tmpdir(), 'dxkit-pm-'));
      writeFileSync(join(d, lockfile), '');
      expect(detectPackageManager(d), lockfile).toBe(pm);
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('lockfile wins over the packageManager field', () => {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
    expect(detectPackageManager(dir)).toBe('pnpm');
  });
});

describe('detectLockfile (dep-scanner selection input, #15)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-lock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when no lockfile is present (package.json alone is not enough to audit)', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
    expect(detectLockfile(dir)).toBeNull();
  });

  it('reports the present lockfile and its owning PM', () => {
    const cases: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['bun.lock', 'bun'],
      ['package-lock.json', 'npm'],
      ['npm-shrinkwrap.json', 'npm'],
    ];
    for (const [lockfile, pm] of cases) {
      const d = mkdtempSync(join(tmpdir(), 'dxkit-lock-'));
      writeFileSync(join(d, lockfile), '');
      expect(detectLockfile(d), lockfile).toEqual({ pm, lockfile });
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('a pnpm lockfile is selected even when a stray package-lock.json also exists', () => {
    // The bug's shape: both lockfiles present, both scanners "found". Selection
    // must pick the PM that actually provisioned the repo, so the scanner reads
    // a lockfile it understands.
    writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
    writeFileSync(join(dir, 'package-lock.json'), '');
    expect(detectLockfile(dir)).toEqual({ pm: 'pnpm', lockfile: 'pnpm-lock.yaml' });
  });

  it('falls back to the packageManager field when no lockfile', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ packageManager: 'pnpm@9.1.0' }));
    expect(detectPackageManager(dir)).toBe('pnpm');
  });

  it('defaults to npm with neither lockfile nor field', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(detectPackageManager(dir)).toBe('npm');
    // and with no package.json at all
    expect(detectPackageManager(mkdtempSync(join(tmpdir(), 'dxkit-pm-')))).toBe('npm');
  });
});

describe('command builders', () => {
  it('addDevCommand phrases the dev-dep install per PM', () => {
    expect(addDevCommand('npm', 'x')).toBe('npm install --save-dev x');
    expect(addDevCommand('pnpm', 'x')).toBe('pnpm add -D x');
    expect(addDevCommand('yarn', 'x')).toBe('yarn add -D x');
    expect(addDevCommand('bun', 'x')).toBe('bun add -d x');
  });

  it('provisionCommand phrases the lockfile install per PM', () => {
    expect(provisionCommand('npm')).toBe('npm ci');
    expect(provisionCommand('pnpm')).toBe('pnpm install');
    expect(provisionCommand('yarn')).toBe('yarn install');
    expect(provisionCommand('bun')).toBe('bun install');
  });

  it('pmAwareDevInstall rewrites an npm-hardcoded string to the PM equivalent', () => {
    const cmd = 'npm install --save-dev "@vitest/coverage-v8@^4"';
    expect(pmAwareDevInstall(cmd, 'npm')).toBe(cmd); // no-op for npm
    expect(pmAwareDevInstall(cmd, 'pnpm')).toBe('pnpm add -D "@vitest/coverage-v8@^4"');
    expect(pmAwareDevInstall(cmd, 'bun')).toBe('bun add -d "@vitest/coverage-v8@^4"');
    // leaves a non-matching command untouched
    expect(pmAwareDevInstall('brew install cloc', 'pnpm')).toBe('brew install cloc');
  });

  it('addDevPrefix is the substring pmAwareDevInstall rewrites from', () => {
    expect(addDevPrefix('npm')).toBe('npm install --save-dev');
    expect(addDevPrefix('pnpm')).toBe('pnpm add -D');
  });
});
