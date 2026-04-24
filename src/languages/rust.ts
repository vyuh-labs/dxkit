import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { parseCoberturaXml } from './csharp';
import { parseCvssV3BaseScore, resolveCvssScores, scoreToTier } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { isMajorBump } from '../analyzers/tools/semver-bump';
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

interface CargoMessage {
  reason: string;
  message?: { level: string; message: string; code?: { code?: string } };
}

/**
 * Clippy lints that indicate definite undefined behavior or memory
 * corruption. These are denied by default in clippy::correctness.
 */
const CRITICAL_CLIPPY = new Set<string>([
  'clippy::mem_replace_with_uninit',
  'clippy::uninit_assumed_init',
  'clippy::uninit_vec',
  'clippy::transmuting_null',
  'clippy::not_unsafe_ptr_arg_deref',
  'clippy::cast_ref_to_mut',
  'clippy::invalid_atomic_ordering',
  'clippy::mut_from_ref',
  'clippy::size_of_in_element_count',
  'clippy::drop_copy',
  'clippy::drop_ref',
  'clippy::forget_copy',
  'clippy::forget_ref',
  'clippy::undropped_manually_drops',
]);

/**
 * Clippy lints that flag likely bugs / correctness issues (not UB but
 * definitely wrong). Bulk of the clippy::correctness group.
 */
const HIGH_CLIPPY = new Set<string>([
  'clippy::absurd_extreme_comparisons',
  'clippy::bad_bit_mask',
  'clippy::cmp_nan',
  'clippy::deprecated_semver',
  'clippy::erasing_op',
  'clippy::fn_address_comparisons',
  'clippy::if_let_redundant_pattern_matching',
  'clippy::ifs_same_cond',
  'clippy::infinite_iter',
  'clippy::invalid_regex',
  'clippy::iter_next_loop',
  'clippy::iterator_step_by_zero',
  'clippy::let_underscore_lock',
  'clippy::logic_bug',
  'clippy::match_on_vec_items',
  'clippy::match_str_case_mismatch',
  'clippy::min_max',
  'clippy::mismatched_target_os',
  'clippy::modulo_one',
  'clippy::never_loop',
  'clippy::nonsensical_open_options',
  'clippy::option_env_unwrap',
  'clippy::out_of_bounds_indexing',
  'clippy::overly_complex_bool_expr',
  'clippy::panicking_unwrap',
  'clippy::possible_missing_comma',
  'clippy::reversed_empty_ranges',
  'clippy::self_assignment',
  'clippy::serde_api_misuse',
  'clippy::suspicious_splitn',
  'clippy::unit_cmp',
  'clippy::unit_hash',
  'clippy::unit_return_expecting_ord',
  'clippy::unsound_collection_transmute',
  'clippy::vec_resize_to_zero',
  'clippy::vtable_address_comparisons',
  'clippy::while_immutable_condition',
  'clippy::zst_offset',
]);

/**
 * Tier a clippy or rustc lint by its code name.
 *
 * clippy lint codes look like `clippy::needless_pass_by_value`.
 * rustc lint codes look like `unused_variables`, `dead_code`, etc.
 *
 * Most clippy lints are style / best-practice suggestions → low.
 * Only the correctness-group lints (hand-catalogued above) are
 * serious. rustc lints default to medium since `unused_*` and
 * `deprecated` are meaningful but rarely critical.
 */
export function mapClippyLintSeverity(code: string | undefined): LintSeverity {
  if (!code) return 'low';
  if (CRITICAL_CLIPPY.has(code)) return 'critical';
  if (HIGH_CLIPPY.has(code)) return 'high';
  if (!code.startsWith('clippy::')) return 'medium'; // rustc-native lint
  return 'low'; // other clippy groups: style, perf, complexity, pedantic, nursery, cargo
}

function tierCargoMessage(msg: CargoMessage['message']): LintSeverity {
  if (!msg) return 'low';
  const tier = mapClippyLintSeverity(msg.code?.code);
  // rustc compile errors (no code.code) are real errors — bump from low to high.
  if (tier === 'low' && msg.level === 'error') return 'high';
  return tier;
}

