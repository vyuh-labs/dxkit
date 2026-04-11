/**
 * Node.js tool runner -- eslint, npm audit, test runners.
 * Layer 1 (project tools) + Layer 2 (optional tools).
 */
import { HealthMetrics } from '../types';
import { run, runJSON, fileExists } from './runner';

interface EslintFileResult {
  messages: Array<{ severity: number }>;
}

interface AuditV1 {
  metadata?: {
    vulnerabilities?: { critical?: number; high?: number; moderate?: number; low?: number };
  };
}

interface AuditV2 {
  vulnerabilities?: Record<string, { severity: string }>;
}

/** Gather Node.js-specific metrics. */
export function gatherNodeMetrics(cwd: string): Partial<HealthMetrics> {
  const metrics: Partial<HealthMetrics> = {
    toolsUsed: [],
    toolsUnavailable: [],
  };

  // ESLint — prefer project-local version to match the project's config format
  if (fileExists(cwd, 'node_modules/.bin/eslint')) {
    const eslintResult = runJSON<EslintFileResult[]>(
      './node_modules/.bin/eslint . --format json 2>/dev/null',
      cwd,
      120000,
    );
    if (eslintResult && Array.isArray(eslintResult)) {
      let errors = 0;
      let warnings = 0;
      for (const file of eslintResult) {
        for (const msg of file.messages || []) {
          if (msg.severity === 2) errors++;
          else warnings++;
        }
      }
      metrics.lintErrors = errors;
      metrics.lintWarnings = warnings;
      metrics.lintTool = 'eslint';
      metrics.toolsUsed!.push('eslint');
    } else {
      metrics.toolsUnavailable!.push('eslint (failed to run)');
    }
  } else {
    metrics.toolsUnavailable!.push('eslint');
  }

  // npm audit -- handles both v1 and v2+ formats
  // npm audit may exit non-zero when vulnerabilities exist, so use run() which catches errors
  // Don't redirect stderr to /dev/null — some versions write JSON to stderr
  const auditRaw = run('npm audit --json 2>&1', cwd, 60000);
  if (auditRaw) {
    try {
      const auditData = JSON.parse(auditRaw) as AuditV1 & AuditV2;
      let critical = 0,
        high = 0,
        medium = 0,
        low = 0;

      if (auditData.metadata?.vulnerabilities) {
        const v = auditData.metadata.vulnerabilities;
        critical = v.critical || 0;
        high = v.high || 0;
        medium = v.moderate || 0;
        low = v.low || 0;
      } else if (auditData.vulnerabilities) {
        for (const v of Object.values(auditData.vulnerabilities)) {
          if (v.severity === 'critical') critical++;
          else if (v.severity === 'high') high++;
          else if (v.severity === 'moderate') medium++;
          else if (v.severity === 'low') low++;
        }
      }
      metrics.depVulnCritical = critical;
      metrics.depVulnHigh = high;
      metrics.depVulnMedium = medium;
      metrics.depVulnLow = low;
      metrics.depAuditTool = 'npm-audit';
      metrics.toolsUsed!.push('npm-audit');
    } catch {
      metrics.toolsUnavailable!.push('npm-audit (parse error)');
    }
  } else {
    metrics.toolsUnavailable!.push('npm-audit');
  }

  // Test runner detection (detect framework but don't run tests -- too slow for health audit)
  const testScript = run(
    "node -e \"const p=require('./package.json'); console.log(p.scripts?.test || '')\" 2>/dev/null",
    cwd,
  );
  if (testScript && testScript !== 'echo "Error: no test specified" && exit 1') {
    let framework = 'unknown';
    if (testScript.includes('vitest')) framework = 'vitest';
    else if (testScript.includes('jest')) framework = 'jest';
    else if (testScript.includes('mocha') || testScript.includes('lb-mocha')) framework = 'mocha';
    else if (testScript.includes('ava')) framework = 'ava';
    else if (testScript.includes('tap')) framework = 'tap';
    metrics.testFramework = framework;
  }

  // npm scripts count
  const scriptsOutput = run(
    'node -e "const p=require(\'./package.json\'); console.log(Object.keys(p.scripts||{}).length)" 2>/dev/null',
    cwd,
  );
  metrics.npmScriptsCount = parseInt(scriptsOutput) || 0;

  // Node engine
  const engineOutput = run(
    "node -e \"const p=require('./package.json'); console.log(p.engines?.node || '')\" 2>/dev/null",
    cwd,
  );
  if (engineOutput) {
    metrics.nodeEngineVersion = engineOutput;
  }

  return metrics;
}
