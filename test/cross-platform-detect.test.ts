import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveOnPath, resolveInDirs, commandExists } from '../src/analyzers/tools/runner';
import {
  loadToolsConfig,
  clearToolsConfigCache,
  toolsConfigPath,
} from '../src/analyzers/tools/tools-config';
import { getInstallEnv } from '../src/analyzers/tools/tool-registry';

/** Run `fn` with `process.platform` temporarily forced to `value`. */
function withPlatform(value: NodeJS.Platform, fn: () => void): void {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value, configurable: true });
  try {
    fn();
  } finally {
    if (orig) Object.defineProperty(process, 'platform', orig);
  }
}

describe('resolveInDirs / resolveOnPath (cross-platform binary detection)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-detect-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds an executable file in a directory on POSIX', () => {
    if (process.platform === 'win32') return; // POSIX exec-bit semantics
    const bin = path.join(dir, 'mytool');
    fs.writeFileSync(bin, '#!/bin/sh\necho hi\n');
    fs.chmodSync(bin, 0o755);
    expect(resolveInDirs('mytool', [dir])).toBe(bin);
  });

  it('does NOT match a non-executable file on POSIX', () => {
    if (process.platform === 'win32') return;
    const bin = path.join(dir, 'notexec');
    fs.writeFileSync(bin, 'data');
    fs.chmodSync(bin, 0o644);
    expect(resolveInDirs('notexec', [dir])).toBeNull();
  });

  it('honors PATHEXT on Windows — bare name resolves to tool.exe', () => {
    const exe = path.join(dir, 'git.exe');
    fs.writeFileSync(exe, 'binary');
    withPlatform('win32', () => {
      const prevExt = process.env.PATHEXT;
      // Windows' FS is case-insensitive (PATHEXT is conventionally
      // uppercase yet matches `git.exe`); the Linux test FS is not, so
      // align the extension case with the file we created.
      process.env.PATHEXT = '.com;.exe;.bat;.cmd';
      try {
        expect(resolveInDirs('git', [dir])).toBe(exe);
      } finally {
        if (prevExt === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = prevExt;
      }
    });
  });

  it('matches a .cmd shim on Windows', () => {
    const cmd = path.join(dir, 'npm.cmd');
    fs.writeFileSync(cmd, 'shim');
    withPlatform('win32', () => {
      const prev = process.env.PATHEXT;
      process.env.PATHEXT = '.exe;.cmd';
      try {
        expect(resolveInDirs('npm', [dir])).toBe(cmd);
      } finally {
        if (prev === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = prev;
      }
    });
  });

  it('returns null when the binary is absent', () => {
    expect(resolveInDirs('definitely-not-here-xyz', [dir])).toBeNull();
  });

  it('resolveOnPath walks process.env.PATH', () => {
    if (process.platform === 'win32') return;
    const bin = path.join(dir, 'ptool');
    fs.writeFileSync(bin, '#!/bin/sh\n');
    fs.chmodSync(bin, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(resolveOnPath('ptool')).toBe(bin);
      expect(commandExists('ptool')).toBe(true);
      expect(commandExists('nope-nope-nope')).toBe(false);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});

describe('loadToolsConfig (.dxkit/tools.json)', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-toolscfg-'));
    clearToolsConfigCache();
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    clearToolsConfigCache();
  });

  function writeConfig(obj: unknown): void {
    const p = toolsConfigPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
    clearToolsConfigCache();
  }

  it('returns an empty config when the file is absent', () => {
    expect(loadToolsConfig(cwd)).toEqual({ probePaths: [], installDir: null });
  });

  it('returns an empty config on malformed JSON (never throws)', () => {
    const p = toolsConfigPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ not json');
    clearToolsConfigCache();
    expect(loadToolsConfig(cwd)).toEqual({ probePaths: [], installDir: null });
  });

  it('reads probePaths and filters non-strings', () => {
    writeConfig({ probePaths: ['/opt/bin', 42, '', '/team/bin'] });
    expect(loadToolsConfig(cwd).probePaths).toEqual(['/opt/bin', '/team/bin']);
  });

  it('adds installDir and installDir/bin to the probe set', () => {
    writeConfig({ installDir: '/custom/tools' });
    const cfg = loadToolsConfig(cwd);
    expect(cfg.installDir).toBe('/custom/tools');
    expect(cfg.probePaths).toContain('/custom/tools');
    expect(cfg.probePaths).toContain(path.join('/custom/tools', 'bin'));
  });

  it('does not duplicate a probe path that equals installDir', () => {
    writeConfig({ probePaths: ['/custom/tools'], installDir: '/custom/tools' });
    const probes = loadToolsConfig(cwd).probePaths;
    expect(probes.filter((p) => p === '/custom/tools')).toHaveLength(1);
  });
});

describe('getInstallEnv', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-installenv-'));
    clearToolsConfigCache();
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    clearToolsConfigCache();
  });

  it('is empty when no installDir is configured', () => {
    expect(getInstallEnv(cwd)).toEqual({});
  });

  it('sets every ecosystem bin-dir variable to the configured installDir', () => {
    const p = toolsConfigPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ installDir: '/custom/tools' }));
    clearToolsConfigCache();
    expect(getInstallEnv(cwd)).toEqual({
      PIPX_BIN_DIR: '/custom/tools',
      npm_config_prefix: '/custom/tools',
      CARGO_INSTALL_ROOT: '/custom/tools',
      GOBIN: '/custom/tools',
    });
  });
});
