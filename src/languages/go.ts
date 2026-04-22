import * as fs from 'fs';
import * as path from 'path';

import { parseGoCoverProfile } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { classifyOsvSeverity, enrichSeverities, type OsvVuln } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
  LicenseFinding,
  LicensesResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
  TestFrameworkResult,
} from './capabilities/types';
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
function mapGolangciLinterSeverity(linter: string | undefined): LintSeverity {
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
 * Consumed by `goDepVulnsProvider` (capability dispatcher).
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

/**
 * Single source of truth for the go pack's lint gathering.
 * Consumed by `goLintProvider` (capability dispatcher).
 */
function gatherGoLintResult(cwd: string): LintGatherOutcome {
  const lint = findTool(TOOL_DEFS['golangci-lint'], cwd);
  if (!lint.available || !lint.path) {
    return { kind: 'unavailable', reason: 'not installed' };
  }

  const raw = run(`${lint.path} run --out-format json ./... 2>/dev/null`, cwd, 120000);
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (!raw) {
    // Empty output = golangci-lint ran with no issues. Matches prior behavior.
    const envelope: LintResult = { schemaVersion: 1, tool: 'golangci-lint', counts };
    return { kind: 'success', envelope };
  }
  try {
    const data = JSON.parse(raw) as GolangciResult;
    for (const issue of data.Issues || []) {
      counts[tierGolangciIssue(issue)]++;
    }
    const envelope: LintResult = { schemaVersion: 1, tool: 'golangci-lint', counts };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'unavailable', reason: 'parse error' };
  }
}

const goLintProvider: CapabilityProvider<LintResult> = {
  source: 'go',
  async gather(cwd) {
    const outcome = gatherGoLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the go pack's coverage gathering.
 * Consumed by `goCoverageProvider` (capability dispatcher).
 */
function gatherGoCoverageResult(cwd: string): CoverageResult | null {
  for (const file of ['coverage.out', 'cover.out']) {
    const abs = path.join(cwd, file);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    try {
      const coverage = parseGoCoverProfile(raw, file, cwd);
      return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
    } catch {
      continue;
    }
  }
  return null;
}

const goCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'go',
  async gather(cwd) {
    return gatherGoCoverageResult(cwd);
  },
};

/**
 * Capture Go module specifiers from source text. Handles both single-line
 * `import "fmt"` and parenthesized multi-line blocks, including aliased
 * imports. Exported for unit tests; the imports capability batches it
 * across all .go files in the repo.
 */
export function extractGoImportsRaw(content: string): string[] {
  const out: string[] = [];
  const singleRe = /^\s*import\s+(?:[a-zA-Z_]\w*\s+)?"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(content)) !== null) {
    out.push(m[1]);
  }
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
}

/**
 * Resolve a Go import specifier to the in-project package directory,
 * or null for stdlib / external modules. A resolved edge target is a
 * directory (not a file), which naturally dead-ends the import-graph
 * BFS. Exported for unit tests.
 */
export function resolveGoImportRaw(_fromFile: string, spec: string, cwd: string): string | null {
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
}

/**
 * Enumerate .go source files and pre-compute the pack's per-file imports
 * + resolved edges. Edges point at package directories (Go's model), not
 * individual files — consumers BFS-ing over them see the same dead-ends
 * as the legacy path.
 */
