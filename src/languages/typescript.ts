import * as fs from 'fs';
import * as path from 'path';

import { parseIstanbulFinal, parseIstanbulSummary } from '../analyzers/tools/coverage';
import { fileExists, run, runJSON } from '../analyzers/tools/runner';
import type { HealthMetrics } from '../analyzers/types';
import type { LanguageSupport } from './types';

const TS_JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

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

interface EslintRunResult {
  ran: boolean;
  errors: number;
  warnings: number;
  reason: string;
}

function runEslint(cwd: string): EslintRunResult {
  const lbEslintPath = 'node_modules/.bin/lb-eslint';
  const eslintPath = 'node_modules/.bin/eslint';

  const hasLbEslint = fileExists(cwd, lbEslintPath);
  const hasEslint = fileExists(cwd, eslintPath);

  if (!hasLbEslint && !hasEslint) {
    return { ran: false, errors: 0, warnings: 0, reason: 'not installed' };
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
      return {
        ran: false,
        errors: 0,
        warnings: 0,
        reason: `v${major} but project uses legacy .eslintrc`,
      };
    } else {
      return { ran: false, errors: 0, warnings: 0, reason: 'no eslint config found' };
    }
  }

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

  tools: ['eslint', 'npm-audit', 'vitest-coverage'],
  semgrepRulesets: ['p/javascript', 'p/typescript'],

  parseCoverage(cwd) {
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
        return c.parser(raw, c.file, cwd);
      } catch {
        continue;
      }
    }
    return null;
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

  gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    const eslintStatus = runEslint(cwd);
    if (eslintStatus.ran) {
      metrics.lintErrors = eslintStatus.errors;
      metrics.lintWarnings = eslintStatus.warnings;
      metrics.lintTool = 'eslint';
      metrics.toolsUsed!.push('eslint');
    } else {
      metrics.toolsUnavailable!.push(`eslint (${eslintStatus.reason})`);
    }

    const auditRaw = run('npm audit --json 2>&1', cwd, 60000);
    if (auditRaw) {
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
