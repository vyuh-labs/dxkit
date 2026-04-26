import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { resolveCvssScores } from '../analyzers/tools/osv';
import { fileExists, run, runExitCode } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
  LicenseFinding,
  LicensesResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
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
 * `dotnet list package --vulnerable --format json` shape (see
 * https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-list-package).
 * Field names match the actual dotnet 8 SDK JSON output verbatim:
 * `vulnerabilities` (not `advisories`) and `advisoryurl` (lowercase,
 * not `advisoryUrl`). Earlier revisions of this parser used the
 * camelCase shape and silently produced zero findings on real dotnet
 * output — surfaced by the cross-ecosystem benchmark fixture in
 * Phase 10h.6.8.
 *
 * Per-vulnerability entries are LEAN compared to other ecosystems'
 * tools — no CVSS, no fix version, no description. We compensate via
 * OSV alias-fallback (advisoryurl → GHSA → OSV.dev) for cvssScore;
 * fix version + summary remain unpopulated until a richer source is
 * wired (e.g. NuGet's vulnerability API).
 */
interface DotnetVulnerability {
  advisoryurl?: string;
  severity?: string;
}

interface DotnetTopLevelPackage {
  id?: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  vulnerabilities?: DotnetVulnerability[];
}

/**
 * Transitive packages differ from top-level entries only in that they
 * lack `requestedVersion` (never manifest-declared). `dotnet list
 * package --vulnerable --include-transitive --format json` emits them
 * separately per framework so downstream can distinguish user-authored
 * deps from auto-resolved ones. Attribution to a top-level parent is
 * NOT provided by the dotnet CLI — `project.assets.json` walk fills
 * that in downstream.
 */
interface DotnetTransitivePackage {
  id?: string;
  resolvedVersion?: string;
  vulnerabilities?: DotnetVulnerability[];
}

interface DotnetFramework {
  framework?: string;
  topLevelPackages?: DotnetTopLevelPackage[];
  transitivePackages?: DotnetTransitivePackage[];
}

interface DotnetVulnerableReport {
  projects?: Array<{
    path?: string;
    frameworks?: DotnetFramework[];
  }>;
}

/**
 * Subset of `project.assets.json` (NuGet's lockfile equivalent) we
 * consume. Real file has additional sections for runtime targets,
 * package folders, signing info — not relevant for dep-graph walking.
 *
 * Structure we care about:
 *   targets.<framework>.<Pkg>/<Version>.dependencies = { <SubPkg>: <range> }
 *     — the forward dep edges, keyed by Pkg/Version for uniqueness.
 *   project.frameworks.<framework>.dependencies = { <Pkg>: { target, version } }
 *     — the top-level (directly manifest-declared) deps per framework.
 */
interface ProjectAssetsJson {
  targets?: Record<
    string,
    Record<string, { dependencies?: Record<string, string>; type?: string }>
  >;
  project?: {
    frameworks?: Record<string, { dependencies?: Record<string, unknown> }>;
  };
}

/**
 * Map dotnet's textual severity to the four-tier `SeverityCounts`
 * domain. NuGet uses critical/high/moderate/low (moderate maps to
 * medium, matching npm-audit).
 */
function normalizeDotnetSeverity(s: string | undefined): keyof SeverityCounts {
  switch (s?.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Extract the GHSA identifier from an advisory URL like
 * `https://github.com/advisories/GHSA-...`. dotnet's --vulnerable
 * output uses the GitHub advisory URL almost universally, so this
 * is the primary id source for C# findings.
 */
function extractGhsaIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * Pure parser for `dotnet list package --vulnerable --include-transitive
 * --format json`. Extracted from the gather function so it can be
 * unit-tested without a real .NET SDK on the dev machine (10h.5
 * release-time validation runs the full pipeline). Returns null when
 * the input is malformed; otherwise returns counts + findings ready
 * for downstream alias enrichment + top-level attribution.
 *
 * Both top-level and transitive packages are iterated. Top-level
 * findings carry `topLevelDep = [self]` (they ARE manifest deps);
 * transitive findings emit with `topLevelDep` unset — the gather
 * function then fills it from `project.assets.json` if available.
 * Leaving attribution unset on transitives when assets.json is absent
 * matches Python's venv-missing behavior: degrade gracefully rather
 * than invent false parents.
 */
export function parseDotnetVulnerableOutput(
  raw: string,
): { counts: SeverityCounts; findings: DepVulnFinding[] } | null {
  let data: DotnetVulnerableReport;
  try {
    data = JSON.parse(raw) as DotnetVulnerableReport;
  } catch {
    return null;
  }

  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  const findings: DepVulnFinding[] = [];

  const emit = (
    pkgId: string,
    resolvedVersion: string | undefined,
    vulnerabilities: DotnetVulnerability[],
    topLevelDep: string[] | undefined,
  ): void => {
    for (const vuln of vulnerabilities) {
      const severity = normalizeDotnetSeverity(vuln.severity);
      if (severity === 'critical') critical++;
      else if (severity === 'high') high++;
      else if (severity === 'medium') medium++;
      else low++;

      const ghsa = extractGhsaIdFromUrl(vuln.advisoryurl);
      const id = ghsa ?? `nuget-${pkgId}@${resolvedVersion ?? 'unknown'}`;
      const finding: DepVulnFinding = {
        id,
        package: pkgId,
        installedVersion: resolvedVersion,
        tool: 'dotnet-vulnerable',
        severity,
      };
      if (topLevelDep && topLevelDep.length > 0) finding.topLevelDep = topLevelDep;
      if (ghsa) finding.aliases = [ghsa];
      if (vuln.advisoryurl) finding.references = [vuln.advisoryurl];
      findings.push(finding);
    }
  };

  for (const proj of data.projects ?? []) {
    for (const fw of proj.frameworks ?? []) {
      for (const pkg of fw.topLevelPackages ?? []) {
        if (!pkg.id) continue;
        emit(pkg.id, pkg.resolvedVersion, pkg.vulnerabilities ?? [], [pkg.id]);
      }
      for (const pkg of fw.transitivePackages ?? []) {
        if (!pkg.id) continue;
        // topLevelDep stays unset; `attachCsharpTopLevelAttribution`
        // downstream fills it from project.assets.json when available.
        emit(pkg.id, pkg.resolvedVersion, pkg.vulnerabilities ?? [], undefined);
      }
    }
  }
  return { counts: { critical, high, medium, low }, findings };
}

/**
 * Pure parser for `obj/project.assets.json`. Extracts the forward
 * dep graph keyed by package name (collapsing versions — same as
 * TS/Go/Rust packs) plus the set of top-level (direct manifest)
 * package names across every target framework declared in `project`.
 *
 * Multi-framework projects: graphs are merged across target
 * frameworks into a single name-level edge map. Top-level set is
 * the union of declared direct deps across frameworks. This
 * over-attributes slightly if a package is direct in netstandard2.0
 * but transitive in net8.0 — it gets listed as a top-level — but the
 * simplification beats per-framework multi-reporting complexity.
 */
export function parseProjectAssetsJson(
  raw: string,
): { topLevels: string[]; edges: Map<string, Set<string>> } | null {
  let data: ProjectAssetsJson;
  try {
    data = JSON.parse(raw) as ProjectAssetsJson;
  } catch {
    return null;
  }
  if (!data.targets && !data.project) return null;

  const nameOf = (key: string): string => {
    // Keys are `Pkg/Version` — split on '/' and take the package part.
    const slash = key.indexOf('/');
    return slash < 0 ? key : key.slice(0, slash);
  };

  const edges = new Map<string, Set<string>>();
  for (const target of Object.values(data.targets ?? {})) {
    for (const [pkgVerKey, pkgEntry] of Object.entries(target)) {
      const srcName = nameOf(pkgVerKey);
      const deps = pkgEntry?.dependencies;
      if (!deps) continue;
      const bucket = edges.get(srcName) ?? new Set<string>();
      for (const depName of Object.keys(deps)) {
        bucket.add(depName);
      }
      edges.set(srcName, bucket);
    }
  }

  const topLevels = new Set<string>();
  for (const fw of Object.values(data.project?.frameworks ?? {})) {
    for (const name of Object.keys(fw?.dependencies ?? {})) {
      topLevels.add(name);
    }
  }

  return { topLevels: [...topLevels].sort(), edges };
}

/**
 * BFS the parsed asset graph to produce a per-package-name index of
 * its top-level ancestors. Mirrors `buildTsTopLevelDepIndex` /
 * `buildRustTopLevelDepIndex` in shape and semantics; attribution is
 * coarse (name-level) and unions across multiple reachable parents.
 */
export function buildCsharpTopLevelDepIndex(parsed: {
  topLevels: ReadonlyArray<string>;
  edges: ReadonlyMap<string, ReadonlySet<string>>;
}): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const top of parsed.topLevels) {
    const visited = new Set<string>();
    const queue: string[] = [top];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      const bucket = result.get(name) ?? new Set<string>();
      bucket.add(top);
      result.set(name, bucket);
      for (const child of parsed.edges.get(name) ?? []) {
        if (!visited.has(child)) queue.push(child);
      }
    }
  }
  const sorted = new Map<string, string[]>();
  for (const [name, parents] of result) {
    sorted.set(name, [...parents].sort());
  }
  return sorted;
}

