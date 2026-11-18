/**
 * The generated AGENTS.md names what the repo TARGETS (4.5.0 agents-owner).
 *
 * The shipped class: an old .NET Framework 4.8 web app and an SDK-style .NET 8
 * web app both rendered `## C# 8.0` (the csharp pack's SDK default dressed up
 * as a fact, reading as a C# language version neither repo states), and every
 * repo without a manifest description rendered "A project". Each heading now
 * comes from the pack (`packStackLabel`, Rule 6), falls back to the bare
 * display name (never `defaultVersion`), and the description line appears
 * only when the repo itself states one.
 *
 * Rendered end-to-end: detect(cwd) → generate() → the AGENTS.md on disk.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detect } from '../src/detect';
import { generate } from '../src/generator';
import { LANGUAGES, packStackLabel } from '../src/languages';
import { clearWalkPathsCache } from '../src/analyzers/tools/walk-paths';
import { dotnetRuntimeForTfm } from '../src/languages/dotnet-targets';
import { csharp } from '../src/languages/csharp';
import type { ResolvedConfig } from '../src/types';

beforeAll(() => {
  // generate() reads the BUILT templates/ dir (`npm run build` copies
  // src-templates/ there; test:run and the pre-push gate build first).
  if (!fs.existsSync(path.join(__dirname, '..', 'templates', 'AGENTS.md.template'))) {
    throw new Error('templates/ missing — run `npm run build` first (test:run does this).');
  }
});

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-agents-label-'));
  clearWalkPathsCache();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function renderAgents(): Promise<string> {
  const config: ResolvedConfig = { ...detect(tmp), coverageThreshold: '80', claudeCode: true };
  // Mute generate()'s per-file lines.
  const mute = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await generate(tmp, config, 'dx-only', false, false, true);
  } finally {
    mute.mockRestore();
  }
  return fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf-8');
}

const OLD_STYLE_WEB = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <ProjectTypeGuids>{349c5851-65df-11da-9384-00065b846f21};{fae04ec0-301f-11d3-bf4b-00c04f79efbc}</ProjectTypeGuids>
    <OutputType>Library</OutputType>
    <TargetFrameworkVersion>v4.8</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(VSToolsPath)\\WebApplications\\Microsoft.WebApplication.targets" />
</Project>
`;

const sdkProject = (tfm: string, sdk = 'Microsoft.NET.Sdk', extra = '') =>
  `<Project Sdk="${sdk}">\n  <PropertyGroup>\n    <TargetFramework>${tfm}</TargetFramework>${extra}\n  </PropertyGroup>\n</Project>\n`;

const heading = (agents: string, prefix: string) =>
  agents.split('\n').find((l) => l.startsWith(`## ${prefix}`));

describe('C# heading names the .NET runtime + app model the projects target', () => {
  it('old-style .NET Framework 4.8 web app → "C# on .NET Framework 4.8 (ASP.NET)"', async () => {
    write('WebApp/WebApp.csproj', OLD_STYLE_WEB);
    write('WebApp/Global.asax.cs', 'namespace WebApp { public class Global {} }\n');
    const agents = await renderAgents();
    expect(heading(agents, 'C#')).toBe('## C# on .NET Framework 4.8 (ASP.NET)');
    expect(agents).not.toMatch(/^## C# \d/m);
  });

  it('SDK-style net8.0 web app → "C# on .NET 8 (ASP.NET Core)"', async () => {
    write('src/Api/Api.csproj', sdkProject('net8.0', 'Microsoft.NET.Sdk.Web'));
    write('src/Api/Program.cs', 'var x = 1;\n');
    const agents = await renderAgents();
    expect(heading(agents, 'C#')).toBe('## C# on .NET 8 (ASP.NET Core)');
  });

  it('multi-target library + app, test project excluded from the label', async () => {
    write(
      'src/Lib/Lib.csproj',
      sdkProject('x', 'Microsoft.NET.Sdk').replace(
        '<TargetFramework>x</TargetFramework>',
        '<TargetFrameworks>netstandard2.0;net8.0</TargetFrameworks>',
      ),
    );
    write(
      'src/App/App.csproj',
      sdkProject(
        'net8.0-windows',
        'Microsoft.NET.Sdk',
        '\n    <UseWindowsForms>true</UseWindowsForms>',
      ),
    );
    write(
      'tests/App.Tests/App.Tests.csproj',
      sdkProject('net9.0', 'Microsoft.NET.Sdk', '\n    <IsTestProject>true</IsTestProject>'),
    );
    write('src/App/Form1.cs', 'class Form1 {}\n');
    const agents = await renderAgents();
    expect(heading(agents, 'C#')).toBe(
      '## C# on .NET 8, .NET 8 for Windows and .NET Standard 2.0 (Windows Forms)',
    );
  });

  it('a TFM inherited from Directory.Build.props is read', async () => {
    write(
      'Directory.Build.props',
      '<Project><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n',
    );
    write('src/Svc/Svc.csproj', '<Project Sdk="Microsoft.NET.Sdk">\n</Project>\n');
    write('src/Svc/A.cs', 'class A {}\n');
    expect(heading(await renderAgents(), 'C#')).toBe('## C# on .NET 9');
  });

  it('a target dxkit cannot name → bare "C#", never the 8.0 SDK default', async () => {
    write('src/X/X.csproj', sdkProject('$(MyTfm)'));
    write('src/X/A.cs', 'class A {}\n');
    expect(heading(await renderAgents(), 'C#')).toBe('## C#');
  });

  it('TFM → runtime names', () => {
    expect(dotnetRuntimeForTfm('net48')).toBe('.NET Framework 4.8');
    expect(dotnetRuntimeForTfm('net472')).toBe('.NET Framework 4.7.2');
    expect(dotnetRuntimeForTfm('net10.0')).toBe('.NET 10');
    expect(dotnetRuntimeForTfm('net5.0')).toBe('.NET 5');
    expect(dotnetRuntimeForTfm('netcoreapp3.1')).toBe('.NET Core 3.1');
    expect(dotnetRuntimeForTfm('netstandard2.1')).toBe('.NET Standard 2.1');
    expect(dotnetRuntimeForTfm('net8.0-windows10.0.19041')).toBe('.NET 8 for Windows');
    expect(dotnetRuntimeForTfm('uap10.0')).toBeUndefined();
  });

  it('the SDK detectVersion reads the same parse: highest modern target, Framework-only → none', () => {
    write('a/A.csproj', sdkProject('net6.0'));
    write('b/B.csproj', sdkProject('net8.0'));
    expect(csharp.detectVersion!(tmp)).toBe('8.0');
    clearWalkPathsCache();
    fs.rmSync(path.join(tmp, 'a'), { recursive: true });
    fs.rmSync(path.join(tmp, 'b'), { recursive: true });
    write('WebApp/WebApp.csproj', OLD_STYLE_WEB);
    expect(csharp.detectVersion!(tmp)).toBeUndefined();
  });
});

describe('every pack: the heading is what the repo states, never the default version', () => {
  it('Node: the stated runtime verbatim, bare "Node.js" when nothing is stated', async () => {
    write('package.json', JSON.stringify({ name: 'n', engines: { node: '>=20' } }));
    write('src/index.ts', 'export const x = 1;\n');
    expect(heading(await renderAgents(), 'Node')).toBe('## Node.js >=20');
  });

  it('Node without any stated runtime', async () => {
    write('package.json', JSON.stringify({ name: 'n' }));
    write('src/index.ts', 'export const x = 1;\n');
    expect(heading(await renderAgents(), 'Node')).toBe('## Node.js');
  });

  it('Python: requires-python verbatim; nothing stated → "Python"', async () => {
    write('pyproject.toml', '[project]\nname = "p"\nrequires-python = ">=3.10"\n');
    write('app.py', 'x = 1\n');
    expect(heading(await renderAgents(), 'Python')).toBe('## Python >=3.10');
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "p"\n');
    clearWalkPathsCache();
    expect(heading(await renderAgents(), 'Python')).toBe('## Python');
  });

  it('Go: go.mod directive; Rust/Java/Ruby fall back to the bare name', async () => {
    write('go.mod', 'module m\n\ngo 1.22\n');
    write('main.go', 'package main\n');
    expect(heading(await renderAgents(), 'Go')).toBe('## Go 1.22');
  });

  it('Kotlin: plugin version, "(Android)" only when an Android plugin is applied', async () => {
    write('build.gradle.kts', 'plugins {\n  kotlin("jvm") version "1.9.22"\n}\n');
    write('src/main/kotlin/App.kt', 'fun main() {}\n');
    expect(heading(await renderAgents(), 'Kotlin')).toBe('## Kotlin 1.9.22');
  });

  it('packStackLabel never returns a pack defaultVersion for an empty repo', () => {
    for (const lang of LANGUAGES) {
      const label = packStackLabel(lang, tmp);
      if (lang.defaultVersion) expect(label).not.toContain(lang.defaultVersion);
    }
  });
});

describe('the description line is repo evidence or absent (never "A project")', () => {
  it('a csproj <Description> is used', async () => {
    write(
      'src/Api/Api.csproj',
      sdkProject(
        'net8.0',
        'Microsoft.NET.Sdk.Web',
        '\n    <Description>Order intake API</Description>',
      ),
    );
    const agents = await renderAgents();
    expect(agents.split('\n')[2]).toBe('Order intake API');
  });

  it('package.json description is used', async () => {
    write('package.json', JSON.stringify({ name: 'n', description: 'Billing service' }));
    write('src/index.ts', 'export const x = 1;\n');
    expect((await renderAgents()).split('\n')[2]).toBe('Billing service');
  });

  it('two different csproj descriptions → none (no guessing which)', async () => {
    write(
      'a/A.csproj',
      sdkProject('net8.0', 'Microsoft.NET.Sdk', '\n    <Description>One</Description>'),
    );
    write(
      'b/B.csproj',
      sdkProject('net8.0', 'Microsoft.NET.Sdk', '\n    <Description>Two</Description>'),
    );
    const agents = await renderAgents();
    expect(agents).not.toContain('A project');
    expect(agents.split('\n')[2]).toBe('## About this product');
  });

  it('no evidence → no placeholder; the owner section carries the description', async () => {
    write('WebApp/WebApp.csproj', OLD_STYLE_WEB);
    const agents = await renderAgents();
    expect(agents).not.toContain('A project');
    expect(agents.split('\n')[2]).toBe('## About this product');
    expect(agents).toContain('<!-- dxkit:owner:start -->\n<!-- dxkit:owner:end -->');
  });
});
