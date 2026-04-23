/**
 * BOM analyzer data-gather. Joins LICENSES + DEP_VULNS via the
 * existing capability gather functions — no new tool invocation logic
 * (CLAUDE.md rule 2). The gather just calls each, then walks both
 * result sets to build a per-package join keyed by `package@version`.
 */

import { gatherLicensesResult } from '../licenses/gather';
import { gatherDepVulns } from '../security/gather';
import type { DepVulnFinding, LicenseFinding } from '../../languages/capabilities/types';
import type { BomEntry, BomSeverity, BomTopLevelRollup } from './types';

const SEV_RANK: Record<BomSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Compare two version strings as semver triples. Strips a leading
 * 'v' (Go-pack convention) and compares dot-separated numeric
 * components. Falls back to lexicographic comparison when either
 * input isn't a parseable triple — preserves a deterministic
 * ordering for non-semver versions (e.g. cargo's "0.10.55+echo.1").
 */
export function compareSemver(a: string, b: string): number {
  const norm = (v: string) => v.replace(/^v/, '');
  const pa = norm(a)
    .split('.')
    .map((p) => parseInt(p, 10));
  const pb = norm(b)
    .split('.')
    .map((p) => parseInt(p, 10));
  if (pa.some(isNaN) || pb.some(isNaN)) return norm(a).localeCompare(norm(b));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const xa = pa[i] ?? 0;
    const xb = pb[i] ?? 0;
    if (xa !== xb) return xa - xb;
  }
  return 0;
}

/** Highest version in `versions` per compareSemver. Returns the input
 *  unchanged when only one version is supplied. */
export function maxSemver(versions: string[]): string {
  if (versions.length === 0) return '';
  return versions.reduce((acc, v) => (compareSemver(v, acc) > 0 ? v : acc));
}

/**
 * Tier-1 resolution proposal derived purely from `fixedVersion`
 * data shipped by each pack's depVulns provider. Per checkpoint §9:
 *   - no vulns → empty
 *   - every vuln has fixedVersion → "PROPOSAL: Upgrade to <maxFix> (resolves N)"
 *   - some vuln lacks fixedVersion → "No fix available — evaluate replacement"
 *
 * Higher tiers (10h.4 Snyk, 10h.6 osv-scanner fix) populate
 * `upgradeAdvice` directly on each finding; the bom render layer
 * picks the richest available value per package.
 */
export function deriveTier1Resolution(vulns: DepVulnFinding[]): string {
  if (vulns.length === 0) return '';
  const fixes = vulns.map((v) => v.fixedVersion).filter((v): v is string => !!v);
  if (fixes.length !== vulns.length) {
    return 'No fix available — evaluate replacement';
  }
  const target = maxSemver(fixes);
  return `PROPOSAL: Upgrade to ${target} (resolves ${vulns.length} vuln${vulns.length === 1 ? '' : 's'})`;
}

/** Highest severity across the supplied vulns. */
function maxSeverityOf(vulns: DepVulnFinding[]): BomSeverity | null {
  if (vulns.length === 0) return null;
  let best: BomSeverity = 'low';
  for (const v of vulns) {
    if (SEV_RANK[v.severity] < SEV_RANK[best]) best = v.severity;
  }
  return best;
}

/**
 * Build the per-top-level-dep rollup from a flat list of entries.
 * Walks every advisory under every entry; increments the counter for
 * each top-level the advisory lists (a vuln reachable from two
 * top-levels increments both, matching Snyk's grouping semantics).
 *
 * Entries with no topLevelDep attribution contribute nothing — the
 * rollup is best-effort based on what each pack populates. Pure
 * function; unit-testable.
 */
export function buildByTopLevelDep(entries: BomEntry[]): Record<string, BomTopLevelRollup> {
  const accum = new Map<
    string,
    { advisoryCount: number; maxSeverity: BomSeverity; packages: Set<string> }
  >();
  for (const e of entries) {
    for (const v of e.vulns) {
      const tops = v.topLevelDep;
      if (!tops || tops.length === 0) continue;
      for (const top of tops) {
        const cur = accum.get(top);
        if (!cur) {
          accum.set(top, {
            advisoryCount: 1,
            maxSeverity: v.severity,
            packages: new Set([e.package]),
          });
        } else {
          cur.advisoryCount++;
          if (SEV_RANK[v.severity] < SEV_RANK[cur.maxSeverity]) cur.maxSeverity = v.severity;
          cur.packages.add(e.package);
        }
      }
    }
  }
  const out: Record<string, BomTopLevelRollup> = {};
  for (const [top, data] of accum) {
    out[top] = {
      advisoryCount: data.advisoryCount,
      maxSeverity: data.maxSeverity,
      packages: [...data.packages].sort(),
    };
  }
  return out;
}

