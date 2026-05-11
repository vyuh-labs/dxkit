/**
 * Dashboard analyzer — deterministic templating that stitches every
 * report under `.dxkit/reports/` into a single self-contained HTML
 * dashboard. Closes D020: the prior agent-based path failed at the
 * Write step in the sub-agent sandbox, and agent rendering is
 * non-deterministic across Claude Code versions anyway. The agent
 * (`dashboard-builder.md`) stays available for LLM-narrative use
 * cases ("explain the dashboard"); this CLI owns the HTML.
 *
 * Inputs (both default to `<cwd>/.dxkit/reports`):
 *   - Markdown reports — per-tab content. One file per report stem
 *     (`health-audit-*.md`, `vulnerability-scan-*.md`, …). When both
 *     `<stem>-*-detailed.md` and `<stem>-*.md` exist we prefer the
 *     detailed one (richer evidence + ranked actions).
 *   - JSON reports — synthesis data for the Overview tab (hero
 *     score, dimension breakdown, badge counts, critical issues).
 *     Best-effort: missing JSON degrades to empty sections, never
 *     throws.
 *
 * Reference: `~/projects/external-repos/_runs/gen-dashboard-v2.js`,
 * the script we ran by hand 2026-05-07 when the agent denied Write.
 * That template is the source-of-truth structure being ported here.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Known report stems → display config. Order here = sidebar order. */
const REPORT_STEMS: Array<{
  key: string;
  stem: string;
  icon: string;
  label: string;
  color: string;
}> = [
  { key: 'health', stem: 'health-audit', icon: '🏥', label: 'Health Audit', color: '#3fb950' },
  {
    key: 'vulnerabilities',
    stem: 'vulnerability-scan',
    icon: '🔒',
    label: 'Vulnerability Scan',
    color: '#f85149',
  },
  { key: 'testGaps', stem: 'test-gaps', icon: '🧪', label: 'Test Gaps', color: '#d29922' },
  { key: 'quality', stem: 'quality-review', icon: '✨', label: 'Code Quality', color: '#bc8cff' },
  {
    key: 'dev',
    stem: 'developer-report',
    icon: '👥',
    label: 'Developer Report',
    color: '#58a6ff',
  },
  { key: 'licenses', stem: 'licenses', icon: '📜', label: 'Licenses', color: '#39d2c0' },
  { key: 'bom', stem: 'bom', icon: '📦', label: 'Bill of Materials', color: '#39d2c0' },
];

export interface DashboardOptions {
  /** Where to read markdown reports from. Default: `<cwd>/.dxkit/reports`. */
  reportsDir?: string;
  /** Where to read JSON synthesis data from. Default: same as reportsDir. */
  jsonDir?: string;
  /** Project name shown in the header. Default: derived from package.json or basename(cwd). */
  projectName?: string;
}

export interface DashboardResult {
  html: string;
  reportCount: number;
  criticalIssueCount: number;
  /** Best-effort summary numbers, surfaced to the CLI for stderr logging. */
  summary: {
    healthScore: number | null;
    healthGrade: string | null;
    vulnCount: number;
    gapCount: number;
    advisoryCount: number;
    slopScore: number | null;
  };
}

