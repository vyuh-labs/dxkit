import * as fs from 'fs';
import * as path from 'path';

import hostedGitInfo from 'hosted-git-info';

import { parseIstanbulFinal, parseIstanbulSummary } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { enrichReleaseDates } from '../analyzers/tools/npm-registry';
import { resolveCvssScores } from '../analyzers/tools/osv';
import {
  enrichWithUpgradePlans,
  gatherOsvScannerFixPlans,
} from '../analyzers/tools/osv-scanner-fix';
import { fileExists, run, runJSON } from '../analyzers/tools/runner';
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
function mapEslintRuleSeverity(ruleId: string | null | undefined): LintSeverity {
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

/**
 * Per-advisory record nested under `vulnerabilities[pkg].via`. npm-audit
 * inlines a full GHSA advisory here when the entry is the actual report;
 * string entries in the same array are pointers to other vulnerable
 * packages (transitive chain) and are skipped during finding extraction.
 */
interface AuditAdvisory {
  source?: number;
  name?: string;
  dependency?: string;
  title?: string;
  url?: string;
  severity?: string;
  cwe?: string[];
  cvss?: { score?: number; vectorString?: string };
  range?: string;
}

interface AuditV2VulnEntry {
  name?: string;
  severity: string;
  via?: Array<string | AuditAdvisory>;
  fixAvailable?: boolean | { name: string; version: string; isSemVerMajor: boolean };
  range?: string;
}

interface AuditV2 {
  vulnerabilities?: Record<string, AuditV2VulnEntry>;
}

/**
 * Map npm-audit's severity vocabulary to the four-tier `SeverityCounts`
 * domain. npm uses `moderate`; we normalize to `medium` everywhere else.
 * Unknown values fall through to `low` to avoid silently inflating counts.
 */
function normalizeNpmSeverity(s: string | undefined): keyof SeverityCounts {
  switch (s) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'moderate':
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Extract the GHSA identifier from a GitHub advisory URL like
 * `https://github.com/advisories/GHSA-h5c3-5r3r-rr8q`. Returns null when
 * the URL doesn't match (e.g. legacy npm advisory pages).
 */
function extractGhsaId(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i);
  return m ? m[0].toUpperCase() : null;
}

/**
 * Read the locally installed version of a package from
 * `node_modules/<pkg>/package.json`. Used to attach `installedVersion`
 * to dep-vuln findings — npm-audit's JSON only reports the affected
 * range, not which exact resolved version is on disk.
 */
function readInstalledTsVersion(cwd: string, pkgName: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'node_modules', pkgName, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version;
  } catch {
    return undefined;
  }
}

/**
 * Shape of npm's lockfileVersion 2/3 `package-lock.json` that this module
 * consumes. Only the fields we read are typed; others are ignored.
 */
interface NpmLockfilePackageEntry {
  dependencies?: Record<string, string>;
}

interface NpmLockfile {
  packages?: Record<
    string,
    NpmLockfilePackageEntry & {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    }
  >;
}

/**
 * Build a per-package-name index mapping each installed npm package to
 * the set of root manifest entries (top-level deps) it rolls up under.
 *
 * Strategy: BFS the lockfile starting from each root `dependencies` /
 * `devDependencies` name, following each visited package's own
 * `dependencies` map. Each lockfile entry for a given name contributes
 * its direct-child names — duplicated copies (nested `node_modules/`)
 * are all consulted so attribution matches npm's resolution at any
 * ancestor path. Attribution is coarse at the package-name level
 * (ignores which exact version serves which parent) — matches Snyk's
 * own grouping in their UI and is what bom + HTML renders group on.
 *
 * Exported for unit tests; pure function over parsed lockfile JSON so
 * fixtures don't need filesystem setup.
 */