/**
 * Locate every `obj/project.assets.json` under cwd (NuGet's lockfile
 * equivalent, created by `dotnet restore`). Unlike the shared
 * `findMatchingRecursive`, we can't skip `obj/` — that's where the
 * file lives. Walks up to `maxDepth` levels to cover solutions with
 * multiple nested projects.
 *
 * Phase 10h.6.7 (closes D003): earlier revisions returned only the
 * first match, so multi-project solutions got transitive attribution
 * from one project's graph, missing vulns reachable only through
 * siblings. `loadCsharpTopLevelDepIndex` now calls this and merges
 * every returned graph before BFS.
 *
 * Exported for test coverage.
 */
export function findAllProjectAssetsJson(cwd: string, maxDepth = 4): string[] {
  const out: string[] = [];
  function search(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Direct-child shortcut: if this directory is `obj`, collect the
    // file right here before recursing siblings. Skipping recursion
    // into `obj/` keeps the walk bounded (obj/ contains no deeper
    // projects of its own).
    if (path.basename(dir) === 'obj') {
      for (const e of entries) {
        if (e.isFile() && e.name === 'project.assets.json') {
          out.push(path.join(dir, e.name));
        }
      }
      return;
    }
    for (const e of entries) {
      if (
        e.name.startsWith('.') ||
        ['node_modules', 'bin', 'TestResults', 'packages'].includes(e.name)
      ) {
        continue;
      }
      if (e.isDirectory()) {
        search(path.join(dir, e.name), depth + 1);
      }
    }
  }
  search(cwd, 0);
  return out;
}