export function analyzeDashboard(cwd: string, options: DashboardOptions = {}): DashboardResult {
  const reportsDir = options.reportsDir ?? path.join(cwd, '.dxkit', 'reports');
  const jsonDir = options.jsonDir ?? reportsDir;
  const projectName = options.projectName ?? deriveProjectName(cwd);

  if (!fs.existsSync(reportsDir)) {
    throw new Error(
      `Reports directory not found: ${reportsDir}\n` +
        `Run 'vyuh-dxkit health .' (or any other report command) first to populate it.`,
    );
  }

  const entries = fs.readdirSync(reportsDir);
  const mdFiles = entries.filter((f) => f.endsWith('.md'));
  const jsonFiles = fs.existsSync(jsonDir)
    ? fs.readdirSync(jsonDir).filter((f) => f.endsWith('.json'))
    : [];

  // For each known stem, pick the most-recent markdown (preferring
  // -detailed.md over the plain variant) and the most-recent JSON
  // (preferring -detailed.json, falling back to bare `<key>.json`
  // for users of the legacy synth-JSON layout that `gen-dashboard-v2`
  // documented).
  const reports: Record<string, string> = {};
  const jsonData: Record<string, unknown> = {};
  const navEntries: Array<{
    key: string;
    reportKey: string;
    icon: string;
    label: string;
    color: string;
    badge: string;
  }> = [];

  for (const cfg of REPORT_STEMS) {
    const md = pickMostRecent(mdFiles, cfg.stem);
    if (md) {
      const reportKey = md.replace(/\.md$/, '');
      reports[reportKey] = fs.readFileSync(path.join(reportsDir, md), 'utf-8');

      const jsonPath = findJsonFor(jsonFiles, cfg.stem, cfg.key, jsonDir);
      if (jsonPath) {
        try {
          jsonData[cfg.key] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        } catch {
          // Bad JSON degrades to "missing"; the Overview falls back
          // to empty values rather than failing the whole dashboard.
        }
      }

      navEntries.push({
        key: cfg.key,
        reportKey,
        icon: cfg.icon,
        label: cfg.label,
        color: cfg.color,
        badge: '', // filled in once we've computed Overview numbers below
      });
    }
  }

  // Synthesize Overview data.
  const health = (jsonData.health as Record<string, unknown> | undefined) ?? {};
  const vulns = (jsonData.vulnerabilities as Record<string, unknown> | undefined) ?? {};
  const testGaps = (jsonData.testGaps as Record<string, unknown> | undefined) ?? {};
  const quality = (jsonData.quality as Record<string, unknown> | undefined) ?? {};
  const bom = (jsonData.bom as Record<string, unknown> | undefined) ?? {};
  const licenses = (jsonData.licenses as Record<string, unknown> | undefined) ?? {};

  const healthSummary =
    (health.summary as { overallScore?: number; grade?: string } | undefined) ?? {};
  const healthScore =
    typeof healthSummary.overallScore === 'number' ? healthSummary.overallScore : null;
  const healthGrade = typeof healthSummary.grade === 'string' ? healthSummary.grade : null;
  const dims =
    (health.dimensions as Record<string, { score?: number } | undefined> | undefined) ?? {};

  const orderedDims: Array<[string, { score?: number } | undefined]> = [
    ['Testing', dims.testing],
    ['Code Quality', dims.quality],
    ['Documentation', dims.documentation],
    ['Security', dims.security],
    ['Maintainability', dims.maintainability],
    ['Developer Experience', dims.developerExperience],
  ];

  type VulnFinding = {
    severity?: string;
    tool?: string;
    rule?: string;
    id?: string;
    file?: string;
    line?: number;
    package?: string;
    installedVersion?: string;
  };
  const vulnFindings: VulnFinding[] = Array.isArray(vulns.findings)
    ? (vulns.findings as VulnFinding[])
    : [];
  const vulnBySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const f of vulnFindings) {
    const sev = f.severity ?? 'unknown';
    vulnBySeverity[sev] = (vulnBySeverity[sev] ?? 0) + 1;
  }

  type Gap = { risk?: string; path?: string; file?: string; lines?: number; reason?: string };
  const gaps: Gap[] = Array.isArray(testGaps.gaps) ? (testGaps.gaps as Gap[]) : [];
  const gapsByRisk = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const g of gaps) {
    const risk = g.risk ?? 'unknown';
    gapsByRisk[risk] = (gapsByRisk[risk] ?? 0) + 1;
  }
  const gapCount = gaps.length;

  const bomSummary =
    (bom.summary as
      | {
          totalAdvisories?: number;
          totalPackages?: number;
          unfilteredTotalPackages?: number;
          triage?: Array<{
            package?: string;
            advisoryCount?: number;
            advice?: string;
            severity?: string;
          }>;
        }
      | undefined) ?? {};
  const advisoryCount = bomSummary.totalAdvisories ?? 0;
  const topPackages = bomSummary.totalPackages ?? 0;
  const totalPackages = bomSummary.unfilteredTotalPackages ?? 0;

  const qualityMetrics =
    (quality.metrics as
      | { slopScore?: number; lintErrors?: number; duplication?: { percentage?: number } }
      | undefined) ?? {};
  const slopScore = typeof qualityMetrics.slopScore === 'number' ? qualityMetrics.slopScore : null;

  const licenseSummary =
    (licenses.summary as
      | { totalPackages?: number; unknownCount?: number; byLicense?: Record<string, number> }
      | undefined) ?? {};
  const totalLicensePkgs = licenseSummary.totalPackages ?? 0;
  const unknownLicenses = licenseSummary.unknownCount ?? 0;

  // Top critical issues from each surface.
  const criticalIssues: Array<{ type: string; label: string; detail: string; severity: string }> =
    [];
  for (const f of vulnFindings
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .slice(0, 3)) {
    criticalIssues.push({
      type: 'vuln',
      label: `${f.tool ?? 'security'} · ${f.rule ?? f.id ?? 'finding'}`,
      detail: f.file
        ? `${f.file}:${f.line ?? '?'}`
        : f.package
          ? `${f.package}@${f.installedVersion ?? '?'}`
          : '',
      severity: f.severity ?? 'high',
    });
  }
  for (const g of gaps.filter((g) => g.risk === 'critical' || g.risk === 'high').slice(0, 3)) {
    criticalIssues.push({
      type: 'gap',
      label: `Untested (${g.risk}): ${g.path ?? g.file ?? '?'}`,
      detail: typeof g.lines === 'number' ? `${g.lines} lines` : (g.reason ?? ''),
      severity: g.risk ?? 'high',
    });
  }
  for (const t of (bomSummary.triage ?? []).slice(0, 2)) {
    criticalIssues.push({
      type: 'bom',
      label: `Upgrade: ${t.package ?? '?'} → resolves ${t.advisoryCount ?? '?'} advisories`,
      detail: t.advice ?? '',
      severity: t.severity ?? 'high',
    });
  }

  // Fill in sidebar badges now that we have the synthesis numbers.
  for (const e of navEntries) {
    if (e.key === 'health' && healthScore !== null) e.badge = `${healthScore}/100`;
    else if (e.key === 'vulnerabilities') e.badge = `${vulnFindings.length}`;
    else if (e.key === 'testGaps') e.badge = `${gapCount}`;
    else if (e.key === 'quality' && slopScore !== null) e.badge = `${slopScore}/100`;
    else if (e.key === 'licenses' && totalLicensePkgs) e.badge = `${totalLicensePkgs}`;
    else if (e.key === 'bom' && advisoryCount) e.badge = `${advisoryCount} adv`;
  }

  const overviewBadge = healthScore !== null ? `${healthScore}/100 (${healthGrade ?? '?'})` : '';
  const generationDate = new Date().toISOString().slice(0, 10);

  const html = renderHtml({
    projectName,
    generationDate,
    healthScore,
    healthGrade,
    overviewBadge,
    orderedDims,
    vulnFindings,
    vulnBySeverity,
    gapCount,
    gapsByRisk,
    advisoryCount,
    topPackages,
    totalPackages,
    slopScore,
    qualityMetrics,
    totalLicensePkgs,
    unknownLicenses,
    licenseByCount: Object.keys(licenseSummary.byLicense ?? {}).length,
    testGapsSummary:
      (testGaps.summary as
        | { sourceFiles?: number; activeTestFiles?: number; coverageSource?: string }
        | undefined) ?? {},
    criticalIssues,
    reports,
    navEntries,
  });

  return {
    html,
    reportCount: Object.keys(reports).length,
    criticalIssueCount: criticalIssues.length,
    summary: {
      healthScore,
      healthGrade,
      vulnCount: vulnFindings.length,
      gapCount,
      advisoryCount,
      slopScore,
    },
  };
}

