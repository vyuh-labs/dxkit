/**
 * Security analyzer — public API.
 */
import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { timed, timedAsync } from '../tools/timing';
import {
  gatherSecrets,
  gatherFileFindings,
  gatherCodePatterns,
  gatherDepVulns,
  gatherTlsBypassFindings,
} from './gather';
import { DEP_VULNS_UNAVAILABLE_CAP } from './scoring';
import { SecurityReport } from './types';
import { buildSecurityAggregate } from './aggregator';
import { allTlsBypassPatterns, getLanguage } from '../../languages';
import type { LanguageId } from '../../types';

export type { SecurityReport, SecurityFinding } from './types';

export interface AnalyzeSecurityOptions {
  verbose?: boolean;
}

/**
 * G_v4_4 (2.4.7): build the "Remediation Commands" entry for one
 * dep-vuln finding by dispatching through the producing pack's
 * `LanguageSupport.upgradeCommand`. Replaces the pre-G_v4_4 switch on
 * `tool` (D062 — switch keyed on `osv-scanner-nuget-direct` but generic
 * osv-scanner findings carried `tool: 'osv-scanner'`, so dotnet-NuGet
 * advisories shipped as bare prose comments). Each pack now owns its
 * own template; non-pack code stays language-agnostic per CLAUDE.md
 * rule 6.
 *
 * Dispatch order:
 *   1. `f.packId` set → call pack's `upgradeCommand` (cardinal path).
 *   2. No `packId` (legacy / non-pack producers) → generic prose fallback.
 *   3. `upgradeCommand` returns `null` → generic prose fallback.
 *
 * No-fixedVersion case always falls back to the "no patched version
 * available" hint — the pack template needs a version to format
 * meaningfully.
 */
