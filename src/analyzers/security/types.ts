/**
 * Security analyzer types.
 */

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
