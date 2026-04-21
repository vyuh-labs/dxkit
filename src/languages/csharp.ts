import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { fileExists, run, runExitCode } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  DepVulnResult,
  LintGatherOutcome,
  LintResult,
} from './capabilities/types';
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

/**
 * Single source of truth for the csharp pack's dep-vuln gathering.
 * Both `capabilities.depVulns.gather()` and `gatherMetrics` consume this.
 *
 * Note: previously the vuln check was nested inside the `dotnet-format`
 * availability gate in gatherMetrics — a quirk that meant a project
 * with `dotnet` but no `dotnet-format` saw zero vuln data. The capability
 * provider runs independently, fixing that incidentally. The legacy
 * decomposition in gatherMetrics now also runs unconditionally.
 */
async function gatherCsharpDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const vulnRaw = run('dotnet list package --vulnerable --format json 2>/dev/null', cwd, 120000);
  if (!vulnRaw) return { kind: 'no-output' };

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
    if (critical + high + medium + low === 0) return { kind: 'no-output' };
    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'dotnet-vulnerable',
      enrichment: null,
      counts: { critical, high, medium, low },
    };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'parse-error' };
  }
}

const csharpDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'csharp',
  async gather(cwd) {
    const outcome = await gatherCsharpDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the csharp pack's lint gathering.
 * Both `capabilities.lint.gather()` and `gatherMetrics` consume this.
 *
 * dotnet-format is a formatter, not a tiered linter — it emits binary
 * pass/fail per file. Violations are formatting issues (indentation,
 * spacing), not correctness. This helper reports them at `low` tier so
 * they don't inflate the Quality/Slop score: gatherMetrics collapses
 * C+H → lintErrors and M+L → lintWarnings, so low-tier counts flow
 * into lintWarnings exclusively (matching the prior behavior).
 */
function gatherCsharpLintResult(cwd: string): LintGatherOutcome {
  const dotnet = findTool(TOOL_DEFS['dotnet-format'], cwd);
  if (!dotnet.available) {
    return { kind: 'unavailable', reason: 'not installed' };
  }

  const exitCode = runExitCode('dotnet format --verify-no-changes 2>/dev/null', cwd, 120000);
  let violations = 0;
  if (exitCode !== 0) {
    const raw = run('dotnet format --verify-no-changes 2>&1', cwd, 120000);
    violations = raw ? raw.split('\n').filter((l) => l.includes('Formatted')).length : 1;
  }

  const envelope: LintResult = {
    schemaVersion: 1,
    tool: 'dotnet-format',
    counts: { critical: 0, high: 0, medium: 0, low: violations },
  };
  return { kind: 'success', envelope };
}

const csharpLintProvider: CapabilityProvider<LintResult> = {
  source: 'csharp',
  async gather(cwd) {
    const outcome = gatherCsharpLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the csharp pack's coverage gathering.
 * Locates the Cobertura artifact across known layouts (explicit `coverage/`
 * dir or `dotnet test --collect`'s TestResults/<guid>/ subtree). Both
 * `capabilities.coverage.gather()` and `parseCoverage` (legacy) consume
 * this. parseCoverage method removed in Phase 10e.B.3.6.
 */
function gatherCsharpCoverageResult(cwd: string): CoverageResult | null {
  const artifact = findCoberturaArtifact(cwd);
  if (!artifact) return null;
  let raw: string;
  try {
    raw = fs.readFileSync(artifact, 'utf-8');
  } catch {
    return null;
  }
  const rel = path.relative(cwd, artifact).split(path.sep).join('/');
  const coverage = parseCoberturaXml(raw, rel, cwd);
  if (!coverage) return null;
  return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
}

const csharpCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'csharp',
  async gather(cwd) {
    return gatherCsharpCoverageResult(cwd);
  },
};

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

  capabilities: {
    depVulns: csharpDepVulnsProvider,
    lint: csharpLintProvider,
    coverage: csharpCoverageProvider,
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

  // mapLintSeverity intentionally omitted: dotnet-format is a formatter,
  // not a tiered linter. It emits binary pass/fail per file and doesn't
  // expose per-rule codes that could be categorized into
  // critical/high/medium/low. Matching the parity of ruff (Python),
  // ESLint (TypeScript), golangci-lint (Go), and clippy (Rust) would
  // require integrating a different tool — parsing `dotnet build
  // --verbosity quiet` output for CS*/CA*/IDE* diagnostic codes and
  // mapping each to a tier. That's deferred until a C# test project
  // is available to validate the integration; see architecture-redesign
  // plan for the capability-based approach this will live in.

  async gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    // LEGACY: lintErrors/lintWarnings/lintTool populated from capabilities.lint;
    // removed in Phase 10e.C when reports stop reading these.
    // Collapse: critical + high → errors, medium + low → warnings.
    // dotnet-format is binary pass/fail so all violations land in `low`,
    // which collapses to lintWarnings — matches prior "style, not errors"
    // classification that keeps Quality/Slop scoring honest.
    const lintOutcome = gatherCsharpLintResult(cwd);
    if (lintOutcome.kind === 'success') {
      const c = lintOutcome.envelope.counts;
      metrics.lintErrors = c.critical + c.high;
      metrics.lintWarnings = c.medium + c.low;
      metrics.lintTool = lintOutcome.envelope.tool;
      metrics.toolsUsed!.push('dotnet-format');
    } else {
      metrics.toolsUnavailable!.push(
        lintOutcome.reason === 'not installed'
          ? 'dotnet-format'
          : `dotnet-format (${lintOutcome.reason})`,
      );
    }

    // LEGACY: depVuln* fields populated from capabilities.depVulns;
    // removed in Phase 10e.C when reports stop reading these.
    // Phase 10e.B.1.5 also decoupled this from the dotnet-format
    // availability gate (which had no logical reason to gate vulns).
    const dvOutcome = await gatherCsharpDepVulnsResult(cwd);
    if (dvOutcome.kind === 'success') {
      const e = dvOutcome.envelope;
      metrics.depVulnCritical = e.counts.critical;
      metrics.depVulnHigh = e.counts.high;
      metrics.depVulnMedium = e.counts.medium;
      metrics.depVulnLow = e.counts.low;
      metrics.depAuditTool = e.tool;
      metrics.toolsUsed!.push('dotnet-vulnerable');
    } else if (dvOutcome.kind === 'parse-error') {
      metrics.toolsUnavailable!.push('dotnet-vulnerable (parse error)');
    }
    // 'tool-missing' (n/a — provider always tries dotnet) and 'no-output'
    // (zero vulns OR dotnet missing) are silent, matching prior behavior.

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
