import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { getFindExcludeFlags } from '../analyzers/tools/exclusions';
import { parseCoberturaXml } from './csharp';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { CapabilityProvider } from './capabilities/provider';
import type {
  CoverageResult,
  DepVulnGatherOutcome,
  DepVulnResult,
  ImportsResult,
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

interface CargoAuditResult {
  vulnerabilities?: {
    found: number;
    count: number;
    list?: Array<{ advisory?: { severity?: string } }>;
  };
}

/**
 * Single source of truth for the rust pack's dep-vuln gathering.
 * Consumed by `rustDepVulnsProvider` (capability dispatcher).
 */
async function gatherRustDepVulnsResult(cwd: string): Promise<DepVulnGatherOutcome> {
  const audit = findTool(TOOL_DEFS['cargo-audit'], cwd);
  if (!audit.available || !audit.path) return { kind: 'tool-missing' };

  const raw = run(`${audit.path} audit --json 2>/dev/null`, cwd, 60000);
  if (!raw) return { kind: 'no-output' };

  try {
    const data = JSON.parse(raw) as CargoAuditResult;
    if (!data.vulnerabilities) return { kind: 'no-output' };

    let critical = 0;
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const v of data.vulnerabilities.list || []) {
      const sev = v.advisory?.severity?.toLowerCase();
      if (sev === 'critical') critical++;
      else if (sev === 'high') high++;
      else if (sev === 'medium') medium++;
      else low++;
    }
    const envelope: DepVulnResult = {
      schemaVersion: 1,
      tool: 'cargo-audit',
      enrichment: null,
      counts: { critical, high, medium, low },
    };
    return { kind: 'success', envelope };
  } catch {
    return { kind: 'parse-error' };
  }
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

  tools: ['clippy', 'cargo-audit', 'cargo-llvm-cov'],
  // No dedicated semgrep Rust ruleset; covered by p/security-audit.
  semgrepRulesets: [],

  capabilities: {
    depVulns: rustDepVulnsProvider,
    lint: rustLintProvider,
    coverage: rustCoverageProvider,
    imports: rustImportsProvider,
    testFramework: rustTestFrameworkProvider,
  },

  mapLintSeverity: mapClippyLintSeverity,
};
