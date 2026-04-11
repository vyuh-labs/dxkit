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

  // ESLint — pick the right binary and config format, skip gracefully if mismatched
  const eslintStatus = runEslint(cwd);
  if (eslintStatus.ran) {
    metrics.lintErrors = eslintStatus.errors;
    metrics.lintWarnings = eslintStatus.warnings;
    metrics.lintTool = 'eslint';
    metrics.toolsUsed!.push('eslint');
  } else {
    metrics.toolsUnavailable!.push(`eslint (${eslintStatus.reason})`);
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

interface EslintRunResult {
  ran: boolean;
  errors: number;
  warnings: number;
  reason: string;
}

/**
 * Run eslint with config-aware binary selection and graceful failure.
 *
 * Compatibility matrix:
 * - ESLint v9+: needs eslint.config.{js,mjs,cjs,ts} (flat config)
 * - ESLint v8: needs .eslintrc.{js,json,yml,yaml,cjs}
 * - LoopBack projects: use lb-eslint binary with embedded config
 */
function runEslint(cwd: string): EslintRunResult {
  // Prefer lb-eslint if present (LoopBack embeds its own config)
  const lbEslintPath = 'node_modules/.bin/lb-eslint';
  const eslintPath = 'node_modules/.bin/eslint';

  const hasLbEslint = fileExists(cwd, lbEslintPath);
  const hasEslint = fileExists(cwd, eslintPath);

  if (!hasLbEslint && !hasEslint) {
    return { ran: false, errors: 0, warnings: 0, reason: 'not installed' };
  }

  // Detect config format
  const hasFlatConfig = fileExists(
    cwd,
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
  );
  const hasLegacyConfig = fileExists(
    cwd,
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
    '.eslintrc.cjs',
  );

  // Get eslint version to check compatibility
  const binToCheck = hasEslint ? `./${eslintPath}` : `./${lbEslintPath}`;
  const versionOutput = run(`${binToCheck} --version 2>/dev/null`, cwd);
  const majorMatch = versionOutput.match(/v?(\d+)/);
  const major = majorMatch ? parseInt(majorMatch[1]) : 0;

  // Config compatibility check
  if (major >= 9 && !hasFlatConfig) {
    // v9+ needs flat config
    if (hasLbEslint) {
      // lb-eslint may provide its own config; try it
      // (fall through to actual run)
    } else if (hasLegacyConfig) {
      return {
        ran: false,
        errors: 0,
        warnings: 0,
        reason: `v${major} but project uses legacy .eslintrc`,
      };
    } else {
      return {
        ran: false,
        errors: 0,
        warnings: 0,
        reason: 'no eslint config found',
      };
    }
  }

  // Prefer lb-eslint first if available, then standard eslint
  const bins = hasLbEslint ? [`./${lbEslintPath}`, `./${eslintPath}`] : [`./${eslintPath}`];

  for (const bin of bins) {
    if (!fileExists(cwd, bin.replace('./', ''))) continue;
    const result = runJSON<EslintFileResult[]>(`${bin} . --format json 2>/dev/null`, cwd, 120000);
    if (result && Array.isArray(result)) {
      let errors = 0;
      let warnings = 0;
      for (const file of result) {
        for (const msg of file.messages || []) {
          if (msg.severity === 2) errors++;
          else warnings++;
        }
      }
      return { ran: true, errors, warnings, reason: '' };
    }
  }

  return { ran: false, errors: 0, warnings: 0, reason: 'config error' };
}
