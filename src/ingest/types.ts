/**
 * External-findings ingestion types.
 *
 * dxkit's own scanners (semgrep, gitleaks, osv-scanner, npm-audit) are
 * intraprocedural / dependency-level. Interprocedural taint SAST —
 * the class of finding a proprietary engine like Snyk Code or an
 * interprocedural engine like CodeQL produces — lives outside dxkit's
 * bundled toolchain. Rather than try to out-detect those engines,
 * dxkit *ingests* their output and makes it first-class: fingerprinted
 * (Rule 9), aggregated (Rule 8), baselined (Rule 10), graph-linked
 * (Rule 12), and fixable through the agent loop.
 *
 * Every supported engine funnels into the SAME normalized shape
 * (`ExternalFinding`) so the rest of the pipeline is engine-agnostic.
 * Adding an engine is a new *producer* (a function that returns
 * `ExternalFinding[]`); the normalize → aggregate → graph → fix path
 * never grows an engine-specific branch.
 */
import type { Severity, FindingCategory } from '../analyzers/security/types';

/**
 * The engines dxkit can ingest from. Each is a *producer* of
 * `ExternalFinding[]`:
 *
 *   - `snyk-code`   — Snyk Code (SAST), read from the Snyk REST API
 *                     (quota-free; reads stored results) or a SARIF
 *                     export from `snyk code test --sarif`.
 *   - `codeql`      — CodeQL, run on-demand where licensing permits
 *                     (OSS / GitHub Advanced Security), emitting SARIF.
 *   - `semgrep-pro` — Semgrep Pro engine (interprocedural), if a
 *                     customer has it; SARIF.
 *   - `sarif`       — a generic SARIF file from any other tool. The
 *                     producer-of-last-resort; keeps dxkit open.
 *
 * The string also becomes the finding's `tool` provenance so reports
 * and the aggregator can attribute each finding to its origin.
 */
export type SourceEngine = 'snyk-code' | 'codeql' | 'semgrep-pro' | 'sarif';

/**
 * One normalized finding from an external engine. Deliberately a
 * superset-mappable shape: it carries exactly the fields the security
 * aggregator's `SecurityFinding` needs, plus the provenance the report
 * surfaces. Identity (`fingerprint`) is NOT computed here — it is
 * assigned by the normalize layer through the canonical helpers so
 * there is one fingerprint scheme across native + ingested findings
 * (Rule 9).
 */
export interface ExternalFinding {
  /** Engine that produced this finding; becomes the `tool` field. */
  engine: SourceEngine;
  /** Four-tier severity, already mapped from the engine's vocabulary. */
  severity: Severity;
  /** `code` for SAST taint findings; `secret`/`config` reserved for
   *  engines that also emit those kinds. Dependency advisories are NOT
   *  ingested here — dxkit's own dep-vuln gather is at parity. */
  category: FindingCategory;
  /** CWE identifier (e.g. `CWE-23`), or `''` when the engine gives none. */
  cwe: string;
  /** Engine-native rule id (e.g. `javascript/path-injection`,
   *  `SNYK-JS-...`). Combined with `engine` to form the canonical rule. */
  rule: string;
  /** Human-readable one-line title. */
  title: string;
  /** Repo-relative source path. */
  file: string;
  /** 1-based line number of the primary location. */
  line: number;
}
