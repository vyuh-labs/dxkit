import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { csharp, extractCsharpImportsRaw, parseCoberturaXml } from '../src/languages/csharp';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-cs-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('csharp.detect', () => {
  it('detects via .sln at the top level', () => {
    fs.writeFileSync(path.join(tmp, 'MySolution.sln'), '');
    expect(csharp.detect(tmp)).toBe(true);
  });

  it('detects via .csproj at the top level', () => {
    fs.writeFileSync(path.join(tmp, 'MyProject.csproj'), '');
    expect(csharp.detect(tmp)).toBe(true);
  });

  it('detects via .csproj nested up to depth 3', () => {
    fs.mkdirSync(path.join(tmp, 'src', 'Project'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'Project', 'Project.csproj'), '');
    expect(csharp.detect(tmp)).toBe(true);
  });

  // D024: enterprise .NET layouts (e.g. deep WinForms monorepos) nest .csproj 5 levels
  // below the repo root. The depth bump 3→5 in detect() lifts the cutoff
  // to cover these without descending into deeply-nested package dirs.
  it('detects via .csproj nested at depth 5 (D024)', () => {
    const deep = path.join(tmp, 'Code', 'Source', 'Dev', 'Core', 'Module');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'Module.csproj'), '');
    expect(csharp.detect(tmp)).toBe(true);
  });

  // Recipe-hardened contract: manifest discovery is depth-unlimited
  // via the canonical walker. Real customer monorepos (the .NET WinForms
  // benchmark: .csproj files at depths 6–9) need this; the previous depth-5 cap
  // misclassified them as non-.NET. The walker still honors
  // `.gitignore` + bundled excludes (node_modules, bin, obj,
  // packages, vendor), so this isn't a free pass — anything excluded
  // still gets pruned at the directory boundary.
  it('detects a .csproj nested arbitrarily deep (depth 6+)', () => {
    const deeper = path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'f');
    fs.mkdirSync(deeper, { recursive: true });
    fs.writeFileSync(path.join(deeper, 'Project.csproj'), '');
    expect(csharp.detect(tmp)).toBe(true);
  });

  it('does NOT detect a .csproj inside an excluded directory (node_modules)', () => {
    const inside = path.join(tmp, 'node_modules', 'some-pkg', 'fixture');
    fs.mkdirSync(inside, { recursive: true });
    fs.writeFileSync(path.join(inside, 'Bogus.csproj'), '');
    expect(csharp.detect(tmp)).toBe(false);
  });

  it('returns false for unrelated directory', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '');
    expect(csharp.detect(tmp)).toBe(false);
  });

  // D024: also verify the committed fixture (mirrors the .NET WinForms benchmark shape)
  // is detectable from its root. Catches drift between the fixture's
  // depth and the detect() cutoff.
  it('detects the committed csharp-nested benchmark fixture (D024)', () => {
    const fixture = path.resolve(__dirname, 'fixtures/benchmarks/csharp-nested');
    expect(csharp.detect(fixture)).toBe(true);
  });
});

describe('csharp testFilePatterns', () => {
  it('declares *Tests.cs pattern (fixes the 10d.2 gap)', () => {
    expect(csharp.testFilePatterns).toContain('*Tests.cs');
    expect(csharp.testFilePatterns).toContain('*.Tests.cs');
  });
});

describe('extractCsharpImportsRaw', () => {
  const run = extractCsharpImportsRaw;

  it('captures simple `using X;`', () => {
    expect(run('using System;\nusing System.IO;')).toEqual(['System', 'System.IO']);
  });

  it('captures `using static X.Y;`', () => {
    expect(run('using static System.Math;')).toEqual(['System.Math']);
  });

  it('captures `using Alias = X.Y;`', () => {
    expect(run('using Json = System.Text.Json;')).toEqual(['System.Text.Json']);
  });

  it('ignores blocks of non-using code', () => {
    const src = `namespace Foo {\n  class Bar {\n    public void M() { }\n  }\n}`;
    expect(run(src)).toEqual([]);
  });

  it('handles mixed file with usings and code', () => {
    const src = `
      using System;
      using System.Collections.Generic;

      namespace App {
        class A { }
      }
    `;
    expect(run(src)).toEqual(['System', 'System.Collections.Generic']);
  });
});

