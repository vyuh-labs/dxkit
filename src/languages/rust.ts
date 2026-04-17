import * as fs from 'fs';
import * as path from 'path';

import type { Coverage, FileCoverage } from '../analyzers/tools/coverage';
import { parseCoberturaXml } from './csharp';
import { fileExists, run } from '../analyzers/tools/runner';
import { findTool, TOOL_DEFS } from '../analyzers/tools/tool-registry';
import type { HealthMetrics } from '../analyzers/types';
import type { LanguageSupport } from './types';

interface CargoMessage {
  reason: string;
  message?: { level: string; message: string };
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
        let errors = 0;
        let warnings = 0;
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line) as CargoMessage;
            if (msg.reason === 'compiler-message' && msg.message) {
              if (msg.message.level === 'error') errors++;
              else if (msg.message.level === 'warning') warnings++;
            }
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
