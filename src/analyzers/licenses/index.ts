/**
 * Licenses analyzer — public API.
 *
 * Produces a per-package license inventory by dispatching the LICENSES
 * capability across every active language pack. Output formats:
 *
 *   - `formatLicensesMarkdown(report)` — table markdown for
 *     `.dxkit/reports/licenses-<date>.md` and PR comments.
 *   - JSON via the CLI's `--json` flag — envelope pass-through with
 *     the added summary + repo metadata.
 *   - XLSX — 15-column drop-in for the customer's spreadsheet
 *     workflow; lands in Phase 10h.2.2 via `exceljs`.
 */

import * as path from 'path';
import { detect } from '../../detect';
import { run } from '../tools/runner';
import { gatherLicensesWithAvailability } from './gather';
import type { LicensesReport } from './types';

export type { LicensesReport } from './types';

export interface AnalyzeLicensesOptions {
  verbose?: boolean;
}

export async function analyzeLicenses(
  repoPath: string,
  _options: AnalyzeLicensesOptions = {},
): Promise<LicensesReport> {
  const stack = detect(repoPath);
  const { envelope, available, unavailableReason } = await gatherLicensesWithAvailability(repoPath);

  const findings = envelope?.findings ?? [];
  const byLicense: Record<string, number> = {};
  let unknownCount = 0;
  for (const f of findings) {
    byLicense[f.licenseType] = (byLicense[f.licenseType] ?? 0) + 1;
    if (f.licenseType === 'UNKNOWN' || f.licenseType.length === 0) unknownCount++;
  }

  const toolsUsed = envelope ? envelope.tool.split(', ').filter((t) => t.length > 0) : [];
  // D031-2: degraded-inventory detection. When a pack falls back to
  // direct manifest parsing (e.g., csharp's `csharp-package-reference-
  // degraded`), the envelope IS populated with real packages but the
  // canonical license tool wasn't actually consulted. The standalone
  // vuln-scan-style ⚠ banner should fire here too so the customer
  // understands "0 known licenses" doesn't mean "no licenses to know."
  const isDegraded = toolsUsed.some((t) => t.endsWith('-degraded'));
  const effectiveAvailable = available && !isDegraded;
  const effectiveReason = isDegraded
    ? `canonical license-inventory tool unavailable; showing degraded fallback from manifest parsing (license types all 'UNKNOWN' until the proper tool is installed)`
    : unavailableReason;
  // toolsUnavailable surfaces the generic label so consumers don't
  // have to map pack→tool. Distinct list when the gather genuinely
  // produced nothing vs degraded-with-real-data: both cases warrant
  // the banner, neither is "all clear."
  const toolsUnavailable: string[] = effectiveAvailable ? [] : ['license-inventory'];

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    schemaVersion: '1',
    summary: {
      totalPackages: findings.length,
      byLicense,
      unknownCount,
    },
    findings,
    toolsUsed,
    toolsUnavailable,
    availability: { available: effectiveAvailable, unavailableReason: effectiveReason },
  };
}

export function formatLicensesReport(report: LicensesReport, elapsed: string): string {
  const L: string[] = [];

  L.push('# License Inventory Report');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push('');
  L.push('---');
  L.push('');

  // Summary
  L.push('## Summary');
  L.push('');
  L.push(
    `**${report.summary.totalPackages} packages** across ${Object.keys(report.summary.byLicense).length} distinct license types.`,
  );
  // D031 (2.4.7): when at least one active pack reported unavailable,
  // surface the explanatory ⚠ banner BEFORE the unknown-license caveat
  // so customers don't misread the "0 packages" / partial counts as
  // "we scanned cleanly and found nothing."
  if (report.availability && !report.availability.available) {
    L.push('');
    L.push(`> ⚠ **License extraction unavailable**: ${report.availability.unavailableReason}.`);
    L.push(`>`);
    L.push(
      `> The license-inventory tool didn't run cleanly on this repo. ${report.summary.totalPackages > 0 ? `The ${report.summary.totalPackages} package(s) below come from a degraded-inventory fallback (name+version from manifest parsing only — license type is \`UNKNOWN\` until the canonical tool is installed).` : 'No packages were inventoried; install the appropriate license tool (e.g. `nuget-license` for csharp, `license-checker-rseidelsohn` for typescript, `pip-licenses` for python, `go-licenses` for go, `cargo-license` for rust) and re-run.'}`,
    );
    L.push('');
  }
  if (report.summary.unknownCount > 0) {
    L.push('');
    L.push(
      `> ⚠️ ${report.summary.unknownCount} package(s) have no detected license — review before shipping.`,
    );
  }
  L.push('');

  // Breakdown by license
  L.push('## License Distribution');
  L.push('');
  L.push('| License | Count |');
  L.push('|---------|-------|');
  const sorted = Object.entries(report.summary.byLicense).sort((a, b) => b[1] - a[1]);
  for (const [lic, count] of sorted) {
    L.push(`| ${lic} | ${count} |`);
  }
  L.push('');
  L.push('---');
  L.push('');

  // Findings table — capped at 50 rows for readability; full list in *-detailed.md
  L.push('## Packages');
  L.push('');
  if (report.findings.length === 0) {
    L.push(
      '_No packages detected. Ensure the project has a resolved dependency tree (e.g. `npm install`, `pip install`, `go mod download`, `cargo build`, `dotnet restore`) before running this analyzer._',
    );
  } else {
    const cap = 50;
    // Sort top-level packages first, then alphabetical — same ordering
    // bom uses so readers comparing the two reports see the same "direct
    // dep" set at the top.
    const rows = [...report.findings].sort((a, b) => {
      const topA = a.isTopLevel === true ? 0 : 1;
      const topB = b.isTopLevel === true ? 0 : 1;
      if (topA !== topB) return topA - topB;
      return a.package.localeCompare(b.package);
    });
    const shown = rows.slice(0, cap);
    // Direct column is the "⭐ fix here first" signal from 10h.5.0;
    // Released column surfaces the npm-registry date (10h.5.1 / D006).
    L.push('| Direct | Package | Version | License | Released | Description |');
    L.push('|:------:|---------|---------|---------|----------|-------------|');
    for (const f of shown) {
      const desc = (f.description || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 80);
      const released = f.releaseDate ? f.releaseDate.slice(0, 10) : '—';
      const direct = f.isTopLevel === true ? '⭐' : f.isTopLevel === false ? '' : '—';
      L.push(
        `| ${direct} | \`${f.package}\` | ${f.version} | ${f.licenseType} | ${released} | ${desc} |`,
      );
    }
    if (rows.length > cap) {
      L.push('');
      L.push(
        `_Showing ${cap} of ${rows.length} packages (top-level first, then alphabetical). ` +
          'Run with `--detailed` for full inventory + risk review.' +
          ` Direct column: ⭐ root manifest dep, blank transitive, — unknown (pack couldn't read lockfile).` +
          '_',
      );
    }
  }
  L.push('');
  L.push('---');
  L.push('');

  // Footer
  L.push(`**Tools used:** ${report.toolsUsed.join(', ') || '(none)'}`);
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return L.join('\n');
}
