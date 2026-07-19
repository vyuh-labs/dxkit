import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import {
  buildNugetAdhocLockfile,
  parseCsprojPackageReferences,
  type PackageReferenceEntry,
} from '../analyzers/tools/nuget-package-reference';
import { resolveCvssScores } from '../analyzers/tools/osv';
import { parseOsvScannerFindings } from '../analyzers/tools/osv-scanner-deps';
import { fileExists, run, runExitCode, runWithExit } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { readRepoFile } from './version-detect';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  LicensesProvider,
  RunTestsOutcome,
} from './capabilities/provider';
import type {
  CorrectnessCommand,
  CorrectnessContext,
  CorrectnessProvider,
} from './capabilities/correctness';
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
import type { LanguageSupport, LintSeverity } from './types';
import type { LintGateProvider } from './capabilities/lint-gate';
import { hashFileInput } from './capabilities/recall-inputs';
import type { ExecutionRequirement } from '../execution';

/**
 * Run dxkit's OWN `dotnet` subprocesses (build / format / test for ANALYSIS,
 * the correctness floor, and the Roslyn lint gate) in invariant globalization
 * mode. A minimal WSL / container / CI image often lacks libicu, where every
 * `dotnet` invocation FailFast-crashes with a cryptic "Couldn't find a valid
 * ICU package installed" — and dxkit's analysis needs no culture-specific
 * globalization, so invariant mode is the correct, sudo-free unblock. Set once
 * in this process's env (inherited by every dotnet child dxkit spawns — the
 * `run()` calls here AND the `{bin:'dotnet'}` commands the floor/lint runner
 * executes), and NEVER overrides a value the user set themselves.
 */