function deriveProjectName(cwd: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8'));
    if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
  } catch {
    // No package.json or unreadable — fall through to basename.
  }
  return path.basename(path.resolve(cwd));
}

/**
 * Pick the most-recent markdown file matching `<stem>-*.md`, preferring
 * the `*-detailed.md` variant when both exist for the same date.
 * "Most recent" is determined by lexical sort on the filename, which
 * works because every dxkit report file embeds an ISO date prefix.
 */
function pickMostRecent(files: string[], stem: string): string | undefined {
  const stemPrefix = `${stem}-`;
  const matching = files.filter((f) => f.startsWith(stemPrefix));
  if (matching.length === 0) return undefined;

  matching.sort();
  // Take the latest date that exists, then prefer -detailed within that
  // date if it's available.
  const latest = matching[matching.length - 1];
  // Extract date prefix `<stem>-<YYYY-MM-DD>`. If we can't parse one,
  // fall back to the lexically-latest file.
  const dateMatch = latest.match(new RegExp(`^${escapeRegex(stemPrefix)}(\\d{4}-\\d{2}-\\d{2})`));
  if (!dateMatch) return latest;
  const date = dateMatch[1];
  const detailed = `${stemPrefix}${date}-detailed.md`;
  if (matching.includes(detailed)) return detailed;
  const plain = `${stemPrefix}${date}.md`;
  if (matching.includes(plain)) return plain;
  return latest;
}

