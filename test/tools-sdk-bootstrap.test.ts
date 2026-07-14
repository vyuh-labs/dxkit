import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { substituteRuntimeVersion } from '../src/analyzers/tools/install-exec';
import { getInstallEnv, TOOL_DEFS } from '../src/analyzers/tools/tool-registry';

/**
 * 3.7.2 SDK-bootstrap execution cluster: the C# SDK bootstrap is NON-SUDO and
 * VERSION-AWARE (#4/#7), and dxkit's own dotnet subprocesses run in invariant
 * globalization mode so a libicu-less image doesn't crash them (#8).
 */

describe('substituteRuntimeVersion (#4 version-aware SDK bootstrap)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-sdk-boot-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is a no-op for a command with no runtime placeholder', () => {
    const cmd = 'brew install cloc';
    expect(substituteRuntimeVersion(cmd, dir)).toBe(cmd);
  });

  it('fills the .NET channel + major from the repo-detected version', () => {
    writeFileSync(
      join(dir, 'App.csproj'),
      '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n',
    );
    const out = substituteRuntimeVersion(
      'dotnet-install.sh --channel __DOTNET_CHANNEL__ ; winget ...SDK.__DOTNET_MAJOR__',
      dir,
    );
    expect(out).toContain('--channel 9.0');
    expect(out).toContain('SDK.9');
    expect(out).not.toContain('__DOTNET_');
  });

  it('falls back to 8.0 when the repo declares no .NET version', () => {
    const out = substituteRuntimeVersion('--channel __DOTNET_CHANNEL__', dir);
    expect(out).toBe('--channel 8.0');
  });
});

describe('dotnet-format install command (#7 non-sudo bootstrap)', () => {
  it('uses the non-sudo dotnet-install.sh, never a sudo apt', () => {
    const cmds = TOOL_DEFS['dotnet-format'].installCommands;
    expect(cmds.linux).toContain('dotnet-install.sh');
    expect(cmds.linux).toContain('$HOME/.dotnet');
    expect(cmds.linux).not.toMatch(/\bapt\b|\bsudo\b/);
    // Version-aware, not a hardcoded major.
    expect(cmds.linux).toContain('__DOTNET_CHANNEL__');
    expect(cmds.linux).not.toContain('dotnet-sdk-8.0');
  });
});

describe('getInstallEnv (#8 ICU invariant for dotnet installs)', () => {
  let dir: string;
  let saved: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-icu-env-'));
    saved = process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT;
    delete process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT;
    else process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('sets the invariant flag so `dotnet tool install` does not ICU-crash', () => {
    expect(getInstallEnv(dir).DOTNET_SYSTEM_GLOBALIZATION_INVARIANT).toBe('1');
  });

  it('never overrides a value the user already set', () => {
    process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = '0';
    expect(getInstallEnv(dir).DOTNET_SYSTEM_GLOBALIZATION_INVARIANT).toBeUndefined();
  });
});
