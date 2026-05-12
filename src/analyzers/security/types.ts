/**
 * Security analyzer types.
 */
import type { DepVulnFinding } from '../../languages/capabilities/types';

export type Severity = 'critical' | 'high' | 'medium' | 'low';

export type FindingCategory = 'secret' | 'code' | 'config' | 'dependency';

export interface SecurityFinding {
  severity: Severity;
  category: FindingCategory;
  cwe: string;
  rule: string;
  title: string;
  file: string;
  line: number;
  tool: string;
}

export interface DepVulnSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
  tool: string | null;
  /** Per-advisory detail concatenated across every active pack. Empty
   *  when no provider returned findings (counts may still be non-zero
   *  for legacy pack output that only emits aggregate counts). */
  findings: DepVulnFinding[];
  /**
   * D025b (2.4.7): true if at least one active pack's depVulns gather
   * either reached `success` OR cleanly reported `no-manifest` (a
   * legitimate "nothing in this stack to scan" state — e.g. a polyglot
   * repo where the csharp pack activates but no `.csproj` is present).
   * false if at least one active pack returned `unavailable` (tool not
   * installed, tool ran with no output, parse failure). False is the
   * customer-credibility signal: dxkit couldn't actually scan the
   * deps. The security scorer (`scoreSecurityFromInput`) caps the
   * dimension at 65/100 when this is false and surfaces a visible
   * markdown notice.
   */
  available: boolean;
  /**
   * Human-readable explanation of why `available === false`, suitable
   * for the markdown notice. Empty string when available. Carries the
   * pack name + reason of the first `unavailable` outcome encountered
   * (e.g. "csharp: dotnet list package produced no output (see D036)").
   */
  unavailableReason: string;
}

export interface SecurityReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  summary: {
    findings: { critical: number; high: number; medium: number; low: number; total: number };
    dependencies: DepVulnSummary;
  };
  findings: SecurityFinding[];
  toolsUsed: string[];
  toolsUnavailable: string[];
}