export function buildTsTopLevelDepIndex(lock: unknown): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  if (!lock || typeof lock !== 'object') return new Map();
  const packages = (lock as NpmLockfile).packages;
  if (!packages) return new Map();
  const root = packages[''];
  if (!root) return new Map();

  const topLevelNames = [
    ...Object.keys(root.dependencies ?? {}),
    ...Object.keys(root.devDependencies ?? {}),
  ];

  // Pre-index: installed package name -> every lockfile key where it lives.
  // Scoped packages ('@foo/bar') are kept intact since everything after
  // the last 'node_modules/' segment is the logical package name.
  const keysByName = new Map<string, string[]>();
  const NM = 'node_modules/';
  for (const key of Object.keys(packages)) {
    const idx = key.lastIndexOf(NM);
    if (idx < 0) continue;
    const name = key.slice(idx + NM.length);
    if (!name) continue;
    const arr = keysByName.get(name) ?? [];
    arr.push(key);
    keysByName.set(name, arr);
  }

  for (const top of topLevelNames) {
    const visited = new Set<string>();
    const queue: string[] = [top];
    while (queue.length > 0) {
      const name = queue.shift() as string;
      if (visited.has(name)) continue;
      visited.add(name);
      const bucket = result.get(name) ?? new Set<string>();
      bucket.add(top);
      result.set(name, bucket);
      for (const key of keysByName.get(name) ?? []) {
        const entry = packages[key];
        const deps = entry?.dependencies;
        if (!deps) continue;
        for (const childName of Object.keys(deps)) {
          if (!visited.has(childName)) queue.push(childName);
        }
      }
    }
  }

  const sorted = new Map<string, string[]>();
  for (const [pkg, parents] of result) {
    sorted.set(pkg, [...parents].sort());
  }
  return sorted;
}

/**
 * Read + parse the project's `package-lock.json`, then run the index.
 * Returns an empty map when the lockfile is missing or unparsable —
 * topLevelDep stays unattributed rather than blocking dep-vuln gather.
 */
