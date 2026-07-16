import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { walkSourceFiles } from '../analyzers/tools/walk-source-files';
import { parseCoberturaXml } from './csharp';
import { parseCvssV3BaseScore, resolveCvssScores, scoreToTier } from '../analyzers/tools/osv';
import { fileExists, run } from '../analyzers/tools/runner';
import { runTestsWithCoverage } from '../analyzers/tools/run-tests-helper';
import { isMajorBump } from '../analyzers/tools/semver-bump';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type {
  CapabilityProvider,
  DepVulnsProvider,
  LicensesProvider,
  RunTestsOutcome,
} from './capabilities/provider';
import type {
  CorrectnessCommand,
  CorrectnessContext,
  CorrectnessProvider,
} from './capabilities/correctness';
import type {
  CoverageResult,
  DepVulnFinding,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
  LicenseFinding,
  LicensesGatherOutcome,
  LicensesResult,
  LintGatherOutcome,
  LintResult,
  SeverityCounts,
  TestFrameworkResult,
} from './capabilities/types';
import type { LanguageSupport, LintSeverity } from './types';
import { readRepoFile } from './version-detect';
import type { LintGateProvider, RawLocatedFinding } from './capabilities/lint-gate';
import { asRecord, jsonLines, num, str } from './capabilities/lint-structured';
import { hashFirstConfig, toolVersionInput } from './capabilities/recall-inputs';

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
 * Extract the minimum patched semver from a RUSTSEC patched-range
 * string. cargo-audit emits requirement strings like:
 *
 *   `">=1.8.4"`            — single lower bound
 *   `">=1.8.4, <1.9.0"`    — line-restricted patch range
 *   `">= 1.8.4, < 1.9.0"`  — RUSTSEC's spaced convention
 *   `"^1.0.0"`             — caret operator
 *   `"1.8.4"`              — bare version
 *
 * Earlier revisions of `parseCargoAuditOutput` only stripped the
 * leading comparator, producing `"1.8.4, <1.9.0"` for the second
 * shape — unusable as a `cargo update --precise` argument. This
 * helper extracts the explicit `>=` floor when present (the minimum
 * patched version of that line); otherwise falls back to the first
 * semver-shaped token in the string. Surfaced by tokio@0.1.22 in
 * the cross-ecosystem benchmark fixture (Phase 10h.6.8).
 */