/**
 * Merge multiple `project.assets.json` parse results into a single
 * graph. `topLevels` unions across projects; `edges` unions the
 * adjacency sets — if project A lists `Newtonsoft.Json` → `Foo` and
 * project B lists `Newtonsoft.Json` → `Bar`, the merged graph shows
 * both children. Run BFS against the union so advisories reachable
 * through any project's dep graph get attribution.
 *
 * Exported for test coverage.
 */
export function mergeAssetParses(
  parses: ReadonlyArray<{ topLevels: string[]; edges: Map<string, Set<string>> }>,
): { topLevels: string[]; edges: Map<string, Set<string>> } {
  const edges = new Map<string, Set<string>>();
  const topLevels = new Set<string>();
  for (const p of parses) {
    for (const t of p.topLevels) topLevels.add(t);
    for (const [src, children] of p.edges) {
      const bucket = edges.get(src) ?? new Set<string>();
      for (const child of children) bucket.add(child);
      edges.set(src, bucket);
    }
  }
  return { topLevels: [...topLevels].sort(), edges };
}

/**
 * Read + parse every discovered `obj/project.assets.json` under cwd
 * and build the unified top-level attribution index. Returns an empty
 * map on complete failure (no files / all files unreadable) —
 * transitive findings then ship without attribution rather than
 * blocking the scan.
 */
