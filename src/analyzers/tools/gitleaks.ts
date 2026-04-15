/**
 * Gitleaks integration -- secret scanning with 800+ patterns.
 * Layer 2 (optional): requires `gitleaks` binary.
 */
import { HealthMetrics } from '../types';
import { run } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';
import { isExcludedPath } from './exclusions';

interface GitleaksFinding {
  RuleID: string;
  Description: string;
  File: string;
  StartLine: number;
  Secret: string;
}

/** Gather secret scanning metrics via gitleaks. */
export function gatherGitleaksMetrics(cwd: string): Partial<HealthMetrics> {
  const gitleaksCmd = findGitleaks(cwd);
  if (!gitleaksCmd) {
    return { toolsUnavailable: ['gitleaks'] };
  }

  // Run gitleaks with JSON report (--no-git scans files, not git history)
  const reportPath = `/tmp/dxkit-gitleaks-${Date.now()}.json`;
  run(
    `${gitleaksCmd} detect --source '${cwd}' --report-format json --report-path '${reportPath}' --no-git --exit-code 0 2>/dev/null`,
    cwd,
    120000,
  );

  // Read report file
  const reportRaw = run(`cat '${reportPath}' 2>/dev/null`, cwd);
  // Clean up
  run(`rm -f '${reportPath}'`, cwd);

  if (!reportRaw) {
    return { toolsUnavailable: ['gitleaks (no output)'] };
  }

  try {
    const findings = JSON.parse(reportRaw) as GitleaksFinding[];
    if (!Array.isArray(findings)) {
      return { toolsUsed: ['gitleaks'] };
    }

    const secretDetails: HealthMetrics['secretDetails'] = findings.map((f) => ({
      file: f.File.replace(cwd + '/', '').replace(cwd, ''),
      line: f.StartLine,
      rule: f.RuleID,
      severity: f.RuleID.includes('private-key') ? 'critical' : 'high',
    }));

    // Post-filter using project exclusions. Gitleaks --no-git scans everything
    // on disk (ignores .gitignore), so we re-apply the resolved exclusion set
    // via the centralized isExcludedPath() predicate.
    const filtered = secretDetails.filter((d) => !isExcludedPath(cwd, d.file));

    return {
      secretFindings: filtered.length,
      secretDetails: filtered,
      toolsUsed: ['gitleaks'],
    };
  } catch {
    return { toolsUnavailable: ['gitleaks (parse error)'] };
  }
}

function findGitleaks(cwd: string): string | null {
  const status = findTool(TOOL_DEFS.gitleaks, cwd);
  return status.available ? status.path : null;
}