/**
 * cargo-audit `--json` output. The shape mirrors the
 * `rustsec_advisory_db::Advisory` struct — see
 * https://docs.rs/rustsec/latest/rustsec/advisory/struct.Advisory.html.
 * `cvss` is a CVSS v3 vector string (not a numeric score) when present;
 * RUSTSEC advisories often only carry textual `severity`. `aliases`
 * typically holds the corresponding CVE id when assigned upstream.
 */
interface CargoAuditAdvisory {
  id?: string;
  package?: string;
  title?: string;
  description?: string;
  date?: string;
  url?: string;
  cvss?: string | null;
  severity?: string;
  aliases?: string[];
  references?: string[];
}

interface CargoAuditVulnEntry {
  advisory?: CargoAuditAdvisory;
  versions?: { patched?: string[]; unaffected?: string[] };
  package?: { name?: string; version?: string };
}

interface CargoAuditResult {
  vulnerabilities?: {
    found?: number;
    count?: number;
    list?: CargoAuditVulnEntry[];
  };
}

/**
 * Map cargo-audit's textual severity to the four-tier `SeverityCounts`
 * domain. RUSTSEC uses the standard critical/high/medium/low set;
 * `informational` advisories (yanked, notice) are treated as low.
 */
function normalizeRustSeverity(s: string | undefined): keyof SeverityCounts {
  switch (s?.toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

/**
 * Pure parser for `cargo-audit --json` output. Extracted from the gather
 * function so it can be exhaustively unit-tested without a real Cargo
 * toolchain on the dev machine (10h.5 release-time validation runs the
 * full pipeline). Returns null when the input is malformed or contains
 * no vulnerabilities object; otherwise returns counts + findings ready
 * for downstream alias-fallback enrichment.
 */
export function parseCargoAuditOutput(
  raw: string,
): { counts: SeverityCounts; findings: DepVulnFinding[] } | null {
  let data: CargoAuditResult;
  try {
    data = JSON.parse(raw) as CargoAuditResult;
  } catch {
    return null;
  }
  if (!data.vulnerabilities) return null;

  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  const findings: DepVulnFinding[] = [];
  for (const v of data.vulnerabilities.list || []) {
    const adv = v.advisory;
    if (!adv?.id) continue;

    // Resolve severity + CVSS first so the counts bucket matches the
    // per-finding severity even when CVSS promotes the classification
    // for advisories that ship only a vector.
    let severity = normalizeRustSeverity(adv.severity);
    let cvssScore: number | null = null;
    if (adv.cvss) {
      const parsed = parseCvssV3BaseScore(adv.cvss);
      if (parsed !== null) {
        cvssScore = parsed;
        if (!adv.severity) {
          const tier = scoreToTier(parsed);
          if (tier !== 'unknown') severity = tier;
        }
      }
    }
    if (severity === 'critical') critical++;
    else if (severity === 'high') high++;
    else if (severity === 'medium') medium++;
    else low++;

    const finding: DepVulnFinding = {
      id: adv.id,
      package: v.package?.name ?? adv.package ?? 'unknown',
      installedVersion: v.package?.version,
      tool: 'cargo-audit',
      severity,
    };
    if (cvssScore !== null) finding.cvssScore = cvssScore;
    const patched = v.versions?.patched ?? [];
    if (patched.length > 0) {
      // RUSTSEC patched entries are version requirement strings
      // (e.g. ">=1.2.5"). Strip the leading comparator so the
      // bom render's "Upgrade to X" text reads cleanly. Multiple
      // patched constraints (rare) fall through with the first.
      const cleanFix = patched[0].replace(/^[<>=^~\s]+/, '').trim() || patched[0];
      finding.fixedVersion = cleanFix;
      // Tier-2 structured plan (10h.6.3): Rust's dep graph is resolved
      // by cargo in one go — there's no "transitive parent" concept like
      // npm's where the fix is at a different package. The upgrade
      // target IS the vulnerable crate itself, so parent == finding
      // package. patches[] carries just this advisory's id (cargo-audit
      // doesn't bundle multi-advisory rollups the way osv-scanner does).
      // `breaking` derives from the semver-major comparison; same pre-
      // 1.x convention as the TS/Python packs.
      finding.upgradePlan = {
        parent: finding.package,
        parentVersion: cleanFix,
        patches: [adv.id],
        breaking: isMajorBump(v.package?.version ?? '', cleanFix),
      };
    }
    const aliases = (adv.aliases ?? []).filter((a) => a && a.length > 0);
    if (aliases.length > 0) finding.aliases = aliases;
    if (adv.title) finding.summary = adv.title;
    else if (adv.description) finding.summary = adv.description;
    const refs = [...(adv.references ?? []), adv.url].filter(
      (u): u is string => typeof u === 'string' && u.length > 0,
    );
    if (refs.length > 0) finding.references = refs;
    else finding.references = [`https://rustsec.org/advisories/${adv.id}.html`];
    findings.push(finding);
  }

  return { counts: { critical, high, medium, low }, findings };
}

/**
 * Subset of `cargo metadata --format-version 1` we consume. The real
 * output has many more fields; we type only the resolve graph bits.
 */
interface CargoMetadata {
  packages?: Array<{ id?: string; name?: string }>;
  resolve?: {
    root?: string;
    nodes?: Array<{
      id?: string;
      dependencies?: string[];
    }>;
  };
}

/**
 * Pure parser for `cargo metadata --format-version 1`, returning a
 * per-crate-name index of the top-level manifest deps that transitively
 * pull that crate. Mirrors the TS pack's `buildTsTopLevelDepIndex`
 * shape so bom + HTML renders can use identical grouping logic.
 *
 * Cargo's resolve graph uses opaque package ids (e.g.
 * `openssl 0.10.50 (registry+...)`). We map id→name via `packages[]`
 * and then BFS starting from each direct dep of `resolve.root`
 * (derived from the workspace root's `resolve.nodes[i].dependencies`).
 *
 * Returns an empty map on malformed input rather than throwing — the
 * caller keeps attribution unset so dep-vuln gather still succeeds.
 */
export function buildRustTopLevelDepIndex(raw: string): Map<string, string[]> {
  let data: CargoMetadata;
  try {
    data = JSON.parse(raw) as CargoMetadata;
  } catch {
    return new Map();
  }
  const packages = data.packages ?? [];
  const nodes = data.resolve?.nodes ?? [];
  const rootId = data.resolve?.root;
  if (!rootId || nodes.length === 0) return new Map();

  const nameById = new Map<string, string>();
  for (const pkg of packages) {
    if (pkg.id && pkg.name) nameById.set(pkg.id, pkg.name);
  }

  const depsById = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.id) depsById.set(node.id, node.dependencies ?? []);
  }

  const rootNode = depsById.get(rootId);
  if (!rootNode) return new Map();

  const result = new Map<string, Set<string>>();
  for (const topId of rootNode) {
    const topName = nameById.get(topId);
    if (!topName) continue;
    const visited = new Set<string>();
    const queue: string[] = [topId];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      if (visited.has(id)) continue;
      visited.add(id);
      const name = nameById.get(id);
      if (name) {
        const bucket = result.get(name) ?? new Set<string>();
        bucket.add(topName);
        result.set(name, bucket);
      }
      for (const childId of depsById.get(id) ?? []) {
        if (!visited.has(childId)) queue.push(childId);
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
 * Read + parse `cargo metadata --format-version 1` for the project at
 * `cwd`. Returns an empty index when cargo itself is missing or the
 * command fails — topLevelDep stays unattributed rather than blocking.
 */
function loadRustTopLevelDepIndex(cwd: string): Map<string, string[]> {
  const raw = run('cargo metadata --format-version 1 2>/dev/null', cwd, 60000);
  if (!raw) return new Map();
  return buildRustTopLevelDepIndex(raw);
}

/**
 * Single source of truth for the rust pack's dep-vuln gathering.
 * Consumed by `rustDepVulnsProvider` (capability dispatcher).
 *
 * Manifest gating: cargo-audit operates on `Cargo.lock` — without one
 * it can't enumerate resolved dependency versions. We return early
 * rather than running the tool against the wrong scope (mirrors the
 * 10h.3.3 fix in the python pack).
 *
 * cvssScore is derived from the advisory's CVSS vector when present
 * (RUSTSEC advisories vary — many ship only textual severity), with
 * resolveCvssScores supplying alias-fallback against CVE OSV records
 * for entries where cargo-audit's bundled vector is missing.
 */
async function gatherRustDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  if (!fileExists(cwd, 'Cargo.lock')) return { kind: 'tool-missing' };
  const audit = findTool(TOOL_DEFS['cargo-audit'], cwd);
  if (!audit.available || !audit.path) return { kind: 'tool-missing' };

  const raw = run(`${audit.path} audit --json 2>/dev/null`, cwd, 60000);
  if (!raw) return { kind: 'no-output' };

  const parsed = parseCargoAuditOutput(raw);
  if (!parsed) return { kind: 'parse-error' };

  const { counts, findings } = parsed;

  // Attach top-level attribution from cargo's resolve graph. Best-effort:
  // when `cargo metadata` is unavailable the findings keep the Tier-1
  // identity fields only.
  if (findings.length > 0) {
    const topLevelIndex = loadRustTopLevelDepIndex(cwd);
    for (const f of findings) {
      const parents = topLevelIndex.get(f.package);
      if (parents && parents.length > 0) f.topLevelDep = parents;
    }
  }

  // Alias-fallback CVSS pass: many RUSTSEC entries ship without a
  // CVSS vector but their CVE alias on OSV.dev carries one.
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
    tool: 'cargo-audit',
    enrichment: null,
    counts,
    findings,
  };
  return { kind: 'success', envelope };
}

const rustDepVulnsProvider: CapabilityProvider<DepVulnResult> = {
  source: 'rust',
  async gather(cwd) {
    const outcome = await gatherRustDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the rust pack's lint gathering.
 * Consumed by `rustLintProvider` (capability dispatcher).
 *
 * Previously, empty cargo output was silently skipped (nothing pushed
 * to toolsUsed or toolsUnavailable). This helper aligns rust with the
 * other packs: empty output = clean run with zero lint issues. Strict
 * improvement.
 */
function gatherRustLintResult(cwd: string): LintGatherOutcome {
  const clippy = findTool(TOOL_DEFS.clippy, cwd);
  if (!clippy.available) {
    return { kind: 'unavailable', reason: 'not installed' };
  }

  const raw = run('cargo clippy --message-format json 2>/dev/null', cwd, 120000);
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as CargoMessage;
      if (msg.reason !== 'compiler-message' || !msg.message) continue;
      // Upstream emits multiple levels (error, warning, note, help).
      // Skip note/help — they're context, not findings.
      if (msg.message.level !== 'error' && msg.message.level !== 'warning') continue;
      counts[tierCargoMessage(msg.message)]++;
    } catch {
      /* skip non-JSON lines */
    }
  }

  const envelope: LintResult = { schemaVersion: 1, tool: 'clippy', counts };
  return { kind: 'success', envelope };
}

const rustLintProvider: CapabilityProvider<LintResult> = {
  source: 'rust',
  async gather(cwd) {
    const outcome = gatherRustLintResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
};

/**
 * Single source of truth for the rust pack's coverage gathering.
 * Tries lcov first (cargo llvm-cov --lcov default), falls back to
 * cobertura XML. Consumed by `rustCoverageProvider` (capability
 * dispatcher).
 */
function gatherRustCoverageResult(cwd: string): CoverageResult | null {
  for (const file of ['lcov.info', 'coverage/lcov.info']) {
    const abs = path.join(cwd, file);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const coverage = parseLcov(raw, file, cwd);
    if (coverage) {
      return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
    }
  }
  for (const file of ['coverage.cobertura.xml', 'coverage/coverage.cobertura.xml']) {
    const abs = path.join(cwd, file);
    let raw: string;
    try {
      raw = fs.readFileSync(abs, 'utf-8');
    } catch {
      continue;
    }
    const coverage = parseCoberturaXml(raw, file, cwd);
    if (coverage) {
      return { schemaVersion: 1, tool: `coverage:${coverage.source}`, coverage };
    }
  }
  return null;
}

const rustCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'rust',
  async gather(cwd) {
    return gatherRustCoverageResult(cwd);
  },
};

/**
 * Capture Rust `use` path specifiers from source text. Handles simple
 * paths (`use std::io;`) and grouped (`use std::{io, fs};`). Rust has
 * no file-level resolver — see note on the pack's capabilities slot —
 * so this is the only raw helper the imports capability needs.
 * Exported for unit tests.
 */
export function extractRustImportsRaw(content: string): string[] {
  const out: string[] = [];
  const re = /^\s*use\s+([a-zA-Z_][\w:]*(?:::\{[^}]+\})?)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Enumerate .rs source files and capture the pack's per-file imports.
 * Rust has no resolveImport (the module/crate hierarchy requires parsing
 * Cargo.toml + mod declarations — out of scope), so `edges` is always
 * empty and the envelope carries only `extracted` for downstream
 * consumers that want package-level import analysis.
 */
function gatherRustImportsResult(cwd: string): ImportsResult | null {
  const excludes = getFindExcludeFlags(cwd);
  const raw = run(`find . -type f -name "*.rs" ${excludes} 2>/dev/null`, cwd);
  if (!raw) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();

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
    extracted.set(rel, extractRustImportsRaw(content));
  }

  if (extracted.size === 0) return null;
  return {
    schemaVersion: 1,
    tool: 'rust-imports',
    sourceExtensions: ['.rs'],
    extracted,
    edges: new Map(),
  };
}

