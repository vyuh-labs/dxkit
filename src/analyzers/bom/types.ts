/**
 * BOM (Bill of Materials) analyzer report shape.
 *
 * Joins the LICENSES and DEP_VULNS capabilities on (package, version)
 * to produce one row per installed package with both the license
 * inventory data the customer's spreadsheet needs (cols 1-9, 15) and
 * the per-package vulnerability rollup (cols 11-13). Per-advisory
 * detail stays attached to each row so the xlsx writer (10h.3.9)
 * can render col 12 (Vulnerability Issues) as an enumerated list.
 */
import type { DepVulnFinding } from '../../languages/capabilities/types';

export type BomSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface BomEntry {
  // Identity
  package: string;
  version: string;

  // License inventory data — passes through from LicenseFinding
  licenseType: string;
  licenseText?: string;
  sourceUrl?: string;
  description?: string;
  supplier?: string;
  releaseDate?: string;

  // Vulnerability rollup. `vulns` is the raw per-advisory list; the
  // derived fields below give renderers a single value per column
  // without re-walking the array.
  vulns: DepVulnFinding[];

  /** Highest severity across `vulns`; null when the package has no
   *  known vulnerabilities. Drives col 11 "Criticality of usage". */
  maxSeverity: BomSeverity | null;

  /** Tier-1 resolution proposal derived from `vulns[].fixedVersion`
   *  at gather time. Empty string when no vulns. Drives col 13
   *  "Resolution". Higher tiers (10h.4 snyk, 10h.6 osv-scanner fix)
   *  may overwrite this in future commits. */
  upgradeAdvice: string;

  /** Whether the package was reported by both the licenses scanner
   *  AND a dep-vuln scanner. False = vuln-only entry (license scanner
   *  didn't see it), which usually indicates a workspace/sub-package
   *  the license tool missed; surfaced in the detailed report so the
   *  user can decide whether to trust the license=UNKNOWN row. */
  joinedFromBoth: boolean;
}

export interface BomReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  /** Bumps when the report shape changes incompatibly. */
  schemaVersion: '1';
  summary: {
    totalPackages: number;
    /** Per-severity package count (one increment per package's
     *  maxSeverity, not per advisory). Matches what bom xlsx
     *  col 11 will summarize. */
    bySeverity: Record<BomSeverity, number>;
    /** Number of packages with at least one known vulnerability.
     *  Note: a single package may carry many advisories — see
     *  totalAdvisories for the per-vuln count. */
    vulnerablePackages: number;
    /** Number of vulnerable packages where every vuln has a
     *  fixedVersion (Tier-1 upgrade proposal is actionable). */
    actionableVulns: number;
    /** Total advisories across every vulnerable package (each row's
     *  vulns.length, summed). Reconciles with the count surfaced by
     *  `vyuh-dxkit vulnerabilities` — that command shows one tick
     *  per advisory; bom shows one row per package. */
    totalAdvisories: number;
    /** Packages found only by a vuln scanner — license scanner
     *  missed them. See BomEntry.joinedFromBoth. */
    vulnOnlyPackages: number;
  };
  entries: ReadonlyArray<BomEntry>;
  toolsUsed: string[];
  toolsUnavailable: string[];
}
