import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { fileExists, run, runExitCode } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
  LicenseFinding,
  LicensesResult,
  LintGatherOutcome,
  LintResult,
  TestFrameworkResult,
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
 * Consumed by `csharpDepVulnsProvider` (capability dispatcher). Runs
 * independently of `dotnet-format` availability — historical bug where
 * projects with `dotnet` but no `dotnet-format` saw zero vuln data.
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
 * Consumed by `csharpLintProvider` (capability dispatcher).
 *
 * dotnet-format is a formatter, not a tiered linter — it emits binary
 * pass/fail per file. Violations are formatting issues (indentation,
 * spacing), not correctness. This helper reports them at `low` tier so
 * they don't inflate the Quality/Slop score.
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
 * dir or `dotnet test --collect`'s TestResults/<guid>/ subtree). Consumed
 * by `csharpCoverageProvider` (capability dispatcher).
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

/**
 * Capture C# `using` directives from source text, including
 * `using static Foo`, aliased (`using X = Foo.Bar`), and plain forms.
 * C# has no deterministic file-level resolver (namespaces aren't files),
 * so this is the only raw helper the imports capability needs. Exported
 * for unit tests.
 */
export function extractCsharpImportsRaw(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*using\s+(?:static\s+)?(?:[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Enumerate .cs source files and capture the pack's per-file imports.
 * C# has no `resolveImport` (namespaces don't map to file paths
 * deterministically), so `edges` is always empty.
 */
function gatherCsharpImportsResult(cwd: string): ImportsResult | null {
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f -name "*.cs" ${excludes} 2>/dev/null`, cwd);
  if (!raw) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();

  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    const rel = p.replace(/^\.\//, '');
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    extracted.set(rel, extractCsharpImportsRaw(content));
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'csharp-imports',
    sourceExtensions: ['.cs'],
    extracted,
    edges: new Map(),
  };
}

const csharpImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'csharp',
  async gather(cwd) {
    return gatherCsharpImportsResult(cwd);
  },
};

/**
 * Detect C# test projects by the runner package referenced in the
 * project's `.csproj` file — xunit, NUnit, and MSTest cover the
 * dominant majority of .NET test projects. A repo without any
 * `.csproj` referencing these returns null.
 */
function gatherCsharpTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  const hasCsproj = fileExists(cwd, '*.csproj') || !!findMatchingRecursive(cwd, /\.csproj$/, 3);
  if (!hasCsproj) return null;

  const csproj = run(
    "find . -name '*.csproj' -exec grep -l 'xunit\\|nunit\\|MSTest' {} \\; 2>/dev/null | head -1",
    cwd,
  );
  if (!csproj) return null;
  return { schemaVersion: 1, tool: 'csharp', name: 'dotnet-test' };
}

const csharpTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'csharp',
  async gather(cwd) {
    return gatherCsharpTestFrameworkResult(cwd);
  },
};

/**
 * Per-package shape emitted by `nuget-license -o JsonPretty`. Field
 * names follow the tool's PascalCase convention. Optional fields are
 * emitted as empty strings by the tool, not omitted — the mapping
 * below normalises empties to undefined.
 */
interface NugetLicenseEntry {
  PackageId: string;
  PackageVersion: string;
  License?: string;
  LicenseUrl?: string;
  PackageProjectUrl?: string;
  Authors?: string;
  Copyright?: string;
  Description?: string;
}

/**
 * Locate the best input for nuget-license. Prefers a `.sln` at repo
 * root (covers every csproj in the solution in one pass), falls back
 * to any `.csproj` found within three levels. Returns an absolute path
 * or null — callers skip cleanly on null.
 */
function findCsharpLicenseInput(cwd: string): string | null {
  // .sln in root first — one pass over the whole solution.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return null;
  }
  const sln = entries.find((e) => e.isFile() && e.name.endsWith('.sln'));
  if (sln) return path.join(cwd, sln.name);
  // Fall back to first .csproj reachable within the standard depth.
  return findMatchingRecursive(cwd, /\.csproj$/, 3);
}

/**
 * Single source of truth for the csharp pack's license gathering.
 * Consumed by `csharpLicensesProvider` (capability dispatcher).
 *
 * Delegates entirely to the `nuget-license` global .NET tool (OSS,
 * MIT-licensed, established) — no custom .nuspec or project.assets.json
 * parsing. Matches the pattern of the other four packs: one ecosystem
 * tool, wrapped. Returns null cleanly when no .sln/.csproj is present
 * or when the tool isn't installed.
 */
function gatherCsharpLicensesResult(cwd: string): LicensesResult | null {
  const input = findCsharpLicenseInput(cwd);
  if (!input) return null;

  const status = findTool(TOOL_DEFS['nuget-license'], cwd);
  if (!status.available || !status.path) return null;

  const raw = run(`${status.path} -i "${input}" -o JsonPretty 2>/dev/null`, cwd, 180000);
  if (!raw) return null;

  let data: NugetLicenseEntry[];
  try {
    data = JSON.parse(raw) as NugetLicenseEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;

  const findings: LicenseFinding[] = [];
  for (const entry of data) {
    if (!entry.PackageId || !entry.PackageVersion) continue;
    const license = entry.License && entry.License.length > 0 ? entry.License : 'UNKNOWN';
    findings.push({
      package: entry.PackageId,
      version: entry.PackageVersion,
      licenseType: license,
      sourceUrl:
        (entry.PackageProjectUrl && entry.PackageProjectUrl.length > 0
          ? entry.PackageProjectUrl
          : entry.LicenseUrl) || undefined,
      description:
        entry.Description && entry.Description.length > 0 ? entry.Description : undefined,
      supplier: entry.Authors && entry.Authors.length > 0 ? entry.Authors : undefined,
    });
  }

  return {
    schemaVersion: 1,
    tool: 'nuget-license',
    findings,
  };
}

const csharpLicensesProvider: CapabilityProvider<LicensesResult> = {
  source: 'csharp',
  async gather(cwd) {
    return gatherCsharpLicensesResult(cwd);
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

  tools: ['dotnet-format', 'nuget-license'],
  // p/csharp semgrep ruleset is sparse — skip until it matures.
  semgrepRulesets: [],

  capabilities: {
    depVulns: csharpDepVulnsProvider,
    lint: csharpLintProvider,
    coverage: csharpCoverageProvider,
    imports: csharpImportsProvider,
    testFramework: csharpTestFrameworkProvider,
    licenses: csharpLicensesProvider,
  },

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
};