const rustImportsProvider: CapabilityProvider<ImportsResult> = {
  source: 'rust',
  async gather(cwd) {
    return gatherRustImportsResult(cwd);
  },
};

/**
 * Rust's canonical test runner is `cargo test`; any crate with a
 * `Cargo.toml` has it available by default. No deeper detection needed.
 */
function gatherRustTestFrameworkResult(cwd: string): TestFrameworkResult | null {
  if (!fileExists(cwd, 'Cargo.toml')) return null;
  return { schemaVersion: 1, tool: 'rust', name: 'cargo-test' };
}

const rustTestFrameworkProvider: CapabilityProvider<TestFrameworkResult> = {
  source: 'rust',
  async gather(cwd) {
    return gatherRustTestFrameworkResult(cwd);
  },
};

/**
 * Per-crate shape emitted by `cargo license --json`. Authors use
 * cargo's pipe-separated convention (`"A <a@x>|B <b@y>"`), which we
 * pass through verbatim — downstream formatters can split if they care.
 */
interface CargoLicenseEntry {
  name: string;
  version: string;
  authors?: string;
  repository?: string;
  license?: string;
  license_file?: string | null;
  description?: string;
}

/**
 * Single source of truth for the rust pack's license gathering.
 * Consumed by `rustLicensesProvider` (capability dispatcher).
 *
 * cargo-license walks the Cargo.toml-resolved dep graph and emits every
 * crate's license metadata in one pass — richer than go-licenses (has
 * description + authors + version natively), simpler than the node path
 * (no per-package disk read needed). Returns null cleanly when the repo
 * isn't a Cargo workspace or the tool isn't installed.
 */
