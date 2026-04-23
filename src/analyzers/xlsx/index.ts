/**
 * XLSX converter entry point.
 *
 * Reads a dxkit JSON report (licenses or bom) and renders the
 * 15-column BOM-format XLSX the customer's workflow expects. Shape
 * detection is lightweight — top-level fields only — so the CLI's
 * `vyuh-dxkit to-xlsx <json-file>` can route without being told
 * which analyzer produced the input.
 */

import type { BomReport } from '../bom/types';
import type { LicensesReport } from '../licenses/types';

export { toLicensesXlsx, BOM_COLUMNS } from './licenses';
export { toBomXlsx } from './bom';

/**
 * Detect which analyzer produced a JSON report. Based on structural
 * shape rather than a type tag — neither LicensesReport nor BomReport
 * carries an analyzer-id today and adding one would be a schema bump.
 * The `entries` field is BomReport-specific (LicensesReport calls its
 * package list `findings`), so it's the cleanest discriminator.
 */
export type ReportKind = 'licenses' | 'bom' | 'unknown';

export function detectReportKind(data: unknown): ReportKind {
  if (!data || typeof data !== 'object') return 'unknown';
  const r = data as Record<string, unknown>;

  // BomReport: { entries: BomEntry[] } where each entry has both
  // `licenseType` (license-side) AND `vulns` (vuln-side). The vulns
  // field is the unique discriminator vs licenses.
  if (Array.isArray(r.entries)) {
    const sample = r.entries[0] as Record<string, unknown> | undefined;
    if (sample && typeof sample.licenseType === 'string' && Array.isArray(sample.vulns)) {
      return 'bom';
    }
  }

  // LicensesReport: { findings: LicenseFinding[] } where each finding
  // carries `licenseType` but NO `vulns` field.
  if (Array.isArray(r.findings)) {
    const sample = r.findings[0] as Record<string, unknown> | undefined;
    if (sample && typeof sample.licenseType === 'string') return 'licenses';
  }
  return 'unknown';
}

/**
 * Render any supported dxkit JSON report as an XLSX buffer. Throws if
 * the input shape isn't recognised so the CLI can surface the error
 * to the user rather than producing garbage output.
 */
export async function toXlsx(data: unknown): Promise<Buffer> {
  const kind = detectReportKind(data);
  if (kind === 'bom') {
    const { toBomXlsx } = await import('./bom');
    return toBomXlsx(data as BomReport);
  }
  if (kind === 'licenses') {
    const { toLicensesXlsx } = await import('./licenses');
    return toLicensesXlsx(data as LicensesReport);
  }
  throw new Error(
    'Unrecognised report shape. Supported inputs: licenses (vyuh-dxkit licenses --detailed) or bom (vyuh-dxkit bom --detailed).',
  );
}
