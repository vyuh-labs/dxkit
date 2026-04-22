/**
 * XLSX converter entry point.
 *
 * Reads a dxkit JSON report (licenses today; bom in Phase 10h.3) and
 * renders the 15-column BOM-format XLSX the customer's workflow expects.
 * Shape detection is lightweight — we look at the top-level fields — so
 * the CLI's `vyuh-dxkit to-xlsx <json-file>` can route without being
 * told which analyzer produced the input.
 */

import type { LicensesReport } from '../licenses/types';

export { toLicensesXlsx, BOM_COLUMNS } from './licenses';

/**
 * Detect which analyzer produced a JSON report. Based on structural
 * shape rather than a type tag — the LicensesReport schema doesn't
 * carry an analyzer-id today and adding one would be a schema bump.
 * bomReport will add its own detection path in Phase 10h.3.
 */
export type ReportKind = 'licenses' | 'unknown';

export function detectReportKind(data: unknown): ReportKind {
  if (!data || typeof data !== 'object') return 'unknown';
  const r = data as Record<string, unknown>;
  // LicensesReport has `findings: LicenseFinding[]` where each carries
  // a licenseType; unique enough to distinguish from any other report
  // shape dxkit emits today.
  if (!Array.isArray(r.findings)) return 'unknown';
  const sample = r.findings[0] as Record<string, unknown> | undefined;
  if (sample && typeof sample.licenseType === 'string') return 'licenses';
  return 'unknown';
}

/**
 * Render any supported dxkit JSON report as an XLSX buffer. Throws if
 * the input shape isn't recognised so the CLI can surface the error
 * to the user rather than producing garbage output.
 */
export async function toXlsx(data: unknown): Promise<Buffer> {
  const kind = detectReportKind(data);
  if (kind === 'licenses') {
    const { toLicensesXlsx } = await import('./licenses');
    return toLicensesXlsx(data as LicensesReport);
  }
  throw new Error(
    'Unrecognised report shape. Supported inputs: licenses (vyuh-dxkit licenses --detailed).',
  );
}
