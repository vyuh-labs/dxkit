/**
 * Detailed security report — JSON schema + markdown formatter.
 */
import type { DepVulnFinding } from '../../languages/capabilities/types';
import { SecurityReport, SecurityFinding, Severity } from './types';
import { RankedAction, rank } from '../remediation';
import { buildSecurityActions, countsFromReport } from './actions';
import { SecurityCounts, scoreSecurityCounts } from './scoring';

export interface SecurityDetailedReport extends SecurityReport {
  schemaVersion: string;
  securityScore: number;
  actions: Array<RankedAction<SecurityCounts>>;
}

export function buildSecurityDetailed(report: SecurityReport): SecurityDetailedReport {
  const counts = countsFromReport(report);
  const actions = rank(buildSecurityActions(report), counts, scoreSecurityCounts);
  return {
    ...report,
    // v12 adds per-advisory dep-vuln detail under summary.dependencies.findings.
    schemaVersion: '12',
    securityScore: scoreSecurityCounts(counts).score,
    actions,
  };
}

const SEV_ORDER: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function formatSecurityDetailedMarkdown(
  detailed: SecurityDetailedReport,
  elapsed: string,
): string {
  const L: string[] = [];
  const s = detailed.summary.findings;
  const d = detailed.summary.dependencies;

  L.push('# Vulnerability Scan — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch} (${detailed.commitSha})`);
  L.push(`**Security Score:** ${detailed.securityScore}/100`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push('---');
  L.push('');

  // Summary — two independent axes (see formatSecurityReport in
  // index.ts for the same rationale). Code findings vs dependency
  // vulnerabilities are NOT summed naïvely; each has its own
  // remediation owner (your team patches code, you upgrade deps).
  L.push('## Summary');
  L.push('');
  L.push('Two independent axes:');
  L.push('- **Code findings** — vulnerabilities in source your team owns. Fix by patching code.');
  L.push(
    '- **Dependency vulnerabilities** — vulnerabilities in third-party packages. Fix by upgrading the dep.',
  );
  L.push('');
  L.push(`**Code findings:** ${s.critical}C ${s.high}H ${s.medium}M ${s.low}L (${s.total} total)`);
  if (d.tool) {
    L.push(
      `**Dependency vulns:** ${d.critical}C ${d.high}H ${d.medium}M ${d.low}L (${d.total} total, via ${d.tool})`,
    );
    L.push('');
    L.push(`**Combined signals:** ${s.total + d.total} (${s.total} code + ${d.total} dependency)`);
  } else {
    L.push('**Dependency vulns:** no audit data');
    L.push('');
    L.push(`**Combined signals:** ${s.total} (code only)`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Ranked actions
  L.push('## Recommended Actions');
  L.push('');
  if (detailed.actions.length === 0) {
    L.push('No security findings — nothing to remediate.');
  } else {
    L.push('Actions are ranked by projected score improvement.');
    L.push('');
    L.push('| # | Action | Score Δ | Projected |');
    L.push('|---|--------|--------:|----------:|');
    detailed.actions.forEach((a, i) => {
      L.push(`| ${i + 1} | ${a.title} | +${a.scoreDelta} | ${a.projectedScore}/100 |`);
    });
    L.push('');
    for (const a of detailed.actions) {
      L.push(`### ${a.title} (+${a.scoreDelta})`);
      L.push('');
      L.push(`- **ID:** \`${a.id}\``);
      L.push(`- **Baseline:** ${a.baselineScore}/100`);
      L.push(`- **Projected:** ${a.projectedScore}/100`);
      if (a.rationale) L.push(`- **Why:** ${a.rationale}`);
      if (a.evidence.length) {
        L.push('- **Evidence:**');
        for (const e of a.evidence.slice(0, 20)) {
          const loc = e.line ? `:${e.line}` : '';
          L.push(`  - \`${e.file}${loc}\` — ${e.message || e.rule}`);
        }
        if (a.evidence.length > 20) {
          L.push(`  - … and ${a.evidence.length - 20} more`);
        }
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // Full findings inventory
  L.push('## Findings Inventory');
  L.push('');
  const sorted: SecurityFinding[] = [...detailed.findings].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || a.file.localeCompare(b.file),
  );
  if (sorted.length === 0) {
    L.push('No code findings.');
  } else {
    L.push('| Severity | Rule | File:Line | Tool | CWE |');
    L.push('|----------|------|-----------|------|-----|');
    for (const f of sorted) {
      L.push(
        `| ${f.severity.toUpperCase()} | \`${f.rule}\` | \`${f.file}${f.line ? ':' + f.line : ''}\` | ${f.tool} | ${f.cwe || '—'} |`,
      );
    }
  }
  L.push('');
  L.push('---');
  L.push('');

  // Dependencies
  if (d.tool) {
    L.push('## Dependency Vulnerabilities');
    L.push('');
    L.push(`Tool: ${d.tool}`);
    L.push('');
    L.push('| Severity | Count |');
    L.push('|----------|------:|');
    L.push(`| Critical | ${d.critical} |`);
    L.push(`| High     | ${d.high} |`);
    L.push(`| Medium   | ${d.medium} |`);
    L.push(`| Low      | ${d.low} |`);
    L.push(`| **Total** | **${d.total}** |`);
    L.push('');
    if (d.findings.length > 0) {
      // Per-advisory inventory. Sorted by (severity, package, id) so the
      // table reads top-down from worst-first within each pack's output.
      const sortedDeps: DepVulnFinding[] = [...d.findings].sort(
        (a, b) =>
          SEV_ORDER[a.severity] - SEV_ORDER[b.severity] ||
          a.package.localeCompare(b.package) ||
          a.id.localeCompare(b.id),
      );
      L.push(`Per-advisory detail (${sortedDeps.length} findings):`);
      L.push('');
      L.push('| Severity | ID | Package | Installed | Fixed | CVSS | EPSS | Tool |');
      L.push('|----------|----|---------|-----------|-------|-----:|-----:|------|');
      for (const f of sortedDeps) {
        const cvss = f.cvssScore !== undefined ? f.cvssScore.toFixed(1) : '—';
        // EPSS rendered as a percentage (probability of exploitation in
        // the next 30 days per FIRST.org). Dash when no CVE alias was
        // scoreable or the EPSS dataset hasn't caught up to this CVE yet.
        const epss = typeof f.epssScore === 'number' ? `${(f.epssScore * 100).toFixed(2)}%` : '—';
        L.push(
          `| ${f.severity.toUpperCase()} | \`${f.id}\` | \`${f.package}\` | ${f.installedVersion ?? '—'} | ${f.fixedVersion ?? '—'} | ${cvss} | ${epss} | ${f.tool} |`,
        );
      }
      L.push('');
    }
    L.push('---');
    L.push('');
  }

  L.push(`**Tools used:** ${detailed.toolsUsed.join(', ')}`);
  if (detailed.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${detailed.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push(
    '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) — detailed mode*',
  );
  return L.join('\n');
}
