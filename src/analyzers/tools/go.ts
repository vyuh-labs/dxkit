/**
 * Go tool runner — golangci-lint, govulncheck.
 * Layer 1: language-specific tools for Go projects.
 */
import { HealthMetrics } from '../types';
import { run, fileExists } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';

interface GolangciIssue {
  Severity: string;
  Text: string;
}

interface GolangciResult {
  Issues?: GolangciIssue[];
}

/** Gather Go-specific metrics. */
export function gatherGoMetrics(cwd: string): Partial<HealthMetrics> {
  const metrics: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };

  // golangci-lint
  const lint = findTool(TOOL_DEFS['golangci-lint'], cwd);
  if (lint.available && lint.path) {
    const raw = run(`${lint.path} run --out-format json ./... 2>/dev/null`, cwd, 120000);
    if (raw) {
      try {
        const data = JSON.parse(raw) as GolangciResult;
        const issues = data.Issues || [];
        const errors = issues.filter((i) => i.Severity === 'error').length;
        const warnings = issues.length - errors;
        metrics.lintErrors = errors;
        metrics.lintWarnings = warnings;
        metrics.lintTool = 'golangci-lint';
        metrics.toolsUsed!.push('golangci-lint');
      } catch {
        metrics.toolsUnavailable!.push('golangci-lint (parse error)');
      }
    } else {
      // Empty = no issues
      metrics.lintErrors = 0;
      metrics.lintWarnings = 0;
      metrics.lintTool = 'golangci-lint';
      metrics.toolsUsed!.push('golangci-lint');
    }
  } else {
    metrics.toolsUnavailable!.push('golangci-lint');
  }

  // govulncheck
  const vuln = findTool(TOOL_DEFS.govulncheck, cwd);
  if (vuln.available && vuln.path) {
    const raw = run(`${vuln.path} -json ./... 2>/dev/null`, cwd, 120000);
    if (raw) {
      try {
        // govulncheck JSON is newline-delimited JSON objects
        let vulnCount = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.finding) vulnCount++;
          } catch {
            /* skip non-JSON lines */
          }
        }
        // govulncheck doesn't provide severity breakdown — count all as high
        metrics.depVulnHigh = vulnCount;
        metrics.depVulnCritical = 0;
        metrics.depVulnMedium = 0;
        metrics.depVulnLow = 0;
        metrics.depAuditTool = 'govulncheck';
        metrics.toolsUsed!.push('govulncheck');
      } catch {
        metrics.toolsUnavailable!.push('govulncheck (parse error)');
      }
    }
  } else {
    metrics.toolsUnavailable!.push('govulncheck');
  }

  // Test framework detection
  if (fileExists(cwd, 'go.mod')) {
    metrics.testFramework = 'go-test';
  }

  return metrics;
}
