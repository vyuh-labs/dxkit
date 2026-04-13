/**
 * C# / .NET tool runner — dotnet format, dotnet list package --vulnerable.
 * Layer 1: language-specific tools for .NET projects.
 */
import { HealthMetrics } from '../types';
import { run, runExitCode, fileExists } from './runner';
import { findTool, TOOL_DEFS } from './tool-registry';

/** Gather .NET-specific metrics. */
export function gatherDotnetMetrics(cwd: string): Partial<HealthMetrics> {
  const metrics: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };

  // dotnet format (lint/formatting check)
  const dotnet = findTool(TOOL_DEFS['dotnet-format'], cwd);
  if (dotnet.available) {
    const exitCode = runExitCode('dotnet format --verify-no-changes 2>/dev/null', cwd, 120000);
    if (exitCode === 0) {
      metrics.lintErrors = 0;
      metrics.lintWarnings = 0;
    } else {
      // Count format violations from output
      const raw = run('dotnet format --verify-no-changes 2>&1', cwd, 120000);
      const violations = raw ? raw.split('\n').filter((l) => l.includes('Formatted')).length : 1;
      metrics.lintErrors = violations;
      metrics.lintWarnings = 0;
    }
    metrics.lintTool = 'dotnet-format';
    metrics.toolsUsed!.push('dotnet-format');
  } else {
    metrics.toolsUnavailable!.push('dotnet-format');
  }

  // dotnet list package --vulnerable
  if (dotnet.available) {
    const raw = run('dotnet list package --vulnerable --format json 2>/dev/null', cwd, 120000);
    if (raw) {
      try {
        const data = JSON.parse(raw) as {
          projects?: Array<{
            frameworks?: Array<{
              topLevelPackages?: Array<{
                resolvedVersion: string;
                advisories?: Array<{ severity: string }>;
              }>;
            }>;
          }>;
        };
        let critical = 0,
          high = 0,
          medium = 0,
          low = 0;
        for (const proj of data.projects || []) {
          for (const fw of proj.frameworks || []) {
            for (const pkg of fw.topLevelPackages || []) {
              for (const adv of pkg.advisories || []) {
                const sev = adv.severity?.toLowerCase();
                if (sev === 'critical') critical++;
                else if (sev === 'high') high++;
                else if (sev === 'moderate' || sev === 'medium') medium++;
                else low++;
              }
            }
          }
        }
        if (critical + high + medium + low > 0) {
          metrics.depVulnCritical = critical;
          metrics.depVulnHigh = high;
          metrics.depVulnMedium = medium;
          metrics.depVulnLow = low;
          metrics.depAuditTool = 'dotnet-vulnerable';
          metrics.toolsUsed!.push('dotnet-vulnerable');
        }
      } catch {
        // --format json not supported in older SDKs — try text parsing
        metrics.toolsUnavailable!.push('dotnet-vulnerable (parse error)');
      }
    }
  }

  // Test framework detection
  if (fileExists(cwd, '*.csproj')) {
    const csproj = run(
      "find . -name '*.csproj' -exec grep -l 'xunit\\|nunit\\|MSTest' {} \\; 2>/dev/null | head -1",
      cwd,
    );
    if (csproj) {
      metrics.testFramework = 'dotnet-test';
    }
  }

  return metrics;
}
