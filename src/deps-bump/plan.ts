/**
 * Deterministic dependency-bump planning (pure half).
 *
 * Turns the enriched dep-vuln findings (`gatherDepVulns` — fix versions from
 * the native scanners + OSV, structured `upgradePlan`s from the Tier-2 fix
 * tools and the transitive resolver) into an ordered bump plan: which
 * top-level packages to upgrade, to what version, and which advisories each
 * bump closes. No LLM, no heuristics — a bump is proposed only when a tool
 * resolved a concrete target version, and everything NOT planned is a named
 * skip (no silent caps).
 *
 * Conservative by default: a bump the producer classified as breaking (major
 * boundary) is skipped unless `allowMajor` — a scheduled robot PR must be
 * boring to merge; majors are a human decision the skip list surfaces.
 */

import type { DepVulnFinding } from '../languages/capabilities/types';
import { isMajorBump } from '../analyzers/tools/semver-bump';

export interface PlannedBump {
  /** The direct dependency to upgrade. */
  readonly parent: string;
  /** Target version — exact semver triple. */
  readonly toVersion: string;
  /** Installed version of the parent when known (display). */
  readonly fromVersion?: string;
  /** Producer-classified major-boundary jump. */
  readonly breaking: boolean;
  /** Advisory ids this bump closes (sorted, deduped). */
  readonly advisories: readonly string[];
  /** Highest severity among the findings this bump closes. */
  readonly maxSeverity: string;
  /** package.json section detection happens at apply time; the plan is
   *  section-agnostic. */
}

export interface SkippedBump {
  readonly package: string;
  readonly advisoryId: string;
  readonly reason:
    | 'no-fix-available' // no tool resolved a target version
    | 'transitive-without-plan' // vulnerable transitively, no parent plan
    | 'breaking-not-allowed' // major bump, allowMajor off
    | 'allowlisted' // an active allowlist entry already covers it
    | 'ecosystem-not-supported'; // apply lane is node-first; others disclosed
}

export interface BumpPlan {
  readonly bumps: readonly PlannedBump[];
  readonly skipped: readonly SkippedBump[];
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'] as const;

function maxSeverity(a: string, b: string): string {
  const ai = (SEVERITY_ORDER as readonly string[]).indexOf(a);
  const bi = (SEVERITY_ORDER as readonly string[]).indexOf(b);
  if (ai === -1) return b;
  if (bi === -1) return a;
  return ai <= bi ? a : b;
}

/** Naive-but-total semver max: numeric field compare, longest wins ties. */
function laterVersion(a: string, b: string): string {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a; // non-numeric — keep first
    if (x !== y) return x > y ? a : b;
  }
  return a;
}

export interface BuildBumpPlanOptions {
  /** Include producer-classified breaking (major) bumps. Default false. */
  readonly allowMajor?: boolean;
}

/**
 * Build the plan. One bump per parent package: when several advisories
 * resolve through the same parent, their target versions collapse to the
 * LATEST proposed one (the higher fix subsumes the lower) and the advisory
 * lists merge.
 */
export function buildBumpPlan(
  findings: readonly DepVulnFinding[],
  opts: BuildBumpPlanOptions = {},
): BumpPlan {
  const allowMajor = opts.allowMajor === true;
  const byParent = new Map<
    string,
    { toVersion: string; fromVersion?: string; breaking: boolean; advisories: Set<string>; sev: string }
  >();
  const skipped: SkippedBump[] = [];

  for (const f of findings) {
    if (f.allowlisted === true) {
      skipped.push({ package: f.package, advisoryId: f.id, reason: 'allowlisted' });
      continue;
    }
    // The apply lane is node-first: a pack that isn't TS/JS is disclosed, not
    // silently dropped — its fix advice still renders in the reports.
    if (f.packId !== undefined && f.packId !== 'typescript') {
      skipped.push({ package: f.package, advisoryId: f.id, reason: 'ecosystem-not-supported' });
      continue;
    }

    // Prefer the structured plan; fall back to a direct-dep fixedVersion.
    let parent: string | undefined;
    let toVersion: string | undefined;
    let breaking = false;
    let fromVersion: string | undefined;
    if (f.upgradePlan) {
      parent = f.upgradePlan.parent;
      toVersion = f.upgradePlan.parentVersion;
      breaking = f.upgradePlan.breaking;
    } else if (f.fixedVersion) {
      const direct =
        f.topLevelDep === undefined ||
        f.topLevelDep.length === 0 ||
        f.topLevelDep.includes(f.package);
      if (direct) {
        parent = f.package;
        toVersion = f.fixedVersion;
        fromVersion = f.installedVersion;
        breaking =
          f.breakingUpgrade ??
          (f.installedVersion ? isMajorBump(f.installedVersion, f.fixedVersion) : false);
      } else {
        skipped.push({ package: f.package, advisoryId: f.id, reason: 'transitive-without-plan' });
        continue;
      }
    } else {
      skipped.push({ package: f.package, advisoryId: f.id, reason: 'no-fix-available' });
      continue;
    }
    if (!parent || !toVersion) {
      skipped.push({ package: f.package, advisoryId: f.id, reason: 'no-fix-available' });
      continue;
    }
    if (breaking && !allowMajor) {
      skipped.push({ package: f.package, advisoryId: f.id, reason: 'breaking-not-allowed' });
      continue;
    }

    const existing = byParent.get(parent);
    const advisoryIds = f.upgradePlan ? f.upgradePlan.patches : [f.id];
    if (existing) {
      existing.toVersion = laterVersion(existing.toVersion, toVersion);
      existing.breaking = existing.breaking || breaking;
      for (const id of advisoryIds) existing.advisories.add(id);
      existing.sev = maxSeverity(existing.sev, f.severity);
      if (!existing.fromVersion && fromVersion) existing.fromVersion = fromVersion;
    } else {
      byParent.set(parent, {
        toVersion,
        ...(fromVersion !== undefined ? { fromVersion } : {}),
        breaking,
        advisories: new Set(advisoryIds),
        sev: f.severity,
      });
    }
  }

  const bumps = [...byParent.entries()]
    .map(([parent, b]) => ({
      parent,
      toVersion: b.toVersion,
      ...(b.fromVersion !== undefined ? { fromVersion: b.fromVersion } : {}),
      breaking: b.breaking,
      advisories: [...b.advisories].sort(),
      maxSeverity: b.sev,
    }))
    // Highest severity first, then name — a deterministic, reviewable order.
    .sort((a, b) => {
      const sa = (SEVERITY_ORDER as readonly string[]).indexOf(a.maxSeverity);
      const sb = (SEVERITY_ORDER as readonly string[]).indexOf(b.maxSeverity);
      if (sa !== sb) return (sa === -1 ? 99 : sa) - (sb === -1 ? 99 : sb);
      return a.parent.localeCompare(b.parent);
    });

  return { bumps, skipped };
}
