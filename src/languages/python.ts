import * as fs from 'fs';
import * as path from 'path';

import { parseCoveragePy } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { enrichOsv, resolveCvssScores } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { isMajorBump } from '../analyzers/tools/semver-bump';
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
import type { LanguageSupport, LintSeverity } from './types';

interface RuffResult {
  code: string;
  message: string;
  severity?: string;
}

interface PipAuditVuln {
  id: string;
  fix_versions: string[];
  aliases?: string[];
  description?: string;
}

interface PipAuditDep {
  name?: string;
  version?: string;
  vulns: PipAuditVuln[];
}

interface PipAuditReport {
  dependencies: PipAuditDep[];
}

function stripPyComments(src: string): string {
  return src.replace(/(^|[^\w"'])#[^\n]*/g, '$1');
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function toRel(abs: string, cwd: string): string {
  return path.relative(cwd, abs).split(path.sep).join('/');
}

function hasPyFileWithinDepth(cwd: string, maxDepth = 2): boolean {
  function search(dir: string, depth: number): boolean {
    if (depth > maxDepth) return false;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (
        e.name.startsWith('.') ||
        ['node_modules', 'vendor', 'bin', 'obj', 'target'].includes(e.name)
      ) {
        continue;
      }
      if (e.isFile() && e.name.endsWith('.py')) return true;
      if (e.isDirectory() && search(path.join(dir, e.name), depth + 1)) return true;
    }
    return false;
  }
  return search(cwd, 0);
}

/**
 * Build the pip-audit invocation for the project at `cwd`. Returns null
 * when no supported manifest is present — without one, pip-audit would
 * silently fall back to scanning its own python environment (the
 * dxkit-installed graphify-venv), reporting irrelevant vulnerabilities
 * against tools rather than against the project's declared dependencies.
 *
 * Manifest precedence:
 *   - pyproject.toml / setup.py → `pip-audit .` (project mode reads the
 *     declared dependencies)
 *   - requirements.txt          → `pip-audit -r requirements.txt`
 *   - Pipfile                   → unsupported by pip-audit natively; we
 *     return null rather than scan the wrong environment.
 */
function buildPipAuditCommand(cwd: string, pipAuditPath: string): string | null {
  if (fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'setup.py')) {
    return `${pipAuditPath} . --format json 2>/dev/null`;
  }
  if (fileExists(cwd, 'requirements.txt')) {
    return `${pipAuditPath} -r requirements.txt --format json 2>/dev/null`;
  }
  return null;
}

/**
 * Pure parser for `pip show pkg1 pkg2 ...` output. pip-show returns
 * RFC-822-ish blocks separated by `---` with `Key: Value` lines. The
 * fields we need:
 *
 *   Name: foo
 *   Requires: a, b, c
 *   Required-by: x, y
 *
 * Empty `Required-by` identifies a package that nothing else in the
 * env depends on — conventionally a directly-installed (top-level)
 * package. Extracted so the builder below can be unit-tested without
 * a live pip invocation.
 */
export function parsePipShowOutput(
  raw: string,
): Map<string, { requires: string[]; requiredBy: string[] }> {
  const graph = new Map<string, { requires: string[]; requiredBy: string[] }>();
  // pip separates blocks with a line containing exactly '---'.
  const blocks = raw.split(/^---\s*$/m);
  for (const block of blocks) {
    let name: string | null = null;
    let requires: string[] = [];
    let requiredBy: string[] = [];
    for (const line of block.split('\n')) {
      const m = line.match(/^(Name|Requires|Required-by):\s*(.*)$/i);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'name') name = val;
      else if (key === 'requires') {
        requires = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      } else if (key === 'required-by') {
        requiredBy = val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
    if (name) graph.set(name, { requires, requiredBy });
  }
  return graph;
}

/**
 * BFS the parsed pip-show graph to produce a per-package-name index of
 * its top-level ancestors. Top-levels are packages with empty
 * `Required-by` — nothing else in the environment depends on them, so
 * they were installed as direct deps.
 *
 * Pure function; testable with fabricated graphs.
 */
export function buildPyTopLevelDepIndex(
  graph: Map<string, { requires: string[]; requiredBy: string[] }>,
): Map<string, string[]> {
  const topLevels: string[] = [];
  for (const [name, meta] of graph) {
    if (meta.requiredBy.length === 0) topLevels.push(name);
  }
  const result = new Map<string, Set<string>>();
  for (const top of topLevels) {
    const visited = new Set<string>();
    const queue: string[] = [top];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      const bucket = result.get(name) ?? new Set<string>();
      bucket.add(top);
      result.set(name, bucket);
      const meta = graph.get(name);
      if (!meta) continue;
      for (const child of meta.requires) {
        if (!visited.has(child)) queue.push(child);
      }
    }
  }
  const sorted = new Map<string, string[]>();
  for (const [k, v] of result) sorted.set(k, [...v].sort());
  return sorted;
}

/**
 * Parse a `requirements.txt`-style file into the set of direct (top-
 * level) package names. Used as a fallback when no venv is available
 * for the pip-show-based dep graph. Handles common requirement-spec
 * shapes:
 *
 *   requests==2.20.0           → 'requests'
 *   requests>=2.20,<3          → 'requests'
 *   Django                     → 'django'  (lowercased to match pip-audit)
 *   # comment                  → skipped
 *   -r other.txt               → skipped (recursive include not followed)
 *   -e .                       → skipped
 *   pkg ; python_version<'3'   → 'pkg'  (env-marker stripped)
 *   pkg[extra1,extra2]         → 'pkg'  (extras stripped)
 *
 * Names are lowercased to match pip-audit's canonical-PyPI casing
 * convention. Returns deduplicated names in the order they appear.
 */
export function parseRequirementsTxtTopLevels(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('-')) continue;
    // Strip inline `;` environment markers — they're conditions, not
    // part of the package spec.
    const beforeMarker = line.split(';')[0].trim();
    // Capture the leading package-name token, allowing the standard PEP
    // 508 character set ([A-Za-z0-9._-]+). Stop at the first specifier
    // (==, >=, <=, ~=, !=, <, >, [, space).
    const m = beforeMarker.match(/^([A-Za-z0-9._-]+)/);
    if (!m) continue;
    const name = m[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Invoke `pip list` + `pip show --all` against the project's venv and
 * build the top-level attribution index. When no venv is present, fall
 * back to parsing `requirements.txt` directly — that gives us at least
 * direct-dep self-attribution (pkg → [pkg]) even when the project has
 * never been `pip install`ed. Surfaced by the cross-ecosystem benchmark
 * fixture (Phase 10h.6.8): a `requirements.txt`-only directory yielded
 * empty `topLevelDep` on every direct dep.
 */
function loadPyTopLevelDepIndex(cwd: string): Map<string, string[]> {
  const venvPython = findPyProjectVenvPython(cwd);
  if (venvPython) {
    const listRaw = run(`${venvPython} -m pip list --format=json 2>/dev/null`, cwd, 60000);
    if (listRaw) {
      try {
        const list = JSON.parse(listRaw) as Array<{ name?: string }>;
        const names = list.map((x) => x.name).filter((n): n is string => !!n);
        if (names.length > 0) {
          // pip show accepts multiple package names in one call; stays
          // well under shell arg-length limits for realistic envs
          // (O(100) pkgs).
          const showRaw = run(
            `${venvPython} -m pip show ${names.join(' ')} 2>/dev/null`,
            cwd,
            60000,
          );
          if (showRaw) return buildPyTopLevelDepIndex(parsePipShowOutput(showRaw));
        }
      } catch {
        /* fall through to requirements.txt fallback */
      }
    }
  }

  // Fallback: parse requirements.txt directly. Only direct deps get
  // attribution; transitives stay unset (would need resolved metadata
  // from a pip-installed env to attribute, which we explicitly don't
  // have here).
  if (!fileExists(cwd, 'requirements.txt')) return new Map();
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(cwd, 'requirements.txt'), 'utf-8');
  } catch {
    return new Map();
  }
  const topLevels = parseRequirementsTxtTopLevels(raw);
  const result = new Map<string, string[]>();
  for (const name of topLevels) result.set(name, [name]);
  return result;
}

/**
 * Single source of truth for the python pack's dep-vuln gathering.
 * Consumed by `pyDepVulnsProvider` (capability dispatcher).
 */
async function gatherPyDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const pipAudit = findTool(TOOL_DEFS['pip-audit'], cwd);
  if (!pipAudit.available || !pipAudit.path) return { kind: 'tool-missing' };

  const cmd = buildPipAuditCommand(cwd, pipAudit.path);
  if (!cmd) return { kind: 'tool-missing' };

  const raw = run(cmd, cwd, 120000);
  if (!raw) return { kind: 'no-output' };

  try {
    const data = JSON.parse(raw) as PipAuditReport;
    const vulnIds: string[] = [];
    for (const dep of data.dependencies || []) {
      for (const v of dep.vulns || []) {
        if (v.id) vulnIds.push(v.id);
      }
    }
    // pip-audit doesn't carry severity or CVSS per vuln — look up via
    // OSV.dev. Unknown/unreachable IDs fall back to medium (pip-audit's
    // legacy default). cvssScore is attached to findings when available.
    const enriched = await enrichOsv(vulnIds);
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let enrichedCount = 0;
    const resolveSeverity = (id: string): keyof SeverityCounts => {
      const detail = enriched.get(id);
      const sev = detail?.severity;
      if (sev && sev !== 'unknown') {
        enrichedCount++;
        if (sev === 'critical') return 'critical';
        if (sev === 'high') return 'high';
        if (sev === 'medium') return 'medium';
        return 'low';
      }
      return 'medium';
    };

    // Lazy-built: only load the top-level index when we have at least
    // one finding. Saves a pip list + pip show invocation on clean
    // projects. The index is built once even if multiple findings
    // reference the same package.
    let topLevelIndex: Map<string, string[]> | null = null;
    const getTopLevel = (pkg: string): string[] | undefined => {
      if (topLevelIndex === null) topLevelIndex = loadPyTopLevelDepIndex(cwd);
      const parents = topLevelIndex.get(pkg);
      return parents && parents.length > 0 ? parents : undefined;
    };

    const findings: DepVulnFinding[] = [];
    // pip-audit emits the same advisory once per affected-version range,
    // so a single CVE on a package can show up multiple times — same
    // (package, version, id), same fingerprint. Dedup at the source so
    // downstream consumers don't see synthetic duplicates. Surfaced by
    // requests@2.20.0 in the cross-ecosystem benchmark fixture (Phase
    // 10h.6.8) where PYSEC-2023-74 was emitted twice.
    const seen = new Set<string>();
    for (const dep of data.dependencies || []) {
      for (const v of dep.vulns || []) {
        if (!v.id) continue;
        const dedupKey = `${dep.name ?? 'unknown'}\0${dep.version ?? ''}\0${v.id}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        const severity = resolveSeverity(v.id);
        if (severity === 'critical') critical++;
        else if (severity === 'high') high++;
        else if (severity === 'medium') medium++;
        else low++;

        const finding: DepVulnFinding = {
          id: v.id,
          package: dep.name ?? 'unknown',
          installedVersion: dep.version,
          tool: 'pip-audit',
          severity,
        };
        // Embedded score from the primary enrichment pass; alias-fallback
        // happens in the batched resolveCvssScores call after this loop.
        const primaryCvss = enriched.get(v.id)?.cvssScore;
        if (primaryCvss !== null && primaryCvss !== undefined) finding.cvssScore = primaryCvss;
        // pip-audit returns sorted fix versions ascending; the first is the
        // minimal upgrade that resolves the issue.
        if (v.fix_versions && v.fix_versions.length > 0) {
          finding.fixedVersion = v.fix_versions[0];
          // Tier-2 structured plan (10h.6.2): Python's dep graph is flat —
          // the fix is always an upgrade of the package itself, so parent
          // == finding.package. `patches[]` carries just this advisory's
          // id (pip-audit doesn't roll up "one upgrade fixes N advisories"
          // the way osv-scanner does on npm). `breaking` derives from a
          // major-version jump from the installed version to the target.
          finding.upgradePlan = {
            parent: finding.package,
            parentVersion: v.fix_versions[0],
            patches: [v.id],
            breaking: isMajorBump(dep.version ?? '', v.fix_versions[0]),
          };
        }
        // Filter empty alias entries — ECHO advisories occasionally emit [].
        const aliases = (v.aliases ?? []).filter((a) => a && a.length > 0);
        if (aliases.length > 0) finding.aliases = aliases;
        if (v.description) finding.summary = v.description;
        // pip-audit doesn't carry advisory URLs; OSV.dev hosts a canonical
        // page per vulnerability id, so synthesize the reference. Render
        // layer can override if a tool-supplied URL becomes available later.
        finding.references = [`https://osv.dev/vulnerability/${v.id}`];
        const parents = getTopLevel(finding.package);
        if (parents) finding.topLevelDep = parents;
        findings.push(finding);
      }
    }

    // Alias-fallback CVSS pass: PYSEC-* records on OSV.dev frequently
    // lack CVSS vectors that the corresponding CVE alias carries (the
    // pip ecosystem assigns PYSEC ids before CVEs land). When primary
    // lookup misses, we re-query each alias to fill the score.
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
      tool: 'pip-audit',
      enrichment: enrichedCount > 0 ? 'osv.dev' : null,
      counts: { critical, high, medium, low },
      findings,
    };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'parse-error' };
  }
}

const pyDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'python',
  async gather(cwd) {
    const outcome = await gatherPyDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

function mapRuffSeverity(code: string): LintSeverity {
  const prefix = code.match(/^[A-Z]+/)?.[0] ?? '';
  switch (prefix) {
    case 'S':
      return 'critical';
    case 'F':
    case 'B':
      return 'high';
    case 'E':
    case 'C':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Single source of truth for the python pack's lint gathering.
 * Consumed by `pyLintProvider` (capability dispatcher).
 */
function gatherPyLintResult(cwd: string): LintGatherOutcome {
  const ruff = findTool(TOOL_DEFS.ruff, cwd);
  if (!ruff.available || !ruff.path) {
    return { kind: 'unavailable', reason: 'not installed' };
  }

  const raw = run(`${ruff.path} check . --output-format json 2>/dev/null`, cwd, 60000);
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (!raw) {
    // Empty output = ruff ran and found nothing, matching prior behavior.
    const envelope: LintResult = { schemaVersion: 1, tool: 'ruff', counts };
    return { kind: 'success', envelope };
  }
  try {
    const results = JSON.parse(raw) as RuffResult[];
    if (!Array.isArray(results)) {
      return { kind: 'unavailable', reason: 'parse error' };
    }
    for (const r of results) {
      counts[mapRuffSeverity(r.code)]++;
    }
    const envelope: LintResult = { schemaVersion: 1, tool: 'ruff', counts };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'unavailable', reason: 'parse error' };
  }
}

const pyLintProvider: CapabilityProvider<LintResult> = {
  source: 'python',
  async gather(cwd) {
    const outcome = gatherPyLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the python pack's coverage gathering.
 * Consumed by `pyCoverageProvider` (capability dispatcher).
 */
function gatherPyCoverageResult(cwd: string): CoverageResult | null {
  const file = path.join(cwd, 'coverage.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
  try {
    const coverage = parseCoveragePy(raw, 'coverage.json', cwd);
    return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
  } catch {
    return null;
  }
}

const pyCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'python',
  async gather(cwd) {
    return gatherPyCoverageResult(cwd);
  },
};

/**
 * Capture Python module specifiers from source text. Handles both
 * `from X import Y` and bare `import X, Y as Z` forms. Exported so
 * unit tests can exercise it directly; the imports capability batches
 * it across all .py files under the repo.
 */
export function extractPyImportsRaw(content: string): string[] {
  const out: string[] = [];
  for (const line of stripPyComments(content).split('\n')) {
    const trimmed = line.trim();
    const fromMatch = trimmed.match(/^from\s+([.\w]+)\s+import\s+/);
    if (fromMatch) {
      out.push(fromMatch[1]);
      continue;
    }
    const impMatch = trimmed.match(/^import\s+(.+)$/);
    if (impMatch) {
      for (const part of impMatch[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim();
        if (name) out.push(name);
      }
    }
  }
  return out;
}

/**
 * Resolve a Python import specifier to an in-project file path, or null
 * for unresolvable / stdlib / external references. Handles relative
 * specifiers (leading dots) and absolute-from-project-root imports.
 * Exported for unit testing.
 */
export function resolvePyImportRaw(fromFile: string, spec: string, cwd: string): string | null {
  const fromDir = path.dirname(path.join(cwd, fromFile));
  const dotMatch = spec.match(/^(\.+)(.*)$/);
  let baseDir: string;
  let remainder: string;
  if (dotMatch) {
    const dots = dotMatch[1].length;
    remainder = dotMatch[2];
    baseDir = fromDir;
    for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
  } else {
    baseDir = cwd;
    remainder = spec;
  }
  if (!remainder) return null;
  const parts = remainder.split('.').filter(Boolean);
  const candidate = path.join(baseDir, ...parts);
  if (isFile(candidate + '.py')) return toRel(candidate + '.py', cwd);
  const init = path.join(candidate, '__init__.py');
  if (isFile(init)) return toRel(init, cwd);
  return null;
}

/**
 * Enumerate .py source files under cwd and pre-compute the pack's
 * per-file imports + resolved edges. Shares enumeration strategy with
 * the typescript pack (find + getFindExcludeFlags).
 */
function gatherPyImportsResult(cwd: string): ImportsResult | null {
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f -name "*.py" ${excludes} 2>/dev/null`, cwd);
  if (!raw) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  const edges = new Map<string, ReadonlySet<string>>();

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
    const specs = extractPyImportsRaw(content);
    extracted.set(rel, specs);
    const targets = new Set<string>();
    for (const spec of specs) {
      const resolved = resolvePyImportRaw(rel, spec, cwd);
      if (resolved) targets.add(resolved);
    }
    if (targets.size > 0) edges.set(rel, targets);
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'python-imports',
    sourceExtensions: ['.py'],
    extracted,
    edges,
  };
}

const pyImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'python',
  async gather(cwd) {
    return gatherPyImportsResult(cwd);
  },
};

/**
 * Detect pytest by the three signals it publishes: `pytest.ini`,
 * `conftest.py`, or a `[tool.pytest]` table in `pyproject.toml`. Other
 * Python runners (unittest, nose) don't self-announce and would need
 * heuristic source-file scanning — out of scope until Phase 10f.1.
 * Returns null when no signal is present.
 */
function gatherPyTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  const hasPytestConfigFile = fileExists(cwd, 'pytest.ini', 'conftest.py');
  if (hasPytestConfigFile) return { schemaVersion: 1, tool: 'python', name: 'pytest' };

  if (fileExists(cwd, 'pyproject.toml')) {
    const pyproject = run('cat pyproject.toml 2>/dev/null', cwd);
    if (pyproject?.includes('[tool.pytest')) {
      return { schemaVersion: 1, tool: 'python', name: 'pytest' };
    }
  }
  return null;
}

const pyTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'python',
  async gather(cwd) {
    return gatherPyTestFrameworkResult(cwd);
  },
};

/**
 * Raw shape emitted per-entry by `pip-licenses --format=json`. Fields are
 * pip-licenses's capitalised names; we map them to LicenseFinding below.
 */
interface PipLicensesEntry {
  Name: string;
  Version: string;
  License?: string;
  LicenseText?: string;
  Author?: string;
  URL?: string;
  Description?: string;
}

/**
 * Check whether an absolute path points at a runnable Python
 * interpreter (a file; Windows `python.exe` not yet supported —
 * matches the pre-10h.4.4 behavior).
 */
function isPyExecutable(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

/**
 * Given a candidate venv root directory, return the path to its
 * `bin/python[3]` binary if present, or null otherwise. Extracted so
 * the fallback chain below can reuse it across detection strategies.
 */
function venvRootToPython(venvRoot: string): string | null {
  for (const exe of ['python', 'python3']) {
    const candidate = path.join(venvRoot, 'bin', exe);
    if (isPyExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Locate the project's own Python interpreter.
 *
 * Detection order (fail-cheap first, subprocess last):
 *   1. `./.venv` or `./venv` under cwd  — uv default, in-project
 *      poetry (`virtualenvs.in-project = true`), hand-rolled venvs.
 *      Zero-cost stat() checks.
 *   2. `$VIRTUAL_ENV` env var — set by `source .venv/bin/activate`
 *      and poetry shell. Catches externally-activated envs.
 *   3. `poetry env info --path` — external poetry venvs
 *      (default `virtualenvs.in-project = false` on most installs;
 *      env lives in `~/.cache/pypoetry/virtualenvs/<hash>`).
 *   4. `pipenv --venv` — pipenv default stores elsewhere too.
 *
 * Returns null if no venv is resolvable — the provider then skips
 * cleanly rather than falling through to pip-licenses's install env
 * (which would report dxkit's own packages, not the project's).
 */
export function findPyProjectVenvPython(cwd: string): string | null {
  // 1. Conventional in-project venv roots (fast path).
  for (const dir of ['.venv', 'venv']) {
    const p = venvRootToPython(path.join(cwd, dir));
    if (p) return p;
  }

  // 2. Caller-activated env (poetry shell, source activate, etc.).
  const active = process.env.VIRTUAL_ENV;
  if (active) {
    const p = venvRootToPython(active);
    if (p) return p;
  }

  // 3. External poetry venv. `poetry env info --path` returns the
  // active env's root directory on stdout or nothing if no env.
  const poetryPath = run('poetry env info --path 2>/dev/null', cwd, 10000).trim();
  if (poetryPath) {
    const p = venvRootToPython(poetryPath);
    if (p) return p;
  }

  // 4. External pipenv venv.
  const pipenvPath = run('pipenv --venv 2>/dev/null', cwd, 10000).trim();
  if (pipenvPath) {
    const p = venvRootToPython(pipenvPath);
    if (p) return p;
  }

  return null;
}

/**
 * Single source of truth for the python pack's license gathering.
 * Consumed by `pyLicensesProvider` (capability dispatcher).
 *
 * Gating is strict — both a Python manifest AND a project venv are
 * required. Reason: pip-licenses operates on the active Python
 * environment, so invoking it without `--python <project-venv>` would
 * report whatever packages are installed in dxkit's graphify-venv
 * (i.e. garbage). Returns null when either prerequisite is missing so
 * the dispatcher drops the pack cleanly.
 */
function gatherPyLicensesResult(cwd: string): LicensesResult | null {
  const hasManifest =
    fileExists(cwd, 'pyproject.toml') ||
    fileExists(cwd, 'setup.py') ||
    fileExists(cwd, 'requirements.txt') ||
    fileExists(cwd, 'Pipfile');
  if (!hasManifest) return null;

  const venvPython = findPyProjectVenvPython(cwd);
  if (!venvPython) return null;

  const status = findTool(TOOL_DEFS['pip-licenses'], cwd);
  if (!status.available || !status.path) return null;

  const raw = run(
    `${status.path} --python ${venvPython} --format=json --with-license-file --no-license-path --with-description --with-urls --with-authors 2>/dev/null`,
    cwd,
    120000,
  );
  if (!raw) return null;

  let data: PipLicensesEntry[];
  try {
    data = JSON.parse(raw) as PipLicensesEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;

  // Top-level attribution reuses the same pip-show-graph BFS the
  // depVulns path builds. Self-parent invariant (`index[top]` contains
  // `top`) classifies every row without a second `pip show` pass.
  // Empty index (pip tools missing, venv gone) leaves isTopLevel unset.
  const topLevelIndex = loadPyTopLevelDepIndex(cwd);
  const hasIndex = topLevelIndex.size > 0;

  const findings: LicenseFinding[] = [];
  for (const entry of data) {
    if (!entry.Name || !entry.Version) continue;
    const licenseType = entry.License && entry.License !== 'UNKNOWN' ? entry.License : 'UNKNOWN';
    const parents = hasIndex ? topLevelIndex.get(entry.Name) : undefined;
    findings.push({
      package: entry.Name,
      version: entry.Version,
      licenseType,
      licenseText:
        entry.LicenseText && entry.LicenseText !== 'UNKNOWN' ? entry.LicenseText : undefined,
      sourceUrl: entry.URL && entry.URL !== 'UNKNOWN' ? entry.URL : undefined,
      description:
        entry.Description && entry.Description !== 'UNKNOWN' ? entry.Description : undefined,
      supplier: entry.Author && entry.Author !== 'UNKNOWN' ? entry.Author : undefined,
      isTopLevel: hasIndex ? (parents?.includes(entry.Name) ?? false) : undefined,
    });
  }

  return {
    schemaVersion: 1,
    tool: 'pip-licenses',
    findings,
  };
}

const pyLicensesProvider: CapabilityProvider<LicensesResult> = {
  source: 'python',
  async gather(cwd) {
    return gatherPyLicensesResult(cwd);
  },
};

export const python: LanguageSupport = {
  id: 'python',
  displayName: 'Python',
  sourceExtensions: ['.py'],
  testFilePatterns: ['test_*.py', '*_test.py'],
  extraExcludes: ['__pycache__', '.pytest_cache', '.ruff_cache', '.venv', 'venv', '.mypy_cache'],

  detect(cwd) {
    return (
      fileExists(cwd, 'pyproject.toml') ||
      fileExists(cwd, 'setup.py') ||
      fileExists(cwd, 'requirements.txt') ||
      fileExists(cwd, 'Pipfile') ||
      hasPyFileWithinDepth(cwd, 2)
    );
  },

  tools: ['ruff', 'pip-audit', 'coverage-py', 'pip-licenses'],
  semgrepRulesets: ['p/python'],

  capabilities: {
    depVulns: pyDepVulnsProvider,
    lint: pyLintProvider,
    coverage: pyCoverageProvider,
    imports: pyImportsProvider,
    testFramework: pyTestFrameworkProvider,
    licenses: pyLicensesProvider,
  },

  mapLintSeverity: mapRuffSeverity,
};