/**
 * Locate a JSON synthesis file for a report stem. Priority:
 *   1. `<stem>-<date>-detailed.json` (what `--detailed --json` produces)
 *   2. `<key>.json` (bare-named, gen-dashboard-v2 legacy layout)
 * Returns an absolute path or undefined.
 */
function findJsonFor(
  jsonFiles: string[],
  stem: string,
  key: string,
  jsonDir: string,
): string | undefined {
  const detailed = jsonFiles
    .filter((f) => f.startsWith(`${stem}-`) && f.endsWith('-detailed.json'))
    .sort();
  if (detailed.length > 0) {
    return path.join(jsonDir, detailed[detailed.length - 1]);
  }
  const bare = `${key}.json`;
  if (jsonFiles.includes(bare)) return path.join(jsonDir, bare);
  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sevColor(sev: string): string {
  if (sev === 'critical') return '#f85149';
  if (sev === 'high') return '#ff7b72';
  if (sev === 'medium') return '#d29922';
  if (sev === 'low') return '#3fb950';
  return '#8b949e';
}

interface RenderArgs {
  projectName: string;
  generationDate: string;
  healthScore: number | null;
  healthGrade: string | null;
  overviewBadge: string;
  orderedDims: Array<[string, { score?: number } | undefined]>;
  vulnFindings: unknown[];
  vulnBySeverity: Record<string, number>;
  gapCount: number;
  gapsByRisk: Record<string, number>;
  advisoryCount: number;
  topPackages: number;
  totalPackages: number;
  slopScore: number | null;
  qualityMetrics: { lintErrors?: number; duplication?: { percentage?: number } };
  totalLicensePkgs: number;
  unknownLicenses: number;
  licenseByCount: number;
  testGapsSummary: { sourceFiles?: number; activeTestFiles?: number; coverageSource?: string };
  criticalIssues: Array<{ label: string; detail: string; severity: string }>;
  reports: Record<string, string>;
  navEntries: Array<{
    key: string;
    reportKey: string;
    icon: string;
    label: string;
    color: string;
    badge: string;
  }>;
}

function renderHtml(a: RenderArgs): string {
  const reportsJson = JSON.stringify(a.reports);
  const navJson = JSON.stringify(a.navEntries);

  // Server-rendered Overview tab (the JS layer just swaps innerHTML
  // when the user navigates between tabs). Keeps the dashboard usable
  // even if marked.min.js fails to load from the CDN — the Overview
  // is always visible.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(a.projectName)} — DXKit Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    :root {
      --bg-primary: #0d1117;
      --bg-secondary: #161b22;
      --bg-tertiary: #21262d;
      --bg-card: #1e2630;
      --border: #30363d;
      --text-primary: #f0f6fc;
      --text-secondary: #c9d1d9;
      --text-muted: #8b949e;
      --accent-blue: #58a6ff;
      --accent-green: #3fb950;
      --accent-red: #f85149;
      --accent-orange: #d29922;
      --accent-purple: #bc8cff;
      --accent-cyan: #39d2c0;
      --sidebar-width: 320px;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      background: var(--bg-primary);
      color: var(--text-secondary);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }
    .sidebar { width: var(--sidebar-width); background: var(--bg-secondary); border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0; overflow: hidden; }
    .sidebar-header { padding: 22px 20px; border-bottom: 1px solid var(--border); }
    .sidebar-header h1 { font-size: 17px; color: var(--text-primary); font-weight: 600; }
    .sidebar-header .project-name { font-size: 13px; color: var(--accent-blue); margin-top: 4px; }
    .sidebar-header .generated { font-size: 11px; color: var(--text-muted); margin-top: 4px; }
    .sidebar-nav { flex: 1; overflow-y: auto; padding: 12px; }
    .nav-section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.8px; color: var(--text-muted); padding: 12px 10px 6px; }
    .nav-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; background: none; border: none; color: var(--text-secondary); padding: 10px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; margin-bottom: 2px; transition: all 0.15s ease; font-family: inherit; }
    .nav-item:hover { background: var(--bg-tertiary); color: var(--text-primary); }
    .nav-item.active { background: var(--accent-blue); color: white; font-weight: 500; }
    .nav-item .icon { font-size: 16px; flex-shrink: 0; }
    .nav-item .label { flex: 1; }
    .nav-item .badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; background: var(--bg-tertiary); color: var(--text-muted); flex-shrink: 0; font-weight: 500; }
    .nav-item.active .badge { background: rgba(255,255,255,0.2); color: white; }
    .sidebar-footer { padding: 14px 20px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-muted); }
    .sidebar-footer a { color: var(--accent-blue); text-decoration: none; }
    .main { flex: 1; overflow-y: auto; padding: 32px 40px 60px; }
    .main-inner { max-width: 1100px; margin: 0 auto; }
    .hero { display: grid; grid-template-columns: auto 1fr; gap: 28px; align-items: center; padding: 28px; background: var(--bg-card); border-radius: 14px; margin-bottom: 28px; border: 1px solid var(--border); }
    .hero-score { font-size: 64px; font-weight: 700; color: var(--text-primary); line-height: 1; }
    .hero-score .grade { font-size: 28px; color: var(--accent-blue); display: block; margin-top: 6px; }
    .hero-meta h2 { font-size: 22px; color: var(--text-primary); margin-bottom: 6px; }
    .hero-meta p { color: var(--text-muted); }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; margin-bottom: 24px; }
    .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--bg-card); padding: 20px; border-radius: 10px; border: 1px solid var(--border); }
    .stat-card .label { font-size: 11px; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.8px; margin-bottom: 8px; }
    .stat-card .value { font-size: 28px; color: var(--text-primary); font-weight: 600; }
    .stat-card .sub { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .dim-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 24px; }
    .dim-card { background: var(--bg-card); padding: 16px; border-radius: 10px; border: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
    .dim-name { flex: 1; font-size: 14px; color: var(--text-primary); font-weight: 500; }
    .dim-bar { flex: 0 0 140px; height: 6px; background: var(--bg-tertiary); border-radius: 3px; overflow: hidden; }
    .dim-bar-fill { height: 100%; transition: width 0.3s; }
    .dim-score { font-size: 18px; color: var(--text-primary); font-weight: 600; min-width: 60px; text-align: right; }
    .crit-list { background: var(--bg-card); border-radius: 10px; padding: 4px; border: 1px solid var(--border); }
    .crit-item { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-radius: 8px; }
    .crit-item:hover { background: var(--bg-tertiary); }
    .crit-item:not(:last-child) { border-bottom: 1px solid var(--border); }
    .crit-sev { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .crit-text { flex: 1; }
    .crit-text .label { font-size: 13px; color: var(--text-primary); }
    .crit-text .detail { font-size: 12px; color: var(--text-muted); margin-top: 2px; font-family: 'SF Mono', 'Fira Code', monospace; }
    .section-title { font-size: 16px; color: var(--text-primary); font-weight: 600; margin-bottom: 14px; margin-top: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
    .main-inner h1 { font-size: 26px; color: var(--text-primary); border-bottom: 1px solid var(--border); padding-bottom: 12px; margin-bottom: 20px; }
    .main-inner h2 { font-size: 20px; color: var(--text-primary); margin-top: 28px; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
    .main-inner h3 { font-size: 16px; color: var(--text-primary); margin-top: 22px; margin-bottom: 8px; }
    .main-inner h4 { font-size: 14px; color: var(--text-primary); margin-top: 16px; margin-bottom: 6px; }
    .main-inner p { line-height: 1.7; margin-bottom: 12px; }
    .main-inner a { color: var(--accent-blue); text-decoration: none; }
    .main-inner a:hover { text-decoration: underline; }
    .main-inner strong { color: var(--text-primary); }
    .main-inner em { color: var(--text-muted); }
    .main-inner ul, .main-inner ol { padding-left: 22px; margin-bottom: 14px; }
    .main-inner li { margin-bottom: 4px; line-height: 1.6; }
    .main-inner table { border-collapse: collapse; width: 100%; margin-bottom: 18px; font-size: 13px; }
    .main-inner th { background: var(--bg-secondary); color: var(--text-primary); font-weight: 600; text-align: left; padding: 10px 14px; border: 1px solid var(--border); }
    .main-inner td { padding: 10px 14px; border: 1px solid var(--border); }
    .main-inner tr:hover td { background: rgba(56, 139, 253, 0.04); }
    .main-inner code { background: var(--bg-secondary); padding: 2px 7px; border-radius: 5px; font-size: 12px; font-family: 'SF Mono', 'Fira Code', monospace; color: var(--accent-blue); }
    .main-inner pre { background: var(--bg-secondary); padding: 16px; border-radius: 10px; overflow-x: auto; margin-bottom: 16px; border: 1px solid var(--border); }
    .main-inner pre code { background: none; padding: 0; color: var(--text-secondary); font-size: 12px; }
    .main-inner blockquote { border-left: 3px solid var(--accent-blue); padding: 8px 16px; color: var(--text-muted); margin-bottom: 12px; background: rgba(56, 139, 253, 0.04); border-radius: 0 6px 6px 0; }
    .main-inner hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
    .mobile-toggle { display: none; position: fixed; top: 12px; left: 12px; z-index: 100; background: var(--bg-secondary); border: 1px solid var(--border); color: var(--text-primary); padding: 8px 12px; border-radius: 8px; cursor: pointer; }
    @media (max-width: 768px) {
      .sidebar { position: fixed; left: -320px; z-index: 50; height: 100vh; transition: left 0.3s ease; }
      .sidebar.open { left: 0; box-shadow: 4px 0 20px rgba(0,0,0,0.5); }
      .mobile-toggle { display: block; }
      .main { padding: 56px 20px 40px; }
      .grid-3, .dim-grid, .grid-2 { grid-template-columns: 1fr; }
      .hero { grid-template-columns: 1fr; text-align: center; }
    }
    @media print {
      body { background: white; color: #1a1a1a; }
      .sidebar, .mobile-toggle { display: none; }
      .main { padding: 20px; }
      .main-inner h1, .main-inner h2, .main-inner h3 { color: #1a1a1a; }
      .main-inner code { background: #f0f0f0; color: #1a1a1a; }
      .stat-card, .hero, .crit-list, .dim-card { background: #f6f8fa; border: 1px solid #ddd; }
      .hero-score, .stat-card .value, .dim-score { color: #1a1a1a; }
    }
    ::-webkit-scrollbar { width: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--bg-tertiary); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--border); }
    .main-inner { animation: fadeIn 0.2s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <button class="mobile-toggle" onclick="document.querySelector('.sidebar').classList.toggle('open')">☰</button>

  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>DXKit Dashboard</h1>
      <div class="project-name">${escapeHtml(a.projectName)}</div>
      <div class="generated">Generated ${a.generationDate}</div>
    </div>
    <div class="sidebar-nav" id="nav">
      <div class="nav-section-label">Overview</div>
      <button class="nav-item active" data-target="overview">
        <span class="icon">📊</span>
        <span class="label">Summary</span>
        ${a.overviewBadge ? `<span class="badge">${escapeHtml(a.overviewBadge)}</span>` : ''}
      </button>
      <div class="nav-section-label">Reports</div>
    </div>
    <div class="sidebar-footer">
      Powered by <a href="https://www.npmjs.com/package/@vyuhlabs/dxkit" target="_blank">VyuhLabs DXKit</a>
    </div>
  </aside>

  <main class="main">
    <div class="main-inner" id="content">
      <div id="overview-content">
        ${
          a.healthScore !== null
            ? `
        <div class="hero">
          <div>
            <div class="hero-score">${a.healthScore}<span style="color:var(--text-muted);font-size:36px">/100</span><span class="grade">Grade ${escapeHtml(a.healthGrade ?? '')}</span></div>
          </div>
          <div class="hero-meta">
            <h2>Overall Codebase Health</h2>
            <p>Computed across 6 dimensions: testing, code quality, documentation, security, maintainability, developer experience.</p>
          </div>
        </div>`
            : ''
        }

        <div class="section-title">Score Breakdown — 6 Dimensions</div>
        <div class="dim-grid">
          ${a.orderedDims
            .map(([name, dim]) => {
              if (!dim) return '';
              const score = dim.score ?? 0;
              const color =
                score >= 70
                  ? 'var(--accent-green)'
                  : score >= 50
                    ? 'var(--accent-orange)'
                    : 'var(--accent-red)';
              return `<div class="dim-card">
                <div class="dim-name">${escapeHtml(name)}</div>
                <div class="dim-bar"><div class="dim-bar-fill" style="width:${score}%;background:${color}"></div></div>
                <div class="dim-score">${score}/100</div>
              </div>`;
            })
            .join('')}
        </div>

        <div class="section-title">Key Metrics</div>
        <div class="grid-3">
          <div class="stat-card">
            <div class="label">Vulnerabilities</div>
            <div class="value" style="color:${a.vulnFindings.length > 0 ? 'var(--accent-red)' : 'var(--accent-green)'}">${a.vulnFindings.length}</div>
            <div class="sub">${a.vulnBySeverity.critical ?? 0} critical · ${a.vulnBySeverity.high ?? 0} high · ${a.vulnBySeverity.medium ?? 0} medium · ${a.vulnBySeverity.low ?? 0} low</div>
          </div>
          <div class="stat-card">
            <div class="label">Test Gaps</div>
            <div class="value" style="color:${a.gapCount > 0 ? 'var(--accent-orange)' : 'var(--accent-green)'}">${a.gapCount}</div>
            <div class="sub">${a.gapsByRisk.critical ?? 0} critical · ${a.gapsByRisk.high ?? 0} high · ${a.gapsByRisk.medium ?? 0} medium · ${a.gapsByRisk.low ?? 0} low</div>
          </div>
          <div class="stat-card">
            <div class="label">BoM Advisories</div>
            <div class="value" style="color:${a.advisoryCount > 0 ? 'var(--accent-orange)' : 'var(--accent-green)'}">${a.advisoryCount}</div>
            <div class="sub">${a.topPackages} top-level packages of ${a.totalPackages} total</div>
          </div>
          <div class="stat-card">
            <div class="label">Code Quality</div>
            <div class="value" style="color:${a.slopScore !== null && a.slopScore < 50 ? 'var(--accent-orange)' : 'var(--accent-green)'}">${a.slopScore !== null ? `${a.slopScore}/100` : 'n/a'}</div>
            <div class="sub">${a.qualityMetrics.duplication?.percentage !== undefined ? `${a.qualityMetrics.duplication.percentage}% duplication` : ''}${a.qualityMetrics.lintErrors !== undefined ? ` · ${a.qualityMetrics.lintErrors} lint errors` : ''}</div>
          </div>
          <div class="stat-card">
            <div class="label">Licenses</div>
            <div class="value">${a.totalLicensePkgs}</div>
            <div class="sub">${a.unknownLicenses} unknown · ${a.licenseByCount} distinct types</div>
          </div>
          <div class="stat-card">
            <div class="label">Source Files</div>
            <div class="value">${a.testGapsSummary.sourceFiles ?? 'n/a'}</div>
            <div class="sub">${a.testGapsSummary.activeTestFiles ?? 0} test files · coverage source: ${escapeHtml(a.testGapsSummary.coverageSource ?? 'n/a')}</div>
          </div>
        </div>

        ${
          a.criticalIssues.length > 0
            ? `
        <div class="section-title">Critical Issues at a Glance</div>
        <div class="crit-list">
          ${a.criticalIssues
            .map(
              (i) => `
            <div class="crit-item">
              <div class="crit-sev" style="background:${sevColor(i.severity)}"></div>
              <div class="crit-text">
                <div class="label">${escapeHtml(i.label)}</div>
                ${i.detail ? `<div class="detail">${escapeHtml(i.detail)}</div>` : ''}
              </div>
            </div>`,
            )
            .join('')}
        </div>`
            : ''
        }

        <p style="margin-top:32px;color:var(--text-muted);font-size:13px">Click any report in the sidebar to see the full breakdown.</p>
      </div>
    </div>
  </main>

  <script id="reports-data" type="application/json">${reportsJson.replace(/</g, '\\u003c')}</script>
  <script id="nav-data" type="application/json">${navJson.replace(/</g, '\\u003c')}</script>
  <script>
    const reports = JSON.parse(document.getElementById('reports-data').textContent);
    const navEntries = JSON.parse(document.getElementById('nav-data').textContent);
    const nav = document.getElementById('nav');
    const content = document.getElementById('content');
    const overviewHtml = document.getElementById('overview-content').outerHTML;

    navEntries.forEach((cfg) => {
      const btn = document.createElement('button');
      btn.className = 'nav-item';
      btn.dataset.target = cfg.reportKey;
      btn.innerHTML = '<span class="icon">' + cfg.icon + '</span><span class="label">' + cfg.label + '</span>' + (cfg.badge ? '<span class="badge">' + cfg.badge + '</span>' : '');
      nav.appendChild(btn);
    });

    function activate(target) {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      const btn = document.querySelector('[data-target="' + target + '"]');
      if (btn) btn.classList.add('active');
      if (target === 'overview') {
        content.innerHTML = overviewHtml;
      } else if (reports[target]) {
        const md = typeof marked !== 'undefined' ? marked.parse(reports[target]) : '<pre>' + reports[target].replace(/</g, '&lt;') + '</pre>';
        content.innerHTML = '<div class="main-inner" style="animation:fadeIn 0.2s ease">' + md + '</div>';
      }
      document.querySelector('.sidebar').classList.remove('open');
    }

    document.querySelectorAll('.nav-item').forEach((btn) => {
      btn.addEventListener('click', () => activate(btn.dataset.target));
    });
  </script>
</body>
</html>
`;
}
