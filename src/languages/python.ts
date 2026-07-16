import * as fs from 'fs';
import * as path from 'path';

import { type Coverage, type FileCoverage, round1, toRelative } from '../analyzers/tools/coverage';
import { enrichOsv, resolveCvssScores } from '../analyzers/tools/osv';
import { commandExists, fileExists, run } from '../analyzers/tools/runner';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { isMajorBump } from '../analyzers/tools/semver-bump';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type {
  CapabilityProvider,
  DepVulnGatherOptions,
  DepVulnsProvider,
  LicensesProvider,
  LintProvider,
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
import { hashFirstConfig, toolVersionInput } from './capabilities/recall-inputs';
import { readRepoFile, repoFileExists } from './version-detect';

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

function hasPyFile(cwd: string): boolean {
  // Depth-unlimited via the canonical walker. The previous depth-2
  // cap missed real Python monorepos (e.g. `services/<svc>/src/*.py`
  // layouts).
  //
  // Requires >=3 `.py` files when no Python manifest is present.
  // The earlier "any .py file anywhere" threshold over-activated on
  // polyglot repos where a single build-output artifact (e.g. a
  // WinForms desktop app shipping one staging `.py` under
  // `StagingArea/Debug/net9.0-windows/`) would otherwise flip the
  // python pack on. With the pack active, `dominantVocabulary`
  // would then pick its Django/Flask-shaped words over the actual
  // dominant language pack's vocabulary — surfaces as wrong-stack
  // prose ("0 views/services, 0 models" on a 2,995-file C# repo).
  //
  // Real Python codebases without a manifest (small scripts, ad-hoc
  // analysis dirs, learning projects) still activate above the
  // threshold — the bar moved from "any" to "non-trivial," not to
  // "requires manifest." Manifest-bearing repos always activate
  // regardless of file count via the caller's `fileExists` checks.
  return walkPaths(cwd, { extensions: ['.py'] }).length >= 3;
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
 *
 * `untrusted` (set by the guardrail gate on possibly-attacker-controlled
 * source): project mode (`pip-audit .`) can build the project via its PEP 517
 * backend, executing arbitrary code — never acceptable on untrusted input. In
 * that mode we use only the non-building requirements path; if there's no
 * requirements.txt we return null (unavailable) rather than build. Reports
 * and the trusted local loop keep full project-mode coverage.
 */
export function buildPipAuditCommand(
  cwd: string,
  pipAuditPath: string,
  untrusted?: boolean,
): string | null {
  if (!untrusted && (fileExists(cwd, 'pyproject.toml') || fileExists(cwd, 'setup.py'))) {
    return `${pipAuditPath} . --format json`;
  }
  if (fileExists(cwd, 'requirements.txt')) {
    return `${pipAuditPath} -r requirements.txt --format json`;
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

// ─── Coverage parser ────────────────────────────────────────────────────────
// Moved from `src/analyzers/tools/coverage.ts` in Phase 10i.0-LP.4.

interface CoveragePyReport {
  totals?: { percent_covered?: number };
  files?: Record<
    string,
    {
      summary?: {
        num_statements?: number;
        missing_lines?: number;
        covered_lines?: number;
        percent_covered?: number;
      };
    }
  >;
}

/** coverage.py JSON: `{ "totals": {...}, "files": { "path": { summary: {...} } } }`. */
export function parseCoveragePy(raw: string, sourceFile: string, cwd: string): Coverage {
  const data = JSON.parse(raw) as CoveragePyReport;
  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalStatements = 0;

  for (const [key, entry] of Object.entries(data.files ?? {})) {
    const summary = entry?.summary;
    if (!summary) continue;
    const total = typeof summary.num_statements === 'number' ? summary.num_statements : 0;
    const missing = typeof summary.missing_lines === 'number' ? summary.missing_lines : 0;
    const covered =
      typeof summary.covered_lines === 'number'
        ? summary.covered_lines
        : Math.max(0, total - missing);
    const rel = toRelative(key, cwd);
    files.set(rel, {
      path: rel,
      covered,
      total,
      pct: round1(
        typeof summary.percent_covered === 'number'
          ? summary.percent_covered
          : total > 0
            ? (covered / total) * 100
            : 0,
      ),
    });
    totalCovered += covered;
    totalStatements += total;
  }

  const linePercent =
    typeof data.totals?.percent_covered === 'number'
      ? round1(data.totals.percent_covered)
      : round1(totalStatements > 0 ? (totalCovered / totalStatements) * 100 : 0);

  return { source: 'coverage-py', sourceFile, linePercent, files };
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
    const listRaw = run(`${venvPython} -m pip list --format=json`, cwd, 60000);
    if (listRaw) {
      try {
        const list = JSON.parse(listRaw) as Array<{ name?: string }>;
        const names = list.map((x) => x.name).filter((n): n is string => !!n);
        if (names.length > 0) {
          // pip show accepts multiple package names in one call; stays
          // well under shell arg-length limits for realistic envs
          // (O(100) pkgs).
          const showRaw = run(`${venvPython} -m pip show ${names.join(' ')}`, cwd, 60000);
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
async function gatherPyDepVulnsResult(
  cwd: string,
  opts?: DepVulnGatherOptions,
): Promise<DepVulnGatherOutcome> {
  const pipAudit = findTool(TOOL_DEFS['pip-audit'], cwd);
  if (!pipAudit.available || !pipAudit.path) {
    return { kind: 'unavailable', reason: 'pip-audit not installed' };
  }

  const cmd = buildPipAuditCommand(cwd, pipAudit.path, opts?.untrusted);
  if (opts?.untrusted && !cmd) {
    return {
      kind: 'unavailable',
      reason:
        'Python project audit needs a build (pyproject/setup.py) which is unsafe on untrusted ' +
        'source; no requirements.txt to audit without building. Run dxkit locally for a full scan.',
    };
  }
  if (!cmd) {
    return { kind: 'no-manifest', reason: 'no pyproject.toml / setup.py / requirements.txt' };
  }

  const raw = run(cmd, cwd, 120000);
  if (!raw) return { kind: 'unavailable', reason: 'pip-audit produced no output' };

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
          packId: 'python',
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
  } catch (err) {
    return { kind: 'unavailable', reason: `pip-audit parse error: ${(err as Error).message}` };
  }
}

const pyDepVulnsProvider: DepVulnsProvider = {
  source: 'python',
  manifestPatterns: [
    'pyproject.toml',
    'setup.py',
    'setup.cfg',
    'requirements*.txt',
    'Pipfile',
    'Pipfile.lock',
    'poetry.lock',
  ],
  // A nested requirements.txt / pyproject.toml resolves its own
  // environment (separate services in one repo), unlike a package of a
  // single rooted environment.
  lockfilePatterns: ['requirements.txt', 'pyproject.toml', 'Pipfile'],
  async gather(cwd) {
    const outcome = await gatherPyDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd, opts) {
    return gatherPyDepVulnsResult(cwd, opts);
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

  const raw = run(`${ruff.path} check . --output-format json`, cwd, 60000);
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

const pyLintProvider: LintProvider = {
  source: 'python',
  async gather(cwd) {
    const outcome = gatherPyLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherPyLintResult(cwd);
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

/**
 * Run `python -m pytest --cov --cov-report=json:coverage.json` from cwd
 * (D021). Prefer the project's own venv python (`.venv`, poetry, pipenv)
 * when resolvable so the test run uses the env that has pytest +
 * pytest-cov installed — falling back to the user's PATH `python`
 * otherwise.
 *
 * Preflight: require at least one Python manifest (pyproject.toml,
 * setup.py, requirements.txt, Pipfile). Without one, this is almost
 * certainly not a Python project (or it's a script-only directory that
 * would need explicit `--lang python` to opt in).
 *
 * Note: pytest-cov plugin presence is NOT preflighted — there is no
 * TOOL_DEFS entry for it, and the spawn outcome is sufficiently clear
 * when it's missing (`pytest: unrecognized arguments: --cov`). The
 * `coverage-py` tool is registry-tracked but the design-doc command
 * uses pytest-cov, not standalone coverage.py.
 */
function runPyTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'python',
      cmd: (() => {
        const venvPython = findPyProjectVenvPython(cwd);
        const py = venvPython ?? 'python';
        return `${py} -m pytest --cov --cov-report=json:coverage.json`;
      })(),
      cwd,
      artifact: 'coverage.json',
      preflight: (cwd) => {
        const hasManifest =
          fileExists(cwd, 'pyproject.toml') ||
          fileExists(cwd, 'setup.py') ||
          fileExists(cwd, 'requirements.txt') ||
          fileExists(cwd, 'Pipfile');
        if (!hasManifest) {
          return 'no Python project manifest (pyproject.toml/setup.py/requirements.txt/Pipfile) in this directory';
        }
        return null;
      },
    }),
  );
}

const pyCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'python',
  async gather(cwd) {
    return gatherPyCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runPyTestsWithCoverage(cwd);
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

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The import roots an absolute (non-relative) Python import resolves
 * against. Always the project root; plus `src/` when it exists — the
 * modern "src layout" (`[tool.setuptools.packages.find] where = ["src"]`)
 * where `from authz.access import x` lives at `src/authz/access.py`, not
 * `authz/access.py`. Derived from the tree, not hardcoded to one repo.
 *
 * Root cause this closes: anchoring absolute imports at `cwd` alone made
 * the resolver blind to the src layout, so an integration test importing
 * the module under test produced no edge and the test-gap analyzer flagged
 * the exercised file as an untested gap (the TS-alias bug's Python analog).
 */
export function pySourceRoots(cwd: string): string[] {
  const roots = [cwd];
  const srcDir = path.join(cwd, 'src');
  if (isDir(srcDir)) roots.push(srcDir);
  return roots;
}

/**
 * Resolve a Python import specifier to an in-project file path, or null
 * for unresolvable / stdlib / external references. Handles relative
 * specifiers (leading dots) and absolute imports rooted at any of the
 * project's source roots (`pySourceRoots` — project root + `src/`).
 * `roots` is injected by the imports gather (computed once); when omitted
 * it is derived per-call so direct/unit callers get src-layout support
 * for free. Exported for unit testing.
 */
export function resolvePyImportRaw(
  fromFile: string,
  spec: string,
  cwd: string,
  roots?: string[],
): string | null {
  const fromDir = path.dirname(path.join(cwd, fromFile));
  const dotMatch = spec.match(/^(\.+)(.*)$/);
  if (dotMatch) {
    const dots = dotMatch[1].length;
    const remainder = dotMatch[2];
    if (!remainder) return null;
    let baseDir = fromDir;
    for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
    return resolvePyModuleAt(baseDir, remainder, cwd);
  }
  // Absolute import — try each source root, most-specific (deepest) later
  // roots don't shadow the project root: first hit wins, project root first.
  for (const root of roots ?? pySourceRoots(cwd)) {
    const resolved = resolvePyModuleAt(root, spec, cwd);
    if (resolved) return resolved;
  }
  return null;
}

/** Resolve a dotted module remainder under a base dir to a `.py` file or package `__init__.py`. */
function resolvePyModuleAt(baseDir: string, remainder: string, cwd: string): string | null {
  const parts = remainder.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  const candidate = path.join(baseDir, ...parts);
  if (isFile(candidate + '.py')) return toRel(candidate + '.py', cwd);
  const init = path.join(candidate, '__init__.py');
  if (isFile(init)) return toRel(init, cwd);
  return null;
}

/**
 * Enumerate .py source files under cwd and pre-compute the pack's
 * per-file imports + resolved edges. Shares enumeration strategy with
 * the typescript pack (the cross-platform `walkSourceFiles` walker).
 * `includeTests` + `includeAutogen` keep the file set identical to the
 * prior `find -name "*.py"` enumeration, which filtered neither.
 */
function gatherPyImportsResult(cwd: string): ImportsResult | null {
  const files = walkSourceFiles(cwd, {
    extensions: ['.py'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  const edges = new Map<string, ReadonlySet<string>>();

  // Compute the project's source roots ONCE (project root + `src/` layout)
  // so absolute imports resolve to edges regardless of layout.
  const roots = pySourceRoots(cwd);

  for (const rel of files) {
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
      const resolved = resolvePyImportRaw(rel, spec, cwd, roots);
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
    let pyproject = '';
    try {
      pyproject = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf-8');
    } catch {
      /* unreadable — treat as no signal */
    }
    if (pyproject.includes('[tool.pytest')) {
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

/** The interpreter the floor runs — the project's venv python (absolute path,
 *  so it uses the env that actually has pytest installed) when resolvable,
 *  else `python3` / `python` on PATH. */
function floorPython(cwd: string): string {
  return findPyProjectVenvPython(cwd) ?? (commandExists('python3') ? 'python3' : 'python');
}

/** Is pytest actually installed for the resolved interpreter? A venv python
 *  (`.../bin/python`) has a sibling `.../bin/pytest`; a PATH interpreter uses
 *  a PATH `pytest`. Gating on this keeps a project WITHOUT pytest installed
 *  fail-OPEN (the check is skipped) rather than a fail-CLOSED "No module named
 *  pytest" that would block a developer who hasn't installed test deps. */
function pytestInstalledFor(python: string): boolean {
  if (python.includes('/') || python.includes(path.sep)) {
    const pytestBin = path.join(path.dirname(python), 'pytest');
    return isPyExecutable(pytestBin);
  }
  return commandExists('pytest');
}

/** A changed Python file that is a pytest test module (`test_*.py` /
 *  `*_test.py`, or under a `tests/` directory) — the pack's file-level
 *  affected-selection unit. */
function isPyTestFile(rel: string): boolean {
  const base = path.basename(rel);
  return (
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /(^|\/)tests?\//.test(rel.replace(/\\/g, '/'))
  );
}

/**
 * The Python correctness floor.
 *
 * syntaxCheck: `python -m py_compile <changed .py>` — the universal, stdlib
 * parse check (needs only an interpreter, catches exactly syntax errors, and
 * cannot false-positive on lint the way `ruff` would). Runs on the changed
 * `.py` files; on the full/undeterminable surface it returns null because the
 * pytest run below imports every module and surfaces a syntax error on import.
 *
 * affectedTests: `python -m pytest`. Native impact-selection needs a plugin
 * (pytest-testmon / pytest-picked) that cannot be reliably detected without
 * running, so the honest v1 rung is FILE-LEVEL — the changed test modules on
 * the fast surface, the whole suite at full scope. A source-only change with no
 * changed test module is syntax-checked on the fast surface and fully tested in
 * CI. (Documented ceiling; testmon-based per-test selection is a future upgrade.)
 */
const pyCorrectnessProvider: CorrectnessProvider = {
  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
    const changedPy = ctx.changedFiles.filter((f) => f.endsWith('.py'));
    if (changedPy.length === 0) return null; // full-scope backstop is the pytest import
    const python = floorPython(ctx.cwd);
    if (!binaryLike(python)) return null;
    return { label: 'syntax', bin: python, args: ['-m', 'py_compile', ...changedPy] };
  },

  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (gatherPyTestFrameworkResult(ctx.cwd) === null) return null; // no pytest project
    const python = floorPython(ctx.cwd);
    if (!pytestInstalledFor(python)) return null; // fail-open: pytest not installed here
    const undeterminable = ctx.changedFiles.length === 0;
    const changedTests = ctx.changedFiles.filter((f) => f.endsWith('.py') && isPyTestFile(f));
    if (ctx.scope === 'affected' && !undeterminable) {
      if (changedTests.length === 0) return null; // no changed test module → nothing to run
      return { label: 'affected-tests', bin: python, args: ['-m', 'pytest', ...changedTests] };
    }
    // Full scope, or the diff was undeterminable → run the whole suite.
    return { label: 'affected-tests', bin: python, args: ['-m', 'pytest'] };
  },
};

/**
 * Lint-GATE provider: ruff, for the net-new lint gate. Resolved via the tool
 * registry (Rule 1); null when ruff isn't installed. `--output-format concise`
 * emits `file:line:col: CODE message` per finding, mapped to located findings.
 * ruff exits non-zero when it reports findings (expectedExit 0 = clean).
 */
/** ruff `--output-format concise` line: `<file>:<line>:<col>: <CODE> <message>`.
 *  Exported so the lint-gate format contract is testable against a real sample. */
export const PY_RUFF_CONCISE_PARSE =
  '^(?<file>.+?):(?<line>\\d+):\\d+:\\s+(?<rule>[A-Z]+\\d+)\\s+(?<message>.*)$';

const pyLintGateProvider: LintGateProvider = {
  lintCommand(ctx) {
    const ruff = findTool(TOOL_DEFS.ruff, ctx.cwd);
    if (!ruff.available || !ruff.path) return null;
    return {
      bin: ruff.path,
      args: ['check', '.', '--output-format', 'concise'],
      parse: PY_RUFF_CONCISE_PARSE,
      expectedExit: 0,
    };
  },
  recallInputs(ctx) {
    // ruff ships its rules in the binary (no plugin ecosystem), so its own
    // version is the whole tool story. `resolved` and `locked` agree here:
    // ruff is a standalone binary, not a declared node/python dependency the
    // repo pins a range for.
    return {
      ...toolVersionInput(TOOL_DEFS.ruff, ctx.cwd, 'ruff'),
      // Which rules are ENABLED lives in config, and ruff reads the first of
      // these that exists.
      ...hashFirstConfig(ctx.cwd, ['ruff.toml', '.ruff.toml', 'pyproject.toml', 'setup.cfg']),
    };
  },
};

/** A `bin` we can hand the runner: a bare name (resolved on PATH) or an
 *  existing interpreter path. Mirrors the runner's own availability gate. */
function binaryLike(bin: string): boolean {
  if (bin.includes('/') || bin.includes(path.sep)) return isPyExecutable(bin);
  return commandExists(bin);
}

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
  const poetryPath = run('poetry env info --path', cwd, 10000).trim();
  if (poetryPath) {
    const p = venvRootToPython(poetryPath);
    if (p) return p;
  }

  // 4. External pipenv venv.
  const pipenvPath = run('pipenv --venv', cwd, 10000).trim();
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
function gatherPyLicensesResult(cwd: string): LicensesGatherOutcome {
  const hasManifest =
    fileExists(cwd, 'pyproject.toml') ||
    fileExists(cwd, 'setup.py') ||
    fileExists(cwd, 'requirements.txt') ||
    fileExists(cwd, 'Pipfile');
  if (!hasManifest) {
    return {
      kind: 'no-manifest',
      reason: 'no pyproject.toml / setup.py / requirements.txt / Pipfile',
    };
  }

  const venvPython = findPyProjectVenvPython(cwd);
  if (!venvPython) {
    return { kind: 'unavailable', reason: 'no resolvable project venv python' };
  }

  const status = findTool(TOOL_DEFS['pip-licenses'], cwd);
  if (!status.available || !status.path) {
    return { kind: 'unavailable', reason: 'pip-licenses not installed' };
  }

  const raw = run(
    `${status.path} --python ${venvPython} --format=json --with-license-file --no-license-path --with-description --with-urls --with-authors`,
    cwd,
    120000,
  );
  if (!raw) return { kind: 'unavailable', reason: 'pip-licenses produced no output' };

  let data: PipLicensesEntry[];
  try {
    data = JSON.parse(raw) as PipLicensesEntry[];
  } catch (err) {
    return { kind: 'unavailable', reason: `pip-licenses parse error: ${(err as Error).message}` };
  }
  if (!Array.isArray(data)) {
    return { kind: 'unavailable', reason: 'pip-licenses output was not a JSON array' };
  }

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

  const envelope: LicensesResult = {
    schemaVersion: 1,
    tool: 'pip-licenses',
    findings,
  };
  return { kind: 'success', envelope };
}

const pyLicensesProvider: LicensesProvider = {
  source: 'python',
  async gather(cwd) {
    const outcome = gatherPyLicensesResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherPyLicensesResult(cwd);
  },
};

/**
 * The Python version this repo targets — `pyproject.toml` `requires-python` or
 * `.python-version` (`3.12`). Feeds setup-python's `python-version` + the
 * devcontainer, so CI runs the interpreter the repo declares.
 */
function detectPythonVersion(cwd: string): string | undefined {
  const pyproject = readRepoFile(cwd, 'pyproject.toml');
  const m = pyproject.match(/requires-python\s*=\s*"[><=!~ ]*(\d+\.\d+)/);
  if (m) return m[1];
  if (repoFileExists(cwd, '.python-version')) {
    const ver = readRepoFile(cwd, '.python-version').trim();
    if (/^\d+\.\d+/.test(ver)) return ver.split('.').slice(0, 2).join('.');
  }
  return undefined;
}

export const python: LanguageSupport = {
  id: 'python',
  displayName: 'Python',
  commentSyntax: { lineComment: '#' },
  sourceExtensions: ['.py'],
  testFilePatterns: ['test_*.py', '*_test.py'],
  extraExcludes: ['__pycache__', '.pytest_cache', '.ruff_cache', '.venv', 'venv', '.mypy_cache'],

  exportDetection: {
    reliability: 'partial',
    strategy:
      '`__all__` list when present, else public-name heuristic (identifier without leading underscore)',
  },

  // D027 (2.4.7): Python module/class/function docstrings use either
  // triple-double or triple-single quotes. Match the docstring opener
  // at the start of a (possibly indented) line.
  docCommentPatterns: ['^[[:space:]]*"""', "^[[:space:]]*'''"],

  // D034 (2.4.7): `requests` and `urllib3` TLS-bypass idioms.
  // `verify=False` is the canonical opt-out on every `requests` call;
  // `disable_warnings(InsecureRequestWarning)` typically accompanies it
  // to silence the runtime warning. `VERIFY_SSL=false` is a common
  // env-var convention in Django/Flask configs.
  tlsBypassPatterns: ['verify[[:space:]]*=[[:space:]]*False', 'VERIFY_SSL.*[Ff]alse'],

  upgradeCommand(name, version) {
    return `pip install '${name}==${version}'`;
  },

  // Django (views/viewsets/serializers), Flask/FastAPI (routers, api
  // endpoints), Celery (tasks) — declarations cover the dominant
  // server-side Python patterns. Plain library / data-science code
  // (where `services/` is rare) simply doesn't match anything and
  // the analyzer degrades to "no primary architecture detected" —
  // exactly the pre-extension behavior.
  architecturalShape: {
    primaryComponentPaths: [
      '/views/',
      '/viewsets/',
      '/handlers/',
      '/services/',
      '/api/',
      '/routers/',
      '/tasks/',
    ],
    routePaths: ['/views/', '/viewsets/', '/routers/', '/api/', '/urls.py'],
    modelPaths: ['/models/', '/schemas/', '/serializers/'],
    vocabulary: {
      components: 'views/services',
      models: 'models',
      routes: 'routes',
    },
    testGapPriority: {
      high: ['/views/', '/services/', '/handlers/', '/tasks/'],
      medium: ['/viewsets/', '/routers/', '/api/', '/serializers/'],
    },
    // Routes driven by an external actor (webhook/cron/health/CLI), so "no
    // in-repo consumer" is expected — the dead-surface analyzer dims these
    // rather than flagging them. Substrings of the route file path OR URL path
    // (Rule 6/8, pack-declared). Bias to false-negative — generous patterns.
    nonConsumerRoutePaths: [
      '/webhook',
      '/callback',
      '/cron/',
      '/tasks/', // Celery/RQ task endpoints, triggered out-of-band
      '/health',
      '/healthz',
      '/readiness',
      '/liveness',
      '/metrics',
      '/.well-known/',
    ],
  },

  // HTTP flow (CLAUDE.md Rule 6): how Python source expresses outbound HTTP
  // calls + route declarations, consumed by the one flow extractor via the
  // grammar-shape adapter (`src/ast/grammar-shape.ts`) — zero extractor code
  // is Python-specific. CLIENT: `requests` / `httpx` are TRUSTED bases (HTTP
  // by construction — their dynamic-URL calls are counted as unverifiable,
  // never silently dropped), and any other receiver's `.get('/x')` with a
  // path-like literal is admitted as a wrapper (`session`, `client`, an
  // app-specific api object) — the same precision guard the TS pack relies
  // on keeps `dict.get('key')` out. SERVED, three declarative forms:
  //   - FastAPI/Sanic/Flask-2 member verb decorators `@app.get('/x')`
  //     (leading-slash guard keeps `@mock.patch('pkg.attr')` out);
  //   - Flask `@app.route('/x', methods=['GET','POST'])` via the
  //     methods-kwarg reader, defaulting to Flask's GET-only;
  //   - Django `path('users/<int:pk>/', view)` in urls.py, emitted as an
  //     `ANY` (method-agnostic) route — the routing layer accepts every
  //     verb there; `include(...)` mounts are prefixes, not routes, and are
  //     excluded. Django's regex `re_path(...)` routes are OUT of scope
  //     (a regex route has no canonical path form to join on) — a repo that
  //     needs them can point `flow.specs` at an OpenAPI document instead.
  // Angle-bracket converters (`<int:pk>`, `<path:rest>`) canonicalize in the
  // shared normalizer, so both Django and Flask param forms join client
  // template URLs.
  httpFlow: {
    clientMethodCallees: {
      methods: ['get', 'post', 'put', 'patch', 'delete'],
      bases: ['requests', 'httpx'],
    },
    routeMemberDecorators: {
      methods: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'],
    },
    routePathDecorators: { names: ['route'], methodsKeyword: 'methods', defaultMethods: ['GET'] },
    routeCallees: { names: ['path'], excludeArgCallees: ['include'] },
    // Discovery-only (doctor's flow recommendation + the config planner):
    // a web framework in a Python manifest signals a served-side flow surface.
    flowSignals: [
      { manifest: 'requirements.txt', anyOf: ['fastapi', 'flask', 'django'] },
      { manifest: 'pyproject.toml', anyOf: ['fastapi', 'flask', 'django'] },
      { manifest: 'Pipfile', anyOf: ['fastapi', 'flask', 'django'] },
    ],
  },

  // Data-model declarations for the model-schema drift gate. Marker-based
  // (precision-first): Django/SQLAlchemy/pydantic base classes and
  // @dataclass. Field facts come from annotations where present; ORM
  // constructor fields (`models.CharField(null=True)`, `Column(String,
  // nullable=False)`) are enriched via fieldCallees — an unlisted exotic
  // field constructor still surfaces its field with an honest unknown type.
  // Known limitation (documented): relation fields fold to their constructor
  // alias (`fk` / `m2m`), so a re-targeted ForeignKey is not a type change.
  modelSchema: {
    modelBaseClasses: ['Model', 'BaseModel', 'DeclarativeBase', 'SQLModel'],
    // `Base` (classic SQLAlchemy declarative) is too generic to trust alone —
    // real-repo validation found unrelated homonym `Base` classes minted as
    // models. Weak: counts only when a Column/mapped_column field corroborates.
    weakModelBaseClasses: ['Base'],
    // SQLAlchemy 2.0 annotates through a transparent wrapper:
    // `so.Mapped[Optional[str]]` is an optional str, never a "Mapped" type.
    transparentTypeWrappers: ['Mapped'],
    modelDecorators: ['dataclass'],
    fieldCallees: [
      {
        // Django field constructors — the callee IS the type token.
        names: [
          'CharField',
          'TextField',
          'EmailField',
          'SlugField',
          'URLField',
          'UUIDField',
          'IntegerField',
          'BigIntegerField',
          'SmallIntegerField',
          'PositiveIntegerField',
          'PositiveSmallIntegerField',
          'AutoField',
          'BigAutoField',
          'BooleanField',
          'FloatField',
          'DecimalField',
          'DateField',
          'DateTimeField',
          'TimeField',
          'DurationField',
          'JSONField',
          'BinaryField',
          'FileField',
          'ImageField',
          'GenericIPAddressField',
          'ForeignKey',
          'OneToOneField',
          'ManyToManyField',
        ],
        optionalityKeyword: 'null',
      },
      {
        // SQLAlchemy column forms — the type is the first argument.
        names: ['Column', 'mapped_column'],
        typeFrom: 'firstArg',
        optionalityKeyword: 'nullable',
      },
    ],
    typeAliases: {
      charfield: 'string',
      textfield: 'string',
      emailfield: 'string',
      slugfield: 'string',
      urlfield: 'string',
      genericipaddressfield: 'string',
      uuidfield: 'uuid',
      integerfield: 'int',
      bigintegerfield: 'int',
      smallintegerfield: 'int',
      positiveintegerfield: 'int',
      positivesmallintegerfield: 'int',
      autofield: 'int',
      bigautofield: 'int',
      booleanfield: 'bool',
      floatfield: 'float',
      decimalfield: 'decimal',
      datefield: 'date',
      datetimefield: 'datetime',
      timefield: 'time',
      durationfield: 'duration',
      jsonfield: 'json',
      binaryfield: 'bytes',
      filefield: 'file',
      imagefield: 'file',
      foreignkey: 'fk',
      onetoonefield: 'fk',
      manytomanyfield: 'm2m',
    },
    schemaSignals: [
      { manifest: 'requirements.txt', anyOf: ['django', 'sqlalchemy', 'pydantic', 'sqlmodel'] },
      { manifest: 'pyproject.toml', anyOf: ['django', 'sqlalchemy', 'pydantic', 'sqlmodel'] },
      { manifest: 'Pipfile', anyOf: ['django', 'sqlalchemy', 'pydantic', 'sqlmodel'] },
    ],
  },

  // Tree-sitter grammar for the canonical AST layer (src/ast/). Logical name —
  // src/ast/ resolves it to the bundled wasm artifact and its shape row.
  treeSitterGrammars: {
    '.py': 'python',
  },

  clocLanguageNames: ['Python'],

  detect(cwd) {
    return (
      fileExists(cwd, 'pyproject.toml') ||
      fileExists(cwd, 'setup.py') ||
      fileExists(cwd, 'requirements.txt') ||
      fileExists(cwd, 'Pipfile') ||
      hasPyFile(cwd)
    );
  },

  tools: ['ruff', 'pip-audit', 'coverage-py', 'pip-licenses'],
  semgrepRulesets: ['p/python'],
  // CodeQL `python` extractor (no build); Snyk Code supports Python.
  deepSast: { codeqlLanguage: 'python', snykCode: true },

  correctness: pyCorrectnessProvider,
  lintGate: pyLintGateProvider,

  capabilities: {
    depVulns: pyDepVulnsProvider,
    lint: pyLintProvider,
    coverage: pyCoverageProvider,
    imports: pyImportsProvider,
    testFramework: pyTestFrameworkProvider,
    licenses: pyLicensesProvider,
  },

  mapLintSeverity: mapRuffSeverity,

  permissions: ['Bash(python3:*)', 'Bash(pytest:*)', 'Bash(ruff:*)'],
  ruleFile: 'python.md',
  ciSetup: {
    steps: [
      {
        name: 'Set up Python',
        uses: 'actions/setup-python@v5',
        with: { 'python-version': '3.12' },
        versionInput: 'python-version',
      },
    ],
  },
  defaultVersion: '3.12',
  detectVersion: detectPythonVersion,
  cliBinaries: ['python3', 'ruff'],
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/python:1',
    // installTools=false: the upstream python feature's installTools
    // bundle (pipx, flake8, black, mypy, autopep8, yapf, pydocstyle,
    // pycodestyle, bandit, pipenv, virtualenv, pylint, pytest) costs
    // ~3 min per devcontainer build and overlaps with dxkit's own
    // pinned scanner toolchain (ruff + pip-audit + pip-licenses +
    // coverage-py installed via TOOL_DEFS). Anything dxkit's Python
    // analyzers actually need is declared in tool-registry.ts; the
    // feature only needs to land the python interpreter itself.
    opts: { version: '3.12', installTools: false },
  },
  devcontainerExtensions: ['ms-python.python', 'ms-python.vscode-pylance'],
};