function loadTsTopLevelDepIndex(cwd: string): Map<string, string[]> {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf-8');
    return buildTsTopLevelDepIndex(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

/**
 * Single source of truth for the typescript pack's dep-vuln gathering.
 * Consumed by `tsDepVulnsProvider` (capability dispatcher).
 *
 * Counts derive from the per-package severity buckets (npm-audit's own
 * aggregation). Findings derive from the per-advisory `via[]` objects
 * — one finding per advisory, so a package with three GHSAs yields
 * three findings even though counts increment by one. This matches the
 * customer xlsx model: col 11 (Criticality) is per-package, col 12
 * (Vulnerability Issues) is per-advisory.
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

    const findings: DepVulnFinding[] = [];
    if (auditData.vulnerabilities) {
      const versionCache = new Map<string, string | undefined>();
      const installedVersion = (pkg: string): string | undefined => {
        if (!versionCache.has(pkg)) versionCache.set(pkg, readInstalledTsVersion(cwd, pkg));
        return versionCache.get(pkg);
      };
      const topLevelIndex = loadTsTopLevelDepIndex(cwd);
      // npm-audit inlines the same advisory record on every consumer's
      // `via[]` across the vulnerability tree (e.g. minimatch's ReDoS
      // advisory appears on @loopback/cli, glob-parent, picomatch, etc.
      // all at once). Without dedup we emit N copies of one logical
      // advisory against the same package@version. Dedup on
      // (package, installedVersion, id) — each advisory-against-pkg pair
      // is the true identity of a finding.
      const seen = new Set<string>();
      for (const [pkgName, entry] of Object.entries(auditData.vulnerabilities)) {
        // npm-audit's `fixAvailable` is the *consumer* upgrade command —
        // `{ name, version }` identifies which top-level dep to bump to
        // resolve the entire advisory tree under this entry. When `name`
        // matches the entry key, the fix is at this package's own
        // version (direct upgrade). When `name` differs, the fix is a
        // transitive parent upgrade — applying `fix.version` as THIS
        // package's fixedVersion is wrong (caused the "uuid@13 fixed at
        // 3.2.1" false positive surfaced by the 10h.3.10 benchmark).
        const fix = entry.fixAvailable;
        const fixIsObject = typeof fix === 'object';
        const directFix = fixIsObject && fix.name === pkgName ? fix : null;
        const transitiveFix = fixIsObject && fix.name !== pkgName ? fix : null;
        for (const v of entry.via ?? []) {
          if (typeof v === 'string') continue;
          const advisoryPkg = v.name ?? pkgName;
          const ghsa = extractGhsaId(v.url);
          const id = ghsa ?? (v.source ? `npm-${v.source}` : `npm-${advisoryPkg}`);
          const dedupeKey = `${advisoryPkg}@${installedVersion(advisoryPkg) ?? ''}|${id}`;
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          const finding: DepVulnFinding = {
            id,
            package: advisoryPkg,
            installedVersion: installedVersion(advisoryPkg),
            tool: 'npm-audit',
            severity: normalizeNpmSeverity(v.severity),
          };
          if (typeof v.cvss?.score === 'number') finding.cvssScore = v.cvss.score;
          if (directFix) {
            finding.fixedVersion = directFix.version;
            finding.breakingUpgrade = directFix.isSemVerMajor;
          } else if (transitiveFix) {
            // Parent-upgrade remediation — surface directly in upgradeAdvice
            // rather than pretending the value is a direct fix. Bom render
            // picks this up as the Tier-1 resolution for the row.
            const majorNote = transitiveFix.isSemVerMajor ? ' [major]' : '';
            finding.upgradeAdvice =
              `Upgrade ${transitiveFix.name} to ${transitiveFix.version}${majorNote} ` +
              `(transitive fix)`;
          }
          if (ghsa) finding.aliases = [ghsa];
          if (v.title) finding.summary = v.title;
          if (v.url) finding.references = [v.url];
          const parents = topLevelIndex.get(advisoryPkg);
          if (parents && parents.length > 0) finding.topLevelDep = parents;
          findings.push(finding);
        }
      }
    }

    // Alias-fallback CVSS pass: npm-audit ships CVSS for ~100% of
    // advisories (smoke: 94/94 on platform), so this is typically a
    // no-op — every input has `embeddedCvss` set, no API calls fire.
    // Future-proof against the rare advisory missing CVSS.
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

    // Tier-2 enrichment — run osv-scanner fix to populate structured
    // `upgradePlan` on every finding it has a proposal for. Free-text
    // `upgradeAdvice` from npm-audit already set above stays as-is (it's
    // the human-readable form for markdown); `upgradePlan` is the
    // agent-consumable form. Degrades silently when osv-scanner is
    // unavailable — zero enrichment, existing advice preserved.
    if (findings.length > 0) {
      const plans = await gatherOsvScannerFixPlans(cwd);
      enrichWithUpgradePlans(findings, plans);
    }

    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'npm-audit',
      enrichment: null,
      counts: { critical, high, medium, low },
      findings,
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
 * Capture raw TS/JS module specifiers from source text. The imports
 * capability batch-calls this while walking the pack's source extensions;
 * unit tests exercise it directly for parse-correctness cases.
 */
export function extractTsImportsRaw(content: string): string[] {
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
}

/**
 * Resolve a TS/JS module specifier to an in-project relative file path,
 * or null for external packages and unresolvable specifiers. Exported so
 * unit tests can exercise resolution directly; the imports capability
 * calls it while building per-file edges.
 */
export function resolveTsImportRaw(fromFile: string, spec: string, cwd: string): string | null {
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
}

/**
 * Single source of truth for the typescript pack's lint gathering.
 * Consumed by `tsLintProvider` (capability dispatcher).
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
 * Consumed by `tsCoverageProvider` (capability dispatcher).
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

/**
 * Enumerate TS/JS source files under cwd and pre-compute the pack's
 * per-file imports (raw specifiers) and resolved edges. `find` is the
 * enumerator to stay consistent with `gatherSourceFiles`; exclusions
 * come from the project's `.gitignore` + `.dxkit-ignore` via the
 * shared `getFindExcludeFlags` helper.
 *
 * Returns null when the repo has no TS/JS source, so the dispatcher
 * can skip this provider cleanly on pure Python/Go/Rust/C# trees.
 */
function gatherTsImportsResult(cwd: string): ImportsResult | null {
  const exts = TS_JS_EXT.map((e) => `-name "*${e}"`).join(' -o ');
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f \\( ${exts} \\) ${excludes} 2>/dev/null`, cwd);
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
    const specs = extractTsImportsRaw(content);
    extracted.set(rel, specs);
    const targets = new Set<string>();
    for (const spec of specs) {
      const resolved = resolveTsImportRaw(rel, spec, cwd);
      if (resolved) targets.add(resolved);
    }
    if (targets.size > 0) edges.set(rel, targets);
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'ts-imports',
    sourceExtensions: TS_JS_EXT,
    extracted,
    edges,
  };
}

const tsImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'typescript',
  async gather(cwd) {
    return gatherTsImportsResult(cwd);
  },
};

/**
 * Detect the JS/TS test framework by inspecting the `scripts.test`
 * entry of `package.json` — that's the contract runners publish
 * themselves by and is cheap/deterministic. Returns null when there's
 * no package.json or no recognizable runner; 'unknown' is NOT returned
 * to the dispatcher because an 'unknown' string is worse than null
 * (the last-wins aggregate would prefer it over another pack's real
 * answer).
 */
function gatherTsTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  const testScript = run(
    "node -e \"const p=require('./package.json'); console.log(p.scripts?.test || '')\" 2>/dev/null", // slop-ok
    cwd,
  );
  if (!testScript || testScript === 'echo "Error: no test specified" && exit 1') return null;

  let name: string | null = null;
  if (testScript.includes('vitest')) name = 'vitest';
  else if (testScript.includes('jest')) name = 'jest';
  else if (testScript.includes('mocha') || testScript.includes('lb-mocha')) name = 'mocha';
  else if (testScript.includes('ava')) name = 'ava';
  else if (testScript.includes('tap')) name = 'tap';

  if (!name) return null;
  return { schemaVersion: 1, tool: 'typescript', name };
}

const tsTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'typescript',
  async gather(cwd) {
    return gatherTsTestFrameworkResult(cwd);
  },
};

/**
 * Raw shape emitted per-entry by license-checker-rseidelsohn's `--json`.
 * Keys are `${name}@${version}` (scoped packages keep the leading '@').
 * Fields are a loose union across versions — we only touch the ones we map.
 */
interface LicenseCheckerEntry {
  licenses?: string | string[];
  repository?: string;
  publisher?: string;
  url?: string;
  licenseFile?: string;
}

/**
 * Read the local `node_modules/<pkg>/package.json` for registry metadata
 * not exposed (or lossily normalized) by license-checker.
 *
 *   - `description` — license-checker doesn't ship it.
 *   - `repositoryUrl` — license-checker normalizes the URL (strips
 *     `git+` prefix + `.git` suffix); we want the raw form to match
 *     tools like `npm view repository.url` + the customer's existing
 *     bom spreadsheet (Phase 10h.5 benchmark).
 *
 * Disk-only, no network — stays sub-millisecond per package and works
 * offline. Returns {} if the package isn't installed locally; callers
 * fall back to license-checker's normalized URL in that case.
 */
interface TsPackageMetadata {
  description?: string;
  repositoryUrl?: string;
}

function readTsPackageMetadata(cwd: string, pkgName: string): TsPackageMetadata {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'node_modules', pkgName, 'package.json'), 'utf-8');
    const parsed = JSON.parse(raw) as {
      description?: string;
      repository?: string | { url?: string };
    };
    let repositoryUrl: string | undefined;
    if (typeof parsed.repository === 'string') {
      repositoryUrl = parsed.repository;
    } else if (parsed.repository && typeof parsed.repository.url === 'string') {
      repositoryUrl = parsed.repository.url;
    }
    return { description: parsed.description, repositoryUrl };
  } catch {
    return {};
  }
}

/**
 * Canonicalise a repository URL via npm's `hosted-git-info`. Expands
 * shorthand (`user/repo`, `github:user/repo`), converts SCP-like SSH
 * (`git@github.com:user/repo.git`) to RFC (`git+ssh://...`), and emits
 * `git+https://` for standard https input — matching the format the
 * customer's benchmark xlsx records (Phase 10h.5). Preserves SSH intent
 * when the source URL is an SSH scheme; falls through unchanged for
 * non-GitHub/GitLab/Bitbucket hosts that hosted-git-info can't parse.
 */
function normalizeRepoUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const info = hostedGitInfo.fromUrl(raw);
  if (!info) return raw;
  const looksSsh = /^(git\+ssh:|ssh:|git@)/.test(raw.trim());
  return looksSsh ? info.sshurl({ noCommittish: true }) : info.https({ noCommittish: true });
}

/**
 * Split license-checker's `${name}@${version}` key, preserving a leading
 * '@' on scoped packages. Returns null on malformed keys (no '@' past
 * position 0) so the caller can skip cleanly.
 */
function splitTsLicenseCheckerKey(key: string): { package: string; version: string } | null {
  const atIdx = key.lastIndexOf('@');
  if (atIdx <= 0) return null;
  return { package: key.slice(0, atIdx), version: key.slice(atIdx + 1) };
}

/**
 * Single source of truth for the typescript pack's license gathering.
 * Consumed by `tsLicensesProvider` (capability dispatcher).
 *
 * Returns null when the repo isn't a Node project OR the tool isn't
 * available (so the dispatcher skips the pack cleanly rather than
 * emitting an empty envelope). License-text is inlined by reading the
 * `licenseFile` path on disk — the customer's existing workflow does
 * the same thing (see `license-generation.sh` in vyuhlabs-platform).
 */
async function gatherTsLicensesResult(cwd: string): Promise<LicensesResult | null> {
  if (!fileExists(cwd, 'package.json')) return null;

  const status = findTool(TOOL_DEFS['license-checker-rseidelsohn'], cwd);
  if (!status.available || !status.path) return null;

  const raw = run(`${status.path} --json --excludePrivatePackages 2>/dev/null`, cwd, 120000);
  if (!raw) return null;

  let data: Record<string, LicenseCheckerEntry>;
  try {
    data = JSON.parse(raw) as Record<string, LicenseCheckerEntry>;
  } catch {
    return null;
  }

  // Load the top-level index once and project it down to `isTopLevel`
  // per finding. The self-parent invariant — `index[top]` always
  // contains `top` itself, because BFS starts from each top-level —
  // is the cheapest signal; checking `parents.includes(pkg)` classifies
  // every row without a second manifest parse. Empty index (missing
  // lockfile, unparsable JSON) leaves isTopLevel unset so the bom
  // filter passes the row through rather than guessing wrong.
  const topLevelIndex = loadTsTopLevelDepIndex(cwd);
  const hasIndex = topLevelIndex.size > 0;

  const findings: LicenseFinding[] = [];
  for (const [key, entry] of Object.entries(data)) {
    const split = splitTsLicenseCheckerKey(key);
    if (!split) continue;

    const licenseType = Array.isArray(entry.licenses)
      ? entry.licenses.join(' OR ')
      : entry.licenses || 'UNKNOWN';

    let licenseText: string | undefined;
    if (entry.licenseFile) {
      try {
        licenseText = fs.readFileSync(entry.licenseFile, 'utf-8');
      } catch {
        // license file vanished between scan and read — skip silently
      }
    }

    const meta = readTsPackageMetadata(cwd, split.package);
    const parents = hasIndex ? topLevelIndex.get(split.package) : undefined;
    findings.push({
      package: split.package,
      version: split.version,
      licenseType,
      licenseText,
      // Prefer raw repository.url (byte-identical to `npm view`) over
      // license-checker's normalized form; normalise via hosted-git-info
      // to expand shorthand and canonicalise across SCP/SSH/HTTPS.
      sourceUrl: normalizeRepoUrl(meta.repositoryUrl || entry.repository || entry.url),
      description: meta.description,
      supplier: entry.publisher,
      isTopLevel: hasIndex ? (parents?.includes(split.package) ?? false) : undefined,
    });
  }

  // Populate releaseDate (xlsx col 10 / D006) from the npm registry.
  // Batched per unique package name; one HTTP call per package
  // regardless of how many versions are installed. Graceful fallback:
  // unreachable registry / unknown package leaves `releaseDate` unset.
  const dateMap = await enrichReleaseDates(
    findings.map((f) => ({ package: f.package, version: f.version })),
  );
  for (const f of findings) {
    const iso = dateMap.get(`${f.package}@${f.version}`);
    if (iso) f.releaseDate = iso;
  }

  return {
    schemaVersion: 1,
    tool: 'license-checker-rseidelsohn',
    findings,
  };
}

const tsLicensesProvider: CapabilityProvider<LicensesResult> = {
  source: 'typescript',
  async gather(cwd) {
    return gatherTsLicensesResult(cwd);
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

  tools: ['eslint', 'npm-audit', 'osv-scanner', 'vitest-coverage', 'license-checker-rseidelsohn'],
  semgrepRulesets: ['p/javascript', 'p/typescript'],

  capabilities: {
    depVulns: tsDepVulnsProvider,
    lint: tsLintProvider,
    coverage: tsCoverageProvider,
    imports: tsImportsProvider,
    testFramework: tsTestFrameworkProvider,
    licenses: tsLicensesProvider,
  },
};
