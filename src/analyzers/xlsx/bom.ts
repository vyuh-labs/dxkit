/**
 * XLSX converter — bom report (2.3.2 PM-grade restructure).
 *
 * Produces a 4-sheet workbook tuned for a PM / security reviewer:
 *
 *   1. `Executive Summary` — KV grid on one screen: totals, severity
 *      breakdown, top upgrade, license-class counts, staleness counts,
 *      tool provenance, analysis time.
 *
 *   2. `Triage` — top 10 findings ranked by composite riskScore, with
 *      PM-friendly columns (Priority / Risk / Severity / KEV / Reach /
 *      Package@Version / Advisory / CVSS / EPSS / Upgrade to / Effort /
 *      Rationale). Sort key is `riskScore desc`; ties resolve by
 *      severity then package name. The list shown here is the same
 *      one the markdown's "This Week's Triage" section surfaces, so
 *      markdown + xlsx tell the same story.
 *
 *   3. `Inventory` — legacy 15-col customer-format sheet with 4 columns
 *      appended (cols 16–19): Risk / KEV / Reachable / EPSS. Sorting
 *      by col 16 desc gives the same triage order as sheet 2; the
 *      legacy cols 1–15 stay byte-identical to the pre-2.3.2 format
 *      for reviewers who have hand-built dashboards on specific cells.
 *
 *   4. `License Breakdown` — pivot: license type × count × risk class
 *      × sample packages. Lets a PM filter for "copyleft-strong" or
 *      "unknown" licenses without eyeballing the full inventory.
 *
 * All derivations (license class, staleness tier, effort estimate)
 * live in `src/analyzers/bom/pm-signals.ts` so the markdown renderer
 * shares the same classification logic — PM sees consistent labels
 * regardless of which report surface they're reading.
 */

import ExcelJS from 'exceljs';

import type { BomEntry, BomReport, BomSeverity } from '../bom/types';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import {
  effortEstimate,
  licenseClass,
  stalenessTier,
  type EffortEstimate,
  type LicenseClass,
  type StalenessTier,
} from '../bom/pm-signals';
import { BOM_COLUMNS } from './licenses';

/** Excel's hard per-cell character limit. */
const EXCEL_CELL_MAX = 32767;

/** Per-advisory truncation in the legacy "Vulnerability Issues" cell. */
const ADVISORY_SUMMARY_MAX = 200;

const SEV_RANK: Record<BomSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SEV_LABEL: Record<BomSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const LICENSE_CLASS_LABEL: Record<LicenseClass, string> = {
  permissive: 'Permissive',
  'copyleft-weak': 'Copyleft (weak)',
  'copyleft-strong': 'Copyleft (strong)',
  proprietary: 'Proprietary',
  unknown: 'Unknown',
};

const STALENESS_LABEL: Record<StalenessTier, string> = {
  fresh: 'Fresh (< 1y)',
  aging: 'Aging (1–3y)',
  stale: 'Stale (≥ 3y)',
  unknown: 'Unknown',
};

const EFFORT_LABEL: Record<EffortEstimate, string> = {
  trivial: 'Trivial (patch bump)',
  moderate: 'Moderate (minor bump)',
  major: 'Major (breaking)',
  blocked: 'Blocked (no fix)',
};

/** XML 1.0 forbids most C0 control chars; Excel refuses to open a sheet
 *  containing them. Same scrub as licenses.ts, inlined here so the xlsx
 *  write boundary owns the rule. */
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

function pct(n: number | undefined): string {
  return typeof n === 'number' ? `${(n * 100).toFixed(2)}%` : '—';
}

function maxRiskAcrossVulns(e: BomEntry): number {
  let best = -1;
  for (const v of e.vulns) {
    if (typeof v.riskScore === 'number' && v.riskScore > best) best = v.riskScore;
  }
  return best;
}

