import * as fs from 'fs';
import * as path from 'path';

import { parseCoveragePy } from '../analyzers/tools/coverage';
import { enrichSeverities } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
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

  parseCoverage(cwd) {
    const file = path.join(cwd, 'coverage.json');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
    try {
      return parseCoveragePy(raw, 'coverage.json', cwd);
    } catch {
      return null;
    }
  },

  extractImports(content) {
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
  },

  resolveImport(fromFile, spec, cwd) {
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
  },

  async gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    const ruff = findTool(TOOL_DEFS.ruff, cwd);
    if (ruff.available && ruff.path) {
      const raw = run(`${ruff.path} check . --output-format json 2>/dev/null`, cwd, 60000);
      if (raw) {
        try {
          const results = JSON.parse(raw) as RuffResult[];
          if (Array.isArray(results)) {
            let errors = 0;
            let warnings = 0;
            for (const r of results) {
              const sev = mapRuffSeverity(r.code);
              if (sev === 'critical' || sev === 'high') errors++;
              else warnings++;
            }
            metrics.lintErrors = errors;
            metrics.lintWarnings = warnings;
            metrics.lintTool = 'ruff';
            metrics.toolsUsed!.push('ruff');
          }
        } catch {
          metrics.toolsUnavailable!.push('ruff (parse error)');
        }
      } else {
        metrics.lintErrors = 0;
        metrics.lintWarnings = 0;
        metrics.lintTool = 'ruff';
        metrics.toolsUsed!.push('ruff');
      }
    } else {
      metrics.toolsUnavailable!.push('ruff');
    }

    const pipAudit = findTool(TOOL_DEFS['pip-audit'], cwd);
    if (pipAudit.available && pipAudit.path) {
      const raw = run(`${pipAudit.path} --format json 2>/dev/null`, cwd, 120000);
      if (raw) {
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
          metrics.depVulnCritical = critical;
          metrics.depVulnHigh = high;
          metrics.depVulnMedium = medium;
          metrics.depVulnLow = low;
          metrics.depAuditTool = 'pip-audit';
          metrics.toolsUsed!.push('pip-audit');
          if (enrichedCount > 0) metrics.toolsUsed!.push('osv.dev');
        } catch {
          metrics.toolsUnavailable!.push('pip-audit (parse error)');
        }
      }
    } else {
      metrics.toolsUnavailable!.push('pip-audit');
    }

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