describe('csharp.capabilities.coverage (cobertura)', () => {
  it('returns null when no artifact exists', async () => {
    expect(await csharp.capabilities!.coverage!.gather(tmp)).toBeNull();
  });

  it('parses coverage/coverage.cobertura.xml at the top level', async () => {
    fs.mkdirSync(path.join(tmp, 'coverage'));
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<coverage line-rate="0.85" lines-covered="340" lines-valid="400" timestamp="1">
  <packages>
    <package name="P" line-rate="0.85">
      <classes>
        <class name="A" filename="src/A.cs" line-rate="0.9"/>
        <class name="B" filename="src/B.cs" line-rate="0.5"/>
      </classes>
    </package>
  </packages>
</coverage>`;
    fs.writeFileSync(path.join(tmp, 'coverage', 'coverage.cobertura.xml'), xml);
    const env = await csharp.capabilities!.coverage!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.coverage.source).toBe('cobertura');
    expect(env!.coverage.linePercent).toBe(85);
    expect(env!.coverage.files.get('src/A.cs')?.pct).toBe(90);
    expect(env!.coverage.files.get('src/B.cs')?.pct).toBe(50);
  });

  it('finds cobertura artifact nested under TestResults/<guid>/', async () => {
    const nested = path.join(tmp, 'TestResults', '12345-abc');
    fs.mkdirSync(nested, { recursive: true });
    const xml = `<coverage line-rate="0.5" lines-covered="10" lines-valid="20"><packages/></coverage>`;
    fs.writeFileSync(path.join(nested, 'coverage.cobertura.xml'), xml);
    const env = await csharp.capabilities!.coverage!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.coverage.linePercent).toBe(50);
  });

  it('falls back to line-rate attribute when lines-covered/valid missing', () => {
    const xml = `<coverage line-rate="0.666"><packages/></coverage>`;
    const cov = parseCoberturaXml(xml, 'mock.xml', tmp);
    expect(cov).not.toBeNull();
    expect(cov!.linePercent).toBe(66.6);
  });

  it('returns null when the XML is not cobertura-shaped', () => {
    expect(parseCoberturaXml('<root/>', 'mock.xml', tmp)).toBeNull();
  });
});

describe('csharp registration', () => {
  it('has id csharp and displayName C#', () => {
    expect(csharp.id).toBe('csharp');
    expect(csharp.displayName).toBe('C#');
  });

  it('declares dotnet-format + nuget-license + osv-scanner tools', () => {
    // D025f (2.4.7) added osv-scanner as the direct-PackageReference
    // fallback when `dotnet list package` can't produce output (D036).
    expect(csharp.tools).toEqual(['dotnet-format', 'nuget-license', 'osv-scanner']);
  });

  it('declares empty semgrep rulesets (p/csharp is sparse)', () => {
    expect(csharp.semgrepRulesets).toEqual([]);
  });

  it('excludes bin/obj/TestResults/packages', () => {
    expect(csharp.extraExcludes).toEqual(
      expect.arrayContaining(['bin', 'obj', 'TestResults', 'packages']),
    );
  });

  it('imports capability has empty edges (C# namespaces are not files)', async () => {
    fs.writeFileSync(path.join(tmp, 'A.cs'), 'using System;\n');
    const env = await csharp.capabilities!.imports!.gather(tmp);
    expect(env).not.toBeNull();
    expect(env!.edges.size).toBe(0);
    expect(env!.extracted.get('A.cs')).toEqual(['System']);
  });
});

describe('csharp.correctness', () => {
  const ctx = (over: Partial<{ changedFiles: string[]; scope: 'affected' | 'full' }> = {}) => ({
    cwd: tmp,
    changedFiles: over.changedFiles ?? ['src/App/Program.cs'],
    scope: over.scope ?? ('affected' as const),
  });
  const writeSln = () =>
    fs.writeFileSync(path.join(tmp, 'App.sln'), 'Microsoft Visual Studio Solution File\n');
  const writeProj = (rel: string, isTest: boolean) => {
    fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, rel),
      isTest
        ? '<Project><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" /></ItemGroup></Project>'
        : '<Project><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>',
    );
  };

  it('syntaxCheck: dotnet build when a build target exists', () => {
    writeSln();
    expect(csharp.correctness!.syntaxCheck(ctx())).toEqual({
      label: 'build',
      bin: 'dotnet',
      args: ['build', '--nologo'],
    });
  });

  it('syntaxCheck: null without a .sln/.csproj build target', () => {
    expect(csharp.correctness!.syntaxCheck(ctx())).toBeNull();
  });

  it('affectedTests: narrows to a single changed TEST project', () => {
    writeSln();
    writeProj('test/App.Tests/App.Tests.csproj', true);
    const cmd = csharp.correctness!.affectedTests(
      ctx({ changedFiles: ['test/App.Tests/FooTests.cs', 'README.md'] }),
    );
    expect(cmd).toEqual({
      label: 'affected-tests',
      bin: 'dotnet',
      args: ['test', 'test/App.Tests/App.Tests.csproj'],
    });
  });

  it('affectedTests: whole solution when a non-test (source) project changed', () => {
    writeSln();
    writeProj('src/App/App.csproj', false);
    const cmd = csharp.correctness!.affectedTests(ctx({ changedFiles: ['src/App/Program.cs'] }));
    expect(cmd?.args).toEqual(['test']);
  });

  it('affectedTests: whole solution at full scope', () => {
    writeSln();
    writeProj('test/App.Tests/App.Tests.csproj', true);
    const cmd = csharp.correctness!.affectedTests(
      ctx({ changedFiles: ['test/App.Tests/FooTests.cs'], scope: 'full' }),
    );
    expect(cmd?.args).toEqual(['test']);
  });

  it('affectedTests: whole solution when the diff is undeterminable', () => {
    writeSln();
    expect(
      csharp.correctness!.affectedTests(ctx({ changedFiles: [], scope: 'affected' }))?.args,
    ).toEqual(['test']);
  });

  it('affectedTests: null on the affected surface when no .cs changed', () => {
    writeSln();
    expect(csharp.correctness!.affectedTests(ctx({ changedFiles: ['README.md'] }))).toBeNull();
  });

  it('affectedTests: null without a build target', () => {
    expect(csharp.correctness!.affectedTests(ctx())).toBeNull();
  });
});
