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
  | 'lcov'
  | 'jacoco';

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

// ─── Helpers ────────────────────────────────────────────────────────────────
//
// Per-language parsers (Istanbul/coverage.py/Go cover-profile/lcov/cobertura)
// moved into their respective `src/languages/<id>.ts` packs in Phase
// 10i.0-LP.4. coverage.ts now hosts only the shared types + small
// utilities the parsers depend on. Adding a 6th language's coverage
// format is a pack-local change — no edits to this file required.

/** Round to one decimal place. Used by every coverage parser for the linePercent contract. */
export function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Turn an absolute or prefixed coverage path into a project-relative path. */
export function toRelative(p: string, cwd: string): string {
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