function gatherRustLicensesResult(cwd: string): LicensesResult | null {
  if (!fileExists(cwd, 'Cargo.toml')) return null;

  const status = findTool(TOOL_DEFS['cargo-license'], cwd);
  if (!status.available || !status.path) return null;

  const raw = run(`${status.path} --json 2>/dev/null`, cwd, 120000);
  if (!raw) return null;

  let data: CargoLicenseEntry[];
  try {
    data = JSON.parse(raw) as CargoLicenseEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(data)) return null;

  // Same self-parent invariant as the other packs: cargo metadata's
  // resolve graph seeds BFS from each direct dep, so `index[top]`
  // always contains `top`. Empty index (cargo missing, not a
  // workspace) leaves isTopLevel unset — the bom filter will pass
  // the row through rather than guess.
  const topLevelIndex = loadRustTopLevelDepIndex(cwd);
  const hasIndex = topLevelIndex.size > 0;

  const findings: LicenseFinding[] = [];
  for (const entry of data) {
    if (!entry.name || !entry.version) continue;
    const parents = hasIndex ? topLevelIndex.get(entry.name) : undefined;
    findings.push({
      package: entry.name,
      version: entry.version,
      licenseType: entry.license && entry.license.length > 0 ? entry.license : 'UNKNOWN',
      sourceUrl: entry.repository || undefined,
      description: entry.description || undefined,
      supplier: entry.authors || undefined,
      isTopLevel: hasIndex ? (parents?.includes(entry.name) ?? false) : undefined,
    });
  }

  return {
    schemaVersion: 1,
    tool: 'cargo-license',
    findings,
  };
}

