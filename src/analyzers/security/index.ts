/**
 * Security analyzer — public API.
 */
import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { timed, timedAsync } from '../tools/timing';
import { gatherSecrets, gatherFileFindings, gatherCodePatterns, gatherDepVulns } from './gather';
import { SecurityReport, SecurityFinding, Severity } from './types';

export type { SecurityReport, SecurityFinding } from './types';

export interface AnalyzeSecurityOptions {
  verbose?: boolean;
}

function countBySeverity(findings: SecurityFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

export async function analyzeSecurity(
  repoPath: string,
  options: AnalyzeSecurityOptions = {},
): Promise<SecurityReport> {
  const verbose = !!options.verbose;
  const stack = detect(repoPath);
  const toolsUsed: string[] = ['find', 'git'];
  const toolsUnavailable: string[] = [];

  // 1. Secrets (gitleaks) — dispatcher-driven via the SECRETS capability.
  const secrets = await timedAsync('gitleaks', verbose, () => gatherSecrets(repoPath));
  if (secrets.toolUsed) toolsUsed.push(secrets.toolUsed);
  else toolsUnavailable.push('gitleaks');

  // 2. File findings (private keys, .env)
  const files = timed('file-findings', verbose, () => gatherFileFindings(repoPath));

  // 3. Code patterns (semgrep) — dispatcher-driven via CODE_PATTERNS.
  const code = await timedAsync('semgrep', verbose, () => gatherCodePatterns(repoPath));
  if (code.toolUsed) toolsUsed.push(code.toolUsed);
  else toolsUnavailable.push('semgrep');

  // 4. Dependency CVEs — capability dispatcher across every active language
  //    pack. The envelope's tool field already joins multiple sources
  //    ('pip-audit, npm-audit'); split it back out for toolsUsed.
  const deps = await timedAsync('dep-audit', verbose, () => gatherDepVulns(repoPath));
  if (deps.tool) {
    for (const t of deps.tool.split(', ')) toolsUsed.push(t);
  } else {
    toolsUnavailable.push('dep-audit');
  }

  const allFindings = [...secrets.findings, ...files, ...code.findings];
  const counts = countBySeverity(allFindings);

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    summary: {
      findings: { ...counts, total: allFindings.length },
      dependencies: deps,
    },
    findings: allFindings,
    toolsUsed,
    toolsUnavailable,
  };
}

export function formatSecurityReport(report: SecurityReport, elapsed: string): string {
  const L: string[] = [];
  L.push('# Vulnerability Scan Report');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push('');
  L.push('---');
  L.push('');

  // Executive summary
  const s = report.summary.findings;
  L.push('## Executive Summary');
  L.push('');
  L.push('| Severity | Count |');
  L.push('|----------|-------|');
  L.push(`| CRITICAL | ${s.critical} |`);
  L.push(`| HIGH     | ${s.high} |`);
  L.push(`| MEDIUM   | ${s.medium} |`);
  L.push(`| LOW      | ${s.low} |`);
  L.push(`| **Total** | **${s.total}** |`);
  L.push('');
  const d = report.summary.dependencies;
  if (d.tool) {
    L.push(
      `Dependency audit: ${d.critical}C ${d.high}H ${d.medium}M ${d.low}L (${d.total} total, via ${d.tool}).`,
    );
  }
  L.push('');
  L.push('---');
  L.push('');

  // Findings grouped by category. Section numbers are assigned dynamically —
  // empty categories are skipped entirely, so the rendered document never
  // jumps from "## 1. ..." to "## 4. ..." when middle sections have no
  // findings.
  const categories: Array<{ key: string; title: string }> = [
    { key: 'secret', title: 'Secrets & Credentials' },
    { key: 'code', title: 'Code Vulnerability Patterns' },
    { key: 'config', title: 'Configuration Issues' },
  ];
  const SORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

  let sectionNum = 1;
  for (const cat of categories) {
    const items = report.findings
      .filter((f) => f.category === cat.key)
      .sort((a, b) => SORDER[a.severity] - SORDER[b.severity]);
    if (items.length === 0) continue;

    L.push(`## ${sectionNum}. ${cat.title}`);
    L.push('');
    for (const f of items) {
      L.push(`### ${f.severity.toUpperCase()}: ${f.title}`);
      L.push(`- **File:** \`${f.file}${f.line ? ':' + f.line : ''}\``);
      if (f.cwe) L.push(`- **CWE:** ${f.cwe}`);
      L.push(`- **Tool:** ${f.tool} / ${f.rule}`);
      L.push('');
    }
    L.push('---');
    L.push('');
    sectionNum++;
  }

  // Dependencies
  if (d.tool) {
    L.push(`## ${sectionNum}. Dependency Vulnerabilities`);
    L.push('');
    L.push('| Severity | Count |');
    L.push('|----------|-------|');
    L.push(`| Critical | ${d.critical} |`);
    L.push(`| High     | ${d.high} |`);
    L.push(`| Medium   | ${d.medium} |`);
    L.push(`| Low      | ${d.low} |`);
    L.push(`| **Total** | **${d.total}** |`);
    L.push('');
    L.push('---');
    L.push('');
  }

  // Footer
  L.push(`**Tools used:** ${report.toolsUsed.join(', ')}`);
  if (report.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${report.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');
  return L.join('\n');
}
