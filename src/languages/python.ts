import * as fs from 'fs';
import * as path from 'path';

import { parseCoveragePy } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { enrichSeverities } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
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
 * Both `capabilities.depVulns.gather()` and `gatherMetrics` consume this.
 * The legacy decomposition in `gatherMetrics` is the bridge that goes
 * away in Phase 10e.C.
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
 * Both `capabilities.lint.gather()` and `gatherMetrics` consume this.
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
 * Both `capabilities.coverage.gather()` and `parseCoverage` (legacy)
 * consume this. The parseCoverage method is removed in Phase 10e.B.3.6.
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

  tools: ['ruff', 'pip-audit', 'coverage-py'],
  semgrepRulesets: ['p/python'],

  capabilities: {
    depVulns: pyDepVulnsProvider,
    lint: pyLintProvider,
    coverage: pyCoverageProvider,
    imports: pyImportsProvider,
  },

  async gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    // LEGACY: lintErrors/lintWarnings/lintTool populated from capabilities.lint;
    // removed in Phase 10e.C when reports stop reading these.
    // Collapse: critical + high → errors, medium + low → warnings.
    const lintOutcome = gatherPyLintResult(cwd);
    if (lintOutcome.kind === 'success') {
      const c = lintOutcome.envelope.counts;
      metrics.lintErrors = c.critical + c.high;
      metrics.lintWarnings = c.medium + c.low;
      metrics.lintTool = lintOutcome.envelope.tool;
      metrics.toolsUsed!.push('ruff');
    } else {
      metrics.toolsUnavailable!.push(
        lintOutcome.reason === 'not installed' ? 'ruff' : `ruff (${lintOutcome.reason})`,
      );
    }

    // LEGACY: depVuln* fields populated from capabilities.depVulns;
    // removed in Phase 10e.C when reports stop reading these.
    const dvOutcome = await gatherPyDepVulnsResult(cwd);
    if (dvOutcome.kind === 'success') {
      const e = dvOutcome.envelope;
      metrics.depVulnCritical = e.counts.critical;
      metrics.depVulnHigh = e.counts.high;
      metrics.depVulnMedium = e.counts.medium;
      metrics.depVulnLow = e.counts.low;
      metrics.depAuditTool = e.tool;
      metrics.toolsUsed!.push('pip-audit');
      if (e.enrichment === 'osv.dev') metrics.toolsUsed!.push('osv.dev');
    } else if (dvOutcome.kind === 'parse-error') {
      metrics.toolsUnavailable!.push('pip-audit (parse error)');
    } else if (dvOutcome.kind === 'tool-missing') {
      metrics.toolsUnavailable!.push('pip-audit');
    }
    // 'no-output' was previously silent (raw was empty so the if (raw) block
    // didn't run and nothing was pushed); preserve that behavior.

    if (fileExists(cwd, 'pytest.ini', 'conftest.py') || fileExists(cwd, 'pyproject.toml')) {
      const pyproject = run('cat pyproject.toml 2>/dev/null', cwd);
      if (pyproject?.includes('[tool.pytest') || fileExists(cwd, 'pytest.ini', 'conftest.py')) {
        metrics.testFramework = 'pytest';
      }
    }

    return metrics;
  },

  mapLintSeverity: mapRuffSeverity,
};
