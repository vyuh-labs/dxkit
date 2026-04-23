/**
 * BOM (Bill of Materials) analyzer — public API.
 *
 * Joins the LICENSES and DEP_VULNS capabilities by `package@version`
 * to produce one row per installed package with both license inventory
 * data (cols 1-9, 15) and per-package vulnerability rollup
 * (cols 11-13). Output formats:
 *
 *   - `formatBomReport(report)` — markdown summary for
 *     `.ai/reports/bom-<date>.md` and PR comments.
 *   - JSON via the CLI's `--json` flag (10h.3.9) — schema-versioned
 *     pass-through with the added summary + repo metadata.
 *   - XLSX via the shared converter (10h.3.9) — drop-in replacement
 *     for the customer's spreadsheet workflow with cols 11-13 filled.
 */

import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { gatherBomEntries } from './gather';
import type { BomEntry, BomReport, BomSeverity } from './types';

export type { BomReport, BomEntry } from './types';

export interface AnalyzeBomOptions {
  verbose?: boolean;
}

export async function analyzeBom(
  repoPath: string,
  _options: AnalyzeBomOptions = {},
): Promise<BomReport> {
  const stack = detect(repoPath);
  const { entries, toolsUsed, toolsUnavailable } = await gatherBomEntries(repoPath);

  const bySeverity: Record<BomSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let vulnerablePackages = 0;
  let actionableVulns = 0;
  let vulnOnlyPackages = 0;
  for (const e of entries) {
    if (e.maxSeverity) {
      bySeverity[e.maxSeverity]++;
      vulnerablePackages++;
      if (e.upgradeAdvice.startsWith('PROPOSAL:')) actionableVulns++;
    }
    if (!e.joinedFromBoth) vulnOnlyPackages++;
  }

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    schemaVersion: '1',
    summary: {
      totalPackages: entries.length,
      bySeverity,
      vulnerablePackages,
      actionableVulns,
      vulnOnlyPackages,
    },
    entries,
    toolsUsed,
    toolsUnavailable,
  };
}

const SEV_BADGE: Record<BomSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

export function formatBomReport(report: BomReport, elapsed: string): string {
  const L: string[] = [];

  L.push('# Bill of Materials (BOM) Report');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push('');
  L.push('---');
  L.push('');

  // Summary
  const s = report.summary;
  L.push('## Summary');
  L.push('');
  L.push(
    `**${s.totalPackages} packages** indexed across the active language pack(s). ` +
      `**${s.vulnerablePackages}** have known vulnerabilities; ` +
      `**${s.actionableVulns}** of those have an upgrade-target proposal (Tier 1).`,
  );
  L.push('');
  if (s.vulnerablePackages > 0) {
    L.push('| Severity | Vulnerable Packages |');
    L.push('|----------|--------------------:|');
    L.push(`| CRITICAL | ${s.bySeverity.critical} |`);
    L.push(`| HIGH     | ${s.bySeverity.high} |`);
    L.push(`| MEDIUM   | ${s.bySeverity.medium} |`);
    L.push(`| LOW      | ${s.bySeverity.low} |`);
    L.push('');
  }
  if (s.vulnOnlyPackages > 0) {
    L.push(
      `> ⚠️ ${s.vulnOnlyPackages} package(s) reported only by the vulnerability scanner — ` +
        `the license scanner missed them (likely a workspace / sub-package). ` +
        `These rows show "UNKNOWN" license; verify manually before shipping.`,
    );
    L.push('');
  }
  L.push('---');
  L.push('');

  // Vulnerable packages section — worst-first, one row per package
  if (s.vulnerablePackages > 0) {
    L.push('## Vulnerable Packages');
    L.push('');
    L.push('Sorted by severity (worst-first), then alphabetical. ');
    L.push('Resolution column shows the Tier-1 derived upgrade target ');
    L.push('(or "No fix available" when an advisory has no published patch).');
    L.push('');
    const SEV_RANK: Record<BomSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const vuln: BomEntry[] = report.entries
      .filter((e) => e.maxSeverity)
      .sort(
        (a, b) =>
          SEV_RANK[a.maxSeverity!] - SEV_RANK[b.maxSeverity!] || a.package.localeCompare(b.package),
      );
    const cap = 50;
    const shown = vuln.slice(0, cap);
    L.push('| Severity | Package@Version | License | # Vulns | Resolution |');
    L.push('|----------|-----------------|---------|--------:|------------|');
    for (const e of shown) {
      const advice = e.upgradeAdvice.replace(/\|/g, '\\|');
      L.push(
        `| ${SEV_BADGE[e.maxSeverity!]} | \`${e.package}@${e.version}\` | ${e.licenseType} | ${e.vulns.length} | ${advice} |`,
      );
    }
    if (vuln.length > cap) {
      L.push('');
      L.push(
        `_Showing ${cap} of ${vuln.length} vulnerable packages. Run with \`--detailed\` for the full inventory + per-advisory CVE list._`,
      );
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Footer
  L.push(`**Tools used:** ${report.toolsUsed.join(', ') || '(none)'}`);
  if (report.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${report.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return L.join('\n');
}
