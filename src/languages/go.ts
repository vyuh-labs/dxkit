import * as fs from 'fs';
import * as path from 'path';

import { parseGoCoverProfile } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import {
  classifyOsvSeverity,
  enrichOsv,
  extractOsvCvssScore,
  resolveCvssScores,
  type OsvVuln,
} from '../analyzers/tools/osv';
import { fileExists, parseJsonStream, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnFinding,
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

interface GovulnFinding {
  osv?: string;
  fixed_version?: string;
  trace?: Array<{ module?: string; version?: string; package?: string }>;
}

/**
 * Pure parser for `go.mod`, extracting module paths declared in
 * `require` blocks WITHOUT a `// indirect` marker. Those are the
 * user's direct deps — the ones that show up as Snyk top-levels.
 *
 * Handles both syntaxes:
 *   require foo.com/bar v1.0                        (single-line)
 *   require ( foo.com/bar v1.0                      (block)
 *             baz.com/qux v2.0 // indirect )        (indirect-marked)
 *
 * Lines with `// indirect` (or `//indirect`) are skipped since those
 * were added by `go mod tidy` to pin transitive versions, not because
 * the user declared them. Go's direct/indirect distinction maps
 * cleanly onto the top-level concept.
 */
export function parseGoModDirectDeps(raw: string): string[] {
  const direct: string[] = [];
  let inRequireBlock = false;
  for (const rawLine of raw.split('\n')) {
    // Strip line comments first so `// indirect` detection is accurate.
    // Preserve the original for the indirect check — which looks at the
    // comment we just stripped.
    const indirect = /\/\/\s*indirect\b/.test(rawLine);
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (line === 'require (') {
      inRequireBlock = true;
      continue;
    }
    if (inRequireBlock && line === ')') {
      inRequireBlock = false;
      continue;
    }
    if (inRequireBlock) {
      if (indirect) continue;
      // Block-form entries are `<modpath> <version>`; we only want the path.
      const parts = line.split(/\s+/);
      if (parts.length >= 1 && parts[0]) direct.push(parts[0]);
      continue;
    }
    // Single-line require outside a block: `require <modpath> <version>`.
    const m = line.match(/^require\s+(\S+)\s+\S+/);
    if (m && !indirect) direct.push(m[1]);
  }
  return direct;
}

/**
 * Pure parser for `go mod graph`, returning a per-module index of the
 * top-level manifest deps (root's direct children, filtered against
 * `go.mod`'s direct-dep list when supplied) that transitively pull
 * each module.
 *
 * `go mod graph` output is line-oriented: `<src> <dst>` where each
 * token is `module@version` except the root module which appears
 * without `@version`. The root's direct deps are the BFS seeds;
 * attribution collapses at the module-name level so the same package
 * appearing at multiple versions maps to a single name.
 *
 * When `directDeps` is supplied, seeds are intersected with that set —
 * excludes indirect-but-in-graph modules (every dependency of a
 * direct dep is also a direct child of root in the graph). Without
 * this filter, Go projects with 5 direct + 30 indirect deps would
 * show 35 "top-levels," inflating attribution.
 */
export function buildGoTopLevelDepIndex(
  raw: string,
  directDeps?: ReadonlyArray<string>,
): Map<string, string[]> {
  const nameOf = (tok: string): string => {
    const at = tok.indexOf('@');
    return at < 0 ? tok : tok.slice(0, at);
  };

  // Root is identified as the only source token without `@version`.
  // All lines whose source lacks `@` share the same root name (barring
  // workspace multi-module repos, which we approximate as a single
  // root — accurate enough for Snyk-style grouping).
  let root: string | null = null;
  const edges = new Map<string, Set<string>>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const srcName = nameOf(parts[0]);
    const dstName = nameOf(parts[1]);
    if (!parts[0].includes('@')) {
      // Source token lacks @version → this is the root module.
      if (root === null) root = srcName;
    }
    const bucket = edges.get(srcName) ?? new Set<string>();
    bucket.add(dstName);
    edges.set(srcName, bucket);
  }
  if (!root) return new Map();

  let rootChildren = [...(edges.get(root) ?? new Set<string>())];
  if (directDeps && directDeps.length > 0) {
    const directSet = new Set(directDeps);
    rootChildren = rootChildren.filter((name) => directSet.has(name));
  }

  const result = new Map<string, Set<string>>();
  for (const top of rootChildren) {
    const visited = new Set<string>();
    const queue: string[] = [top];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      const bucket = result.get(name) ?? new Set<string>();
      bucket.add(top);
      result.set(name, bucket);
      for (const child of edges.get(name) ?? []) {
        if (!visited.has(child)) queue.push(child);
      }
    }
  }

  const sorted = new Map<string, string[]>();
  for (const [name, parents] of result) {
    sorted.set(name, [...parents].sort());
  }
  return sorted;
}