function maxCvssAcrossVulns(e: BomEntry): number {
  let best = -1;
  for (const v of e.vulns) {
    if (typeof v.cvssScore === 'number' && v.cvssScore > best) best = v.cvssScore;
  }
  return best;
}

function maxEpssAcrossVulns(e: BomEntry): number {
  let best = -1;
  for (const v of e.vulns) {
    if (typeof v.epssScore === 'number' && v.epssScore > best) best = v.epssScore;
  }
  return best;
}

function anyKev(e: BomEntry): boolean {
  return e.vulns.some((v) => v.kev === true);
}

function anyReachable(e: BomEntry): 'yes' | 'no' | 'unknown' {
  let sawTrue = false;
  let sawFalse = false;
  for (const v of e.vulns) {
    if (v.reachable === true) sawTrue = true;
    else if (v.reachable === false) sawFalse = true;
  }
  if (sawTrue) return 'yes';
  if (sawFalse) return 'no';
  return 'unknown';
}

/**
 * Render a `BomReport` as a multi-sheet XLSX workbook.
 */
export async function toBomXlsx(report: BomReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'vyuh-dxkit';
  wb.created = new Date(report.analyzedAt);

  writeExecutiveSummary(wb, report);
  writeTriage(wb, report);
  writeInventory(wb, report);
  writeLicenseBreakdown(wb, report);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}

// ─── Sheet 1: Executive Summary ─────────────────────────────────────────────

function writeExecutiveSummary(wb: ExcelJS.Workbook, report: BomReport): void {
  const ws = wb.addWorksheet('Executive Summary');
  ws.columns = [
    { header: '', key: 'label', width: 42 },
    { header: '', key: 'value', width: 60 },
  ];

  const s = report.summary;
  const now = new Date();

  // Top-line identity
  ws.addRow(['Repository', report.repo]);
  ws.addRow(['Branch', `${report.branch} (${report.commitSha})`]);
  ws.addRow(['Scan date', report.analyzedAt.slice(0, 10)]);
  ws.addRow([
    'Scope',
    s.filter === 'top-level'
      ? `Top-level packages only (${s.totalPackages} of ${s.unfilteredTotalPackages} installed)`
      : `All installed packages (${s.totalPackages})`,
  ]);
  if (s.projectRoots.length > 1) {
    ws.addRow(['Project roots', `${s.projectRoots.length} — ${s.projectRoots.join(', ')}`]);
  }
  ws.addRow([]);

  // Risk posture
  ws.addRow(['Risk posture', '']).font = { bold: true };
  ws.addRow(['Vulnerable packages', `${s.vulnerablePackages} (of ${s.totalPackages})`]);
  ws.addRow(['Total advisories', `${s.totalAdvisories}`]);
  ws.addRow([
    'Severity breakdown (worst-of-package)',
    `Critical ${s.bySeverity.critical} · High ${s.bySeverity.high} · Medium ${s.bySeverity.medium} · Low ${s.bySeverity.low}`,
  ]);

  // Highest-risk advisory + top upgrade
  const triage = buildTriageRows(report);
  if (triage.length > 0) {
    const top = triage[0];
    ws.addRow([
      'Top ship-blocker',
      `${top.packageAtVersion} — ${top.advisoryId} (Risk ${top.risk.toFixed(0)})`,
    ]);
  } else {
    ws.addRow(['Top ship-blocker', 'None — no advisory crossed the moderate-risk threshold']);
  }

  // byTopLevelDep: the single upgrade with the biggest blast-radius win
  const rollupEntries = Object.entries(s.byTopLevelDep).sort(
    (a, b) =>
      SEV_RANK[a[1].maxSeverity] - SEV_RANK[b[1].maxSeverity] ||
      b[1].advisoryCount - a[1].advisoryCount,
  );
  if (rollupEntries.length > 0) {
    const [name, r] = rollupEntries[0];
    ws.addRow([
      'Highest-leverage upgrade',
      `${name} — resolves up to ${r.advisoryCount} transitive advisories (worst ${SEV_LABEL[r.maxSeverity]})`,
    ]);
  }
  ws.addRow([]);

  // License risk
  ws.addRow(['License risk', '']).font = { bold: true };
  const licBuckets = new Map<LicenseClass, number>();
  for (const e of report.entries) {
    const c = licenseClass(e.licenseType);
    licBuckets.set(c, (licBuckets.get(c) ?? 0) + 1);
  }
  for (const c of [
    'permissive',
    'copyleft-weak',
    'copyleft-strong',
    'proprietary',
    'unknown',
  ] as LicenseClass[]) {
    ws.addRow([LICENSE_CLASS_LABEL[c], licBuckets.get(c) ?? 0]);
  }
  ws.addRow([]);

  // Staleness
  ws.addRow(['Staleness', '']).font = { bold: true };
  const staleBuckets = new Map<StalenessTier, number>();
  for (const e of report.entries) {
    const t = stalenessTier(e.releaseDate, now);
    staleBuckets.set(t, (staleBuckets.get(t) ?? 0) + 1);
  }
  for (const t of ['fresh', 'aging', 'stale', 'unknown'] as StalenessTier[]) {
    ws.addRow([STALENESS_LABEL[t], staleBuckets.get(t) ?? 0]);
  }
  ws.addRow([]);

  // Tools + provenance
  ws.addRow(['Tools used', report.toolsUsed.join(', ') || '(none)']);
  if (report.toolsUnavailable.length > 0) {
    ws.addRow(['Tools unavailable', report.toolsUnavailable.join(', ')]);
  }
  ws.addRow(['Schema version', report.schemaVersion]);

  // Bold the label column
  for (let i = 1; i <= ws.rowCount; i++) {
    const cell = ws.getRow(i).getCell(1);
    if (!cell.font?.bold) cell.font = { bold: true };
  }
}