/**
 * Join LICENSES + DEP_VULNS by (package, version). Strategy:
 *   - Primary index: package@version. Both LicenseFinding and
 *     DepVulnFinding usually carry both — match exact.
 *   - Fallback: package only. DepVulnFindings without
 *     installedVersion fall back to package-name match against
 *     the licenses list (joins to the single matching version
 *     when unambiguous, all matching versions when not).
 *
 * License-only packages emit BomEntry with empty `vulns`. Vuln-only
 * packages (rare — license scanner gap) emit a row with empty
 * license fields and `joinedFromBoth: false` so the detailed report
 * can flag the gap.
 */
export interface BomGatherResult {
  entries: BomEntry[];
  toolsUsed: string[];
  toolsUnavailable: string[];
}

export async function gatherBomEntries(cwd: string): Promise<BomGatherResult> {
  const [licensesEnv, depVulns] = await Promise.all([
    gatherLicensesResult(cwd),
    gatherDepVulns(cwd),
  ]);

  const licenseFindings = licensesEnv?.findings ?? [];
  const vulnFindings = depVulns.findings;

  // Index vulns by package@version (primary) and package (fallback).
  const vulnByPkgVer = new Map<string, DepVulnFinding[]>();
  const vulnByPkg = new Map<string, DepVulnFinding[]>();
  for (const v of vulnFindings) {
    if (v.installedVersion) {
      const key = `${v.package}@${v.installedVersion}`;
      const arr = vulnByPkgVer.get(key) ?? [];
      arr.push(v);
      vulnByPkgVer.set(key, arr);
    }
    const arr = vulnByPkg.get(v.package) ?? [];
    arr.push(v);
    vulnByPkg.set(v.package, arr);
  }

  const entries: BomEntry[] = [];
  const matchedVulnKeys = new Set<string>();
  for (const lic of licenseFindings) {
    const exactKey = `${lic.package}@${lic.version}`;
    let attached = vulnByPkgVer.get(exactKey);
    if (attached) {
      matchedVulnKeys.add(exactKey);
    } else {
      // Version-less vuln entries fall back to package-name match.
      // Filter to only those that lacked installedVersion to avoid
      // double-counting against other version rows.
      const byPkg = vulnByPkg.get(lic.package) ?? [];
      const versionless = byPkg.filter((v) => !v.installedVersion);
      attached = versionless.length > 0 ? versionless : [];
    }
    entries.push(buildEntry(lic, attached, true));
  }

  // Vuln-only entries: vulns whose package@version did not match a
  // license row AND whose package is absent from every license entry
  // (versionless fallback is consumed above).
  const licensePackages = new Set(licenseFindings.map((l) => l.package));
  const vulnOnlyByPkgVer = new Map<string, DepVulnFinding[]>();
  for (const [key, vulns] of vulnByPkgVer) {
    if (matchedVulnKeys.has(key)) continue;
    const pkg = vulns[0].package;
    if (licensePackages.has(pkg)) continue; // already attached via versionless or other version
    const arr = vulnOnlyByPkgVer.get(key) ?? [];
    arr.push(...vulns);
    vulnOnlyByPkgVer.set(key, arr);
  }
  for (const [, vulns] of vulnOnlyByPkgVer) {
    const v0 = vulns[0];
    const synthLicense: LicenseFinding = {
      package: v0.package,
      version: v0.installedVersion ?? 'unknown',
      licenseType: 'UNKNOWN',
    };
    entries.push(buildEntry(synthLicense, vulns, false));
  }

  // Stable sort: package alphabetical, then version.
  entries.sort((a, b) => a.package.localeCompare(b.package) || compareSemver(a.version, b.version));

  const toolsUsed = new Set<string>();
  if (licensesEnv?.tool) {
    for (const t of licensesEnv.tool.split(', ')) if (t) toolsUsed.add(t);
  }
  if (depVulns.tool) {
    for (const t of depVulns.tool.split(', ')) if (t) toolsUsed.add(t);
  }

  return {
    entries,
    toolsUsed: [...toolsUsed],
    toolsUnavailable: [],
  };
}

function buildEntry(
  lic: LicenseFinding,
  vulns: DepVulnFinding[],
  joinedFromBoth: boolean,
): BomEntry {
  // Tier 2/4 fields on individual findings outrank Tier-1 derivation.
  // Pick the first non-empty `upgradeAdvice` from any finding; fall
  // back to derived advice when all vulns are Tier-1 only.
  const tieredAdvice = vulns.map((v) => v.upgradeAdvice).find((a) => a && a.length > 0);
  return {
    package: lic.package,
    version: lic.version,
    licenseType: lic.licenseType,
    licenseText: lic.licenseText,
    sourceUrl: lic.sourceUrl,
    description: lic.description,
    supplier: lic.supplier,
    releaseDate: lic.releaseDate,
    vulns,
    maxSeverity: maxSeverityOf(vulns),
    upgradeAdvice: tieredAdvice ?? deriveTier1Resolution(vulns),
    joinedFromBoth,
  };
}