/**
 * Invoke `go mod graph` + read `go.mod` and build the top-level index.
 * Returns an empty map when either is missing — attribution stays
 * unset so dep-vuln gather still succeeds. Degrades safely on
 * toolchain-less environments (e.g. containerized CI lacking go).
 */
function loadGoTopLevelDepIndex(cwd: string): Map<string, string[]> {
  const graphRaw = run('go mod graph 2>/dev/null', cwd, 60000);
  if (!graphRaw) return new Map();
  let directDeps: string[] = [];
  try {
    const modRaw = fs.readFileSync(path.join(cwd, 'go.mod'), 'utf-8');
    directDeps = parseGoModDirectDeps(modRaw);
  } catch {
    // go.mod missing/unreadable — fall back to pre-filter behavior
    // (all root children become top-levels). Consistent with the
    // pre-10h.4.4.a semantics rather than blocking attribution.
  }
  return buildGoTopLevelDepIndex(graphRaw, directDeps);
}

/**
 * Single source of truth for the go pack's dep-vuln gathering.
 * Consumed by `goDepVulnsProvider` (capability dispatcher).
 *
 * govulncheck only emits `finding` records when call analysis confirms
 * the vulnerable code is reachable from the project's main package, so
 * every emitted DepVulnFinding sets `reachable: true` — Tier-1 output
 * with Tier-4 reachability semantics by virtue of the upstream tool's
 * design.
 *
 * Findings are grouped by (osvId, module, installedVersion). One
 * advisory hitting multiple modules yields multiple findings; multiple
 * call paths through the same (advisory, module, version) collapse to
 * one. govulncheck's per-call-path output (102 raw findings on the
 * Tickit smoke) is intentional internal detail; the bom/render layer
 * wants one row per (vuln × installed package).
 */
