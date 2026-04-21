import * as fs from 'fs';
import * as path from 'path';

import { parseIstanbulFinal, parseIstanbulSummary } from '../analyzers/tools/coverage';
import { fileExists, run, runJSON } from '../analyzers/tools/runner';
import type { HealthMetrics } from '../analyzers/types';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  DepVulnResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
} from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';

const TS_JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

interface EslintFileResult {
  messages: Array<{ severity: number; ruleId?: string | null }>;
}

/**
 * Tier an ESLint rule ID into the four-tier severity model.
 *
 * Priority is rule-name pattern first (security plugins, known-dangerous
 * rules), falling back to the rule's ESLint severity (2=error → high,
 * 1=warning → medium) for rules we don't recognize.
 *
 * Unknown rules default to 'low' so unfamiliar plugins don't inflate the
 * error count. Callers that also have the ESLint severity should prefer
 * mapLintMessageSeverity below.
 */
export function mapEslintRuleSeverity(ruleId: string | null | undefined): LintSeverity {
  if (!ruleId) return 'low';

  // Security plugins — both eslint-plugin-security and eslint-plugin-security-node.
  if (/^security(-node)?\//.test(ruleId)) return 'critical';

  // Known-dangerous built-in rules: anything that permits code injection.
  if (
    ruleId === 'no-eval' ||
    ruleId === 'no-implied-eval' ||
    ruleId === 'no-new-func' ||
    ruleId === 'no-script-url' ||
    ruleId === 'no-proto'
  ) {
    return 'critical';
  }
  if (/^@typescript-eslint\/no-unsafe-(eval|function-type)/.test(ruleId)) return 'critical';

  // Correctness / type-safety — bugs, not style.
  if (
    ruleId === 'no-undef' ||
    ruleId === 'no-unreachable' ||
    ruleId === 'no-duplicate-case' ||
    ruleId === 'no-dupe-keys' ||
    ruleId === 'no-dupe-args' ||
    ruleId === 'valid-typeof' ||
    ruleId === 'use-isnan' ||
    ruleId === 'no-cond-assign' ||
    ruleId === 'no-unsafe-negation' ||
    ruleId === 'no-obj-calls'
  ) {
    return 'high';
  }
  if (/^@typescript-eslint\/no-unsafe-/.test(ruleId)) return 'high';
  if (/^react-hooks\/rules-of-hooks$/.test(ruleId)) return 'high';

  // Best-practice / maintenance — not buggy but worth flagging.
  if (
    ruleId === 'no-console' ||
    ruleId === 'no-debugger' ||
    ruleId === 'no-var' ||
    ruleId === 'prefer-const' ||
    ruleId === 'eqeqeq'
  ) {
    return 'medium';
  }
  if (/^@typescript-eslint\/(no-explicit-any|no-unused-vars|ban-types)/.test(ruleId))
    return 'medium';
  if (/^react-hooks\/exhaustive-deps$/.test(ruleId)) return 'medium';

  // Style / formatting plugins default to low.
  if (/^(prettier|import|react|jsx-a11y|unicorn)\//.test(ruleId)) return 'low';

  return 'low';
}

/** Combine a rule-based tier with ESLint's own severity for unknown rules. */
function tierEslintMessage(
  ruleId: string | null | undefined,
  eslintSeverity: number,
): LintSeverity {
  const tiered = mapEslintRuleSeverity(ruleId);
  // For unknown rules (→ 'low'), use ESLint's own severity as a floor.
  if (tiered === 'low' && ruleId) {
    if (eslintSeverity === 2) return 'high';
    if (eslintSeverity === 1) return 'medium';
  }
  return tiered;
}

interface AuditV1 {
  metadata?: {
    vulnerabilities?: { critical?: number; high?: number; moderate?: number; low?: number };
  };
}

interface AuditV2 {
  vulnerabilities?: Record<string, { severity: string }>;
}

/**
 * Single source of truth for the typescript pack's dep-vuln gathering.
 * Both `capabilities.depVulns.gather()` and `gatherMetrics` consume this
 * — the legacy decomposition in `gatherMetrics` is the bridge that goes
 * away in Phase 10e.C.
 */
async function gatherTsDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  if (!fileExists(cwd, 'package.json')) return { kind: 'tool-missing' };
  const auditRaw = run('npm audit --json 2>&1', cwd, 60000);
  if (!auditRaw) return { kind: 'no-output' };
  try {
    const auditData = JSON.parse(auditRaw) as AuditV1 & AuditV2;
    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
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
    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical, high, medium, low },
    };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'parse-error' };
  }
}

const tsDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'typescript',
  async gather(cwd) {
    const outcome = await gatherTsDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

function stripTsJsComments(src: string): string {
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:"'/])\/\/[^\n]*/g, '$1');
  return out;
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

/**
 * Single source of truth for the typescript pack's lint gathering.
 * Both `capabilities.lint.gather()` and `gatherMetrics` consume this.
 * The legacy decomposition (collapse tier counts → errors/warnings) lives
 * in gatherMetrics and goes away in Phase 10e.C.
 */
function gatherTsLintResult(cwd: string): LintGatherOutcome {
  const lbEslintPath = 'node_modules/.bin/lb-eslint';
  const eslintPath = 'node_modules/.bin/eslint';

  const hasLbEslint = fileExists(cwd, lbEslintPath);
  const hasEslint = fileExists(cwd, eslintPath);

  if (!hasLbEslint && !hasEslint) {
    return { kind: 'unavailable', reason: 'not installed' };
  }

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

  const binToCheck = hasEslint ? `./${eslintPath}` : `./${lbEslintPath}`;
  const versionOutput = run(`${binToCheck} --version 2>/dev/null`, cwd);
  const majorMatch = versionOutput.match(/v?(\d+)/);
  const major = majorMatch ? parseInt(majorMatch[1]) : 0;

  if (major >= 9 && !hasFlatConfig) {
    if (hasLbEslint) {
      // lb-eslint may provide its own config; fall through to try it
    } else if (hasLegacyConfig) {
      return { kind: 'unavailable', reason: `v${major} but project uses legacy .eslintrc` };
    } else {
      return { kind: 'unavailable', reason: 'no eslint config found' };
    }
  }

  const bins = hasLbEslint ? [`./${lbEslintPath}`, `./${eslintPath}`] : [`./${eslintPath}`];
  for (const bin of bins) {
    if (!fileExists(cwd, bin.replace('./', ''))) continue;
    const result = runJSON<EslintFileResult[]>(`${bin} . --format json 2>/dev/null`, cwd, 120000);
    if (result && Array.isArray(result)) {
      const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
      for (const file of result) {
        for (const msg of file.messages || []) {
          counts[tierEslintMessage(msg.ruleId, msg.severity)]++;
        }
      }
      const envelope: LintResult = { schemaVersion: 1, tool: 'eslint', counts };
      return { kind: 'success', envelope };
    }
  }

  return { kind: 'unavailable', reason: 'config error' };
}

const tsLintProvider: CapabilityProvider<LintResult> = {
  source: 'typescript',
  async gather(cwd) {
    const outcome = gatherTsLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the typescript pack's coverage gathering.
 * Both `capabilities.coverage.gather()` and `parseCoverage` (legacy)
 * consume this. The parseCoverage method is removed in Phase 10e.B.3.6.
 */
function gatherTsCoverageResult(cwd: string): CoverageResult | null {
  const candidates = [
    { file: 'coverage/coverage-summary.json', parser: parseIstanbulSummary },
    { file: 'coverage/coverage-final.json', parser: parseIstanbulFinal },
  ] as const;
  for (const c of candidates) {
    const abs = path.join(cwd, c.file);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    try {
      const coverage = c.parser(raw, c.file, cwd);
      return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
    } catch {
      continue;
    }
  }
  return null;
}

const tsCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'typescript',
  async gather(cwd) {
    return gatherTsCoverageResult(cwd);
  },
};

export const typescript: LanguageSupport = {
  id: 'typescript',
  displayName: 'TypeScript / JavaScript',
  sourceExtensions: [...TS_JS_EXT],
  testFilePatterns: [
    '*.test.ts',
    '*.test.tsx',
    '*.test.js',
    '*.test.jsx',
    '*.test.mjs',
    '*.test.cjs',
    '*.spec.ts',
    '*.spec.tsx',
    '*.spec.js',
    '*.spec.jsx',
    '*.spec.mjs',
    '*.spec.cjs',
  ],
  extraExcludes: ['node_modules', 'dist', '.next', '.turbo', 'coverage', '.cache'],

  detect(cwd) {
    return fileExists(cwd, 'package.json');
  },

  mapLintSeverity: mapEslintRuleSeverity,

  tools: ['eslint', 'npm-audit', 'vitest-coverage'],
  semgrepRulesets: ['p/javascript', 'p/typescript'],

  capabilities: {
    depVulns: tsDepVulnsProvider,
    lint: tsLintProvider,
    coverage: tsCoverageProvider,
  },

  extractImports(content) {
    const out: string[] = [];
    const stripped = stripTsJsComments(content);
    const importRe = /\bimport\s+(?:[^'";]*?from\s+)?['"]([^'"]+)['"]/g;
    const reexportRe = /\bexport\s+(?:[^'";]*?from\s+)['"]([^'"]+)['"]/g;
    const dynRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    const reqRe = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const re of [importRe, reexportRe, dynRe, reqRe]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        out.push(m[1]);
      }
    }
    return out;
  },

  resolveImport(fromFile, spec, cwd) {
    if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
    const fromDir = path.dirname(path.join(cwd, fromFile));
    const baseAbs = path.resolve(fromDir, spec);

    for (const ext of TS_JS_EXT) {
      if (baseAbs.endsWith(ext) && isFile(baseAbs)) {
        return toRel(baseAbs, cwd);
      }
    }
    for (const ext of TS_JS_EXT) {
      if (isFile(baseAbs + ext)) return toRel(baseAbs + ext, cwd);
    }
    for (const ext of TS_JS_EXT) {
      const idx = path.join(baseAbs, 'index' + ext);
      if (isFile(idx)) return toRel(idx, cwd);
    }
    return null;
  },

  async gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    // LEGACY: lintErrors/lintWarnings/lintTool populated from capabilities.lint;
    // removed in Phase 10e.C when reports stop reading these.
    // Collapse: critical + high → errors, medium + low → warnings.
    const lintOutcome = gatherTsLintResult(cwd);
    if (lintOutcome.kind === 'success') {
      const c = lintOutcome.envelope.counts;
      metrics.lintErrors = c.critical + c.high;
      metrics.lintWarnings = c.medium + c.low;
      metrics.lintTool = lintOutcome.envelope.tool;
      metrics.toolsUsed!.push('eslint');
    } else {
      metrics.toolsUnavailable!.push(`eslint (${lintOutcome.reason})`);
    }

    // LEGACY: depVuln* fields populated from capabilities.depVulns;
    // removed in Phase 10e.C when reports stop reading these.
    const dvOutcome = await gatherTsDepVulnsResult(cwd);
    if (dvOutcome.kind === 'success') {
      const e = dvOutcome.envelope;
      metrics.depVulnCritical = e.counts.critical;
      metrics.depVulnHigh = e.counts.high;
      metrics.depVulnMedium = e.counts.medium;
      metrics.depVulnLow = e.counts.low;
      metrics.depAuditTool = e.tool;
      metrics.toolsUsed!.push('npm-audit');
    } else if (dvOutcome.kind === 'parse-error') {
      metrics.toolsUnavailable!.push('npm-audit (parse error)');
    } else if (dvOutcome.kind === 'no-output' || dvOutcome.kind === 'tool-missing') {
      metrics.toolsUnavailable!.push('npm-audit');
    }

    const testScript = run(
      "node -e \"const p=require('./package.json'); console.log(p.scripts?.test || '')\" 2>/dev/null", // slop-ok
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

    const scriptsOutput = run(
      'node -e "const p=require(\'./package.json\'); console.log(Object.keys(p.scripts||{}).length)" 2>/dev/null', // slop-ok
      cwd,
    );
    metrics.npmScriptsCount = parseInt(scriptsOutput) || 0;

    const engineOutput = run(
      "node -e \"const p=require('./package.json'); console.log(p.engines?.node || '')\" 2>/dev/null", // slop-ok
      cwd,
    );
    if (engineOutput) {
      metrics.nodeEngineVersion = engineOutput;
    }

    return metrics;
  },
};
