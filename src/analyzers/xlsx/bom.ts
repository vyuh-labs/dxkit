/**
 * XLSX converter — bom report.
 *
 * Same 15-column header as the licenses converter (10h.2.3) so the
 * file is a drop-in replacement for the customer's hand-built sheet,
 * but cols 11/12/13 are now mechanically populated from the joined
 * dep-vuln data:
 *   - col 11 "Criticality of usage of this version" — max severity
 *     across the package's advisories ("Critical (3 vulns)") or
 *     blank when no known vulns.
 *   - col 12 "Vulnerability Issues" — semicolon-joined advisory list
 *     ("GHSA-XXXX: title; CVE-YYYY: title; ..."). Truncated per
 *     advisory to keep the cell readable.
 *   - col 13 "Resolution" — the bom entry's `upgradeAdvice` (Tier-1
 *     "PROPOSAL: Upgrade to ..." or "No fix available — ...").
 *
 * Cols 1-10, 14, 15 mirror the licenses converter exactly so any
 * downstream Excel formulas referencing those columns stay valid.
 */

import ExcelJS from 'exceljs';

import type { BomReport, BomSeverity } from '../bom/types';
import { BOM_COLUMNS } from './licenses';

/** Excel's hard per-cell character limit. Some advisory summaries
 *  (e.g. octokit ReDoS write-ups) blow past this when concatenated
 *  across 5+ vulns on the same package. */
const EXCEL_CELL_MAX = 32767;

/** Per-advisory truncation in col 12 — keeps the joined cell readable
 *  and well under the per-cell limit even on packages with 10+ vulns. */
const ADVISORY_SUMMARY_MAX = 200;

/** Same control-char + length scrub as licenses.ts. Inlined rather
 *  than exported because the rule lives at the xlsx-write boundary,
 *  not as a general-purpose utility. */
function xlsxSafe(v: string | undefined): string {
  if (!v) return '';
  let s = '';
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    s += v[i];
  }
  if (s.length > EXCEL_CELL_MAX) {
    const suffix = '\n\n... [truncated for XLSX cell limit; see JSON report for full text]';
    s = s.slice(0, EXCEL_CELL_MAX - suffix.length) + suffix;
  }
  return s;
}

const SEV_LABEL: Record<BomSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/**
 * Render a `BomReport` as an XLSX workbook and return the serialized
 * bytes. Sort matches the licenses converter (alphabetical by package)
 * for diff-stable output across runs.
 */
export async function toBomXlsx(report: BomReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'vyuh-dxkit';
  wb.created = new Date(report.analyzedAt);

  const ws = wb.addWorksheet('platform');
  ws.addRow(BOM_COLUMNS as string[]);
  ws.getRow(1).font = { bold: true };

  const reportDate = report.analyzedAt.slice(0, 10);
  const rows = [...report.entries].sort((a, b) => a.package.localeCompare(b.package));

  // Non-vulnerable rows still need a signal in cols 11/12/13 so a reviewer
  // can distinguish "scanned, clean" from "not scanned / unknown". Blank
  // leaves the same ambiguity the customer's hand-built sheet had.
  const NO_VULNS_CRITICALITY = 'None';
  const NO_VULNS_ISSUES = 'None';
  const NO_VULNS_RESOLUTION = 'No action required';

  for (const e of rows) {
    // col 11: severity badge + count, e.g. "Critical (3 vulns)".
    const criticality = e.maxSeverity
      ? `${SEV_LABEL[e.maxSeverity]} (${e.vulns.length} vuln${e.vulns.length === 1 ? '' : 's'})`
      : NO_VULNS_CRITICALITY;

    // col 12: per-advisory list. "ID: summary" with summary truncated
    // per entry. Sorted by severity within the package so the most
    // serious issues appear first when the cell is rendered.
    const SEV_RANK: Record<BomSeverity, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    const sortedVulns = [...e.vulns].sort(
      (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.id.localeCompare(b.id),
    );
    const vulnLines = sortedVulns.map((v) => {
      const title = (v.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, ADVISORY_SUMMARY_MAX);
      const cvss = v.cvssScore !== undefined ? ` [CVSS ${v.cvssScore.toFixed(1)}]` : '';
      // Top-level attribution: tells the reviewer which direct manifest
      // dep to upgrade. Missing when the pack couldn't parse the graph
      // (e.g. TS repo with no lockfile) — silent in that case so the
      // column stays clean.
      const tops = v.topLevelDep ?? [];
      let via = '';
      if (tops.length === 1) via = ` via ${tops[0]}`;
      else if (tops.length > 1) via = ` via ${tops[0]} (+${tops.length - 1} more)`;
      return title ? `${v.id}${cvss}${via}: ${title}` : `${v.id}${cvss}${via}`;
    });
    const vulnerabilityIssues = e.vulns.length === 0 ? NO_VULNS_ISSUES : vulnLines.join('; ');
    const resolution = e.vulns.length === 0 ? NO_VULNS_RESOLUTION : e.upgradeAdvice;

    ws.addRow([
      xlsxSafe(e.package), // col 1
      xlsxSafe(e.version), // col 2
      xlsxSafe(e.description), // col 3
      'Dependency', // col 4 — static
      `Reported ${reportDate}`, // col 5 — freshness stamp
      xlsxSafe(e.sourceUrl), // col 6
      xlsxSafe(e.licenseType), // col 7
      xlsxSafe(e.licenseText), // col 8
      xlsxSafe(e.supplier), // col 9
      xlsxSafe(e.releaseDate), // col 10 — deferred (needs npm registry
      //   enrichment; belongs in 10h.6 OSS enrichment phase)
      xlsxSafe(criticality), // col 11 — bom-only
      xlsxSafe(vulnerabilityIssues), // col 12 — bom-only
      xlsxSafe(resolution), // col 13 — bom-only
      '', // col 14 — intentionally blank (human workflow: OK/Pending/etc)
      `${e.package}@${e.version}`, // col 15
    ]);
  }

  // Same widths as the licenses converter — preserves visual fidelity
  // when reviewers diff a licenses-only sheet against a bom sheet.
  const widths = [30, 14, 50, 14, 18, 50, 18, 50, 24, 18, 22, 50, 40, 12, 40];
  ws.columns.forEach((col, i) => {
    if (col && widths[i]) col.width = widths[i];
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