// ─── Sheet 2: Triage ────────────────────────────────────────────────────────

interface TriageFinding {
  risk: number;
  severity: BomSeverity;
  kev: boolean;
  reachable: 'yes' | 'no' | 'unknown';
  packageAtVersion: string;
  advisoryId: string;
  cvss: number | undefined;
  epss: number | undefined;
  fix: string | undefined;
  effort: EffortEstimate;
  rationale: string;
}

function buildTriageRows(report: BomReport, limit = 10, minRisk = 15): TriageFinding[] {
  const flat: TriageFinding[] = [];
  for (const e of report.entries) {
    if (e.vulns.length === 0) continue;
    const effort = effortEstimate(e);
    for (const v of e.vulns) {
      if (typeof v.riskScore !== 'number' || v.riskScore < minRisk) continue;
      const rationale = buildRationale(v);
      flat.push({
        risk: v.riskScore,
        severity: v.severity,
        kev: v.kev === true,
        reachable: v.reachable === true ? 'yes' : v.reachable === false ? 'no' : 'unknown',
        packageAtVersion: `${e.package}@${e.version}`,
        advisoryId: v.id,
        cvss: v.cvssScore,
        epss: v.epssScore,
        fix: v.fixedVersion ?? e.upgradeAdvice.replace(/^PROPOSAL:\s*/, '') ?? undefined,
        effort,
        rationale,
      });
    }
  }
  flat.sort(
    (a, b) =>
      b.risk - a.risk ||
      SEV_RANK[a.severity] - SEV_RANK[b.severity] ||
      a.packageAtVersion.localeCompare(b.packageAtVersion),
  );
  return flat.slice(0, limit);
}

function buildRationale(v: DepVulnFinding): string {
  const parts: string[] = [];
  if (v.kev) parts.push('KEV');
  if (v.reachable === true) parts.push('reachable');
  if (v.reachable === false) parts.push('not reachable');
  if (typeof v.cvssScore === 'number') parts.push(`CVSS ${v.cvssScore.toFixed(1)}`);
  if (typeof v.epssScore === 'number' && v.epssScore >= 0.01) {
    parts.push(`EPSS ${(v.epssScore * 100).toFixed(1)}%`);
  }
  return parts.length > 0 ? parts.join(', ') : '—';
}

