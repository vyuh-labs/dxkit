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

  it('returns false for unrelated directory', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '');
    expect(csharp.detect(tmp)).toBe(false);
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

  it('declares dotnet-format + nuget-license tools', () => {
    expect(csharp.tools).toEqual(['dotnet-format', 'nuget-license']);
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
