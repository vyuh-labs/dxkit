import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import {
  buildNugetAdhocLockfile,
  parseCsprojPackageReferences,
  type PackageReferenceEntry,
} from '../analyzers/tools/nuget-package-reference';
import { resolveCvssScores } from '../analyzers/tools/osv';
import { parseOsvScannerFindings } from '../analyzers/tools/osv-scanner-deps';
import { fileExists, run, runExitCode } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { walkPaths } from '../analyzers/tools/walk-paths';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  LicensesProvider,
  RunTestsOutcome,
} from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
  LicenseFinding,
  LicensesGatherOutcome,
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

function findCoberturaArtifact(cwd: string): string | null {
  // Common layouts:
  //   coverage/coverage.cobertura.xml        (explicit run)
  //   TestResults/<guid>/coverage.cobertura.xml  (default `dotnet test --collect`)
  //
  // The canonical walker rightly excludes `TestResults/` (a build-
  // output subtree) from manifest/source discovery, but here we need
  // to look INSIDE it. We run the walker scoped to the TestResults
  // directory itself with `respectIgnore: false` so the bundled
  // excludes don't fire — we're starting from inside the very subtree
  // they were meant to prune. Depth-unlimited so future tooling that
  // nests artifacts deeper than today's `TestResults/<guid>/` shape
  // still finds them.
  const top = path.join(cwd, 'coverage', 'coverage.cobertura.xml');
  if (fs.existsSync(top)) return top;
  const testResults = path.join(cwd, 'TestResults');
  if (!fs.existsSync(testResults)) return null;
  const matches = walkPaths(testResults, {
    extensions: ['.xml'],
    respectIgnore: false,
  }).filter((rel) => rel.endsWith('coverage.cobertura.xml'));
  if (matches.length === 0) return null;
  return path.join(testResults, matches[0]);
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
        packId: 'csharp',
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
export function findAllProjectAssetsJson(cwd: string): string[] {
  // Project-anchored discovery: every `obj/project.assets.json` sits
  // next to a `.csproj`. Find every `.csproj` via the canonical walker
  // (depth-unlimited, exclusion-aware), then probe each project's
  // `obj/project.assets.json` directly. This replaces a parallel
  // depth-capped walker that missed deep monorepos (the .NET WinForms
  // benchmark's .csproj files sit 6–9 levels under repo root) and naturally
  // inherits the same `.gitignore` / `.dxkit-ignore` / standard
  // exclusion rules every other dxkit walker honors.
  const out: string[] = [];
  for (const csproj of findAllCsprojFiles(cwd)) {
    const assets = path.join(path.dirname(csproj), 'obj', 'project.assets.json');
    if (fs.existsSync(assets)) out.push(assets);
  }
  return out;
}

/**
 * Locate every `.csproj` reachable from cwd within `maxDepth` levels.
 * D025f (2.4.7): the direct-parsing fallback iterates this list when
 * `dotnet list package` can't produce output (D036: cwd is a parent
 * of the actual project files, dotnet has no way to pick one).
 *
 * Skips standard non-source dirs (node_modules / bin / obj /
 * TestResults / packages). Unlike `findAllProjectAssetsJson` (which
 * needs `obj/`), this walk's targets sit in project root directories
 * so the obj-skip is fine.
 *
 * Exported for test coverage.
 */
export function findAllCsprojFiles(cwd: string): string[] {
  return walkPaths(cwd, { extensions: ['.csproj'] }).map((rel) => path.join(cwd, rel));
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
 * D025f (2.4.7) — direct PackageReference scan via osv-scanner.
 *
 * Fallback gather path that bypasses `dotnet list package` entirely.
 * Used when (a) dotnet isn't installed or (b) dotnet ran but produced
 * no output (D036: cwd is a parent directory and dotnet can't pick
 * a project file).
 *
 * Architecture:
 *   1. Walk every `.csproj` under cwd (depth 5).
 *   2. Parse each via `parseCsprojPackageReferences`.
 *   3. Union direct PackageReferences across all .csprojs (dedup by
 *      name@version; cross-csproj version collisions documented in
 *      the parser-helper layer as last-write-wins at lockfile time).
 *   4. Generate ad-hoc `packages.lock.json` schema → temp file.
 *   5. Invoke osv-scanner via `--lockfile=NuGet:<tmp>`.
 *   6. Parse output via the shared `parseOsvScannerFindings` (same
 *      helper kotlin/java/ruby packs already use for their osv path).
 *   7. Clean up temp file.
 *
 * Transitive coverage: NOT included. The direct-parsing path only
 * surfaces vulnerabilities in packages explicitly listed in a .csproj's
 * `<PackageReference>` blocks. Industry studies put ~80% of typical
 * .NET CVE surface on direct refs; the remaining ~20% needs
 * `project.assets.json` or `dotnet list --include-transitive` which
 * the D025c path covers when available.
 *
 * Return shape: same `DepVulnGatherOutcome` as the primary gather.
 * `unavailableReason` carries the original dotnet failure reason
 * concatenated with the fallback's own failure (osv-scanner missing,
 * no parseable references, etc.) so the customer can trace BOTH
 * paths' state from a single message.
 */
async function gatherDirectPackageReferenceFallback(
  cwd: string,
  dotnetFailureReason: string,
): Promise<DepVulnGatherOutcome> {
  const csprojs = findAllCsprojFiles(cwd);
  if (csprojs.length === 0) {
    // Shouldn't happen (hasCsharpProject already passed) but defensive
    // in case the walk + the gate diverge somehow.
    return {
      kind: 'unavailable',
      reason: `${dotnetFailureReason}; no .csproj files for direct-parsing fallback`,
    };
  }

  const scanner = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!scanner.available || !scanner.path) {
    return {
      kind: 'unavailable',
      reason: `${dotnetFailureReason}; osv-scanner also unavailable for D025f fallback`,
    };
  }

  // Aggregate PackageReferences across every .csproj. Cross-csproj
  // dedup at the name+version level here; package-only collisions get
  // resolved by `buildNugetAdhocLockfile`'s last-write-wins.
  const entries: PackageReferenceEntry[] = [];
  const seen = new Set<string>();
  for (const csprojPath of csprojs) {
    let xml: string;
    try {
      xml = fs.readFileSync(csprojPath, 'utf-8');
    } catch {
      continue;
    }
    for (const entry of parseCsprojPackageReferences(xml)) {
      const key = `${entry.name}@${entry.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  if (entries.length === 0) {
    return {
      kind: 'no-manifest',
      reason: `${csprojs.length} .csproj files contain no parseable PackageReferences (possibly Central Package Management — Version comes from Directory.Packages.props which D025f doesn't yet resolve)`,
    };
  }

  // osv-scanner v2.x detects lockfile ecosystem by FILENAME — there's
  // no `--lockfile=NuGet:<path>` syntax (verified 2026-05-12 during
  // D025f integration; that syntax was speculation). The NuGet
  // extractor only fires when the file is literally named
  // `packages.lock.json`. We create a process-unique temp DIRECTORY
  // and write the adhoc file inside it as `packages.lock.json`; the
  // dir wraps the file so concurrent dxkit runs don't collide on a
  // single `/tmp/packages.lock.json` path.
  const adhocDir = fs.mkdtempSync(path.join(os.tmpdir(), `dxkit-nuget-adhoc-${process.pid}-`));
  const adhocPath = path.join(adhocDir, 'packages.lock.json');
  try {
    fs.writeFileSync(adhocPath, buildNugetAdhocLockfile(entries));
    const raw = run(
      `${scanner.path} scan source --lockfile=${adhocPath} --format json 2>/dev/null`,
      cwd,
      180000,
    );
    if (!raw) {
      return {
        kind: 'unavailable',
        reason: `${dotnetFailureReason}; D025f fallback ran but osv-scanner produced no output on ${entries.length} parsed PackageReferences`,
      };
    }
    const { counts, findings, vulnsForCvss } = parseOsvScannerFindings(raw, 'NuGet', 'csharp');

    // Per-finding CVSS enrichment — mirrors the primary csharp gather's
    // OSV alias-fallback path. Direct PackageReferences carry the
    // package name + version; osv-scanner emits the advisory IDs;
    // resolveCvssScores attaches scores via GHSA → CVE alias chain.
    if (findings.length > 0) {
      const resolved = await resolveCvssScores(vulnsForCvss);
      for (const f of findings) {
        const score = resolved.get(f.id);
        if (score !== null && score !== undefined) f.cvssScore = score;
      }
    }

    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'osv-scanner-nuget-direct',
      enrichment: 'osv.dev',
      counts,
      findings,
    };
    return { kind: 'success', envelope };
  } finally {
    // Clean up the whole adhoc directory (file + dir). Best-effort —
    // the OS will reap `/tmp/` on next boot if we miss it.
    try {
      fs.unlinkSync(adhocPath);
    } catch {
      /* best-effort */
    }
    try {
      fs.rmdirSync(adhocDir);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Run `dotnet list package --vulnerable --include-transitive` on cwd
 * and return a DepVulnGatherOutcome. The "primary" half of the
 * always-merge G_v4_9 strategy. Pulled out of
 * `gatherCsharpDepVulnsResult` so both halves can run in parallel.
 *
 * Returns no-manifest for the dotnet-not-installed case (the
 * dotnet-vulnerable path simply can't run); the fallback-half is
 * the source of truth in that case.
 */
async function runDotnetVulnerablePath(cwd: string): Promise<DepVulnGatherOutcome> {
  const dotnet = findTool(TOOL_DEFS['dotnet-format'], cwd);
  if (!dotnet.available || !dotnet.path) {
    return {
      kind: 'no-manifest',
      reason: 'dotnet SDK not installed (osv-scanner path covers this case)',
    };
  }

  const vulnRaw = run(
    `${dotnet.path} list package --vulnerable --include-transitive --format json 2>/dev/null`,
    cwd,
    120000,
  );
  if (!vulnRaw) {
    // D036 case: dotnet couldn't pick a project from this cwd (e.g.
    // cwd is the repo root, the .csproj lives in a sub-dir). Treat
    // as no-manifest at this layer; the always-merge wrapper relies
    // on the osv-scanner-nuget-direct half to surface vulns instead.
    return { kind: 'no-manifest', reason: 'dotnet list package produced no output (D036)' };
  }

  const parsed = parseDotnetVulnerableOutput(vulnRaw);
  if (!parsed) {
    return { kind: 'unavailable', reason: 'dotnet list package output failed JSON parse' };
  }

  const { counts, findings } = parsed;

  // Attach top-level attribution to transitive findings (top-level
  // findings already carry self-attribution from the parser). Skipped
  // when project.assets.json is absent — user hasn't run
  // `dotnet restore`, or the obj/ dir was cleaned.
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

  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool: 'dotnet-vulnerable',
    enrichment: null,
    counts,
    findings,
  };
  return { kind: 'success', envelope };
}

/**
 * Single source of truth for the csharp pack's dep-vuln gathering.
 * Consumed by `csharpDepVulnsProvider` (capability dispatcher).
 *
 * G_v4_9 (2.4.7 Phase C1.9) always-merge strategy:
 *
 *   **Both tools run, results merge by fingerprint** when each is
 *   available. The csharp pack's gather is now cwd-invariant: the
 *   same fingerprint set is produced regardless of where cwd points
 *   within the repo. Pre-G_v4_9 the gather was cwd-sensitive (D107):
 *   at sub-roots with stale `obj/project.assets.json`, dotnet
 *   returned 0 findings and the safety-net fallback didn't fire
 *   (its condition required no project.assets.json); at repo-root,
 *   dotnet returned no output (D036) and the fallback fired correctly,
 *   surfacing 2 NuGet CVEs on the .NET WinForms benchmark. Different cwd, different
 *   totals — same disease class as D086/D087/D091 at the pack-contract
 *   layer instead of the consumer layer.
 *
 *   **dotnet path** (`dotnet list package --vulnerable --include-transitive`):
 *   surfaces transitive vulns via NuGet's own resolution when
 *   `dotnet restore` has been run.
 *
 *   **osv-scanner-nuget-direct path**: parses every `.csproj` for
 *   direct PackageReferences, writes an adhoc `packages.lock.json`,
 *   runs osv-scanner. Covers ~80% of typical .NET CVE surface
 *   (direct refs only — no transitive resolution).
 *
 *   Findings union, fingerprint-deduped at (package, installedVersion,
 *   id). Envelope counts recomputed from the merged set. Both tool
 *   names join in the envelope's `tool` field so users see what
 *   actually ran.
 *
 * Manifest gate: a `.csproj` or `.sln` must be findable within depth 5
 * (D035 / `hasCsharpProject`). Below that, the gather doesn't even
 * try — that's a `no-manifest` outcome.
 */
async function gatherCsharpDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  if (!hasCsharpProject(cwd)) {
    return { kind: 'no-manifest', reason: 'no .csproj or .sln found within depth 5' };
  }

  // Run both tools in parallel. Each returns a DepVulnGatherOutcome;
  // we merge whatever succeeds.
  const [primaryOutcome, fallbackOutcome] = await Promise.all([
    runDotnetVulnerablePath(cwd),
    gatherDirectPackageReferenceFallback(cwd, 'G_v4_9 always-merge'),
  ]);

  // Pick the better outcome when both fail to succeed.
  if (primaryOutcome.kind !== 'success' && fallbackOutcome.kind !== 'success') {
    // Surface the more-informative reason. `unavailable` (tool ran
    // and failed) beats `no-manifest` (tool didn't apply).
    if (primaryOutcome.kind === 'unavailable') return primaryOutcome;
    if (fallbackOutcome.kind === 'unavailable') return fallbackOutcome;
    // Both no-manifest → genuinely nothing to scan.
    return {
      kind: 'no-manifest',
      reason:
        'csharp dep-vuln scan unavailable on this cwd: both dotnet and osv-scanner-nuget-direct returned no-manifest',
    };
  }

  // Merge findings from whichever succeeded. Dedup at the pack layer
  // by (package, installedVersion, id) so envelope counts are honest;
  // downstream aggregator also fingerprints to be safe.
  const primaryFindings =
    primaryOutcome.kind === 'success' ? (primaryOutcome.envelope.findings ?? []) : [];
  const fallbackFindings =
    fallbackOutcome.kind === 'success' ? (fallbackOutcome.envelope.findings ?? []) : [];
  const merged: DepVulnFinding[] = [];
  const seen = new Set<string>();
  for (const f of [...primaryFindings, ...fallbackFindings]) {
    const key = `${f.package}\0${f.installedVersion ?? ''}\0${f.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(f);
  }

  // Alias-fallback CVSS pass: dotnet --vulnerable ships zero CVSS data
  // per advisory; the GHSA id (extracted from advisoryUrl) is the only
  // anchor. resolveCvssScores looks up via GHSA → CVE alias chain.
  // Run on the merged set so fallback findings also get enriched if
  // dotnet's path didn't carry them.
  if (merged.length > 0) {
    const cvssInputs = merged.map((f) => ({
      primaryId: f.id,
      embeddedCvss: f.cvssScore ?? null,
      aliases: f.aliases ?? [],
    }));
    const resolved = await resolveCvssScores(cvssInputs);
    for (const f of merged) {
      const score = resolved.get(f.id);
      if (score !== null && score !== undefined) f.cvssScore = score;
    }
  }

  // Recompute counts from merged set so the envelope is internally
  // consistent (pre-G_v4_9 each path computed its own counts; sum
  // would double-count overlapping advisories). aggregator-ok: this
  // builds the pack's DepVulnResult envelope from its OWN findings,
  // which is the dispatcher input — distinct from consumer-side
  // re-aggregation across envelopes that G_v4_8 prohibits.
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of merged) counts[f.severity]++; // aggregator-ok: pack envelope counts from own merged findings

  // Compose envelope tool names from what actually succeeded.
  const tools: string[] = [];
  if (primaryOutcome.kind === 'success') tools.push(primaryOutcome.envelope.tool);
  if (fallbackOutcome.kind === 'success') tools.push(fallbackOutcome.envelope.tool);
  const enrichment =
    fallbackOutcome.kind === 'success' ? fallbackOutcome.envelope.enrichment : null;

  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool: tools.join(', '),
    enrichment,
    counts,
    findings: merged,
  };
  return { kind: 'success', envelope };
}

/**
 * True if `cwd` (or any nested directory up to depth 5) contains a
 * `.csproj` or `.sln` file. Used as the depVulns gather preflight —
 * `dotnet list package --vulnerable` needs a project file in scope.
 *
 * Depth 5 mirrors `csharp.detect()`'s recursive walk (D024 / 2.4.7):
 * enterprise layouts like the .NET WinForms benchmark nest .csproj under
 * `Code/Source/Dev/Core/<Module>/`. Pre-D035, this was a depth-1
 * custom walk; symmetrical with detect()'s old depth-3 limit until
 * D024 broke the symmetry. The Sprint A validation
 * (2026-05-12) surfaced the inconsistency — D025c's tool-registry
 * probe was unreachable from `Code/Source/` because this preflight
 * rejected before reaching it. See D035 in tmp/known-defects.md.
 */
function hasCsharpProject(cwd: string): boolean {
  return (
    dirHasMatching(cwd, /\.(sln|csproj)$/) ||
    walkPaths(cwd, { extensions: ['.csproj', '.sln'] }).length > 0
  );
}

const csharpDepVulnsProvider: DepVulnsProvider = {
  source: 'csharp',
  async gather(cwd) {
    const outcome = await gatherCsharpDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherCsharpDepVulnsResult(cwd);
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

/**
 * Run `dotnet test --collect:"XPlat Code Coverage"` from cwd (D021).
 *
 * `dotnet test --collect` is the canonical way to materialize coverage
 * across the whole solution. It auto-discovers test projects and writes
 * a cobertura XML into `TestResults/<guid>/coverage.cobertura.xml`,
 * where `<guid>` is generated per test run. The artifact param uses
 * the function form so the helper locates the actual file post-run via
 * the existing `findCoberturaArtifact` (which already knows the
 * TestResults layout and the explicit `coverage/coverage.cobertura.xml`
 * fallback).
 *
 * `--results-directory TestResults` pins the parent directory so
 * `findCoberturaArtifact` doesn't have to walk arbitrary roots — the
 * GUID-named subdirectory underneath is still non-deterministic but
 * bounded.
 *
 * Preflight: require a `.csproj` or `.sln` in cwd. Without one, this
 * isn't a .NET project root. We don't preflight `dotnet` itself — the
 * spawn ENOENT path classifies it as `unavailable` cleanly.
 */
function runCsharpTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'csharp',
      cmd: 'dotnet test --collect:"XPlat Code Coverage" --results-directory TestResults',
      cwd,
      artifact: (cwd) => {
        const abs = findCoberturaArtifact(cwd);
        if (!abs) return null;
        return path.relative(cwd, abs).split(path.sep).join('/');
      },
      preflight: (cwd) => {
        const hasManifest =
          dirHasMatching(cwd, /\.(sln|csproj)$/i) ||
          walkPaths(cwd, { extensions: ['.csproj', '.sln'] }).length > 0;
        if (!hasManifest) {
          return 'no .csproj or .sln in this directory tree — not a .NET project';
        }
        return null;
      },
    }),
  );
}

const csharpCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'csharp',
  async gather(cwd) {
    return gatherCsharpCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runCsharpTestsWithCoverage(cwd);
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
  const hasCsproj =
    fileExists(cwd, '*.csproj') || walkPaths(cwd, { extensions: ['.csproj'] }).length > 0;
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
  // Prefer a `.sln` (covers every csproj in the solution in one
  // nuget-license pass) over a single `.csproj`. Within each kind,
  // pick the shallowest match — closest to repo root is the most
  // likely "primary" manifest. Depth-unlimited via the canonical
  // walker, so deep monorepos (manifests 6–9 levels under repo root)
  // discover them where prior hard depth caps silently missed.
  const manifests = walkPaths(cwd, { extensions: ['.csproj', '.sln'] });
  if (manifests.length === 0) return null;
  manifests.sort((a, b) => {
    const aIsSln = a.endsWith('.sln') ? 0 : 1;
    const bIsSln = b.endsWith('.sln') ? 0 : 1;
    if (aIsSln !== bIsSln) return aIsSln - bIsSln;
    return a.split('/').length - b.split('/').length;
  });
  return path.join(cwd, manifests[0]);
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
/**
 * D031-2 (2.4.7) — degraded license inventory fallback.
 *
 * When `nuget-license` is unavailable but we have `.csproj` files,
 * parse direct PackageReferences from each .csproj and emit a
 * LicensesResult with `licenseType: 'UNKNOWN'` per package — name +
 * version only. Reuses the D025f-1 `parseCsprojPackageReferences`
 * helper (and `findAllCsprojFiles` walker) so this fallback shares
 * one truth source with the depVulns direct-scan path.
 *
 * Customer outcome on the .NET WinForms benchmark: pre-D031 → "0 packages" (with the
 * pack reporting `unavailable` because `nuget-license` is missing).
 * Post-D031 → "53 packages identified; license info unavailable" via
 * the markdown framing banner from `analyzers/licenses/index.ts`.
 * The customer can decide remediation BEFORE installing nuget-license
 * (e.g., "we have 53 NuGet deps; install nuget-license to see their
 * licenses" is more actionable than "0 packages").
 *
 * Returns `null` when the degraded path itself can't produce data
 * (no .csproj files at all, or every .csproj has zero parseable
 * PackageReferences). Caller propagates the original `unavailable`
 * outcome in those cases.
 */
function gatherCsharpLicensesDegradedInventory(cwd: string): LicensesResult | null {
  const csprojs = findAllCsprojFiles(cwd);
  if (csprojs.length === 0) return null;

  const entries: PackageReferenceEntry[] = [];
  const seen = new Set<string>();
  for (const csprojPath of csprojs) {
    let xml: string;
    try {
      xml = fs.readFileSync(csprojPath, 'utf-8');
    } catch {
      continue;
    }
    for (const entry of parseCsprojPackageReferences(xml)) {
      const key = `${entry.name}@${entry.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push(entry);
    }
  }
  if (entries.length === 0) return null;

  const findings: LicenseFinding[] = entries.map((e) => ({
    package: e.name,
    version: e.version,
    licenseType: 'UNKNOWN',
    // No license URL / description / supplier — the degraded path only
    // has the manifest reference. Customer can identify what's
    // installed; install nuget-license for the full inventory.
  }));

  return {
    schemaVersion: 1,
    tool: 'csharp-package-reference-degraded',
    findings,
  };
}

function gatherCsharpLicensesResult(cwd: string): LicensesGatherOutcome {
  const input = findCsharpLicenseInput(cwd);
  if (!input) {
    return { kind: 'no-manifest', reason: 'no .csproj or .sln found within depth 3' };
  }

  const status = findTool(TOOL_DEFS['nuget-license'], cwd);
  if (!status.available || !status.path) {
    // D031-2: degraded-inventory fallback. nuget-license is the
    // canonical tool but parsing direct PackageReferences gives the
    // customer at minimum a name+version inventory while the tool
    // is being installed. We surface this through the SUCCESS path
    // (envelope's tool name carries the `-degraded` suffix so
    // downstream renderers can disambiguate) so the LicensesReport's
    // summary count reflects real data — the framing banner from
    // `analyzers/licenses/index.ts` explains the asterisk.
    //
    // Path B (no .csproj or empty PackageReferences across all
    // csprojs): degraded inventory returns null; we propagate the
    // original `unavailable` so the report frames the gap honestly
    // ("0 packages" with the explanatory ⚠ banner).
    const degraded = gatherCsharpLicensesDegradedInventory(cwd);
    if (degraded) return { kind: 'success', envelope: degraded };
    return { kind: 'unavailable', reason: 'nuget-license not installed' };
  }

  const raw = run(`${status.path} -i "${input}" -o JsonPretty 2>/dev/null`, cwd, 180000);
  if (!raw) {
    // D031-2 extended (2.4.7): nuget-license commonly produces no
    // output when `dotnet restore` hasn't been run (no
    // `obj/project.assets.json` for it to read). Rather than tell
    // the customer "0 packages," fall back to direct PackageReference
    // parsing so they get a real inventory. Validated on the .NET WinForms benchmark
    // 2026-05-13: 53 packages surface via the fallback when
    // nuget-license itself returns empty.
    const degraded = gatherCsharpLicensesDegradedInventory(cwd);
    if (degraded) return { kind: 'success', envelope: degraded };
    return { kind: 'unavailable', reason: 'nuget-license produced no output' };
  }

  let data: NugetLicenseEntry[];
  try {
    data = JSON.parse(raw) as NugetLicenseEntry[];
  } catch (err) {
    return { kind: 'unavailable', reason: `nuget-license parse error: ${(err as Error).message}` };
  }
  if (!Array.isArray(data)) {
    return { kind: 'unavailable', reason: 'nuget-license output was not a JSON array' };
  }

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

  // D031-2 extended (2.4.7): if nuget-license ran AND parsed cleanly
  // but produced zero valid findings, the canonical scan failed
  // silently (typically: assets.json absent → tool emits an empty
  // array). Same customer-visibility concern as the no-output path
  // — fall back to degraded inventory so the customer sees real
  // packages instead of "0 packages." If the degraded path also
  // returns null (no .csproj parseable), drop through to the
  // empty-success path (legitimate "no licenseable deps in this
  // pack's scope").
  if (findings.length === 0) {
    const degraded = gatherCsharpLicensesDegradedInventory(cwd);
    if (degraded) return { kind: 'success', envelope: degraded };
  }

  const envelope: LicensesResult = {
    schemaVersion: 1,
    tool: 'nuget-license',
    findings,
  };
  return { kind: 'success', envelope };
}

const csharpLicensesProvider: LicensesProvider = {
  source: 'csharp',
  async gather(cwd) {
    const outcome = gatherCsharpLicensesResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
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
  // D028 (2.4.7): auto-generated .NET source patterns. Visual Studio's
  // WinForms designer creates `*.designer.cs` (UI scaffolding,
  // typically hundreds of lines, repetitive). T4 templates emit
  // `*.g.cs`. Source generators (Roslyn) emit `*.g.i.cs`. The legacy
  // AssemblyInfo split files (`*.AssemblyInfo.cs`,
  // `*.AssemblyAttributes.cs`) are MSBuild-generated. None of these
  // are human-authored; counting them as "source" inflates Code
  // Quality + Maintainability dimensions on any .NET UI codebase
  // (the .NET WinForms benchmark is the motivating case — large
  // WinForms enterprise app with extensive designer.cs files).
  autogeneratedSourcePatterns: [
    '*.designer.cs',
    '*.Designer.cs',
    '*.g.cs',
    '*.g.i.cs',
    '*.generated.cs',
    '*.AssemblyInfo.cs',
    '*.AssemblyAttributes.cs',
    // WCF "Connected Services" auto-generated proxy classes
    // (svcutil.exe / Add Service Reference). The .NET WinForms
    // benchmark's `Reference.cs` was 42,370 lines of WCF proxy. Other tools'
    // service-reference output (gRPC tools, OpenAPI generators)
    // commonly also emit `Reference.cs`.
    'Reference.cs',
  ],

  // D027 (2.4.7): C# uses XML-doc triple-slash comments above
  // public APIs. Pre-D027 the generic doc-comment heuristic
  // matched JSDoc `/**` only, so the .NET WinForms benchmark's 3,234 .cs files
  // contributed zero to docCommentFiles even though many carry
  // `/// <summary>` blocks. POSIX class `[[:space:]]` for cross-
  // platform grep (BSD vs GNU).
  docCommentPatterns: ['^[[:space:]]*///'],

  // D034 (2.4.7): canonical .NET TLS-bypass idioms. Pre-D034 only
  // Node-shaped (`NODE_TLS_REJECT_UNAUTHORIZED`) and Python-shaped
  // (`VERIFY_SSL`) tokens were grep'd — every C# project reported
  // zero TLS-bypass findings even when using
  // `ServerCertificateValidationCallback = (s,c,ch,e) => true` (the
  // canonical "accept any certificate" pattern). The .NET WinForms
  // benchmark is the motivating case: WCF + enterprise integration code commonly
  // ships permissive callbacks.
  //
  // Listed tokens:
  //   - ServicePointManager.ServerCertificateValidationCallback (legacy)
  //   - HttpClientHandler.ServerCertificateCustomValidationCallback
  //     (HttpClient — .NET Core / 5+)
  //   - SslStream.AuthenticateAsClient* with RemoteCertificateValidationCallback
  //   - HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
  //     (.NET 5+ shorthand — literally named `Dangerous*`)
  tlsBypassPatterns: [
    'ServerCertificateValidationCallback',
    'ServerCertificateCustomValidationCallback',
    'RemoteCertificateValidationCallback',
    'DangerousAcceptAnyServerCertificateValidator',
  ],

  upgradeCommand(name, version) {
    return `dotnet add package ${name} --version ${version}`;
  },

  // .NET spans two very different application shapes: ASP.NET MVC /
  // Web API (controllers, endpoints) and WinForms / WPF desktop
  // (Forms, ViewModels, UserControls). Both are first-class
  // contributors here — a WinForms enterprise app's primary
  // architecture IS its Forms + Services layer, not a notional
  // controllers/ directory that doesn't exist on disk. The narrower
  // routePaths subset stays silent on desktop-only repos so the
  // "Add API documentation" recommendation doesn't fire there.
  architecturalShape: {
    primaryComponentPaths: [
      '/Controllers/',
      '/Services/',
      '/Forms/',
      '/ViewModels/',
      '/Pages/',
      '/Views/',
      '/UserControls/',
      '/Handlers/',
    ],
    routePaths: ['/Controllers/', '/Endpoints/'],
    modelPaths: ['/Models/', '/Entities/', '/DTOs/', '/DataTransferObjects/', '/Domain/'],
    vocabulary: {
      components: 'Forms/Services',
      models: 'models',
      routes: 'endpoints',
    },
    testGapPriority: {
      high: ['/Controllers/', '/Services/', '/Handlers/'],
      medium: ['/Forms/', '/ViewModels/', '/Pages/', '/Views/', '/UserControls/'],
    },
  },

  clocLanguageNames: ['C#'],

  detect(cwd) {
    // Depth 5 covers enterprise .NET layouts like
    // `Code/Source/Dev/Core/<Module>/<Module>.csproj` (D024).
    // Lower limits silently miss these from the repo root.
    return (
      dirHasMatching(cwd, /\.(sln|csproj)$/) ||
      walkPaths(cwd, { extensions: ['.csproj', '.sln'] }).length > 0
    );
  },

  // D025f (2.4.7): osv-scanner added — used by the direct-PackageReference
  // fallback in gatherDirectPackageReferenceFallback when `dotnet list
  // package` can't produce output (D036). Cross-pack tool; kotlin/java/ruby
  // already use it via the shared osv-scanner-deps helper.
  tools: ['dotnet-format', 'nuget-license', 'osv-scanner'],
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
  defaultVersion: '8.0',
  cliBinaries: ['dotnet'],
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/dotnet:2',
    opts: { version: '8.0' },
  },
};