function ensureDotnetInvariant(): void {
  if (process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT === undefined) {
    process.env.DOTNET_SYSTEM_GLOBALIZATION_INVARIANT = '1';
  }
}

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
  /** Per-project errors dotnet emits INSIDE the JSON (exit stays 0) — the
   *  load-bearing one: `No assets file was found ... Please run restore`
   *  on every unrestored project. */
  problems?: Array<{
    project?: string;
    level?: string;
    text?: string;
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
export function parseDotnetVulnerableOutput(raw: string): {
  counts: SeverityCounts;
  findings: DepVulnFinding[];
  /** Projects the report says it could NOT observe (`No assets file was
   *  found ... Please run restore`, level error). Non-empty means this
   *  output is a PARTIAL view of the dependency tree — the caller must
   *  refuse to read it as ran-and-clean (the unrestored-tree class, caught live on a real org repo: an
   *  unrestored tree parsed as 0 findings, the baseline read
   *  "comparable", and CI's restored scan false-blocked 9 pre-existing
   *  vulns as the PR's). */
  unrestoredProjects: string[];
} | null {
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
  const unrestoredProjects = (data.problems ?? [])
    .filter(
      (p) =>
        p.level === 'error' &&
        typeof p.text === 'string' &&
        /no assets file was found|please run restore/i.test(p.text),
    )
    .map((p) => p.project ?? '(unknown project)');

  return { counts: { critical, high, medium, low }, findings, unrestoredProjects };
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
    // Exit-aware (VERIFY-40 F-7): 0/1 = complete scan (clean / vulns found);
    // anything else = the scan errored and its JSON may be PARTIAL — a
    // degraded OSV response once wrote a 1-of-14 baseline here that
    // false-blocked the next check 13 times. Partial is disclosed
    // unavailable, never recorded as a complete observation.
    const { code, stdout: raw } = runWithExit(
      `${scanner.path} scan source --lockfile=${adhocPath} --format json`,
      cwd,
      180000,
    );
    if (code !== 0 && code !== 1) {
      return {
        kind: 'unavailable',
        reason:
          `${dotnetFailureReason}; osv-scanner exited ` +
          `${code ?? 'without a code (timeout/spawn failure)'} on the D025f fallback — the ` +
          `scan errored, so its output may be partial and was discarded`,
      };
    }
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
 * Discover the repo's COMMITTED `packages.lock.json` files. NuGet writes
 * one next to each project (`<ProjectDir>/packages.lock.json`) when lock
 * files are enabled (`RestorePackagesWithLockFile` / CI restore), and it
 * records the FULL resolved transitive tree with pinned versions — the
 * exact input osv-scanner needs for transitive coverage. Anchored to the
 * `.csproj` discovery so it shares the canonical depth-unlimited walker.
 */
export function findRealPackagesLockFiles(cwd: string): string[] {
  const out: string[] = [];
  for (const csproj of findAllCsprojFiles(cwd)) {
    const lock = path.join(path.dirname(csproj), 'packages.lock.json');
    if (fs.existsSync(lock)) out.push(lock);
  }
  return out;
}

/**
 * Scan the repo's real `packages.lock.json` files with osv-scanner. This
 * is the TRANSITIVE-capable osv path: unlike the direct-PackageReference
 * fallback (which synthesizes a lockfile from `.csproj` direct refs and
 * therefore can't see transitive deps), a committed lock file already
 * carries the entire resolved tree, so osv-scanner surfaces vulnerable
 * transitive packages (e.g. a CVE in `Azure.Identity` reached through
 * `Microsoft.Data.SqlClient`) without needing `dotnet` installed or a
 * `dotnet restore` to have run.
 *
 * osv-scanner detects NuGet by the literal filename `packages.lock.json`,
 * so the real files are passed straight through `--lockfile=`.
 */
async function gatherRealLockfilePath(
  cwd: string,
  lockfiles: string[],
): Promise<DepVulnGatherOutcome> {
  const scanner = findTool(TOOL_DEFS['osv-scanner'], cwd);
  if (!scanner.available || !scanner.path) {
    return {
      kind: 'unavailable',
      reason: `osv-scanner unavailable for packages.lock.json transitive scan (${lockfiles.length} lock files found)`,
    };
  }

  const lockfileFlags = lockfiles.map((f) => `--lockfile=${f}`).join(' ');
  // Exit-aware for the same reason as the D025f fallback (VERIFY-40 F-7).
  const { code, stdout: raw } = runWithExit(
    `${scanner.path} scan source ${lockfileFlags} --format json`,
    cwd,
    180000,
  );
  if (code !== 0 && code !== 1) {
    return {
      kind: 'unavailable',
      reason:
        `osv-scanner exited ${code ?? 'without a code (timeout/spawn failure)'} on ` +
        `${lockfiles.length} packages.lock.json file(s) — the scan errored, so its output ` +
        `may be partial and was discarded`,
    };
  }
  if (!raw) {
    return {
      kind: 'unavailable',
      reason: `osv-scanner produced no output on ${lockfiles.length} packages.lock.json file(s)`,
    };
  }

  const { counts, findings, vulnsForCvss } = parseOsvScannerFindings(raw, 'NuGet', 'csharp');
  if (findings.length > 0) {
    const resolved = await resolveCvssScores(vulnsForCvss);
    for (const f of findings) {
      const score = resolved.get(f.id);
      if (score !== null && score !== undefined) f.cvssScore = score;
    }
  }

  const envelope: DepVulnResult = {
    schemaVersion: 1,
    tool: 'osv-scanner-nuget-lockfile',
    enrichment: 'osv.dev',
    counts,
    findings,
  };
  return { kind: 'success', envelope };
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
  ensureDotnetInvariant();

  const vulnRaw = run(
    `${dotnet.path} list package --vulnerable --include-transitive --format json`,
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

  // An unrestored project makes this half's view PARTIAL — reading it as
  // ran-and-clean is the false-clean class (proven live: an unrestored
  // tree reported 1 finding where the restored tree reports 16, and the
  // committed baseline then false-blocked CI's true findings as net-new).
  // Unavailable is honest: this half drops out of provenance, so Rule 19
  // sees the environments differ instead of "comparable and clean". The
  // osv half still covers committed lockfiles / direct references.
  if (parsed.unrestoredProjects.length > 0) {
    return {
      kind: 'unavailable',
      reason:
        `dotnet list package could not observe ${parsed.unrestoredProjects.length} unrestored ` +
        'project(s) (no assets file) — run `dotnet restore` for the full transitive audit',
    };
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
 *   **osv path**: prefers the repo's COMMITTED `packages.lock.json`
 *   files (`osv-scanner-nuget-lockfile`) — these carry the full
 *   resolved transitive tree, so osv surfaces vulnerable transitive
 *   deps (e.g. `Azure.Identity` reached through `Microsoft.Data.SqlClient`)
 *   with no `dotnet`/restore required. When no lock file is committed it
 *   falls back to `osv-scanner-nuget-direct`: parse every `.csproj` for
 *   direct PackageReferences, write an adhoc `packages.lock.json`, run
 *   osv-scanner (direct refs only — no transitive resolution).
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

  // Run the dotnet path and the osv path in parallel; merge whatever
  // succeeds. The osv half prefers the repo's COMMITTED
  // `packages.lock.json` files (full transitive tree, no `dotnet`
  // required) and only falls back to the direct-PackageReference
  // synthesis when no lock file is committed — so a repo that uses lock
  // files gets transitive coverage from osv even when `dotnet` is absent
  // (the case that silently dropped vulnerable transitive deps before).
  const realLockfiles = findRealPackagesLockFiles(cwd);
  const osvHalf =
    realLockfiles.length > 0
      ? gatherRealLockfilePath(cwd, realLockfiles)
      : gatherDirectPackageReferenceFallback(cwd, 'G_v4_9 always-merge');
  const [primaryOutcome, fallbackOutcome] = await Promise.all([
    runDotnetVulnerablePath(cwd),
    osvHalf,
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
 * Depth 5 mirrors `csharp.detect()`'s recursive walk: deeply-nested
 * enterprise layouts nest .csproj several levels down, e.g.
 * `app/modules/Core/<Module>/`. An earlier depth-1 custom walk left
 * the deeper project files unreachable — the tool-registry probe
 * couldn't see a .csproj because this preflight rejected before
 * descending far enough. The depth-5 walk restores symmetry with
 * detect().
 */
function hasCsharpProject(cwd: string): boolean {
  return (
    dirHasMatching(cwd, /\.(sln|csproj)$/) ||
    walkPaths(cwd, { extensions: ['.csproj', '.sln'] }).length > 0
  );
}

const csharpDepVulnsProvider: DepVulnsProvider = {
  source: 'csharp',
  // Host-agnostic BY DESIGN, unlike the build-based C# capabilities: the
  // osv-scanner half (a registry tool — Rule 1) reads committed
  // packages.lock.json / PackageReference entries with no dotnet and no
  // build, precisely so dependency auditing works where the Windows build
  // cannot run. The dotnet half enriches when present; it is not required.
  execution: (): ExecutionRequirement => ({
    hosts: ['any'],
    toolchains: [],
    needsBuild: false,
    buildTarget: 'none',
    weight: 'cheap',
  }),
  manifestPatterns: [
    '*.csproj',
    '*.sln',
    'packages.lock.json',
    'packages.config',
    'Directory.Packages.props',
  ],
  // NuGet lockfiles are per-project when enabled; csproj deliberately NOT
  // listed (projects resolve from the solution tree, already root-audited).
  lockfilePatterns: ['packages.lock.json'],
  async gather(cwd) {
    const outcome = await gatherCsharpDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherCsharpDepVulnsResult(cwd);
  },
};

/**
 * Severity tier for a Roslyn/MSBuild diagnostic code. The security-relevant
 * analyzer families rank high — CA21xx (the security category: SQL-injection
 * review and friends), CA3xxx (injection), CA5xxx (crypto). Other CA
 * design/usage rules, CS compiler warnings, and SYSLIB obsoletions are
 * medium; IDE style rules and formatter codes (WHITESPACE, FINALNEWLINE)
 * are low. Non-string input short-circuits to 'low' (the mapLintSeverity
 * contract — real tool output occasionally omits the code).
 */
export function mapRoslynSeverity(code: string | null | undefined): LintSeverity {
  if (typeof code !== 'string') return 'low';
  const c = code.toUpperCase();
  if (/^CA(21|3|5)\d+/.test(c)) return 'high';
  if (/^(CA|CS|SYSLIB)\d+/.test(c)) return 'medium';
  return 'low';
}

/**
 * Tiered counts from a `dotnet build` output stream — one diagnostic per
 * canonical warning line (the same shape the lint gate parses), deduplicated
 * by (file, line, rule) because a multi-targeted project re-emits every
 * diagnostic once per TFM. Exported for the parse-contract tests.
 */
export function countRoslynWarnings(raw: string): LintResult['counts'] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const re = new RegExp(CSHARP_MSBUILD_WARNING_PARSE);
  const seen = new Set<string>();
  for (const lineText of raw.split('\n')) {
    const m = re.exec(lineText.trim());
    if (!m?.groups) continue;
    const key = `${m.groups.file}(${m.groups.line}):${m.groups.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[mapRoslynSeverity(m.groups.rule)]++;
  }
  return counts;
}

/**
 * Single source of truth for the csharp pack's lint gathering.
 * Consumed by `csharpLintProvider` (capability dispatcher).
 *
 * The real C# linter is the compiler: Roslyn analyzers ride `dotnet build`,
 * emitting `File.cs(l,c): warning CAxxxx: …` lines — the same canonical
 * stream the lint gate parses — which tier through `mapRoslynSeverity`.
 * `--no-incremental` is load-bearing: an incremental build skips up-to-date
 * projects and RE-EMITS NOTHING, which would zero the counts on every
 * second scan of an unchanged tree.
 *
 * A repo `dotnet build` cannot compile (legacy .NET Framework projects,
 * broken trees — any `error` diagnostic means the warning stream is
 * partial and untrustworthy) falls back to the formatter path: dotnet-format
 * violations are formatting issues, not correctness, reported at `low` tier
 * so they don't inflate the Quality/Slop score.
 */
function gatherCsharpLintResult(cwd: string): LintGatherOutcome {
  const dotnet = findTool(TOOL_DEFS['dotnet-format'], cwd);
  if (!dotnet.available) {
    return { kind: 'unavailable', reason: 'not installed' };
  }
  ensureDotnetInvariant();

  const buildRaw = run('dotnet build --no-incremental --nologo -clp:NoSummary 2>&1', cwd, 180000);
  if (buildRaw !== '' && !/\): error \w+:|error (MSB|NETSDK)\d+/.test(buildRaw)) {
    return {
      kind: 'success',
      envelope: {
        schemaVersion: 1,
        tool: 'roslyn-analyzers',
        counts: countRoslynWarnings(buildRaw),
      },
    };
  }

  const exitCode = runExitCode('dotnet format --verify-no-changes', cwd, 120000);
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
  const files = walkSourceFiles(cwd, {
    extensions: ['.cs'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();

  for (const rel of files) {
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

  // Scan each .csproj for a known test-runner package reference. Reads
  // files directly via the cross-platform walker rather than shelling
  // out to `find … -exec grep | head` (POSIX-only).
  // Case-sensitive to match the prior `grep 'xunit\|nunit\|MSTest'`
  // exactly (no behavior change bundled into the refactor).
  const runnerPattern = /xunit|nunit|MSTest/;
  const hasRunner = walkPaths(cwd, { extensions: ['.csproj'] }).some((rel) => {
    try {
      return runnerPattern.test(fs.readFileSync(path.join(cwd, rel), 'utf-8'));
    } catch {
      return false;
    }
  });
  if (!hasRunner) return null;
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

  const raw = run(`${status.path} -i "${input}" -o JsonPretty`, cwd, 180000);
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

/** Does cwd have a build target `dotnet` can auto-discover (a `.sln`, or a
 *  `.csproj` at the root)? Without one, `dotnet build`/`test` with no argument
 *  can't tell what to build, so the floor skips rather than erroring. */
function csharpHasBuildTarget(cwd: string): boolean {
  try {
    return fs.readdirSync(cwd).some((f) => f.endsWith('.sln') || f.endsWith('.csproj'));
  } catch {
    return false;
  }
}

/** The nearest ancestor `.csproj` owning a changed file (repo-relative), or
 *  null. C#'s affected unit is the project. */
function csharpNearestProject(cwd: string, relFile: string): string | null {
  let dir = path.dirname(relFile).replace(/\\/g, '/');
  for (;;) {
    try {
      const entry = fs.readdirSync(path.join(cwd, dir)).find((f) => f.endsWith('.csproj'));
      if (entry) return (dir === '.' ? entry : `${dir}/${entry}`).replace(/\\/g, '/');
    } catch {
      /* dir unreadable — keep walking up */
    }
    if (dir === '.' || dir === '') break;
    dir = path.dirname(dir);
  }
  return null;
}

/** Is a `.csproj` a test project? Every .NET test project references
 *  `Microsoft.NET.Test.Sdk`; also accept an explicit `<IsTestProject>` or a
 *  known test framework, so `dotnet test <proj>` won't be aimed at a
 *  non-test project (which would error "no tests"). */
function csharpIsTestProject(cwd: string, relProj: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(cwd, relProj), 'utf-8');
    return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|\b(xunit|nunit|MSTest)\b/i.test(raw);
  } catch {
    return false;
  }
}

/**
 * Does any project in this repo target Windows? A `net*-windows` TFM (or an
 * explicit WinForms/WPF opt-in) makes the BUILD Windows-only — `dotnet build`
 * of such a target on Linux/macOS fails on missing Windows Desktop reference
 * packs. This is the repo fact that narrows every build-based C# capability's
 * host requirement (Rule 20): the dpl-studio class, where a Linux driver
 * could never produce the build half of the gate and nothing said so.
 */
function csharpTargetsWindows(cwd: string): boolean {
  for (const csproj of walkPaths(cwd, { extensions: ['.csproj'] })) {
    const content = readRepoFile(cwd, csproj);
    if (
      /<TargetFrameworks?>[^<]*-windows/i.test(content) ||
      /<UseWindowsForms>\s*true/i.test(content) ||
      /<UseWPF>\s*true/i.test(content)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The execution requirement every BUILD-based C# capability shares (floor,
 * Roslyn lint gate, CodeQL extraction): the .NET SDK, a project build, hosts
 * narrowed to Windows when the repo targets it, and a build target that is
 * `discovered` only when `dotnet` can auto-resolve one (a root `.sln` /
 * `.csproj`) — the 29-solutions-no-root repo is `configured`.
 */
function csharpBuildExecution(cwd: string): ExecutionRequirement {
  return {
    hosts: csharpTargetsWindows(cwd) ? ['windows'] : ['any'],
    toolchains: ['dotnet-sdk'],
    needsBuild: true,
    buildTarget: csharpHasBuildTarget(cwd) ? 'discovered' : 'configured',
    weight: 'build',
  };
}

/**
 * The C# correctness floor.
 *
 * syntaxCheck: `dotnet build` — compiles the solution/project `dotnet`
 * auto-discovers in cwd, reporting compile errors. Incremental via MSBuild's
 * cache; a cold build is bounded by the runner's timeout (fail-open → CI).
 *
 * affectedTests: `dotnet test`. C#'s affected unit is the PROJECT. When the
 * changed `.cs` files all belong to a SINGLE test project it narrows to
 * `dotnet test <that.csproj>`; otherwise (a source project changed, or several
 * projects) it runs the whole solution — `dotnet test` takes one target, so it
 * can't union several projects, and a source change's dependent test project
 * isn't cheaply resolvable. A change touching no `.cs` on the fast surface skips.
 */
const csharpCorrectnessProvider: CorrectnessProvider = {
  execution: csharpBuildExecution,

  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (!csharpHasBuildTarget(ctx.cwd)) return null;
    ensureDotnetInvariant();
    return { label: 'build', bin: 'dotnet', args: ['build', '--nologo'] };
  },

  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (!csharpHasBuildTarget(ctx.cwd)) return null;
    ensureDotnetInvariant();
    const undeterminable = ctx.changedFiles.length === 0;
    const changedCs = ctx.changedFiles.filter((f) => f.endsWith('.cs'));
    if (ctx.scope === 'affected' && !undeterminable) {
      if (changedCs.length === 0) return null; // no .cs change
      const projs = new Set(
        changedCs.map((f) => csharpNearestProject(ctx.cwd, f)).filter((p): p is string => !!p),
      );
      if (projs.size === 1) {
        const [proj] = [...projs];
        if (csharpIsTestProject(ctx.cwd, proj)) {
          return { label: 'affected-tests', bin: 'dotnet', args: ['test', proj] };
        }
      }
      // else fall through to the whole solution (safe default)
    }
    return { label: 'affected-tests', bin: 'dotnet', args: ['test'] };
  },
};

/** MSBuild analyzer-warning line: `<file>(<line>,<col>): warning <CODE>: <message> [<proj>]`.
 *  Exported for the format-contract test. */
export const CSHARP_MSBUILD_WARNING_PARSE =
  '^(?<file>.+?)\\((?<line>\\d+),\\d+\\):\\s+warning\\s+(?<rule>\\w+):\\s+(?<message>.*?)(?:\\s+\\[[^\\]]*\\])?\\s*$';

/**
 * Lint-GATE provider: the .NET Roslyn analyzers, surfaced through `dotnet build`.
 * C# has no standalone per-line linter (analyzers run in the compiler), so the
 * gate parses build warnings — `File.cs(line,col): warning CAxxxx: message`.
 * `dotnet build` exits 0 even with warnings, which is why the runner parses
 * regex output regardless of exit code; a clean build emits no warning lines
 * (pass). `--nologo` trims the banner. Fail-open when `dotnet` isn't installed.
 * (Formatting-only style can instead be gated with a user check running
 * `dotnet format --verify-no-changes`.)
 */
const csharpLintGateProvider: LintGateProvider = {
  // The gate reads Roslyn analyzer warnings out of `dotnet build` — it is a
  // BUILD, with everything that implies (SDK, host, target). The
  // pre-declaration model implicitly claimed `{ hosts: any, toolchains: [],
  // needsBuild: false }` here, which was wrong on every axis.
  execution: csharpBuildExecution,
  lintCommand() {
    ensureDotnetInvariant();
    return {
      bin: 'dotnet',
      args: ['build', '--nologo', '-clp:NoSummary'],
      // Deliberately still regex (the one pack not on structured output):
      // `dotnet build` has no machine-readable diagnostic stream on stdout,
      // and the SARIF alternative (`/p:ErrorLog=`) writes one file PER
      // PROJECT — a multi-csproj solution means globbing per-project files
      // with partial-failure semantics, a follow-on. The pattern is the
      // 3.8-hardened MSBuild shape (two-path fixture-pinned).
      parse: { kind: 'regex', pattern: CSHARP_MSBUILD_WARNING_PARSE },
      expectedExit: 0,
    };
  },
  recallInputs(ctx) {
    // The gate reads MSBuild warnings, so the analyzer set is whatever the SDK
    // plus the repo's analyzer packages provide: an SDK bump ships new built-in
    // analyzers, `.editorconfig` sets severities, and `Directory.Build.props`
    // is where a solution turns analysis on and pins its analyzer packages for
    // every project at once. `global.json` pins the SDK itself.
    //
    // Residue, deliberate: on a repo with no `global.json`, `dotnet build` uses
    // whatever SDK the machine has, and a machine-level SDK upgrade adds
    // analyzers with no file change for us to notice. dxkit does not manage the
    // .NET SDK — it is an ambient runtime (`cliBinaries`), not a registry tool
    // (Rule 1) — so there is no honest version to probe here. Pinning the SDK
    // with `global.json` closes it on the repo's side.
    return {
      ...hashFileInput(ctx.cwd, '.editorconfig'),
      ...hashFileInput(ctx.cwd, 'Directory.Build.props'),
      ...hashFileInput(ctx.cwd, 'global.json'),
    };
  },
};

/**
 * The .NET SDK version this repo targets — from a `.csproj` TargetFramework(s)
 * or `global.json`. `net9.0` / `net9.0-windows` → `'9.0'` so CI provisions .NET
 * 9 (setup-dotnet + the devcontainer feature). The TFM tag may carry an OS
 * suffix (`net9.0-windows`) — capture the first `netX.Y` regardless. `.csproj`
 * discovery is depth-aware (enterprise layouts nest them deep).
 */
function detectCsharpVersion(cwd: string): string | undefined {
  // Depth-UNLIMITED discovery via the canonical walker: enterprise .NET layouts
  // nest .csproj files 6–9 deep, past any hardcoded cap (G_v4_12).
  const csproj = walkPaths(cwd, { extensions: ['.csproj'] })[0];
  if (csproj) {
    const content = readRepoFile(cwd, csproj);
    const m = content.match(/<TargetFrameworks?>[^<]*?net(\d+\.\d+)/);
    if (m) return m[1];
  }
  const globalJson = readRepoFile(cwd, 'global.json');
  if (globalJson) {
    try {
      const ver = (JSON.parse(globalJson) as { sdk?: { version?: string } })?.sdk?.version;
      if (ver) return ver.split('.').slice(0, 2).join('.');
    } catch {
      /* ignore malformed global.json */
    }
  }
  return undefined;
}

export const csharp: LanguageSupport = {
  id: 'csharp',
  displayName: 'C#',
  commentSyntax: { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' },
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
    // Plain `AssemblyInfo.cs` (no prefix) is the canonical .NET
    // Framework per-project file Visual Studio writes into
    // `Properties/AssemblyInfo.cs`. It carries the `[assembly: ...]`
    // attributes (Version, Title, GUID) — boilerplate per project,
    // not human-authored business logic. The `*.AssemblyInfo.cs`
    // glob above only matches prefixed variants
    // (`MyProject.AssemblyInfo.cs`) emitted by some custom build
    // scripts; the unprefixed form covers vanilla VS projects.
    // The .NET WinForms benchmark had 38 such files post 2.7 fix
    // (Properties/AssemblyInfo.cs inside each .csproj subtree).
    'AssemblyInfo.cs',
    // WCF "Connected Services" auto-generated proxy classes
    // (svcutil.exe / Add Service Reference). The .NET WinForms
    // benchmark's `Reference.cs` was 42,370 lines of WCF proxy. Other tools'
    // service-reference output (gRPC tools, OpenAPI generators)
    // commonly also emit `Reference.cs`.
    'Reference.cs',
  ],

  // D027 (2.4.7): C# uses XML-doc triple-slash comments above
  // public APIs. Pre-D027 the generic doc-comment heuristic
  exportDetection: {
    reliability: 'full',
    strategy: '`public` access modifier on type and member declarations',
  },

  // graphify can't resolve `using`-directive call targets across
  // assemblies, so most .cs files surface zero callers even when
  // heavily depended upon. Blast radius is therefore not trustworthy
  // for C#: consumers suppress the caller count rather than let a false
  // "0 callers" read as "safe to change".
  callGraphReliability: 'unreliable',

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

  // HTTP flow: ASP.NET Core attribute routing ([HttpGet]/[Route] with the
  // [controller] token substituted from the enclosing class — the token MUST
  // resolve or the path is dropped; a placeholder there would over-match
  // every route under it), minimal APIs (app.MapGet), and HttpClient
  // clients (interpolated $"…" URLs canonicalize; a runtime-built URL on a
  // trusted client counts as a dynamic call site). Out of scope, documented:
  // MapGroup chains (the group lives on a variable — statically opaque),
  // HttpRequestMessage constructors (the verb is an HttpMethod enum
  // argument), C#-11 raw string literals (parse as soup in the bundled
  // grammar — their URLs are unread).
  httpFlow: {
    routeDecorators: [
      'HttpGet',
      'HttpPost',
      'HttpPut',
      'HttpDelete',
      'HttpPatch',
      'HttpHead',
      'HttpOptions',
    ],
    routePrefixDecorators: { names: ['Route'] },
    // A standalone method-level [Route("x")] with no verb attribute serves
    // every verb; one sharing its method with a verb MARKER belongs to the
    // pair form (the engine suppresses the double mint).
    routePathDecorators: { names: ['Route'], methodsKeyword: 'method', defaultMethods: ['ANY'] },
    routeAnnotationPairs: {
      methodMarkers: [
        'HttpGet',
        'HttpPost',
        'HttpPut',
        'HttpDelete',
        'HttpPatch',
        'HttpHead',
        'HttpOptions',
      ],
      pathNames: ['Route'],
    },
    decoratorPathKeywords: ['template'],
    routeTemplateTokens: [
      { token: '[controller]', from: 'enclosingType', stripSuffix: 'Controller', lowercase: true },
      // [action] substitutes the handler method's name — in a class-level
      // "[controller]/[action]" prefix it resolves per handler. Lowercased
      // like [controller] (ASP.NET routing is case-insensitive; API clients
      // conventionally call lowercase paths — the casing trade-off is
      // documented with the pack's coverage notes).
      { token: '[action]', from: 'enclosingFunction', lowercase: true },
    ],
    routeRouterCallees: {
      methods: ['MapGet', 'MapPost', 'MapPut', 'MapDelete', 'MapPatch'],
      bases: ['app'],
    },
    clientMethodCallees: {
      methods: [
        'GetAsync',
        'PostAsync',
        'PutAsync',
        'PatchAsync',
        'DeleteAsync',
        'GetFromJsonAsync',
        'GetStringAsync',
        'GetByteArrayAsync',
        'PostAsJsonAsync',
        'PutAsJsonAsync',
        'PatchAsJsonAsync',
      ],
      bases: ['client', 'httpClient', '_client', '_httpClient'],
    },
    methodAliases: {
      httpget: 'GET',
      httppost: 'POST',
      httpput: 'PUT',
      httpdelete: 'DELETE',
      httppatch: 'PATCH',
      httphead: 'HEAD',
      httpoptions: 'OPTIONS',
      mapget: 'GET',
      mappost: 'POST',
      mapput: 'PUT',
      mapdelete: 'DELETE',
      mappatch: 'PATCH',
      getasync: 'GET',
      postasync: 'POST',
      putasync: 'PUT',
      patchasync: 'PATCH',
      deleteasync: 'DELETE',
      getfromjsonasync: 'GET',
      getstringasync: 'GET',
      getbytearrayasync: 'GET',
      postasjsonasync: 'POST',
      putasjsonasync: 'PUT',
      patchasjsonasync: 'PATCH',
    },
    // No flowSignals: .NET manifests are variable-named .csproj files, which
    // the fixed-name manifest probe cannot express — discovery simply never
    // proactively recommends flow here (extraction works once configured).
  },

  // Data models for the schema drift gate: EF Core entities — both the
  // annotated forms ([Table]/[Keyless]/[Owned]) and the DbSet<T> convention
  // (the marker lives on the DbContext CONTAINER; referenced classes promote
  // repo-wide via modelTypeRefContainers). Partial classes merge at
  // model-set assembly (partialMarker), so codegen splits are never drift.
  // Optionality is the nullable-reference-type annotation (string? — the
  // declared-intent stance; non-NRT projects overstate requiredness, the
  // documented trade-off). Wire names ride positional [Column("x")] /
  // [JsonPropertyName("x")] arguments. Marker-less DTOs stay invisible by
  // design — `schema.specs` covers them.
  modelSchema: {
    modelDecorators: ['Table', 'Keyless', 'Owned'],
    modelTypeRefContainers: {
      containerBaseClasses: ['DbContext'],
      propertyTypeWrappers: ['DbSet'],
    },
    fieldDecoratorSpecs: [{ names: ['Column', 'JsonPropertyName'], wireNameFrom: 'firstArg' }],
  },

  // Tree-sitter grammar for the canonical AST layer (src/ast/). NB: the
  // bundled wasm is tree-sitter-c_sharp.wasm — underscore, not hyphen.
  treeSitterGrammars: {
    '.cs': 'c_sharp',
  },

  clocLanguageNames: ['C#'],

  detect(cwd) {
    // Depth 5 covers deeply-nested enterprise .NET layouts like
    // `app/modules/Core/<Module>/<Module>.csproj`. Lower limits
    // silently miss these from the repo root.
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
  // CodeQL `csharp` extractor needs a build; Snyk Code supports C#.
  deepSast: { codeqlLanguage: 'csharp', snykCode: true, execution: csharpBuildExecution },

  correctness: csharpCorrectnessProvider,
  lintGate: csharpLintGateProvider,

  capabilities: {
    depVulns: csharpDepVulnsProvider,
    lint: csharpLintProvider,
    coverage: csharpCoverageProvider,
    imports: csharpImportsProvider,
    testFramework: csharpTestFrameworkProvider,
    licenses: csharpLicensesProvider,
  },

  // Roslyn diagnostic codes tier through the same map the lint capability
  // uses — CS*/CA*/IDE* codes from `dotnet build`, security analyzer
  // families ranked high. Parity with ruff/ESLint/golangci-lint/clippy.
  mapLintSeverity: mapRoslynSeverity,

  permissions: [
    'Bash(dotnet test:*)',
    'Bash(dotnet build:*)',
    'Bash(dotnet format:*)',
    'Bash(dotnet run:*)',
  ],
  ruleFile: 'csharp.md',
  ciSetup: {
    steps: [
      {
        name: 'Set up .NET',
        uses: 'actions/setup-dotnet@v4',
        with: { 'dotnet-version': '8.0' },
        versionInput: 'dotnet-version',
      },
    ],
  },
  defaultVersion: '8.0',
  detectVersion: detectCsharpVersion,
  cliBinaries: ['dotnet'],
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/dotnet:2',
    opts: { version: '8.0' },
  },
  devcontainerExtensions: ['ms-dotnettools.csharp'],
};
