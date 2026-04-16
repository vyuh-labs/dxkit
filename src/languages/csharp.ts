import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { fileExists, run, runExitCode } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
import type { LanguageSupport } from './types';

function dirHasMatching(dir: string, regex: RegExp): boolean {
  try {
    return fs.readdirSync(dir).some((name) => regex.test(name));
  } catch {
    return false;
  }
}

function findMatchingRecursive(cwd: string, regex: RegExp, maxDepth = 3): string | null {
  function search(dir: string, depth: number): string | null {
    if (depth > maxDepth) return null;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const e of entries) {
      if (
        e.name.startsWith('.') ||
        ['node_modules', 'bin', 'obj', 'TestResults', 'packages'].includes(e.name)
      ) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isFile() && regex.test(e.name)) return full;
      if (e.isDirectory()) {
        const nested = search(full, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }
  return search(cwd, 0);
}

function findCoberturaArtifact(cwd: string): string | null {
  // Common layouts:
  //   coverage/coverage.cobertura.xml        (explicit run)
  //   TestResults/<guid>/coverage.cobertura.xml  (default `dotnet test --collect`)
  const top = path.join(cwd, 'coverage', 'coverage.cobertura.xml');
  if (fs.existsSync(top)) return top;
  const testResults = path.join(cwd, 'TestResults');
  if (fs.existsSync(testResults)) {
    const nested = findMatchingRecursive(testResults, /coverage\.cobertura\.xml$/, 4);
    if (nested) return nested;
  }
  return null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function parseCoberturaXml(raw: string, sourceFile: string, cwd: string): Coverage | null {
  const header = raw.match(/<coverage\s+([^>]*)>/);
  if (!header) return null;
  const attrs = header[1];
  const linesCovered = parseInt(attrs.match(/lines-covered="(\d+)"/)?.[1] ?? '', 10);
  const linesValid = parseInt(attrs.match(/lines-valid="(\d+)"/)?.[1] ?? '', 10);
  const lineRate = parseFloat(attrs.match(/line-rate="([\d.]+)"/)?.[1] ?? '');

  let linePercent: number;
  if (!Number.isNaN(linesCovered) && !Number.isNaN(linesValid) && linesValid > 0) {
    linePercent = round1((linesCovered / linesValid) * 100);
  } else if (!Number.isNaN(lineRate)) {
    linePercent = round1(lineRate * 100);
  } else {
    return null;
  }

  const files = new Map<string, FileCoverage>();
  const classRe = /<class\s+[^>]*?filename="([^"]+)"[^>]*?line-rate="([\d.]+)"[^>]*?(?:\/>|>)/g;
  let cm: RegExpExecArray | null;
  while ((cm = classRe.exec(raw)) !== null) {
    const filename = cm[1].replace(/\\/g, '/');
    const rate = parseFloat(cm[2]);
    if (Number.isNaN(rate)) continue;
    const existing = files.get(filename);
    if (existing) continue;
    files.set(filename, {
      path: filename,
      covered: 0,
      total: 0,
      pct: round1(rate * 100),
    });
  }

  const rel = path.relative(cwd, path.resolve(cwd, sourceFile)).split(path.sep).join('/');
  return { source: 'cobertura', sourceFile: rel || sourceFile, linePercent, files };
}

export const csharp: LanguageSupport = {
  id: 'csharp',
  displayName: 'C#',
  sourceExtensions: ['.cs'],
  // Fixes the pattern gap: previously C# tests named `FooTests.cs` were missed
  // because gather.ts only matched *.test.*, *.spec.*, *_test.*, test_*.
  testFilePatterns: ['*Tests.cs', '*.Tests.cs'],
  extraExcludes: ['bin', 'obj', 'TestResults', 'packages'],

  detect(cwd) {
    return (
      dirHasMatching(cwd, /\.(sln|csproj)$/) || findMatchingRecursive(cwd, /\.csproj$/, 3) !== null
    );
  },

  tools: ['dotnet-format'],
  // p/csharp semgrep ruleset is sparse — skip until it matures.
  semgrepRulesets: [],

  parseCoverage(cwd) {
    const artifact = findCoberturaArtifact(cwd);
    if (!artifact) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(artifact, 'utf-8');
    } catch {
      return null;
    }
    const rel = path.relative(cwd, artifact).split(path.sep).join('/');
    return parseCoberturaXml(raw, rel, cwd);
  },

  extractImports(content) {
    // `using System;`, `using System.IO;`, `using static System.Math;`,
    // `using Alias = Foo.Bar;`. Captures the fully-qualified namespace.
    const out: string[] = [];
    const re = /^\s*using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      out.push(m[1]);
    }
    return out;
  },

  // resolveImport intentionally omitted: C# namespaces don't map to file
  // paths deterministically — one namespace can span many files, one file
  // can declare many namespaces. Internal edges are best inferred via the
  // project assembly graph, which is out of scope here.

  gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    const dotnet = findTool(TOOL_DEFS['dotnet-format'], cwd);
    if (dotnet.available) {
      const exitCode = runExitCode('dotnet format --verify-no-changes 2>/dev/null', cwd, 120000);
      if (exitCode === 0) {
        metrics.lintErrors = 0;
        metrics.lintWarnings = 0;
      } else {
        const raw = run('dotnet format --verify-no-changes 2>&1', cwd, 120000);
        const violations = raw ? raw.split('\n').filter((l) => l.includes('Formatted')).length : 1;
        metrics.lintErrors = violations;
        metrics.lintWarnings = 0;
      }
      metrics.lintTool = 'dotnet-format';
      metrics.toolsUsed!.push('dotnet-format');

      const vulnRaw = run(
        'dotnet list package --vulnerable --format json 2>/dev/null',
        cwd,
        120000,
      );
      if (vulnRaw) {
        try {
          const data = JSON.parse(vulnRaw) as {
            projects?: Array<{
              frameworks?: Array<{
                topLevelPackages?: Array<{
                  resolvedVersion: string;
                  advisories?: Array<{ severity: string }>;
                }>;
              }>;
            }>;
          };
          let critical = 0;
          let high = 0;
          let medium = 0;
          let low = 0;
          for (const proj of data.projects || []) {
            for (const fw of proj.frameworks || []) {
              for (const pkg of fw.topLevelPackages || []) {
                for (const adv of pkg.advisories || []) {
                  const sev = adv.severity?.toLowerCase();
                  if (sev === 'critical') critical++;
                  else if (sev === 'high') high++;
                  else if (sev === 'moderate' || sev === 'medium') medium++;
                  else low++;
                }
              }
            }
          }
          if (critical + high + medium + low > 0) {
            metrics.depVulnCritical = critical;
            metrics.depVulnHigh = high;
            metrics.depVulnMedium = medium;
            metrics.depVulnLow = low;
            metrics.depAuditTool = 'dotnet-vulnerable';
            metrics.toolsUsed!.push('dotnet-vulnerable');
          }
        } catch {
          metrics.toolsUnavailable!.push('dotnet-vulnerable (parse error)');
        }
      }
    } else {
      metrics.toolsUnavailable!.push('dotnet-format');
    }

    if (fileExists(cwd, '*.csproj') || findMatchingRecursive(cwd, /\.csproj$/, 3)) {
      const csproj = run(
        "find . -name '*.csproj' -exec grep -l 'xunit\\|nunit\\|MSTest' {} \\; 2>/dev/null | head -1",
        cwd,
      );
      if (csproj) {
        metrics.testFramework = 'dotnet-test';
      }
    }

    return metrics;
  },
};