const rustLicensesProvider: CapabilityProvider<LicensesResult> = {
  source: 'rust',
  async gather(cwd) {
    return gatherRustLicensesResult(cwd);
  },
};

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function parseLcov(raw: string, sourceFile: string, cwd: string): Coverage | null {
  const files = new Map<string, FileCoverage>();
  let totalHit = 0;
  let totalFound = 0;
  let currentFile: string | null = null;
  let fileHit = 0;
  let fileFound = 0;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SF:')) {
      currentFile = trimmed.slice(3);
      fileHit = 0;
      fileFound = 0;
    } else if (trimmed.startsWith('LH:')) {
      fileHit = parseInt(trimmed.slice(3), 10) || 0;
    } else if (trimmed.startsWith('LF:')) {
      fileFound = parseInt(trimmed.slice(3), 10) || 0;
    } else if (trimmed === 'end_of_record' && currentFile) {
      const rel = path.isAbsolute(currentFile)
        ? path.relative(cwd, currentFile).split(path.sep).join('/')
        : currentFile;
      files.set(rel, {
        path: rel,
        covered: fileHit,
        total: fileFound,
        pct: round1(fileFound > 0 ? (fileHit / fileFound) * 100 : 0),
      });
      totalHit += fileHit;
      totalFound += fileFound;
      currentFile = null;
    }
  }

  if (files.size === 0) return null;
  return {
    source: 'lcov',
    sourceFile,
    linePercent: round1(totalFound > 0 ? (totalHit / totalFound) * 100 : 0),
    files,
  };
}

export const rust: LanguageSupport = {
  id: 'rust',
  displayName: 'Rust',
  sourceExtensions: ['.rs'],
  // Rust convention: tests live in the same file via #[cfg(test)] / #[test],
  // or in a dedicated tests/ directory. Filename patterns cover the latter.
  testFilePatterns: ['*_test.rs', 'tests/*.rs'],
  extraExcludes: ['target'],

  detect(cwd) {
    return fileExists(cwd, 'Cargo.toml');
  },

  tools: ['clippy', 'cargo-audit', 'cargo-llvm-cov', 'cargo-license'],
  // No dedicated semgrep Rust ruleset; covered by p/security-audit.
  semgrepRulesets: [],

  capabilities: {
    depVulns: rustDepVulnsProvider,
    lint: rustLintProvider,
    coverage: rustCoverageProvider,
    imports: rustImportsProvider,
    testFramework: rustTestFrameworkProvider,
    licenses: rustLicensesProvider,
  },

  mapLintSeverity: mapClippyLintSeverity,
};
