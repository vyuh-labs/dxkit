/**
 * Python tool runner — ruff (lint), pip-audit (deps).
 * Layer 1: language-specific tools for Python projects.
 */
import { HealthMetrics } from '../types';
import { run, fileExists } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';

interface RuffResult {
  code: string;
  message: string;
  severity?: string;
}

/** Gather Python-specific metrics. */
export function gatherPythonMetrics(cwd: string): Partial<HealthMetrics> {
  const metrics: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };

  // ruff (lint)
  const ruff = findTool(TOOL_DEFS.ruff, cwd);
  if (ruff.available && ruff.path) {
    const raw = run(`${ruff.path} check . --output-format json 2>/dev/null`, cwd, 60000);
    if (raw) {
      try {
        const results = JSON.parse(raw) as RuffResult[];
        if (Array.isArray(results)) {
          // ruff doesn't distinguish error/warning by default — all are errors
          metrics.lintErrors = results.length;
          metrics.lintWarnings = 0;
          metrics.lintTool = 'ruff';
          metrics.toolsUsed!.push('ruff');
        }
      } catch {
        metrics.toolsUnavailable!.push('ruff (parse error)');
      }
    } else {
      // Empty output = no errors
      metrics.lintErrors = 0;
      metrics.lintWarnings = 0;
      metrics.lintTool = 'ruff';
      metrics.toolsUsed!.push('ruff');
    }
  } else {
    metrics.toolsUnavailable!.push('ruff');
  }

  // pip-audit (dependency vulnerabilities)
  const pipAudit = findTool(TOOL_DEFS['pip-audit'], cwd);
  if (pipAudit.available && pipAudit.path) {
    const raw = run(`${pipAudit.path} --format json 2>/dev/null`, cwd, 120000);
    if (raw) {
      try {
        const data = JSON.parse(raw) as {
          dependencies: Array<{ vulns: Array<{ id: string; fix_versions: string[] }> }>;
        };
        let medium = 0;
        for (const dep of data.dependencies || []) {
          // pip-audit doesn't provide severity — count all as medium
          medium += (dep.vulns || []).length;
        }
        const critical = 0;
        const high = 0;
        const low = 0;
        metrics.depVulnCritical = critical;
        metrics.depVulnHigh = high;
        metrics.depVulnMedium = medium;
        metrics.depVulnLow = low;
        metrics.depAuditTool = 'pip-audit';
        metrics.toolsUsed!.push('pip-audit');
      } catch {
        metrics.toolsUnavailable!.push('pip-audit (parse error)');
      }
    }
  } else {
    metrics.toolsUnavailable!.push('pip-audit');
  }

  // Test framework detection (don't run tests — just detect)
  if (fileExists(cwd, 'pytest.ini', 'conftest.py') || fileExists(cwd, 'pyproject.toml')) {
    const pyproject = run('cat pyproject.toml 2>/dev/null', cwd);
    if (pyproject?.includes('[tool.pytest') || fileExists(cwd, 'pytest.ini', 'conftest.py')) {
      metrics.testFramework = 'pytest';
    }
  }

  return metrics;
}
