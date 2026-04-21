/**
 * Coverage artifact import.
 *
 * Detects and parses coverage reports produced by the project's test runner
 * so dxkit can report line-level truth instead of fabricating coverage from
 * filename matches.
 *
 * Supported formats per language pack (src/languages/*.ts):
 *   - typescript  → Istanbul summary + final
 *   - python      → coverage.py JSON
 *   - go          → coverprofile (coverage.out / cover.out)
 *   - rust        → lcov.info + cobertura XML (cargo llvm-cov)
 *   - csharp      → cobertura (dotnet test --collect:XPlat)
 *
 * `loadCoverage` is a thin wrapper over the capability dispatcher —
 * active language packs produce `CoverageResult` envelopes, the
 * descriptor's aggregator (last-wins in mixed-stack repos) reduces to
 * one, and we unwrap `.coverage` for callers. Returns null when no
 * artifact exists or parsing fails; callers (tests analyzer) should
 * treat a null return as "fall back to filename matching."
 */

import * as fs from 'fs';
import * as path from 'path';

import { detectActiveLanguages } from '../../languages';
import { COVERAGE } from '../../languages/capabilities/descriptors';
import type { CapabilityProvider } from '../../languages/capabilities/provider';
import type { CoverageResult } from '../../languages/capabilities/types';
import { defaultDispatcher } from '../dispatcher';

export type CoverageSource =
  | 'istanbul-summary'
  | 'istanbul-final'
  | 'coverage-py'
  | 'go'
  | 'cobertura'
  | 'lcov';

export interface FileCoverage {
  /** Project-relative path (normalized to forward slashes). */
  path: string;
  /** Covered lines or statements. */
  covered: number;
  /** Total lines or statements considered. */
  total: number;
  /** covered / total * 100, rounded to one decimal place. */
  pct: number;
}

export interface Coverage {
  /** Which artifact we read. */
  source: CoverageSource;
  /** Project-relative path of the artifact. */
  sourceFile: string;
  /** Overall line coverage 0-100, rounded to one decimal. */
  linePercent: number;
  /** Per-file coverage, keyed by project-relative path. */
  files: Map<string, FileCoverage>;
}

/**
 * Locate and parse a coverage artifact for the given repo root by
 * dispatching to every active language pack's coverage capability.
 * Returns null when no artifact is found or parsing fails.
 *
 * Mixed-stack repos: the COVERAGE descriptor's aggregator is
 * last-wins — if Node + Python both produce artifacts the later
 * provider wins. Cross-language coverage merging is out of scope for
 * now (would need per-language file weighting).
 */
export async function loadCoverage(cwd: string): Promise<Coverage | null> {
  const providers: CapabilityProvider<CoverageResult>[] = [];
  for (const lang of detectActiveLanguages(cwd)) {
    if (lang.capabilities?.coverage) providers.push(lang.capabilities.coverage);
  }
  if (providers.length === 0) return null;
  const envelope = await defaultDispatcher.gather(cwd, COVERAGE, providers);
  return envelope?.coverage ?? null;
}

// ─── Parsers ────────────────────────────────────────────────────────────────

/** Istanbul coverage-summary.json: `{ "total": {...}, "/abs/path": {...} }`. */
export function parseIstanbulSummary(raw: string, sourceFile: string, cwd: string): Coverage {
  const data = JSON.parse(raw) as Record<string, IstanbulSummaryEntry>;
  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalLines = 0;

  for (const [key, entry] of Object.entries(data)) {
    if (key === 'total') continue;
    const lines = entry?.lines;
    if (!lines || typeof lines.covered !== 'number' || typeof lines.total !== 'number') continue;
    const rel = toRelative(key, cwd);
    const fc: FileCoverage = {
      path: rel,
      covered: lines.covered,
      total: lines.total,
      pct: round1(lines.total > 0 ? (lines.covered / lines.total) * 100 : 0),
    };
    files.set(rel, fc);
    totalCovered += lines.covered;
    totalLines += lines.total;
  }

  const total = data.total?.lines;
  const linePercent =
    total && typeof total.pct === 'number'
      ? round1(total.pct)
      : round1(totalLines > 0 ? (totalCovered / totalLines) * 100 : 0);

  return { source: 'istanbul-summary', sourceFile, linePercent, files };
}

interface IstanbulSummaryEntry {
  lines?: { total: number; covered: number; skipped: number; pct: number };
}

/** Istanbul coverage-final.json: `{ "/abs/path": { s: { "0": 1, "1": 0, ... }, statementMap: {...} } }`. */
export function parseIstanbulFinal(raw: string, sourceFile: string, cwd: string): Coverage {
  const data = JSON.parse(raw) as Record<string, IstanbulFinalEntry>;
  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalStatements = 0;

  for (const [key, entry] of Object.entries(data)) {
    const s = entry?.s;
    if (!s || typeof s !== 'object') continue;
    const counts = Object.values(s);
    const total = counts.length;
    const covered = counts.filter((n) => typeof n === 'number' && n > 0).length;
    const rel = toRelative(entry.path || key, cwd);
    files.set(rel, {
      path: rel,
      covered,
      total,
      pct: round1(total > 0 ? (covered / total) * 100 : 0),
    });
    totalCovered += covered;
    totalStatements += total;
  }

  return {
    source: 'istanbul-final',
    sourceFile,
    linePercent: round1(totalStatements > 0 ? (totalCovered / totalStatements) * 100 : 0),
    files,
  };
}

