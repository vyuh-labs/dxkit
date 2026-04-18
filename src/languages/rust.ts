import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { parseCoberturaXml } from './csharp';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
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

  mapLintSeverity: mapClippyLintSeverity,

  parseCoverage(cwd) {
    // Try lcov.info first (common default for cargo llvm-cov --lcov)
    for (const file of ['lcov.info', 'coverage/lcov.info']) {
      const abs = path.join(cwd, file);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const result = parseLcov(raw, file, cwd);
      if (result) return result;
    }
    // Fall back to cobertura XML (cargo llvm-cov --cobertura)
    for (const file of ['coverage.cobertura.xml', 'coverage/coverage.cobertura.xml']) {
      const abs = path.join(cwd, file);
      let raw: string;
      try {
        raw = fs.readFileSync(abs, 'utf-8');
      } catch {
        continue;
      }
      const result = parseCoberturaXml(raw, file, cwd);
      if (result) return result;
    }
    return null;
  },

  extractImports(content) {
    // Rust: `use std::io;`, `use std::collections::HashMap;`,
    // `use crate::module;`, `use super::sibling;`
    // Also block form: `use std::{io, fs};`
    const out: string[] = [];
    const re = /^\s*use\s+([a-zA-Z_][\w:]*(?:::\{[^}]+\})?)\s*;/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      out.push(m[1]);
    }
    return out;
  },

  // resolveImport intentionally omitted: Rust's module system uses crate/mod.rs
  // hierarchy which requires parsing Cargo.toml + mod declarations. Out of scope.

  async gatherMetrics(cwd) {
    const metrics: Partial<HealthMetrics> = {
      toolsUsed: [],
      toolsUnavailable: [],
    };

    const clippy = findTool(TOOL_DEFS.clippy, cwd);
    if (clippy.available) {
      const raw = run('cargo clippy --message-format json 2>/dev/null', cwd, 120000);
      if (raw) {
        // Tier by clippy lint code (clippy::*) or rustc lint name.
        // Collapse: critical + high → errors, medium + low → warnings.
        let errors = 0;
        let warnings = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as CargoMessage;
            if (msg.reason !== 'compiler-message' || !msg.message) continue;
            // Upstream emits multiple levels (error, warning, note, help).
            // Skip note/help — they're context, not findings.
            if (msg.message.level !== 'error' && msg.message.level !== 'warning') continue;
            const tier = tierCargoMessage(msg.message);
            if (tier === 'critical' || tier === 'high') errors++;
            else warnings++;
          } catch {
            /* skip non-JSON lines */
          }
        }
        metrics.lintErrors = errors;
        metrics.lintWarnings = warnings;
        metrics.lintTool = 'clippy';
        metrics.toolsUsed!.push('clippy');
      }
    } else {
      metrics.toolsUnavailable!.push('clippy');
    }

    const audit = findTool(TOOL_DEFS['cargo-audit'], cwd);
    if (audit.available && audit.path) {
      const raw = run(`${audit.path} audit --json 2>/dev/null`, cwd, 60000);
      if (raw) {
        try {
          const data = JSON.parse(raw) as CargoAuditResult;
          if (data.vulnerabilities) {
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
            metrics.depVulnCritical = critical;
            metrics.depVulnHigh = high;
            metrics.depVulnMedium = medium;
            metrics.depVulnLow = low;
            metrics.depAuditTool = 'cargo-audit';
            metrics.toolsUsed!.push('cargo-audit');
          }
        } catch {
          metrics.toolsUnavailable!.push('cargo-audit (parse error)');
        }
      }
    } else {
      metrics.toolsUnavailable!.push('cargo-audit');
    }

    if (fileExists(cwd, 'Cargo.toml')) {
      metrics.testFramework = 'cargo-test';
    }

    return metrics;
  },
};
