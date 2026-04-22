/**
 * XLSX converter — licenses report.
 *
 * Produces the 15-column spreadsheet format the customer uses today as
 * their BOM artifact (Phase 10h benchmark: userserver-dependencies2.xlsx
 * "platform" tab). Header text is byte-identical to the reference sheet,
 * including the quirky `"Component  Name"` double-space and
 * `"Component version "` trailing-space.
 *
 * Drop-in replacement: a reviewer who previously received the hand-built
 * sheet can open a dxkit-generated one and see the same column layout,
 * now with up to 10 columns mechanically populated (vs the customer's
 * current 7). The remaining 5 columns are either vulnerability-derived
 * (11, 12, 13 — filled by `vyuh-dxkit bom`, Phase 10h.3) or human
 * workflow state (5, 14).
 *
 * Status column (5) auto-fills with `"Reported YYYY-MM-DD"` from
 * `report.analyzedAt` — a freshness stamp the reviewer overwrites when
 * they make a fix/accept decision. Strictly additive over the customer's
 * current sheet, which leaves col 5 blank.
 */

import ExcelJS from 'exceljs';

import type { LicensesReport } from '../licenses/types';

/** Excel's hard per-cell character limit; longer strings trigger a
 * "file needs repair" dialog on open even though the data is preserved.
 * Some license texts (vite ships ~162 KB of bundled licenses) blow past
 * this easily. */
const EXCEL_CELL_MAX = 32767;

/**
 * Scrub + bound a string for safe XLSX cell placement. XML 1.0 bans C0
 * control chars (0x00-0x1F) except TAB / LF / CR; license-checker's
 * inlined file reads can surface NUL or other control bytes from
 * non-UTF-8 license sources, and Excel refuses to open a sheet
 * containing them (triggering the "file needs repair" recovery dialog).
 * Per-char filter avoids a literal-control-char regex (trips ESLint's
 * no-control-regex / no-irregular-whitespace rules). Truncation uses a
 * visible suffix pointing at the JSON report for full content. Empty /
 * undefined inputs return an empty string so `addRow` doesn't emit
 * `undefined`.
 */
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

/**
 * The 15 canonical column headers in benchmark order. Text is preserved
 * byte-identically (note `"Component  Name"` has two spaces and
 * `"Component version "` has a trailing space). Downstream Excel
 * formulas the customer may have referencing these headers stay valid.
 */
export const BOM_COLUMNS: ReadonlyArray<string> = [
  'Component  Name',
  'Component version ',
  'Description',
  'Component Type',
  'Status',
  'Source URL',
  'License Type',
  'License Information',
  'Supplier Name',
  'Component Release Date',
  'Criticality of usage of this version',
  'Vulnerability Issues',
  'Resolution',
  'Checklist',
  'Unique Identifier',
];

/**
 * Render a `LicensesReport` as an XLSX workbook and return the serialized
 * bytes. Sort is alphabetical by package so repeat runs produce
 * diff-stable output.
 *
 * The return type is `Buffer` for consumers (CLI's writeFileSync).
 * exceljs's `writeBuffer` returns `ArrayBuffer`-ish; wrap in
 * `Buffer.from` at the boundary.
 */
export async function toLicensesXlsx(report: LicensesReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'vyuh-dxkit';
  wb.created = new Date(report.analyzedAt);

  // Sheet name matches the benchmark's primary tab for drop-in fidelity;
  // length limit is 31 chars per Excel spec so any project-name prefix
  // would risk truncation — plain 'platform' is safe and explicit.
  const ws = wb.addWorksheet('platform');

  // Write headers as a plain row rather than `columns = [{header, key}]`:
  // exceljs normalises leading/trailing whitespace in the {header} form,
  // which would eat the benchmark's `"Component  Name"` (two-space) and
  // `"Component version "` (trailing-space) quirks. addRow preserves the
  // raw byte sequence.
  ws.addRow(BOM_COLUMNS as string[]);
  ws.getRow(1).font = { bold: true };

  const reportDate = report.analyzedAt.slice(0, 10);
  const rows = [...report.findings].sort((a, b) => a.package.localeCompare(b.package));

  for (const f of rows) {
    ws.addRow([
      xlsxSafe(f.package), // col 1
      xlsxSafe(f.version), // col 2
      xlsxSafe(f.description), // col 3
      'Dependency', // col 4 — static
      `Reported ${reportDate}`, // col 5 — freshness stamp
      xlsxSafe(f.sourceUrl), // col 6
      xlsxSafe(f.licenseType), // col 7
      xlsxSafe(f.licenseText), // col 8 — usually the longest field
      xlsxSafe(f.supplier), // col 9
      '', // col 10 — release date (deferred)
      '', // col 11 — criticality (bom only)
      '', // col 12 — vulnerability issues (bom only)
      '', // col 13 — resolution (bom only)
      '', // col 14 — checklist (human)
      `${f.package}@${f.version}`, // col 15
    ]);
  }

  // Sensible column widths: package/version narrow, description/license text wide.
  const widths = [30, 14, 50, 14, 18, 50, 18, 50, 24, 18, 22, 22, 22, 12, 40];
  ws.columns.forEach((col, i) => {
    if (col && widths[i]) col.width = widths[i];
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