async function gatherGoDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const vuln = findTool(TOOL_DEFS.govulncheck, cwd);
  if (!vuln.available || !vuln.path) return { kind: 'tool-missing' };

  const raw = run(`${vuln.path} -json ./... 2>/dev/null`, cwd, 120000);
  if (!raw) return { kind: 'no-output' };

  try {
    // govulncheck -json emits a stream of *pretty-printed* JSON objects
    // (each spanning many lines), not single-line ndjson — so we can't
    // JSON.parse line-by-line. Accumulate lines into a buffer and try to
    // parse after each newline; success resets the buffer for the next
    // record. Three relevant top-level shapes:
    //   { "osv": { ...full OSV record... } }   — the advisory detail
    //   { "finding": { "osv": "GO-YYYY-NNNN", "trace": [...] } }  — a call-site hit
    //   { "config": ... } / { "progress": ... } / { "SBOM": ... } — ignored
    const groupedFindings = new Map<string, GovulnFinding>();
    const embeddedOsv = new Map<string, OsvVuln>();
    for (const obj of parseJsonStream(raw) as Array<{
      finding?: GovulnFinding;
      osv?: OsvVuln;
    }>) {
      if (obj.finding?.osv) {
        const trace0 = obj.finding.trace?.[0] ?? {};
        const key = `${obj.finding.osv}|${trace0.module ?? ''}|${trace0.version ?? ''}`;
        if (!groupedFindings.has(key)) groupedFindings.set(key, obj.finding);
      }
      if (obj.osv?.id) embeddedOsv.set(obj.osv.id, obj.osv);
    }

    // Prefer severity from the embedded OSV record (already in the
    // govulncheck output, no extra API call). Fall back to an OSV.dev
    // lookup for IDs without embedded data. Fall back to 'high' (the
    // legacy govulncheck default) for anything still unknown.
    const uniqueIds = [
      ...new Set([...groupedFindings.values()].map((f) => f.osv).filter(Boolean) as string[]),
    ];
    const needsLookup = uniqueIds.filter((id) => {
      const rec = embeddedOsv.get(id);
      if (!rec) return true;
      return classifyOsvSeverity(rec) === 'unknown';
    });
    const lookedUp = needsLookup.length > 0 ? await enrichOsv(needsLookup) : new Map();

    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    let enrichedCount = 0;
    const severityById = new Map<string, keyof SeverityCounts>();
    for (const id of uniqueIds) {
      const rec = embeddedOsv.get(id);
      let sev = rec ? classifyOsvSeverity(rec) : 'unknown';
      if (sev === 'unknown') sev = lookedUp.get(id)?.severity ?? 'unknown';
      let bucket: keyof SeverityCounts;
      if (sev !== 'unknown') {
        enrichedCount++;
        if (sev === 'critical') bucket = 'critical';
        else if (sev === 'high') bucket = 'high';
        else if (sev === 'medium') bucket = 'medium';
        else bucket = 'low';
      } else {
        bucket = 'high'; // govulncheck legacy default
      }
      severityById.set(id, bucket);
      if (bucket === 'critical') critical++;
      else if (bucket === 'high') high++;
      else if (bucket === 'medium') medium++;
      else low++;
    }

    const topLevelIndex = loadGoTopLevelDepIndex(cwd);

    const findings: DepVulnFinding[] = [];
    for (const grouped of groupedFindings.values()) {
      if (!grouped.osv) continue;
      const trace0 = grouped.trace?.[0] ?? {};
      const osvRec = embeddedOsv.get(grouped.osv) as
        | (OsvVuln & { affected?: Array<{ package?: { name?: string } }> })
        | undefined;
      // Prefer the trace module (project-specific), fall back to the OSV
      // record's affected package name, then 'unknown' if neither shipped.
      const pkgName = trace0.module ?? osvRec?.affected?.[0]?.package?.name ?? 'unknown';
      const finding: DepVulnFinding = {
        id: grouped.osv,
        package: pkgName,
        installedVersion: trace0.version,
        tool: 'govulncheck',
        severity: severityById.get(grouped.osv) ?? 'high',
        reachable: true,
      };
      if (grouped.fixed_version) finding.fixedVersion = grouped.fixed_version;
      // Capture the embedded CVSS (govulncheck bundles severity vectors
      // for many third-party deps but rarely for stdlib). Alias-fallback
      // happens in the batched resolveCvssScores pass after this loop.
      const embeddedScore = osvRec ? extractOsvCvssScore(osvRec) : null;
      if (embeddedScore !== null) finding.cvssScore = embeddedScore;
      if (osvRec) {
        const aliases = (osvRec.aliases ?? []).filter((a) => a && a.length > 0);
        if (aliases.length > 0) finding.aliases = aliases;
        if (osvRec.summary) finding.summary = osvRec.summary;
        else if (osvRec.details) finding.summary = osvRec.details;
        const refs = (osvRec.references ?? []).map((r) => r.url).filter(Boolean);
        if (refs.length > 0) finding.references = refs;
      }
      // Synthesize an OSV.dev URL when the embedded record lacked references.
      if (!finding.references) {
        finding.references = [`https://osv.dev/vulnerability/${grouped.osv}`];
      }
      const parents = topLevelIndex.get(pkgName);
      if (parents && parents.length > 0) finding.topLevelDep = parents;
      findings.push(finding);
    }

    // Alias-fallback CVSS pass: stdlib advisories (GO-YYYY-NNNN) often
    // carry no CVSS in either govulncheck's embedded data or OSV.dev's
    // GO-* record, while the corresponding CVE alias does (e.g.
    // GO-2025-3750 → CVE-2025-0913). resolveCvssScores re-queries each
    // alias for findings still missing a score, batched.
    if (findings.length > 0) {
      const cvssInputs = findings.map((f) => ({
        primaryId: f.id,
        embeddedCvss: f.cvssScore ?? null,
        aliases: f.aliases ?? [],
      }));
      const resolved = await resolveCvssScores(cvssInputs);
      for (const f of findings) {
        const score = resolved.get(f.id);
        if (score !== null && score !== undefined) f.cvssScore = score;
      }
    }

    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'govulncheck',
      // OSV is "used" only when we made an actual API lookup AND it
      // produced enrichment. Embedded-only severity isn't an OSV call.
      enrichment: enrichedCount > 0 && needsLookup.length > 0 ? 'osv.dev' : null,
      counts: { critical, high, medium, low },
      findings,
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
