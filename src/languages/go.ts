import * as fs from 'fs';
import * as path from 'path';

import { parseGoCoverProfile } from '../analyzers/tools/coverage';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
import type { LanguageSupport } from './types';

interface GolangciResult {
  Issues?: Array<{ Severity: string; Text: string }>;
}

export const go: LanguageSupport = {
  id: 'go',
  displayName: 'Go',
  sourceExtensions: ['.go'],
  testFilePatterns: ['*_test.go'],
  extraExcludes: ['vendor'],

  detect(cwd) {
    return fileExists(cwd, 'go.mod');
  },

  tools: ['golangci-lint', 'govulncheck'],
  semgrepRulesets: ['p/gosec'],

  parseCoverage(cwd) {
    for (const file of ['coverage.out', 'cover.out']) {
      const abs = path.join(cwd, file);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      try {
        return parseGoCoverProfile(raw, file, cwd);
      } catch {
        continue;
      }
    }
    return null;
  },

  extractImports(content) {
    const out: string[] = [];
    // Single-line: `import "fmt"` or `import foo "pkg/name"`
    const singleRe = /^\s*import\s+(?:[a-zA-Z_]\w*\s+)?"([^"]+)"/gm;
    let m: RegExpExecArray | null;
    while ((m = singleRe.exec(content)) !== null) {
      out.push(m[1]);
    }
    // Multi-line: `import (\n  "fmt"\n  alias "pkg"\n)`
    const blockRe = /import\s*\(([\s\S]*?)\)/g;
    while ((m = blockRe.exec(content)) !== null) {
      const block = m[1];
      const lineRe = /(?:[a-zA-Z_]\w*\s+)?"([^"]+)"/g;
      let lm: RegExpExecArray | null;
      while ((lm = lineRe.exec(block)) !== null) {
        if (!out.includes(lm[1])) {
          out.push(lm[1]);
        }
      }
    }
    return out;
  },

  resolveImport(fromFile, spec, cwd) {
    // Go import paths are module-based, not file-relative.
    // Internal packages resolve as <module>/internal/... → cwd/internal/...
    let goMod: string;
    try {
      goMod = fs.readFileSync(path.join(cwd, 'go.mod'), 'utf-8');
    } catch {
      return null;
    }
    const moduleMatch = goMod.match(/^module\s+(\S+)/m);
    if (!moduleMatch) return null;
    const modulePath = moduleMatch[1];
    if (!spec.startsWith(modulePath + '/')) return null;
    const rel = spec.slice(modulePath.length + 1);
    const dir = path.join(cwd, rel);
    try {
      if (fs.statSync(dir).isDirectory()) {
        return rel;
      }
    } catch {
      // not found
    }
    return null;
  },

  async gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

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
        metrics.lintErrors = 0;
        metrics.lintWarnings = 0;
        metrics.lintTool = 'golangci-lint';
        metrics.toolsUsed!.push('golangci-lint');
      }
    } else {
      metrics.toolsUnavailable!.push('golangci-lint');
    }

    const vuln = findTool(TOOL_DEFS.govulncheck, cwd);
    if (vuln.available && vuln.path) {
      const raw = run(`${vuln.path} -json ./... 2>/dev/null`, cwd, 120000);
      if (raw) {
        try {
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

    if (fileExists(cwd, 'go.mod')) {
      metrics.testFramework = 'go-test';
    }

    return metrics;
  },
};
