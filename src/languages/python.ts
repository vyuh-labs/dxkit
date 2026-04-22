import * as fs from 'fs';
import * as path from 'path';

import { parseCoveragePy } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { enrichSeverities } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
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
  SeverityCounts,
  TestFrameworkResult,
} from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';

interface RuffResult {
  code: string;
  message: string;
  severity?: string;
}

interface PipAuditReport {
  dependencies: Array<{ vulns: Array<{ id: string; fix_versions: string[] }> }>;
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
 * Single source of truth for the python pack's dep-vuln gathering.
 * Consumed by `pyDepVulnsProvider` (capability dispatcher).
 */
async function gatherPyDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const pipAudit = findTool(TOOL_DEFS['pip-audit'], cwd);
  if (!pipAudit.available || !pipAudit.path) return { kind: 'tool-missing' };

  const raw = run(`${pipAudit.path} --format json 2>/dev/null`, cwd, 120000);
  if (!raw) return { kind: 'no-output' };

  try {
    const data = JSON.parse(raw) as PipAuditReport;
    const vulnIds: string[] = [];
    for (const dep of data.dependencies || []) {
      for (const v of dep.vulns || []) {
        if (v.id) vulnIds.push(v.id);
      }
    }
    // pip-audit doesn't carry severity per vuln — look up via OSV.dev.
    // Unknown/unreachable IDs fall back to medium (pip-audit's legacy default).
    const severities = await enrichSeverities(vulnIds);
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let enrichedCount = 0;
    for (const id of vulnIds) {
      const sev = severities.get(id);
      if (sev && sev !== 'unknown') {
        enrichedCount++;
        if (sev === 'critical') critical++;
        else if (sev === 'high') high++;
        else if (sev === 'medium') medium++;
        else low++;
      } else {
        medium++;
      }
    }
    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'pip-audit',
      enrichment: enrichedCount > 0 ? 'osv.dev' : null,
      counts: { critical, high, medium, low },
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
 * Locate the project's own Python interpreter. Conventional venv locations
 * are `.venv/bin/python[3]` or `venv/bin/python[3]`; we check in that
 * order. Returns null if no venv is found — the provider then skips
 * cleanly rather than falling through to pip-licenses's install env
 * (which would report dxkit's own packages, not the project's).
 */
function findPyProjectVenvPython(cwd: string): string | null {
  const candidates = [
    path.join(cwd, '.venv', 'bin', 'python'),
    path.join(cwd, '.venv', 'bin', 'python3'),
    path.join(cwd, 'venv', 'bin', 'python'),
    path.join(cwd, 'venv', 'bin', 'python3'),
  ];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* not this one */
    }
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

  const findings: LicenseFinding[] = [];
  for (const entry of data) {
    if (!entry.Name || !entry.Version) continue;
    const licenseType = entry.License && entry.License !== 'UNKNOWN' ? entry.License : 'UNKNOWN';
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
