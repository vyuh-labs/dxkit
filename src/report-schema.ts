/**
 * Canonical schema banners for dxkit's machine-readable analyzer
 * reports. Every `--json` and `--detailed --json` payload carries a
 * top-level `schema` string so downstream consumers (AI agents, CI
 * runners, dashboards) version-gate before reading deeper fields.
 *
 * Schema-evolution contract: a backwards-compatible field addition
 * keeps the existing `vN` banner. A breaking field rename / removal
 * bumps to `v(N+1)`, and the bump is paired with a migration entry
 * in `CHANGELOG.md`. Today every analyzer emits `v1`; future
 * versions land in this map without consumers having to touch each
 * analyzer's emitter.
 *
 * Pure module: the helpers don't allocate beyond the returned
 * envelope.
 */

/**
 * Discriminator the schema-banner map keys off. Mirrors the dxkit
 * subcommand names that emit JSON. `quality` reports remain
 * fingerprint-stable even when re-rendered, so they share the same
 * banner across `--json` and `--detailed --json` paths.
 */
export type ReportKind =
  | 'health'
  | 'health-detailed'
  | 'vulnerabilities'
  | 'vulnerabilities-detailed'
  | 'test-gaps'
  | 'test-gaps-detailed'
  | 'quality'
  | 'quality-detailed'
  | 'licenses'
  | 'licenses-detailed'
  | 'bom'
  | 'bom-detailed'
  | 'dev-report'
  | 'dev-report-detailed';

/**
 * The canonical banner for each report kind. New analyzers extend
 * this map; consumers read `schema` and compare against the
 * constant they understand.
 */
export const REPORT_SCHEMAS: Readonly<Record<ReportKind, string>> = Object.freeze({
  health: 'dxkit.health-report.v1',
  'health-detailed': 'dxkit.health-detailed.v1',
  vulnerabilities: 'dxkit.vulnerability-report.v1',
  'vulnerabilities-detailed': 'dxkit.vulnerability-detailed.v1',
  'test-gaps': 'dxkit.test-gaps-report.v1',
  'test-gaps-detailed': 'dxkit.test-gaps-detailed.v1',
  quality: 'dxkit.quality-report.v1',
  'quality-detailed': 'dxkit.quality-detailed.v1',
  licenses: 'dxkit.licenses-report.v1',
  'licenses-detailed': 'dxkit.licenses-detailed.v1',
  bom: 'dxkit.bom.v1',
  'bom-detailed': 'dxkit.bom-detailed.v1',
  'dev-report': 'dxkit.dev-report.v1',
  'dev-report-detailed': 'dxkit.dev-report-detailed.v1',
});

/**
 * Stamp a report with its canonical `schema` banner. Returns a new
 * object — never mutates the input — so callers can stamp before
 * `JSON.stringify` without worrying about clobbering shared state.
 *
 * Order matters for human-readable JSON: `schema` lands first so a
 * reader skimming a pretty-printed file sees the discriminator
 * immediately rather than scrolling past nested fields.
 */
export function stampSchema<T extends object>(
  report: T,
  kind: ReportKind,
): { readonly schema: string } & T {
  return { schema: REPORT_SCHEMAS[kind], ...report };
}