function writeTriage(wb: ExcelJS.Workbook, report: BomReport): void {
  const ws = wb.addWorksheet('Triage');
  ws.columns = [
    { header: 'Priority', key: 'priority', width: 10 },
    { header: 'Risk', key: 'risk', width: 8 },
    { header: 'Severity', key: 'severity', width: 12 },
    { header: 'KEV', key: 'kev', width: 6 },
    { header: 'Reachable', key: 'reachable', width: 12 },
    { header: 'Package@Version', key: 'pkg', width: 40 },
    { header: 'Advisory', key: 'id', width: 24 },
    { header: 'CVSS', key: 'cvss', width: 8 },
    { header: 'EPSS', key: 'epss', width: 10 },
    { header: 'Upgrade to', key: 'fix', width: 14 },
    { header: 'Effort', key: 'effort', width: 22 },
    { header: 'Rationale', key: 'rationale', width: 42 },
  ];
  ws.getRow(1).font = { bold: true };

  const triage = buildTriageRows(report);
  triage.forEach((t, i) => {
    ws.addRow({
      priority: i + 1,
      risk: Math.round(t.risk),
      severity: SEV_LABEL[t.severity],
      kev: t.kev ? '⚠' : '',
      reachable: t.reachable,
      pkg: t.packageAtVersion,
      id: t.advisoryId,
      cvss: typeof t.cvss === 'number' ? t.cvss.toFixed(1) : '—',
      epss: pct(t.epss),
      fix: t.fix ? xlsxSafe(t.fix) : '—',
      effort: EFFORT_LABEL[t.effort],
      rationale: t.rationale,
    });
  });
  if (triage.length === 0) {
    ws.addRow({
      priority: '—',
      rationale: 'No advisories crossed the moderate-risk threshold (Risk ≥ 15).',
    });
  }
}

// ─── Sheet 3: Inventory (legacy 15 + 4 appended) ────────────────────────────

