/**
 * Normalize ingested external findings into the security pipeline's
 * `SecurityFinding` shape.
 *
 * Deliberately a pure field-map and nothing more. In particular it does
 * NOT compute identity: the security aggregator owns fingerprinting for
 * every code finding (`canonicalRuleFor(tool, rule)` →
 * `computeCodeFingerprint`) and the cross-tool dedup that collapses,
 * say, a Snyk Code and a semgrep finding on the same line into one
 * `CodeFinding`. Routing ingested findings through that same path is
 * what keeps one fingerprint scheme across native + ingested findings
 * (Rule 9) — an ingest-local hash would silently fork the contract.
 *
 * The engine name becomes the finding's `tool` provenance, so the
 * canonical rule (`canonicalRuleFor(engine, rule)`) and the report's
 * attribution both trace back to the producing engine.
 */
import type { SecurityFinding } from '../analyzers/security/types';
import type { ExternalFinding } from './types';

/** Map normalized external findings to `SecurityFinding[]` for the
 *  aggregator. Identity + dedup happen downstream (Rule 9). */
export function externalToSecurityFindings(
  findings: ReadonlyArray<ExternalFinding>,
): SecurityFinding[] {
  return findings.map((f) => ({
    severity: f.severity,
    category: f.category,
    cwe: f.cwe,
    rule: f.rule,
    title: f.title,
    file: f.file,
    line: f.line,
    tool: f.engine,
  }));
}
