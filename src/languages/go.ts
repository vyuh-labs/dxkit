import * as fs from 'fs';
import * as path from 'path';

import { parseGoCoverProfile } from '../analyzers/tools/coverage';
import { classifyOsvSeverity, enrichSeverities, type OsvVuln } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
import type { CapabilityProvider } from './capabilities/provider';
import type { DepVulnGatherOutcome, DepVulnResult } from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';

interface GolangciIssue {
  FromLinter?: string;
  Severity?: string;
  Text?: string;
}

interface GolangciResult {
  Issues?: GolangciIssue[];
}

/**
 * Tier a golangci-lint finding by the linter that produced it.
 *
 * golangci-lint bundles ~60 linters with different character. The
 * `FromLinter` field identifies which one fired. `Severity` (often empty)
 * is used only as a fallback floor for unknown linters.
 */
export function mapGolangciLinterSeverity(linter: string | undefined): LintSeverity {
  if (!linter) return 'low';

  // Security — gosec exclusively flags vuln patterns.
  if (linter === 'gosec') return 'critical';

  // Correctness bugs — go vet, staticcheck analyses, type errors, etc.
  if (
    linter === 'govet' ||
    linter === 'staticcheck' ||
    linter === 'typecheck' ||
    linter === 'errorlint' ||
    linter === 'ineffassign' ||
    linter === 'unused' ||
    linter === 'nilerr' ||
    linter === 'bodyclose' ||
    linter === 'rowserrcheck' ||
    linter === 'sqlclosecheck' ||
    linter === 'noctx'
  ) {
    return 'high';
  }

  // Best practices / maintenance
  if (
    linter === 'errcheck' ||
    linter === 'gocritic' ||
    linter === 'revive' ||
    linter === 'goconst' ||
    linter === 'gocyclo' ||
    linter === 'funlen' ||
    linter === 'dupl' ||
    linter === 'gosimple' ||
    linter === 'unconvert' ||
    linter === 'unparam' ||
    linter === 'prealloc' ||
    linter === 'gocognit'
  ) {
    return 'medium';
  }

  // Style / formatting
  if (
    linter === 'gofmt' ||
    linter === 'gofumpt' ||
    linter === 'goimports' ||
    linter === 'stylecheck' ||
    linter === 'whitespace' ||
    linter === 'misspell' ||
    linter === 'godot' ||
    linter === 'lll'
  ) {
    return 'low';
  }

  return 'low';
}

function tierGolangciIssue(issue: GolangciIssue): LintSeverity {
  const byLinter = mapGolangciLinterSeverity(issue.FromLinter);
  // For unknown linters we fell through to 'low' — but golangci-lint's
  // own Severity field may say otherwise. Use it as a floor.
  if (byLinter === 'low' && issue.FromLinter) {
    const sev = (issue.Severity || '').toLowerCase();
    if (sev === 'error') return 'high';
    if (sev === 'warning') return 'medium';
  }
  return byLinter;
}

/**
 * Single source of truth for the go pack's dep-vuln gathering.
 * Both `capabilities.depVulns.gather()` and `gatherMetrics` consume this.
 * The legacy decomposition in `gatherMetrics` is the bridge that goes
 * away in Phase 10e.C.
 */
async function gatherGoDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const vuln = findTool(TOOL_DEFS.govulncheck, cwd);
  if (!vuln.available || !vuln.path) return { kind: 'tool-missing' };

  const raw = run(`${vuln.path} -json ./... 2>/dev/null`, cwd, 120000);
  if (!raw) return { kind: 'no-output' };

  try {
    // govulncheck emits ndjson with three relevant shapes:
    //   { "osv": { ...full OSV record... } }   — the advisory detail
    //   { "finding": { "osv": "GO-YYYY-NNNN", "trace": [...] } }  — a call-site hit
    //   { "config": ... } / { "progress": ... } — ignored
    const findingIds = new Set<string>();
    const embeddedOsv = new Map<string, OsvVuln>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          finding?: { osv?: string };
          osv?: OsvVuln & { id?: string };
        };
        if (obj.finding?.osv) findingIds.add(obj.finding.osv);
        if (obj.osv?.id) embeddedOsv.set(obj.osv.id, obj.osv);
      } catch {
        /* skip non-JSON lines */
      }
    }

    // Prefer severity from the embedded OSV record (already in the
    // govulncheck output, no extra API call). Fall back to an OSV.dev
    // lookup for IDs without embedded data. Fall back to 'high' (the
    // legacy govulncheck default) for anything still unknown.
    const ids = [...findingIds];
    const needsLookup = ids.filter((id) => {
      const rec = embeddedOsv.get(id);
      if (!rec) return true;
      return classifyOsvSeverity(rec) === 'unknown';
    });
    const lookedUp = needsLookup.length > 0 ? await enrichSeverities(needsLookup) : new Map();

    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let enrichedCount = 0;
    for (const id of ids) {
      const rec = embeddedOsv.get(id);
      let sev = rec ? classifyOsvSeverity(rec) : 'unknown';
      if (sev === 'unknown') sev = lookedUp.get(id) ?? 'unknown';
      if (sev !== 'unknown') {
        enrichedCount++;
        if (sev === 'critical') critical++;
        else if (sev === 'high') high++;
        else if (sev === 'medium') medium++;
        else low++;
      } else {
        high++; // govulncheck legacy default
      }
    }

    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'govulncheck',
      // OSV is "used" only when we made an actual API lookup AND it
      // produced enrichment. Embedded-only severity isn't an OSV call.
      enrichment: enrichedCount > 0 && needsLookup.length > 0 ? 'osv.dev' : null,
      counts: { critical, high, medium, low },
    };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'parse-error' };
  }
}

const goDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'go',
  async gather(cwd) {
    const outcome = await gatherGoDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

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

  capabilities: {
    depVulns: goDepVulnsProvider,
  },

  mapLintSeverity: mapGolangciLinterSeverity,

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
          // Tier each issue by its FromLinter, then collapse:
          // critical + high → errors, medium + low → warnings.
          let errors = 0;
          let warnings = 0;
          for (const issue of issues) {
            const tier = tierGolangciIssue(issue);
            if (tier === 'critical' || tier === 'high') errors++;
            else warnings++;
          }
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

    // LEGACY: depVuln* fields populated from capabilities.depVulns;
    // removed in Phase 10e.C when reports stop reading these.
    const dvOutcome = await gatherGoDepVulnsResult(cwd);
    if (dvOutcome.kind === 'success') {
      const e = dvOutcome.envelope;
      metrics.depVulnCritical = e.counts.critical;
      metrics.depVulnHigh = e.counts.high;
      metrics.depVulnMedium = e.counts.medium;
      metrics.depVulnLow = e.counts.low;
      metrics.depAuditTool = e.tool;
      metrics.toolsUsed!.push('govulncheck');
      if (e.enrichment === 'osv.dev') metrics.toolsUsed!.push('osv.dev');
    } else if (dvOutcome.kind === 'parse-error') {
      metrics.toolsUnavailable!.push('govulncheck (parse error)');
    } else if (dvOutcome.kind === 'tool-missing') {
      metrics.toolsUnavailable!.push('govulncheck');
    }
    // 'no-output' was previously silent (raw was empty so the if (raw) block
    // didn't run and nothing was pushed); preserve that behavior.

    if (fileExists(cwd, 'go.mod')) {
      metrics.testFramework = 'go-test';
    }

    return metrics;
  },
};