function loadCsharpTopLevelDepIndex(cwd: string): Map<string, string[]> {
  const assetsPaths = findAllProjectAssetsJson(cwd);
  if (assetsPaths.length === 0) return new Map();
  const parses: Array<{ topLevels: string[]; edges: Map<string, Set<string>> }> = [];
  for (const assetsPath of assetsPaths) {
    let raw: string;
    try {
      raw = fs.readFileSync(assetsPath, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseProjectAssetsJson(raw);
    if (parsed) parses.push(parsed);
  }
  if (parses.length === 0) return new Map();
  return buildCsharpTopLevelDepIndex(mergeAssetParses(parses));
}

/**
 * Single source of truth for the csharp pack's dep-vuln gathering.
 * Consumed by `csharpDepVulnsProvider` (capability dispatcher). Runs
 * independently of `dotnet-format` availability — historical bug where
 * projects with `dotnet` but no `dotnet-format` saw zero vuln data.
 *
 * Project-file gating: dotnet list requires a .csproj or .sln in cwd
 * to identify what to scan. Without one it'd fail with a non-JSON
 * error message. Mirrors the python pack manifest gating from 10h.3.3
 * — return null cleanly rather than scan an unrelated scope.
 */
async function gatherCsharpDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  if (!hasCsharpProject(cwd)) return { kind: 'tool-missing' };

  // `--include-transitive` (10h.4.4.c) extends the scan to indirect
  // deps; without it NuGet would only report vulns where the
  // vulnerable package is itself declared in .csproj. Transitive
  // attribution lands via `project.assets.json` below.
  const vulnRaw = run(
    'dotnet list package --vulnerable --include-transitive --format json 2>/dev/null',
    cwd,
    120000,
  );
  if (!vulnRaw) return { kind: 'no-output' };

  const parsed = parseDotnetVulnerableOutput(vulnRaw);
  if (!parsed) return { kind: 'parse-error' };

  const { counts, findings } = parsed;

  // Attach top-level attribution to transitive findings (top-level
  // findings already carry self-attribution from the parser). Skipped
  // when project.assets.json is absent — user hasn't run
  // `dotnet restore`, or the obj/ dir was cleaned. Findings ship with
  // `topLevelDep` unset in that case, matching Python's no-venv path.
  const transitiveNeedsAttribution = findings.some(
    (f) => !f.topLevelDep || f.topLevelDep.length === 0,
  );
  if (transitiveNeedsAttribution) {
    const topLevelIndex = loadCsharpTopLevelDepIndex(cwd);
    if (topLevelIndex.size > 0) {
      for (const f of findings) {
        if (f.topLevelDep && f.topLevelDep.length > 0) continue;
        const parents = topLevelIndex.get(f.package);
        if (parents && parents.length > 0) f.topLevelDep = parents;
      }
    }
  }

  // Alias-fallback CVSS pass: dotnet --vulnerable ships zero CVSS data
  // per advisory; the GHSA id (extracted from advisoryUrl) is the only
  // anchor. resolveCvssScores looks up via GHSA → CVE alias chain.
  if (findings.length > 0) {
    const cvssInputs = findings.map((f) => ({
      primaryId: f.id,
      embeddedCvss: f.cvssScore ?? null,
      aliases: f.aliases ?? [],
    }));
    const resolved = await resolveCvssScores(cvssInputs);
    for (const f of findings) {
      const score = resolved.get(f.id);
      if (score !== null && score !== undefined) f.cvssScore = score;
    }
  }

  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool: 'dotnet-vulnerable',
    enrichment: null,
    counts,
    findings,
  };
  return { kind: 'success', envelope };
}

/** True if `cwd` has a .csproj or .sln file at depth 0 or 1 (workspace
 *  layouts often nest projects one level under the repo root). */
function hasCsharpProject(cwd: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (e.isFile() && (e.name.endsWith('.csproj') || e.name.endsWith('.sln'))) return true;
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
      try {
        const sub = fs.readdirSync(path.join(cwd, e.name), { withFileTypes: true });
        if (sub.some((s) => s.isFile() && (s.name.endsWith('.csproj') || s.name.endsWith('.sln'))))
          return true;
      } catch {
        /* unreadable subdir — ignore */
      }
    }
  }
  return false;
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
    // dotnet-format emits one line per violation in the form
    //   path/to/File.cs(line,col): error CODE: message [project.csproj]
    // (codes include WHITESPACE, FINALNEWLINE, IDE-style rules, etc.).
    // Pre-2.4.2 this filtered for `'Formatted'` substring matches —
    // a string that never appears in real dotnet-format output —
    // resulting in 0 violations on every real C# project despite
    // exitCode != 0 (D016, surfaced by Phase 10i.0.2 cross-ecosystem
    // matrix). Match the canonical `): error CODE:` pattern instead.
    violations = raw ? raw.split('\n').filter((l) => /\): error \w+:/.test(l)).length : 1;
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

  // Top-level attribution reuses project.assets.json via
  // loadCsharpTopLevelDepIndex. Same self-parent invariant as the
  // other packs. Missing assets-json (user hasn't run dotnet restore)
  // leaves isTopLevel unset.
  const topLevelIndex = loadCsharpTopLevelDepIndex(cwd);
  const hasIndex = topLevelIndex.size > 0;

  const findings: LicenseFinding[] = [];
  for (const entry of data) {
    if (!entry.PackageId || !entry.PackageVersion) continue;
    const license = entry.License && entry.License.length > 0 ? entry.License : 'UNKNOWN';
    const parents = hasIndex ? topLevelIndex.get(entry.PackageId) : undefined;
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
      isTopLevel: hasIndex ? (parents?.includes(entry.PackageId) ?? false) : undefined,
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

  permissions: [
    'Bash(dotnet test:*)',
    'Bash(dotnet build:*)',
    'Bash(dotnet format:*)',
    'Bash(dotnet run:*)',
  ],
  ruleFile: 'csharp.md',
  // No templateFiles — .csproj/.sln are project-owned, not pack-generated.
  cliBinaries: ['dotnet'],
  projectYamlBlock: ({ config, enabled }) =>
    [
      `  csharp:`,
      `    enabled: ${enabled}`,
      `    version: "${config.versions.csharp}"`,
      `    quality:`,
      `      lint: true`,
      `      format: true`,
    ].join('\n'),
};