function gatherGoImportsResult(cwd: string): ImportsResult | null {
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f -name "*.go" ${excludes} 2>/dev/null`, cwd);
  if (!raw) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();
  const edges = new Map<string, ReadonlySet<string>>();

  for (const line of raw.split('\n')) {
    const p = line.trim();
    if (!p) continue;
    const rel = p.replace(/^\.\//, '');
    let content: string;
    try {
      content = fs.readFileSync(path.join(cwd, rel), 'utf-8');
    } catch {
      continue;
    }
    const specs = extractGoImportsRaw(content);
    extracted.set(rel, specs);
    const targets = new Set<string>();
    for (const spec of specs) {
      const resolved = resolveGoImportRaw(rel, spec, cwd);
      if (resolved) targets.add(resolved);
    }
    if (targets.size > 0) edges.set(rel, targets);
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'go-imports',
    sourceExtensions: ['.go'],
    extracted,
    edges,
  };
}

const goImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'go',
  async gather(cwd) {
    return gatherGoImportsResult(cwd);
  },
};

/**
 * Go ships with a single test runner (`go test`) and every module
 * using it is identified by `go.mod` at the root — detection is a
 * single file-existence check.
 */
function gatherGoTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  if (!fileExists(cwd, 'go.mod')) return null;
  return { schemaVersion: 1, tool: 'go', name: 'go-test' };
}

const goTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'go',
  async gather(cwd) {
    return gatherGoTestFrameworkResult(cwd);
  },
};

/** Subset of `go list -m -json` per-module output we consume for versions. */
interface GoListModule {
  Path?: string;
  Version?: string;
  Main?: boolean;
}

/**
 * Parse the NDJSON-ish stream emitted by `go list -m -json all`. The tool
 * outputs concatenated `{...}` objects separated by no delimiter; each
 * object starts with '{' and ends with '}' at column 0. Match each with
 * a multiline regex and JSON.parse individually.
 */
function parseGoListModuleStream(raw: string): GoListModule[] {
  const out: GoListModule[] = [];
  const re = /^\{[\s\S]*?^\}/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    try {
      out.push(JSON.parse(m[0]) as GoListModule);
    } catch {
      /* skip malformed block */
    }
  }
  return out;
}

/**
 * Find the module whose path is the longest prefix of a Go package path,
 * returning its version. go-licenses reports at the package level
 * (`github.com/x/y/subpkg`) while `go list -m all` reports at the module
 * level (`github.com/x/y`); longest-prefix match bridges the two.
 */
function goVersionForPackage(pkgPath: string, modules: Map<string, string>): string {
  let best = '';
  for (const mod of modules.keys()) {
    if ((pkgPath === mod || pkgPath.startsWith(mod + '/')) && mod.length > best.length) {
      best = mod;
    }
  }
  return modules.get(best) ?? '';
}

/**
 * Single source of truth for the go pack's license gathering. Consumed
 * by `goLicensesProvider` (capability dispatcher).
 *
 * Two-step merge: `go-licenses report .` emits per-package CSV
 * (path,url,license) and `go list -m -json all` emits per-module
 * versions. Modules and packages have different granularity in the
 * Go module system, so we longest-prefix-match the package path
 * against the module list. Returns null cleanly on any Go module
 * without go-licenses installed, without go.mod, or when the tool
 * fails (commonly because `go mod download` hasn't been run).
 */
function gatherGoLicensesResult(cwd: string): LicensesResult | null {
  if (!fileExists(cwd, 'go.mod')) return null;

  const status = findTool(TOOL_DEFS['go-licenses'], cwd);
  if (!status.available || !status.path) return null;

  const csvRaw = run(`${status.path} report . 2>/dev/null`, cwd, 180000);
  if (!csvRaw) return null;

  const listRaw = run('go list -m -json all 2>/dev/null', cwd, 60000);
  const versions = new Map<string, string>();
  if (listRaw) {
    for (const mod of parseGoListModuleStream(listRaw)) {
      if (mod.Main) continue;
      if (mod.Path && mod.Version) versions.set(mod.Path, mod.Version);
    }
  }

  const findings: LicenseFinding[] = [];
  for (const line of csvRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(',');
    if (parts.length < 3) continue;
    const pkg = parts[0].trim();
    const url = parts[1].trim();
    const license = parts[2].trim();
    findings.push({
      package: pkg,
      version: goVersionForPackage(pkg, versions),
      licenseType: license || 'UNKNOWN',
      sourceUrl: url || undefined,
    });
  }

  return {
    schemaVersion: 1,
    tool: 'go-licenses',
    findings,
  };
}

const goLicensesProvider: CapabilityProvider<LicensesResult> = {
  source: 'go',
  async gather(cwd) {
    return gatherGoLicensesResult(cwd);
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

  tools: ['golangci-lint', 'govulncheck', 'go-licenses'],
  semgrepRulesets: ['p/gosec'],

  capabilities: {
    depVulns: goDepVulnsProvider,
    lint: goLintProvider,
    coverage: goCoverageProvider,
    imports: goImportsProvider,
    testFramework: goTestFrameworkProvider,
    licenses: goLicensesProvider,
  },

  mapLintSeverity: mapGolangciLinterSeverity,
};