interface IstanbulFinalEntry {
  path?: string;
  s?: Record<string, number>;
}

/** coverage.py JSON: `{ "totals": {...}, "files": { "path": { summary: {...} } } }`. */
export function parseCoveragePy(raw: string, sourceFile: string, cwd: string): Coverage {
  const data = JSON.parse(raw) as CoveragePyReport;
  const files = new Map<string, FileCoverage>();
  let totalCovered = 0;
  let totalStatements = 0;

  for (const [key, entry] of Object.entries(data.files ?? {})) {
    const summary = entry?.summary;
    if (!summary) continue;
    const total = typeof summary.num_statements === 'number' ? summary.num_statements : 0;
    const missing = typeof summary.missing_lines === 'number' ? summary.missing_lines : 0;
    const covered =
      typeof summary.covered_lines === 'number'
        ? summary.covered_lines
        : Math.max(0, total - missing);
    const rel = toRelative(key, cwd);
    files.set(rel, {
      path: rel,
      covered,
      total,
      pct: round1(
        typeof summary.percent_covered === 'number'
          ? summary.percent_covered
          : total > 0
            ? (covered / total) * 100
            : 0,
      ),
    });
    totalCovered += covered;
    totalStatements += total;
  }

  const linePercent =
    typeof data.totals?.percent_covered === 'number'
      ? round1(data.totals.percent_covered)
      : round1(totalStatements > 0 ? (totalCovered / totalStatements) * 100 : 0);

  return { source: 'coverage-py', sourceFile, linePercent, files };
}

interface CoveragePyReport {
  totals?: { percent_covered?: number };
  files?: Record<
    string,
    {
      summary?: {
        num_statements?: number;
        missing_lines?: number;
        covered_lines?: number;
        percent_covered?: number;
      };
    }
  >;
}

/**
 * Go coverprofile:
 *   mode: set
 *   pkg/path/file.go:5.2,10.1 3 1
 *
 * Each line: file:startLine.col,endLine.col numStatements count.
 * A block is covered iff count > 0.
 */
export function parseGoCoverProfile(raw: string, sourceFile: string, cwd: string): Coverage {
  const perFile = new Map<string, { covered: number; total: number }>();
  let totalCovered = 0;
  let totalStatements = 0;

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith('mode:')) continue;
    // file:startLine.col,endLine.col numStatements count
    const m = line.match(/^(.+):\d+\.\d+,\d+\.\d+\s+(\d+)\s+(\d+)$/);
    if (!m) continue;
    const file = m[1];
    const stmts = parseInt(m[2], 10);
    const count = parseInt(m[3], 10);
    const bucket = perFile.get(file) ?? { covered: 0, total: 0 };
    bucket.total += stmts;
    if (count > 0) bucket.covered += stmts;
    perFile.set(file, bucket);
    totalStatements += stmts;
    if (count > 0) totalCovered += stmts;
  }

  const files = new Map<string, FileCoverage>();
  for (const [key, { covered, total }] of perFile) {
    // Go coverprofile uses module-relative paths (e.g. github.com/user/repo/pkg/foo.go).
    // Strip the module prefix if it resolves to a real file in cwd.
    const rel = resolveGoPath(key, cwd);
    files.set(rel, {
      path: rel,
      covered,
      total,
      pct: round1(total > 0 ? (covered / total) * 100 : 0),
    });
  }

  return {
    source: 'go',
    sourceFile,
    linePercent: round1(totalStatements > 0 ? (totalCovered / totalStatements) * 100 : 0),
    files,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Turn an absolute or prefixed coverage path into a project-relative path. */
function toRelative(p: string, cwd: string): string {
  let out = p.replace(/\\/g, '/');
  const cwdNorm = cwd.replace(/\\/g, '/');
  if (out.startsWith(cwdNorm + '/')) {
    out = out.slice(cwdNorm.length + 1);
  } else if (out === cwdNorm) {
    out = '';
  }
  if (out.startsWith('./')) out = out.slice(2);
  return out;
}

/**
 * Go coverprofile paths look like `github.com/user/repo/pkg/foo.go`. If that
 * file doesn't exist at cwd, try stripping leading segments until we find one
 * that does. Fall back to the original string if nothing resolves.
 */
function resolveGoPath(p: string, cwd: string): string {
  const norm = p.replace(/\\/g, '/');
  // Already relative and exists?
  if (fs.existsSync(path.join(cwd, norm))) return norm;
  const parts = norm.split('/');
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (fs.existsSync(path.join(cwd, candidate))) return candidate;
  }
  return norm;
}