function buildUpgradeCommand(f: {
  tool?: string;
  packId?: LanguageId;
  package: string;
  fixedVersion?: string;
  installedVersion?: string;
}): string | null {
  if (!f.fixedVersion) {
    return `# ${f.package}: no patched version available — review references for mitigations`;
  }
  if (f.packId) {
    const pack = getLanguage(f.packId);
    if (pack && pack.upgradeCommand) {
      const cmd = pack.upgradeCommand(f.package, f.fixedVersion);
      if (cmd) return cmd;
    }
  }
  return `# Upgrade ${f.package} to ${f.fixedVersion} (source tool: ${f.tool ?? 'unknown'})`;
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

  // 5. TLS / certificate-validation bypass (D045 / D034) — per-pack
  //    registry-driven patterns. Complements semgrep's `p/security-audit`
  //    ruleset, which doesn't ship the per-language idioms each pack
  //    declares (csharp `ServerCertificateValidationCallback`, go
  //    `InsecureSkipVerify`, rust `danger_accept_invalid_certs`, etc.).
  const tlsBypass = timed('tls-bypass', verbose, () => gatherTlsBypassFindings(repoPath));
  if (tlsBypass.length > 0) toolsUsed.push('tls-bypass-registry');

  // C1.2 (G_v4_8 / 2.4.7 Phase C): aggregate every gathered envelope
  // into the canonical SecurityAggregate. Closes the D086/D087/D091
  // class — `aggregate.codeBySeverity` is the ONE code-finding count
  // surface (no consumer re-sums from arrays);
  // `aggregate.dependencyAdvisoryUniqueCount` is the canonical
  // user-facing dep-vuln total (matches BoM's existing
  // fingerprint-unique semantics, ending the 70 vs 81 same-page drift);
  // cross-tool TLS-bypass collapses to one CodeFinding via the
  // canonical-rule + line-window dedup.
  const aggregate = buildSecurityAggregate({
    secrets,
    fileFindings: files,
    codePatterns: code,
    tlsBypass,
    tlsBypassPatternCount: allTlsBypassPatterns().length,
    depVulns: {
      findings: deps.findings,
      tool: deps.tool,
      available: deps.available,
      unavailableReason: deps.unavailableReason,
    },
  });

  // Combined code-side severity counts for the existing "Code Findings"
  // table (which renders secrets+files+code+config under one heading).
  // Derived from the dedup'd aggregate, NOT from raw envelope arrays —
  // that's the D086/D091 closure. Sum of unique findings across the
  // code/secret/config categories.
  const codeFindings = [
    ...aggregate.findingsByCategory.secret,
    ...aggregate.findingsByCategory.code,
    ...aggregate.findingsByCategory.config,
  ];
  const codeSummary = {
    critical: aggregate.codeBySeverity.critical + aggregate.secretsBySeverity.critical,
    high: aggregate.codeBySeverity.high + aggregate.secretsBySeverity.high,
    medium: aggregate.codeBySeverity.medium + aggregate.secretsBySeverity.medium,
    low: aggregate.codeBySeverity.low + aggregate.secretsBySeverity.low,
    total: codeFindings.length,
  };

  // C2.1 (perception-D086 closure): code-only + secrets-only severity
  // breakdowns surfaced as siblings of `summary.findings`. Renderer
  // splits the executive-summary "Code Findings" table into two
  // labeled sections so a reader scanning health + vuln-scan sees
  // the SAME number under the SAME label.
  const codeOnlySummary = {
    critical: aggregate.codeBySeverity.critical,
    high: aggregate.codeBySeverity.high,
    medium: aggregate.codeBySeverity.medium,
    low: aggregate.codeBySeverity.low,
    total: aggregate.findingsByCategory.code.length,
  };
  const secretsOnlySummary = {
    critical: aggregate.secretsBySeverity.critical,
    high: aggregate.secretsBySeverity.high,
    medium: aggregate.secretsBySeverity.medium,
    low: aggregate.secretsBySeverity.low,
    total: aggregate.findingsByCategory.secret.length + aggregate.findingsByCategory.config.length,
  };

  // D087 closure: dependency totals now read the canonical
  // unique-by-fingerprint count from the aggregate, matching BoM's
  // semantics. critical/high/medium/low are derived from the unique
  // set, so the bucket sum always equals the unique total — no more
  // 70 vs 81 on the same page.
  const depSummary = {
    ...deps,
    critical: aggregate.depBySeverity.critical,
    high: aggregate.depBySeverity.high,
    medium: aggregate.depBySeverity.medium,
    low: aggregate.depBySeverity.low,
    total: aggregate.dependencyAdvisoryUniqueCount,
    findings: [...aggregate.findingsByCategory.dependency],
  };

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    summary: {
      findings: codeSummary,
      codeOnly: codeOnlySummary,
      secretsOnly: secretsOnlySummary,
      dependencies: depSummary,
    },
    findings: codeFindings,
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

  // C2.1 (perception D086 closure): three independent axes, each with
  // its own labeled table. Pre-C2.1 the executive summary had a single
  // "Code Findings" table that combined code+secret+config under one
  // label — health's "code findings" prose meant code-only, so the
  // two surfaces showed different numbers under the same name. Now
  // each surface reads its own named field and the labels match.
  const s = report.summary.findings;
  const c = report.summary.codeOnly;
  const k = report.summary.secretsOnly;
  const d = report.summary.dependencies;
  L.push('## Executive Summary');
  L.push('');
  L.push('Security signals split across three independent axes:');
  L.push(
    '- **Code findings** — code-pattern vulnerabilities your team owns (semgrep + TLS-bypass-registry). Fix by patching code.',
  );
  L.push(
    '- **Secret & config findings** — hardcoded secrets, private-key files, `.env` tracked in git. Fix by rotating + removing from history.',
  );
  L.push(
    '- **Dependency vulnerabilities** — vulnerabilities in third-party packages. Fix by upgrading the dep.',
  );
  L.push('');

  // Code-only severity table. Reads `summary.codeOnly` directly from
  // the canonical aggregator field `codeBySeverity`. Health's
  // `Xc Yh Zm Wl code findings` prose comes from the same field —
  // numbers match by construction.
  const codeSources = [
    ...new Set(report.findings.filter((f) => f.category === 'code').map((f) => f.tool)),
  ].sort();
  L.push('### Code Findings');
  L.push('');
  L.push(`_Sources: ${codeSources.join(', ') || '(none)'}_`);
  L.push('');
  L.push('| Severity | Count |');
  L.push('|----------|------:|');
  L.push(`| CRITICAL | ${c.critical} |`);
  L.push(`| HIGH     | ${c.high} |`);
  L.push(`| MEDIUM   | ${c.medium} |`);
  L.push(`| LOW      | ${c.low} |`);
  L.push(`| **Subtotal** | **${c.total}** |`);
  L.push('');

  // Secret + config severity table. Reads `summary.secretsOnly` from
  // the aggregator's `secretsBySeverity` axis.
  const secretSources = [
    ...new Set(
      report.findings
        .filter((f) => f.category === 'secret' || f.category === 'config')
        .map((f) => f.tool),
    ),
  ].sort();
  L.push('### Secret & Config Findings');
  L.push('');
  L.push(`_Sources: ${secretSources.join(', ') || '(none)'}_`);
  L.push('');
  L.push('| Severity | Count |');
  L.push('|----------|------:|');
  L.push(`| CRITICAL | ${k.critical} |`);
  L.push(`| HIGH     | ${k.high} |`);
  L.push(`| MEDIUM   | ${k.medium} |`);
  L.push(`| LOW      | ${k.low} |`);
  L.push(`| **Subtotal** | **${k.total}** |`);
  L.push('');

  L.push('### Dependency Vulnerabilities');
  L.push('');
  if (d.tool) {
    L.push(`_Source: ${d.tool}_`);
    L.push('');
    L.push('| Severity | Count |');
    L.push('|----------|------:|');
    L.push(`| CRITICAL | ${d.critical} |`);
    L.push(`| HIGH     | ${d.high} |`);
    L.push(`| MEDIUM   | ${d.medium} |`);
    L.push(`| LOW      | ${d.low} |`);
    L.push(`| **Subtotal** | **${d.total}** |`);
    L.push('');
    // D025e: if at least one pack scanned successfully (tool set) but
    // another active pack returned unavailable, the totals are partial.
    // Surface this rather than letting the customer assume the table is
    // exhaustive across their stack.
    if (!d.available) {
      L.push(`> ⚠ **Partial scan**: ${d.unavailableReason}. The table above`);
      L.push(`> reflects only the packs whose dep-vuln tooling succeeded;`);
      L.push(`> findings in the unscanned pack may be present but not listed.`);
      L.push('');
    }
    L.push(
      `**Total signals:** ${s.total + d.total} (${c.total} code + ${k.total} secret/config + ${d.total} dependency)`,
    );
  } else if (!d.available) {
    // D025e: scan was attempted but couldn't run for any active pack.
    // Pre-D025e this case shared the "no language pack with a depVulns
    // provider was active" string with the genuinely-inactive case — a
    // factually-wrong framing because pack WAS active, just blocked.
    L.push(`> ⚠ **Dependency vulnerability scan unavailable**: ${d.unavailableReason}.`);
    L.push(`>`);
    L.push(`> The dep-audit tool didn't run on this repo, so the count below`);
    L.push(`> is not "0 vulnerabilities found" — it's "0 vulnerabilities`);
    L.push(`> reported because the scan didn't complete." The Security`);
    L.push(
      `> dimension score is capped at ${DEP_VULNS_UNAVAILABLE_CAP}/100 until the underlying tool`,
    );
    L.push(`> becomes available or a fallback path produces real data.`);
    L.push('');
    L.push(`**Total signals:** ${s.total} (code only — dep-audit incomplete)`);
  } else {
    // D025e: genuinely-inactive case. No active language pack exposes a
    // depVulns provider — either the repo is non-code (docs/assets only)
    // or every active pack legitimately reported `no-manifest` (a
    // polyglot repo where the pack activates but has nothing to scan).
    L.push('_No dependency audit data — no active language pack reported a manifest to scan._');
    L.push('');
    L.push(`**Total signals:** ${s.total} (code only)`);
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

  // Dep-vuln per-package detail. Counts already appeared in the
  // Executive Summary; this section gives the actionable list (which
  // packages, which versions, which CVEs) so a reader can act without
  // bouncing to the --detailed report. Sorted by composite riskScore
  // desc so "this week's triage" sits at the top — matches bom's
  // triage ordering.
  if (d.tool && d.findings.length > 0) {
    L.push(`## ${sectionNum}. Dependency Vulnerabilities`);
    L.push('');
    L.push(
      `${d.findings.length} advisories across third-party packages (counts above), ` +
        'ranked by composite risk score (CVSS × KEV × EPSS × reachable).',
    );
    L.push('');
    const sorted = [...d.findings].sort((a, b) => {
      const ra = a.riskScore ?? -1;
      const rb = b.riskScore ?? -1;
      if (ra !== rb) return rb - ra;
      return SORDER[a.severity] - SORDER[b.severity] || a.package.localeCompare(b.package);
    });
    const cap = 50;
    const shown = sorted.slice(0, cap);
    L.push('| Risk | Severity | KEV | Reach | Package@Version | ID | Fix | EPSS | Tool |');
    L.push('|-----:|----------|:---:|:-----:|-----------------|----|-----|-----:|------|');
    for (const f of shown) {
      const risk = typeof f.riskScore === 'number' ? `**${f.riskScore.toFixed(0)}**` : '—';
      const kev = f.kev ? '⚠' : '';
      // D044 (2.4.7): three-state reachability rendering. Pre-D044
      // `reachable === false` rendered as a mid-dot `·` which customers
      // misread as "unknown/not-checked." Use ✓/✗/— for clarity and
      // pair with the legend below the table.
      const reach = f.reachable === true ? '✓' : f.reachable === false ? '✗' : '—';
      const epss = typeof f.epssScore === 'number' ? `${(f.epssScore * 100).toFixed(2)}%` : '—';
      L.push(
        `| ${risk} | ${f.severity.toUpperCase()} | ${kev} | ${reach} | \`${f.package}@${f.installedVersion ?? '?'}\` | \`${f.id}\` | ${f.fixedVersion ?? '—'} | ${epss} | ${f.tool} |`,
      );
    }
    if (sorted.length > cap) {
      L.push('');
      L.push(
        `_Showing ${cap} of ${sorted.length} advisories ranked by risk score. Run with \`--detailed\` for the full inventory + CVSS column._`,
      );
    }

    // D043 + D044 (2.4.7): column legends. Customers shouldn't have to
    // infer what `·` / `✓` / `**19**` mean. Brief explanations keep the
    // table interpretable without external docs.
    L.push('');
    L.push('**Column legend**:');
    L.push('');
    L.push(
      `- **Risk**: composite score combining CVSS base score, KEV-listing, EPSS exploitation probability, and source-code reachability. Higher is worse. Tiers (post-D023 / risk-score.ts): \`< 10\` deprioritized · \`10-25\` watch · \`25-50\` plan-and-patch · \`> 50\` patch-now.`,
    );
    L.push(
      `- **KEV**: \`⚠\` means the CVE appears in CISA's Known Exploited Vulnerabilities catalog (active in-the-wild exploitation). Blank = not-KEV (verified, not omitted).`,
    );
    L.push(
      `- **Reach**: \`✓\` = an active language-pack's imports capability found this package in source (reachable). \`✗\` = imports walked but this package is declared in manifest only, not imported in code. \`—\` = imports capability didn't run (no active pack, no source files, etc.) — unknown reachability.`,
    );
    L.push(
      `- **Fix**: minimum upgrade version that clears the advisory (extracted from OSV's \`affected.ranges.events.fixed\`). \`—\` = no patch released yet (consider mitigations) OR the source tool didn't surface fix info.`,
    );
    L.push(
      `- **EPSS**: probability the CVE is exploited within the next 30 days (FIRST.org's exploit-prediction scoring system). Blank/\`—\` = no EPSS data (typically GHSA without a CVE alias).`,
    );
    L.push('');
    L.push('---');
    L.push('');

    // 2.4.7: Remediation Commands section. For each advisory with a
    // fixedVersion, generate the ecosystem-specific install command so
    // the customer can copy-paste the patch. Findings without a known
    // remediation path (no fixedVersion, or unrecognized tool) are
    // listed with a `# (no patch / manual)` placeholder so they're
    // visible but distinct.
    const remediations = report.summary.dependencies.findings
      .map((f) => ({ finding: f, cmd: buildUpgradeCommand(f) }))
      .filter((r) => r.cmd !== null);
    if (remediations.length > 0) {
      L.push('## Remediation Commands');
      L.push('');
      L.push('Copy-paste to upgrade each vulnerable package (run from the project root):');
      L.push('');
      L.push('```bash');
      for (const r of remediations) {
        const f = r.finding;
        L.push(
          `# ${f.package}@${f.installedVersion ?? '?'} → ${f.fixedVersion ?? '(no patch)'} (${f.id})`,
        );
        L.push(r.cmd as string);
        L.push('');
      }
      L.push('```');
      L.push('');
      L.push('---');
      L.push('');
    }
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