function writeInventory(wb: ExcelJS.Workbook, report: BomReport): void {
  const ws = wb.addWorksheet('Inventory');

  // Append the 4 PM-signal columns to the legacy header.
  const header = [...BOM_COLUMNS, 'Risk', 'KEV', 'Reachable', 'EPSS'];
  ws.addRow(header);
  ws.getRow(1).font = { bold: true };

  const reportDate = report.analyzedAt.slice(0, 10);
  const rows = [...report.entries].sort((a, b) => a.package.localeCompare(b.package));

  const NO_VULNS_CRITICALITY = 'None';
  const NO_VULNS_ISSUES = 'None';
  const NO_VULNS_RESOLUTION = 'No action required';

  for (const e of rows) {
    const criticality = e.maxSeverity
      ? `${SEV_LABEL[e.maxSeverity]} (${e.vulns.length} vuln${e.vulns.length === 1 ? '' : 's'})`
      : NO_VULNS_CRITICALITY;

    const sortedVulns = [...e.vulns].sort(
      (a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || a.id.localeCompare(b.id),
    );
    const vulnLines = sortedVulns.map((v) => {
      const title = (v.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, ADVISORY_SUMMARY_MAX);
      const cvss = v.cvssScore !== undefined ? ` [CVSS ${v.cvssScore.toFixed(1)}]` : '';
      const tops = v.topLevelDep ?? [];
      let via = '';
      if (tops.length === 1) via = ` via ${tops[0]}`;
      else if (tops.length > 1) via = ` via ${tops[0]} (+${tops.length - 1} more)`;
      return title ? `${v.id}${cvss}${via}: ${title}` : `${v.id}${cvss}${via}`;
    });
    const vulnerabilityIssues = e.vulns.length === 0 ? NO_VULNS_ISSUES : vulnLines.join('; ');
    const resolution = e.vulns.length === 0 ? NO_VULNS_RESOLUTION : e.upgradeAdvice;

    // PM signals — appended cols 16–19. Use max-across-vulns for sortability.
    const risk = maxRiskAcrossVulns(e);
    const cvssMax = maxCvssAcrossVulns(e);
    const epssMax = maxEpssAcrossVulns(e);
    const kevCell = anyKev(e) ? 'Yes' : '';
    const reachCell = anyReachable(e);

    ws.addRow([
      xlsxSafe(e.package),
      xlsxSafe(e.version),
      xlsxSafe(e.description),
      'Dependency',
      `Reported ${reportDate}`,
      xlsxSafe(e.sourceUrl),
      xlsxSafe(e.licenseType),
      xlsxSafe(e.licenseText),
      xlsxSafe(e.supplier),
      xlsxSafe(e.releaseDate ? e.releaseDate.slice(0, 10) : ''),
      xlsxSafe(criticality),
      xlsxSafe(vulnerabilityIssues),
      xlsxSafe(resolution),
      '',
      `${e.package}@${e.version}`,
      // 16–19: PM-signals (numeric so sort asc/desc works correctly)
      risk >= 0 ? Math.round(risk) : '',
      kevCell,
      reachCell === 'unknown' ? '' : reachCell,
      epssMax >= 0 ? pct(epssMax) : '',
      // Keep CVSS-max for power users; col 20 is an extra that helps
      // pivot tables without cluttering the main table.
      cvssMax >= 0 ? cvssMax.toFixed(1) : '',
    ]);
  }

  // Legacy widths (15 cols) + PM-signal widths (4 + 1 for cvss-max).
  const widths = [30, 14, 50, 14, 18, 50, 18, 50, 24, 18, 22, 50, 40, 12, 40, 8, 6, 12, 10, 8];
  ws.columns.forEach((col, i) => {
    if (col && widths[i]) col.width = widths[i];
  });

  // Header for the bonus col 20 (CVSS max)
  ws.getRow(1).getCell(20).value = 'CVSS (max)';
  ws.getRow(1).getCell(20).font = { bold: true };
}

// ─── Sheet 4: License Breakdown ─────────────────────────────────────────────

function writeLicenseBreakdown(wb: ExcelJS.Workbook, report: BomReport): void {
  const ws = wb.addWorksheet('License Breakdown');
  ws.columns = [
    { header: 'License', key: 'license', width: 30 },
    { header: 'Class', key: 'class', width: 22 },
    { header: 'Count', key: 'count', width: 8 },
    { header: 'Sample packages', key: 'samples', width: 80 },
  ];
  ws.getRow(1).font = { bold: true };

  // Group entries by license type, remember up to 5 sample package names
  const buckets = new Map<string, string[]>();
  for (const e of report.entries) {
    const lic = e.licenseType || '(empty)';
    const list = buckets.get(lic) ?? [];
    list.push(e.package);
    buckets.set(lic, list);
  }

  // Sort: worst class first (copyleft-strong), then count desc, then name
  const rows = [...buckets.entries()]
    .map(([lic, pkgs]) => ({
      license: lic,
      cls: licenseClass(lic),
      count: pkgs.length,
      samples: pkgs.slice(0, 5).join(', ') + (pkgs.length > 5 ? `, +${pkgs.length - 5} more` : ''),
    }))
    .sort((a, b) => {
      const classRank: Record<LicenseClass, number> = {
        'copyleft-strong': 0,
        'copyleft-weak': 1,
        proprietary: 2,
        unknown: 3,
        permissive: 4,
      };
      return (
        classRank[a.cls] - classRank[b.cls] ||
        b.count - a.count ||
        a.license.localeCompare(b.license)
      );
    });

  for (const r of rows) {
    ws.addRow({
      license: r.license,
      class: LICENSE_CLASS_LABEL[r.cls],
      count: r.count,
      samples: r.samples,
    });
  }
}
