/**
 * BOM analyzer — detailed report.
 *
 * Extends the base BomReport with risk-categorized buckets so the
 * reader can triage the inventory by what needs action first.
 * Mirrors the licenses/detailed pattern (10h.2.2) but the categories
 * are vuln-driven rather than license-driven, since BOM exists
 * primarily to surface upgrade work.
 */

import type { BomEntry, BomReport, BomSeverity } from './types';

export interface BomRiskCategory {
  /** Severity tier for ordering. */
  readonly priority: BomSeverity;
  /** Stable category key — for programmatic filtering / dashboards. */
  readonly id:
    | 'critical-no-fix'
    | 'critical-actionable'
    | 'high-no-fix'
    | 'high-actionable'
    | 'medium-vulns'
    | 'low-vulns'
    | 'vuln-only-license-gap';
  readonly title: string;
  readonly rationale: string;
  readonly recommendation: string;
  readonly affected: ReadonlyArray<BomEntry>;
}

export interface BomDetailedReport extends BomReport {
  riskCategories: ReadonlyArray<BomRiskCategory>;
}

export function buildBomDetailed(report: BomReport): BomDetailedReport {
  const categories: BomRiskCategory[] = [];

  // Buckets keyed by (severity, has-fix). The `actionable` axis matters
  // because "critical with no fix" is qualitatively different from
  // "critical with a one-line upgrade" — same severity, different
  // remediation cost.
  const buckets = new Map<string, BomEntry[]>();
  for (const e of report.entries) {
    if (!e.maxSeverity) continue;
    const actionable = e.upgradeAdvice.startsWith('PROPOSAL:');
    const key = `${e.maxSeverity}|${actionable ? 'fix' : 'nofix'}`;
    const arr = buckets.get(key) ?? [];
    arr.push(e);
    buckets.set(key, arr);
  }

  const criticalNoFix = buckets.get('critical|nofix') ?? [];
  if (criticalNoFix.length > 0) {
    categories.push({
      priority: 'critical',
      id: 'critical-no-fix',
      title: 'Critical vulns with no published fix',
      rationale:
        'These packages have one or more critical-severity advisories ' +
        'with no upstream fix version. Upgrading the dep does not resolve ' +
        'them — replacement or vendor pressure is the only remediation path.',
      recommendation:
        'Evaluate replacement packages, contact maintainers, or accept ' +
        'and document the risk. Do not ship to production untreated.',
      affected: criticalNoFix,
    });
  }
  const criticalActionable = buckets.get('critical|fix') ?? [];
  if (criticalActionable.length > 0) {
    categories.push({
      priority: 'critical',
      id: 'critical-actionable',
      title: 'Critical vulns with an upgrade path',
      rationale:
        'These packages have critical advisories AND a published fixed ' +
        'version. The upgrade is the highest-leverage security action ' +
        'available for this codebase right now.',
      recommendation:
        'Schedule the upgrades immediately. Prefer the Tier-1 PROPOSAL ' +
        'target unless a major-version bump introduces compat risk.',
      affected: criticalActionable,
    });
  }
  const highNoFix = buckets.get('high|nofix') ?? [];
  if (highNoFix.length > 0) {
    categories.push({
      priority: 'high',
      id: 'high-no-fix',
      title: 'High-severity vulns with no published fix',
      rationale:
        'High-severity advisories without an upstream fix. Less urgent ' +
        'than critical-no-fix but still warrants a documented decision.',
      recommendation:
        'Plan replacement evaluation alongside critical-no-fix items. ' +
        'Track the upstream advisory for fix availability.',
      affected: highNoFix,
    });
  }
  const highActionable = buckets.get('high|fix') ?? [];
  if (highActionable.length > 0) {
    categories.push({
      priority: 'high',
      id: 'high-actionable',
      title: 'High-severity vulns with an upgrade path',
      rationale: 'High-severity advisories with a published fixed version.',
      recommendation: 'Schedule upgrades within the next sprint.',
      affected: highActionable,
    });
  }

  const mediumVulns = [
    ...(buckets.get('medium|fix') ?? []),
    ...(buckets.get('medium|nofix') ?? []),
  ];
  if (mediumVulns.length > 0) {
    categories.push({
      priority: 'medium',
      id: 'medium-vulns',
      title: 'Medium-severity vulnerabilities',
      rationale: 'Medium-severity advisories. Plan into routine dep maintenance.',
      recommendation:
        'Batch into a recurring "dependency upgrade week" cadence. ' +
        'Watch for severity bumps — OSV/CVSS revisions can promote ' +
        'these into the high bucket.',
      affected: mediumVulns,
    });
  }

  const lowVulns = [...(buckets.get('low|fix') ?? []), ...(buckets.get('low|nofix') ?? [])];
  if (lowVulns.length > 0) {
    categories.push({
      priority: 'low',
      id: 'low-vulns',
      title: 'Low-severity vulnerabilities',
      rationale: 'Low-severity advisories. Track but not blocking.',
      recommendation: 'Bundle into routine maintenance; no urgency.',
      affected: lowVulns,
    });
  }

  const vulnOnly = report.entries.filter((e) => !e.joinedFromBoth);
  if (vulnOnly.length > 0) {
    categories.push({
      priority: 'medium',
      id: 'vuln-only-license-gap',
      title: 'License-scanner gap (vuln-only entries)',
      rationale:
        'These packages were reported by a vulnerability scanner but ' +
        'not by the license scanner. The license is shown as UNKNOWN; ' +
        'the most likely cause is a workspace / sub-package the license ' +
        'tool did not traverse.',
      recommendation:
        'Verify the licenses manually before shipping. If the package ' +
        'lives in a workspace, surface it in the root manifest or use ' +
        'the workspace-aware license tool flag.',
      affected: vulnOnly,
    });
  }

  return { ...report, riskCategories: categories };
}

