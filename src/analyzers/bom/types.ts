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

  /** True when this package is a root manifest dep (direct or dev-dep).
   *  False when definitely transitive. Undefined when the language
   *  pack couldn't determine it (missing lockfile / manifest parse
   *  failure). `analyzeBom({ filter: 'top-level' })` drops rows where
   *  this is `false` — undefined passes through so degraded gathers
   *  don't accidentally filter the whole report down to zero. */
  isTopLevel?: boolean;

  /** Cwd-relative paths of the sub-project roots this package was
   *  found in (e.g. `["."]`, `["userserver"]`, or
   *  `[".", "userserver", "tools"]`). Populated only when
   *  `analyzeBom({ nested: true })` discovers more than one root.
   *  When a package appears under multiple roots (common for shared
   *  transitives like `lodash`), the sources list unions the
   *  sub-paths so the reader can see the full blast radius of an
   *  upgrade. Unset when nested scan was disabled or only one root
   *  existed. */
  sources?: string[];
}

/**
 * Per-top-level-dep aggregation. A single advisory may roll up under
 * multiple top-levels (e.g. lodash reachable from 20 loopback packages),
 * in which case each top-level's `advisoryCount` increments by one.
 * Matches Snyk's UI rollup: "@loopback/cli has 49 advisories".
 */
export interface BomTopLevelRollup {
  /** Total advisories rolled up under this top-level. */
  advisoryCount: number;
  /** Highest severity across all rolled-up advisories. */
  maxSeverity: BomSeverity;
  /** Distinct vulnerable package names reachable under this top-level.
   *  Rendered in markdown as a comma-joined list; cap in renderer. */
  packages: string[];
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
    /** Snyk-style upgrade-oriented grouping: per-top-level-dep rollup
     *  built from `vulns[].topLevelDep`. Empty when no findings carry
     *  topLevelDep attribution (e.g. pre-10h.4 packs or projects
     *  without a parseable dep graph). Always computed on the
     *  unfiltered entry set so the rollup reflects full blast radius
     *  even when the caller requested `filter: 'top-level'`. */
    byTopLevelDep: Record<string, BomTopLevelRollup>;
    /** Which row filter was applied. Defaults to `'all'` (no filter).
     *  `'top-level'` drops `BomEntry.isTopLevel === false` rows. */
    filter: 'all' | 'top-level';
    /** Total package count in the unfiltered entry set. Equals
     *  `totalPackages` when `filter === 'all'`; equals the pre-filter
     *  row count otherwise, so the header can show "120 of 1371
     *  (filter=top-level)." */
    unfilteredTotalPackages: number;
    /** Cwd-relative paths of every project root the nested scan
     *  discovered (e.g. `["."]` or `[".", "userserver"]`). Sorted,
     *  distinct. When nested scan is disabled or only one root was
     *  found, this is `["."]` so consumers can treat it uniformly. */
    projectRoots: string[];
  };
  entries: ReadonlyArray<BomEntry>;
  toolsUsed: string[];
  toolsUnavailable: string[];
}