export function extractMinPatchedVersion(patchedRange: string): string {
  const semver = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/;
  const gte = patchedRange.match(new RegExp(`>=\\s*(${semver.source})`));
  if (gte) return gte[1];
  const any = patchedRange.match(semver);
  return any ? any[0] : patchedRange;
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
      packId: 'rust',
      severity,
    };
    if (cvssScore !== null) finding.cvssScore = cvssScore;
    const patched = v.versions?.patched ?? [];
    if (patched.length > 0) {
      // RUSTSEC patched entries are version *requirement* strings, often
      // ranges like ">=1.8.4, <1.9.0" — they describe an entire patched
      // version line, not a single version. Earlier revisions stripped
      // only the leading `>=`, leaving `"1.8.4, <1.9.0"` in
      // `parentVersion` which then can't be passed to `cargo update
      // --precise <X>`. Surfaced by tokio@0.1.22 in the cross-ecosystem
      // benchmark fixture (Phase 10h.6.8). Now we extract the explicit
      // `>=` floor when present (the minimum patched version), or fall
      // back to the first semver-shaped token in the string.
      const cleanFix = extractMinPatchedVersion(patched[0]);
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
  const raw = run('cargo metadata --format-version 1', cwd, 60000);
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
  if (!fileExists(cwd, 'Cargo.lock')) {
    return { kind: 'no-manifest', reason: 'no Cargo.lock — run cargo generate-lockfile first' };
  }
  const audit = findTool(TOOL_DEFS['cargo-audit'], cwd);
  if (!audit.available || !audit.path) {
    return { kind: 'unavailable', reason: 'cargo-audit not installed' };
  }

  const raw = run(`${audit.path} audit --json`, cwd, 60000);
  if (!raw) return { kind: 'unavailable', reason: 'cargo-audit produced no output' };

  const parsed = parseCargoAuditOutput(raw);
  if (!parsed) return { kind: 'unavailable', reason: 'cargo-audit output failed JSON parse' };

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

const rustDepVulnsProvider: DepVulnsProvider = {
  source: 'rust',
  manifestPatterns: ['Cargo.toml', 'Cargo.lock'],
  // A workspace member has no own Cargo.lock; a nested one marks an
  // independent crate the root audit cannot see.
  lockfilePatterns: ['Cargo.lock'],
  async gather(cwd) {
    const outcome = await gatherRustDepVulnsResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
    return gatherRustDepVulnsResult(cwd);
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

  const raw = run('cargo clippy --message-format json', cwd, 120000);
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

/**
 * Run `cargo llvm-cov --lcov --output-path lcov.info` from cwd (D021).
 *
 * cargo-llvm-cov drives the standard `cargo test` runner under LLVM
 * source-based coverage instrumentation, so this is the canonical
 * "test + coverage" command for any Cargo workspace. The output file
 * `lcov.info` is the first artifact `gatherRustCoverageResult` looks
 * for on the next dispatcher pass.
 *
 * Preflight:
 *   - `Cargo.toml` must exist — otherwise this isn't a Rust project
 *     and cargo's own "could not find Cargo.toml" framing is worse than
 *     a fast "skipped" outcome.
 *   - `cargo-llvm-cov` must be installed. Unlike Go's built-in
 *     `go test -cover`, Rust coverage requires the third-party subcommand;
 *     without it `cargo` would exit non-zero with "no such command:
 *     llvm-cov", which we'd classify as `failed` — misleading framing for
 *     what is really a missing tool. Route the user to the install path
 *     instead (per CLAUDE.md rule #1: tools go through the registry).
 */
function runRustTestsWithCoverage(cwd: string): Promise<RunTestsOutcome> {
  return Promise.resolve(
    runTestsWithCoverage({
      pack: 'rust',
      cmd: 'cargo llvm-cov --lcov --output-path lcov.info',
      cwd,
      artifact: 'lcov.info',
      preflight: (cwd) => {
        if (!fileExists(cwd, 'Cargo.toml')) {
          return 'no Cargo.toml in this directory — not a Rust project';
        }
        if (!findTool(TOOL_DEFS['cargo-llvm-cov'], cwd).available) {
          return 'cargo-llvm-cov not installed — run `vyuh-dxkit tools install`';
        }
        return null;
      },
    }),
  );
}

const rustCoverageProvider: CapabilityProvider<CoverageResult> = {
  source: 'rust',
  async gather(cwd) {
    return gatherRustCoverageResult(cwd);
  },
  async runTests(cwd) {
    return runRustTestsWithCoverage(cwd);
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
  const files = walkSourceFiles(cwd, {
    extensions: ['.rs'],
    includeTests: true,
    includeAutogen: true,
  });
  if (files.length === 0) return null;

  const extracted = new Map<string, ReadonlyArray<string>>();

  for (const rel of files) {
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
function gatherRustLicensesResult(cwd: string): LicensesGatherOutcome {
  if (!fileExists(cwd, 'Cargo.toml')) {
    return { kind: 'no-manifest', reason: 'no Cargo.toml' };
  }

  const status = findTool(TOOL_DEFS['cargo-license'], cwd);
  if (!status.available || !status.path) {
    return { kind: 'unavailable', reason: 'cargo-license not installed' };
  }

  const raw = run(`${status.path} --json`, cwd, 120000);
  if (!raw) return { kind: 'unavailable', reason: 'cargo-license produced no output' };

  let data: CargoLicenseEntry[];
  try {
    data = JSON.parse(raw) as CargoLicenseEntry[];
  } catch (err) {
    return { kind: 'unavailable', reason: `cargo-license parse error: ${(err as Error).message}` };
  }
  if (!Array.isArray(data)) {
    return { kind: 'unavailable', reason: 'cargo-license output was not a JSON array' };
  }

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

  const envelope: LicensesResult = {
    schemaVersion: 1,
    tool: 'cargo-license',
    findings,
  };
  return { kind: 'success', envelope };
}

const rustLicensesProvider: LicensesProvider = {
  source: 'rust',
  async gather(cwd) {
    const outcome = gatherRustLicensesResult(cwd);
    return outcome.kind === 'success' ? outcome.envelope : null;
  },
  async gatherOutcome(cwd) {
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

/** Does the root `Cargo.toml` declare a `[workspace]` (multi-crate)? */
function rustIsWorkspace(cwd: string): boolean {
  try {
    return /^\s*\[workspace\]/m.test(fs.readFileSync(path.join(cwd, 'Cargo.toml'), 'utf-8'));
  } catch {
    return false;
  }
}

/** The `[package] name` declared in a Cargo.toml, or null (virtual manifest /
 *  unreadable). Scoped to the `[package]` table by scanning line-by-line so a
 *  `[dependencies] name = …` can't be mistaken for the crate name. */
function rustCrateNameOf(cargoTomlAbs: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(cargoTomlAbs, 'utf-8');
  } catch {
    return null;
  }
  let inPackage = false;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (/^\[.*\]$/.test(t)) {
      inPackage = t === '[package]';
      continue;
    }
    if (inPackage) {
      const m = t.match(/^name\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * The distinct workspace-member crate names owning the changed `.rs` files —
 * each file's nearest ancestor `Cargo.toml` (not above `cwd`). Returns null when
 * ANY changed `.rs` cannot be attributed to a named crate, so the caller falls
 * back to the whole-workspace `cargo test` (never silently under-tests).
 */
function rustChangedCrates(cwd: string, changedFiles: readonly string[]): string[] | null {
  const names = new Set<string>();
  for (const f of changedFiles) {
    if (!f.endsWith('.rs')) continue;
    let dir = path.dirname(f).replace(/\\/g, '/');
    let name: string | null = null;
    // Walk up to (and including) the repo root looking for the owning manifest.
    for (;;) {
      const abs = path.join(cwd, dir, 'Cargo.toml');
      if (fs.existsSync(abs)) {
        name = rustCrateNameOf(abs);
        break;
      }
      if (dir === '.' || dir === '') break;
      dir = path.dirname(dir);
    }
    if (!name) return null; // unattributable → caller runs the whole workspace
    names.add(name);
  }
  return [...names];
}

/**
 * The Rust correctness floor.
 *
 * syntaxCheck: `cargo check` — compiles the crate/workspace WITHOUT producing
 * binaries (the fast "does it compile + typecheck" path), incremental via
 * cargo's cache. A cold check on a large workspace is bounded by the runner's
 * timeout (fail-open → CI backstop).
 *
 * affectedTests: `cargo test`. Rust's native affected unit is the CRATE. A
 * single-crate project runs `cargo test` (that crate). A workspace narrows to
 * the changed members' crates via `-p <crate>` — falling back to the whole
 * workspace when a changed `.rs` can't be attributed to a named crate, so it
 * never silently under-tests. Full scope always runs the whole workspace.
 * (Crate-level rung, like Go's package-level: a change whose DEPENDENTS live in
 * another crate is caught at full/CI scope, not the affected surface.)
 */
const rustCorrectnessProvider: CorrectnessProvider = {
  syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (!fileExists(ctx.cwd, 'Cargo.toml')) return null; // not a cargo project
    return { label: 'check', bin: 'cargo', args: ['check'] };
  },

  affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
    if (!fileExists(ctx.cwd, 'Cargo.toml')) return null;
    const undeterminable = ctx.changedFiles.length === 0;
    if (ctx.scope === 'affected' && !undeterminable) {
      if (!ctx.changedFiles.some((f) => f.endsWith('.rs'))) return null; // no .rs change
      if (rustIsWorkspace(ctx.cwd)) {
        const crates = rustChangedCrates(ctx.cwd, ctx.changedFiles);
        if (crates && crates.length > 0) {
          return {
            label: 'affected-tests',
            bin: 'cargo',
            args: ['test', ...crates.flatMap((c) => ['-p', c])],
          };
        }
        // else fall through to whole-workspace `cargo test` (safe default)
      }
    }
    return { label: 'affected-tests', bin: 'cargo', args: ['test'] };
  },
};

/** clippy `--message-format short` line: `<file>:<line>:<col>: warning|error: <message>`.
 *  clippy's short format omits the lint name, so there is no `rule` group — the
 *  finding is (file, line, message). Exported for the format-contract test. */
/**
 * Map cargo/clippy `--message-format json` (newline-delimited JSON) to raw
 * located findings. Each relevant line is `{ reason: 'compiler-message',
 * message: { code: { code } | null, level, message, spans: [...] } }`; the
 * primary span carries the location. Only `warning`/`error` levels count —
 * `note`/`help` are sub-diagnostics of a parent finding.
 *
 * This is the rule-name identity fix: the short display format prints NO lint
 * name, so the prior parse minted identities from file+lineWindow alone and
 * two different lints in one 3-line window collided — a REAL net-new lint on
 * a line that already carried a grandfathered one slid through the gate.
 * `message.code.code` (`clippy::needless_return`, `unused_variables`) is the
 * discriminator the display format was hiding.
 *
 * Exported so the lint-gate format contract is testable against real samples.
 */
export function parseClippyJson(output: string): RawLocatedFinding[] {
  const out: RawLocatedFinding[] = [];
  for (const entry of jsonLines(output)) {
    const record = asRecord(entry);
    if (str(record?.reason) !== 'compiler-message') continue;
    const message = asRecord(record?.message);
    if (!message) continue;
    const level = str(message.level);
    if (level !== 'warning' && level !== 'error') continue;
    const text = str(message.message);
    if (!text) continue;
    const spans = Array.isArray(message.spans) ? message.spans.map(asRecord) : [];
    const primary = spans.find((s) => s?.is_primary === true) ?? spans[0];
    const file = str(primary?.file_name);
    if (!file) continue; // e.g. the trailing "N warnings emitted" summary
    const line = num(primary?.line_start);
    const rule = str(asRecord(message.code)?.code);
    out.push({
      file,
      ...(line !== undefined ? { line } : {}),
      ...(rule !== undefined ? { rule } : {}),
      message: text,
    });
  }
  return out;
}

/**
 * Lint-GATE provider: clippy, the standard Rust linter that ships with the
 * toolchain (via cargo). `-D warnings` promotes every lint to a non-zero exit so
 * the gate actually fires (clippy is exit-0 on warnings otherwise);
 * `--message-format json` is cargo's native NDJSON diagnostic stream — see
 * `parseClippyJson` for why the short display format was an identity bug. A repo
 * without clippy is handled by the runner's fail-open on a failed cargo
 * subcommand only insofar as it produces no located matches — clippy is part of
 * a default rustup install, the common case when a Rust team opts into linting.
 */
const rustLintGateProvider: LintGateProvider = {
  lintCommand() {
    return {
      bin: 'cargo',
      args: ['clippy', '--message-format', 'json', '--', '-D', 'warnings'],
      parse: { kind: 'structured', label: 'clippy-json', parse: parseClippyJson },
      expectedExit: 0,
    };
  },
  recallInputs(ctx) {
    // clippy's lint set is versioned WITH the toolchain, so its own version is
    // the input that matters: a `rustup update` on a floating channel adds
    // lints under an unchanged command. `rust-toolchain.toml` pins that
    // channel; `clippy.toml` tunes the thresholds the lints fire at.
    return {
      ...toolVersionInput(TOOL_DEFS.clippy, ctx.cwd, 'clippy'),
      ...hashFirstConfig(ctx.cwd, ['rust-toolchain.toml', 'rust-toolchain']),
      ...hashFirstConfig(ctx.cwd, ['clippy.toml', '.clippy.toml']),
    };
  },
};

/** The Rust toolchain this repo targets — `rust-toolchain.toml` channel or
 *  `Cargo.toml` `rust-version`. Feeds the `RUST_VERSION` template var (the CI
 *  step uses `rust-toolchain@stable`, whose channel is in the action ref, so
 *  there's no `versionInput` to substitute). */
function detectRustVersion(cwd: string): string | undefined {
  const toolchain = readRepoFile(cwd, 'rust-toolchain.toml').match(/channel\s*=\s*"([^"]+)"/);
  if (toolchain) return toolchain[1];
  const cargo = readRepoFile(cwd, 'Cargo.toml').match(/rust-version\s*=\s*"([^"]+)"/);
  return cargo ? cargo[1] : undefined;
}

export const rust: LanguageSupport = {
  id: 'rust',
  displayName: 'Rust',
  commentSyntax: { lineComment: '//', blockCommentStart: '/*', blockCommentEnd: '*/' },
  sourceExtensions: ['.rs'],
  // Rust convention: tests live in the same file via #[cfg(test)] / #[test],
  // or in a dedicated tests/ directory. Filename patterns cover the latter.
  testFilePatterns: ['*_test.rs', 'tests/*.rs'],
  extraExcludes: ['target'],

  exportDetection: {
    reliability: 'full',
    strategy: '`pub`, `pub(crate)`, `pub(super)` visibility modifiers on items',
  },

  // D027 (2.4.7): rustdoc uses outer (`///`) and inner (`//!`)
  // doc-comment markers. Both at the start of a (possibly indented)
  // line.
  docCommentPatterns: ['^[[:space:]]*///', '^[[:space:]]*//!'],

  // D034 (2.4.7): `reqwest`'s permissive opt-outs are the dominant
  // Rust TLS-bypass idiom (`Client::builder().danger_accept_invalid_certs(true)`).
  // Function names are explicitly `danger_*` — high-signal greppable
  // tokens with near-zero false-positive rate.
  tlsBypassPatterns: ['danger_accept_invalid_certs', 'danger_accept_invalid_hostnames'],

  upgradeCommand(name, version) {
    return `cargo update -p ${name} --precise ${version}`;
  },

  // Rust's build layout (`src/bin/`, `src/lib.rs`, `src/main.rs`)
  // is too generic to call "primary architecture" — every Rust
  // project has it. axum/actix/rocket web frameworks organize HTTP
  // surface under `handlers/`, `routes/`, `api/`; CLI tools and
  // standalone binaries don't, and degrade cleanly to "no primary
  // architecture detected."
  architecturalShape: {
    primaryComponentPaths: ['/handlers/', '/routes/', '/api/', '/services/'],
    routePaths: ['/handlers/', '/routes/', '/api/'],
    modelPaths: ['/models/'],
    vocabulary: {
      components: 'handlers/services',
      models: 'models',
      routes: 'routes',
    },
    testGapPriority: {
      high: ['/handlers/', '/routes/', '/services/'],
    },
  },

  // HTTP flow: actix-web / Rocket attribute routes (#[get("/x")] — bare and
  // crate-scoped forms), axum routers (.route(...) mints method-agnostic ANY
  // routes — the verb lives on the handler argument's callee chain, not the
  // registration; .nest prefixes its ARGUMENT side only, never a chain-link
  // sibling), and reqwest clients (`reqwest::get` resolves as a member via
  // the scoped-identifier form; a format!-built URL is a macro, not a
  // string — counted as a dynamic call site). Out of scope, documented:
  // Rocket mount prefixes (`routes![]` macro linkage — routes mint
  // unprefixed), axum verb sharpening from the handler argument,
  // variable-held routers.
  httpFlow: {
    routeDecorators: ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'],
    routeCallees: { memberNames: ['route'] },
    routeGroupCallees: { names: ['nest'] },
    clientMethodCallees: {
      methods: ['get', 'post', 'put', 'patch', 'delete', 'head'],
      bases: ['client', 'reqwest'],
    },
    flowSignals: [
      { manifest: 'Cargo.toml', anyOf: ['actix-web', 'axum', 'rocket', 'warp', 'reqwest'] },
    ],
  },

  // Data models for the schema drift gate: serde structs
  // (#[derive(Serialize/Deserialize)] — the model row expands derive lists
  // so each trait reads as a marker), with #[serde(rename = "x")] wire
  // names read from the attribute token soup and Option<T> as precise
  // grammar-level optionality. Out of scope, documented:
  // #[serde(rename_all)] container transforms, #[serde(default)] /
  // skip_serializing_if optionality nuances.
  modelSchema: {
    modelDecorators: ['Serialize', 'Deserialize'],
    fieldDecoratorSpecs: [{ names: ['serde'], wireNameKeyword: 'rename' }],
    schemaSignals: [{ manifest: 'Cargo.toml', anyOf: ['serde', 'diesel', 'sea-orm'] }],
  },

  // Tree-sitter grammar for the canonical AST layer (src/ast/).
  treeSitterGrammars: {
    '.rs': 'rust',
  },

  clocLanguageNames: ['Rust'],

  detect(cwd) {
    return fileExists(cwd, 'Cargo.toml');
  },

  tools: ['clippy', 'cargo-audit', 'cargo-llvm-cov', 'cargo-license'],
  // No dedicated semgrep Rust ruleset; covered by p/security-audit.
  semgrepRulesets: [],
  // CodeQL `rust` extractor is beta (no build). Snyk Code has no Rust
  // support today, so leave snykCode unset.
  deepSast: { codeqlLanguage: 'rust', codeqlBeta: true },

  correctness: rustCorrectnessProvider,
  lintGate: rustLintGateProvider,

  capabilities: {
    depVulns: rustDepVulnsProvider,
    lint: rustLintProvider,
    coverage: rustCoverageProvider,
    imports: rustImportsProvider,
    testFramework: rustTestFrameworkProvider,
    licenses: rustLicensesProvider,
  },

  mapLintSeverity: mapClippyLintSeverity,

  permissions: ['Bash(cargo test:*)', 'Bash(cargo build:*)', 'Bash(cargo clippy:*)'],
  ruleFile: 'rust.md',
  ciSetup: {
    steps: [{ name: 'Set up Rust', uses: 'dtolnay/rust-toolchain@stable' }],
  },
  defaultVersion: 'stable',
  detectVersion: detectRustVersion,
  cliBinaries: ['rustc', 'cargo'],
  devcontainerFeature: {
    name: 'ghcr.io/devcontainers/features/rust:1',
    opts: { version: 'stable', profile: 'default' },
  },
  devcontainerExtensions: ['rust-lang.rust-analyzer'],
};