const SEV_LABEL: Record<BomSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

export function formatBomDetailedMarkdown(detailed: BomDetailedReport, elapsed: string): string {
  const L: string[] = [];
  const s = detailed.summary;

  L.push('# Bill of Materials (BOM) — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch} (${detailed.commitSha})`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push('---');
  L.push('');

  L.push('## Summary');
  L.push('');
  L.push(`- **Total packages:** ${s.totalPackages}`);
  L.push(`- **Vulnerable packages:** ${s.vulnerablePackages}`);
  L.push(`- **Total advisories:** ${s.totalAdvisories} (one package can have many)`);
  L.push(`- **Actionable upgrades (Tier-1 proposals):** ${s.actionableVulns}`);
  if (s.vulnOnlyPackages > 0) {
    L.push(`- **Vuln-only entries (license gap):** ${s.vulnOnlyPackages}`);
  }
  L.push('');
  L.push(
    `> Reconciles with \`vyuh-dxkit vulnerabilities\`: that command counts ` +
      `per-advisory (${s.totalAdvisories}); bom collapses per-package ` +
      `(${s.vulnerablePackages}) so each xlsx row is one upgrade decision.`,
  );
  L.push('');
  L.push('---');
  L.push('');

  L.push('## Risk Review');
  L.push('');
  if (detailed.riskCategories.length === 0) {
    L.push('No vulnerable packages — nothing to triage.');
  } else {
    for (const cat of detailed.riskCategories) {
      L.push(`### ${SEV_LABEL[cat.priority]}: ${cat.title} (${cat.affected.length})`);
      L.push('');
      L.push(`**Why this matters:** ${cat.rationale}`);
      L.push('');
      L.push(`**Recommendation:** ${cat.recommendation}`);
      L.push('');
      L.push('| Package@Version | License | # Vulns | Resolution |');
      L.push('|-----------------|---------|--------:|------------|');
      for (const e of cat.affected) {
        const advice = e.upgradeAdvice.replace(/\|/g, '\\|');
        L.push(
          `| \`${e.package}@${e.version}\` | ${e.licenseType} | ${e.vulns.length} | ${advice} |`,
        );
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // Per-advisory inventory across every vuln in every entry. Lets the
  // reader drill from "this package has 3 vulns" up to the actual CVE
  // ids without leaving the markdown.
  L.push('## Per-Advisory Inventory');
  L.push('');
  const SEV_RANK: Record<BomSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const flat = detailed.entries
    .filter((e) => e.vulns.length > 0)
    .flatMap((e) =>
      e.vulns.map((v) => ({
        severity: v.severity,
        package: e.package,
        version: e.version,
        id: v.id,
        fixedVersion: v.fixedVersion,
        cvssScore: v.cvssScore,
        tool: v.tool,
        summary: v.summary,
      })),
    )
    .sort(
      (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.package.localeCompare(b.package),
    );

  if (flat.length === 0) {
    L.push('No vulnerabilities — empty inventory.');
  } else {
    L.push(`${flat.length} advisories total.`);
    L.push('');
    L.push('| Severity | Package@Version | ID | Fix | CVSS | Tool | Summary |');
    L.push('|----------|-----------------|----|-----|-----:|------|---------|');
    for (const v of flat) {
      const summary = (v.summary || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 100);
      const cvss = v.cvssScore !== undefined ? v.cvssScore.toFixed(1) : '—';
      L.push(
        `| ${SEV_LABEL[v.severity]} | \`${v.package}@${v.version}\` | \`${v.id}\` | ${v.fixedVersion ?? '—'} | ${cvss} | ${v.tool} | ${summary} |`,
      );
    }
  }
  L.push('');
  L.push('---');
  L.push('');

  L.push(`**Tools used:** ${detailed.toolsUsed.join(', ') || '(none)'}`);
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push(
    '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) — detailed mode*',
  );
  return L.join('\n');
}
