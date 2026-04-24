/**
 * BOM (Bill of Materials) analyzer — public API.
 *
 * Joins the LICENSES and DEP_VULNS capabilities by `package@version`
 * to produce one row per installed package with both license inventory
 * data (cols 1-9, 15) and per-package vulnerability rollup
 * (cols 11-13). Output formats:
 *
 *   - `formatBomReport(report)` — markdown summary for
 *     `.dxkit/reports/bom-<date>.md` and PR comments.
 *   - JSON via the CLI's `--json` flag (10h.3.9) — schema-versioned
 *     pass-through with the added summary + repo metadata.
 *   - XLSX via the shared converter (10h.3.9) — drop-in replacement
 *     for the customer's spreadsheet workflow with cols 11-13 filled.
 */

import * as path from 'path';
import { detect } from '../../detect';
import { collectFingerprints } from '../tools/fingerprint';
import { run } from '../tools/runner';
import { discoverProjectRoots } from './discovery';
import { buildByTopLevelDep, gatherBomEntries, mergeNestedBomEntries } from './gather';
import { licenseClass, stalenessTier, type LicenseClass } from './pm-signals';
import type { BomEntry, BomReport, BomSeverity } from './types';

export type { BomReport, BomEntry } from './types';

export type BomFilter = 'all' | 'top-level';

export interface AnalyzeBomOptions {
  verbose?: boolean;
  /** Row filter. `'all'` emits every package (default, no behavior change).
   *  `'top-level'` keeps only direct manifest deps; `byTopLevelDep`
   *  (which attributes transitive advisories to their parent) is
   *  computed on the unfiltered set so the rollup still answers
   *  "upgrading @loopback/cli resolves 29 advisories" even when the
   *  29 transitive rows themselves are hidden. Entries with
   *  `isTopLevel === false` are dropped; `undefined` passes through. */
  filter?: BomFilter;
  /** When `true` (default), walk the repo and aggregate every sub-project
   *  root with a language manifest. Closes D001a: `bom platform/` would
   *  previously miss `platform/userserver/` entirely. Set `false` to
   *  restore the pre-10h.5.0b root-only behavior (useful when the caller
   *  has already narrowed to a single project and wants to avoid the
   *  walk cost / cross-root merge). */
  nested?: boolean;
}

export async function analyzeBom(
  repoPath: string,
  options: AnalyzeBomOptions = {},
): Promise<BomReport> {
  const stack = detect(repoPath);
  const nested = options.nested ?? true;
  const gatherResult = nested ? await gatherNested(repoPath) : await gatherBomEntries(repoPath);
  const { entries: rawEntries, toolsUsed, toolsUnavailable, projectRoots } = gatherResult;

  // byTopLevelDep must be built from the full entry set so the rollup
  // continues to reflect the complete blast radius of upgrading each
  // top-level dep — independent of whether the user requested the
  // filtered row view.
  const byTopLevelDep = buildByTopLevelDep(rawEntries);

  const filter: BomFilter = options.filter ?? 'all';
  const entries =
    filter === 'top-level' ? rawEntries.filter((e) => e.isTopLevel !== false) : rawEntries;

  const bySeverity: Record<BomSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  let vulnerablePackages = 0;
  let actionableVulns = 0;
  let totalAdvisories = 0;
  let vulnOnlyPackages = 0;
  for (const e of entries) {
    if (e.maxSeverity) {
      bySeverity[e.maxSeverity]++;
      vulnerablePackages++;
      if (e.upgradeAdvice.startsWith('PROPOSAL:')) actionableVulns++;
    }
    totalAdvisories += e.vulns.length;
    if (!e.joinedFromBoth) vulnOnlyPackages++;
  }

  // Manifest of every advisory identity in the (post-filter) report.
  // Drawn from `entries` rather than `rawEntries` so `filter=top-level`
  // reports surface only the fingerprints the caller actually sees —
  // diffing two filtered reports stays consistent.
  const fingerprints = collectFingerprints(entries.flatMap((e) => e.vulns));

  return {
    repo: stack.projectName || path.basename(repoPath),
    analyzedAt: new Date().toISOString(),
    commitSha: run('git rev-parse --short HEAD 2>/dev/null', repoPath),
    branch: run('git rev-parse --abbrev-ref HEAD 2>/dev/null', repoPath),
    schemaVersion: '1',
    summary: {
      totalPackages: entries.length,
      bySeverity,
      vulnerablePackages,
      actionableVulns,
      totalAdvisories,
      vulnOnlyPackages,
      byTopLevelDep,
      filter,
      unfilteredTotalPackages: rawEntries.length,
      projectRoots,
      fingerprints,
    },
    entries,
    toolsUsed,
    toolsUnavailable,
  };
}

/**
 * Run gatherBomEntries against every discovered project root and
 * merge. When only one root is found (single-project repos, the
 * common case), short-circuits to a normal gather with
 * `projectRoots: ["."]` — zero overhead beyond the directory walk.
 */
async function gatherNested(
  repoPath: string,
): Promise<ReturnType<typeof gatherBomEntries> extends Promise<infer T> ? T : never> {
  const absRoots = discoverProjectRoots(repoPath);
  if (absRoots.length <= 1) {
    // No sub-roots discovered (or only cwd itself): fall through to
    // the non-nested path so the output shape is identical.
    return gatherBomEntries(repoPath);
  }
  const perRoot = await Promise.all(
    absRoots.map(async (absRoot) => ({
      relPath: path.relative(repoPath, absRoot) || '.',
      result: await gatherBomEntries(absRoot),
    })),
  );
  return mergeNestedBomEntries(perRoot);
}

const SEV_BADGE: Record<BomSeverity, string> = {
  critical: 'CRITICAL',
  high: 'HIGH',
  medium: 'MEDIUM',
  low: 'LOW',
};

/**
 * Row in the "This Week's Triage" section. Pure projection over the
 * flattened advisories sorted by riskScore desc — exposed for tests
 * so the one-line rationale logic is verifiable without a full report
 * fixture.
 */
export interface TriageRow {
  risk: number;
  id: string;
  packageAtVersion: string;
  rationale: string;
  fix: string;
}

/**
 * Build the triage list: top N advisories by riskScore across the
 * whole bom, each with a one-line rationale stitched from the
 * signals that drove the score. Filters out advisories below
 * `minRisk` so the section stays the "interesting" subset —
 * not every advisory the bom touched.
 *
 * Rationale is constructed left-to-right from the most decisive
 * signals: KEV > reachable > high CVSS > high EPSS, so the reader
 * can immediately see *why* this entry sits high. Examples:
 *
 *   - "KEV, reachable, CVSS 9.8"
 *   - "reachable, CVSS 4.8"
 *   - "CVSS 9.1" (transitive only, no reach/KEV signal)
 *
 * Pure function; exported for unit tests.
 */
export function buildTriageRows(report: BomReport, limit: number, minRisk: number): TriageRow[] {
  interface Flat {
    risk: number;
    id: string;
    packageAtVersion: string;
    cvss?: number;
    epss?: number;
    kev?: boolean;
    reachable?: boolean;
    upgradeAdvice: string;
  }
  const flat: Flat[] = [];
  for (const e of report.entries) {
    for (const v of e.vulns) {
      if (typeof v.riskScore !== 'number') continue;
      if (v.riskScore < minRisk) continue;
      flat.push({
        risk: v.riskScore,
        id: v.id,
        packageAtVersion: `${e.package}@${e.version}`,
        cvss: v.cvssScore,
        epss: v.epssScore,
        kev: v.kev,
        reachable: v.reachable,
        upgradeAdvice: v.upgradeAdvice ?? e.upgradeAdvice,
      });
    }
  }
  flat.sort((a, b) => b.risk - a.risk || a.id.localeCompare(b.id));
  const top = flat.slice(0, limit);

  return top.map((f) => {
    const parts: string[] = [];
    if (f.kev) parts.push('KEV');
    if (f.reachable === true) parts.push('reachable');
    if (f.reachable === false) parts.push('not reachable');
    if (typeof f.cvss === 'number') parts.push(`CVSS ${f.cvss.toFixed(1)}`);
    if (typeof f.epss === 'number' && f.epss >= 0.01) {
      parts.push(`EPSS ${(f.epss * 100).toFixed(1)}%`);
    }
    const rationale = parts.length > 0 ? parts.join(', ') : '—';
    // Keep fix concise: strip the leading "PROPOSAL:" noise so the
    // cell reads as a direct instruction.
    const fix = (f.upgradeAdvice || '—').replace(/^PROPOSAL:\s*/, '').replace(/\|/g, '\\|');
    return {
      risk: f.risk,
      id: f.id,
      packageAtVersion: f.packageAtVersion,
      rationale,
      fix,
    };
  });
}

export function formatBomReport(report: BomReport, elapsed: string): string {
  const L: string[] = [];

  L.push('# Bill of Materials (BOM) Report');
  L.push('');
  L.push(`**Date:** ${report.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${report.repo}`);
  L.push(`**Branch:** ${report.branch} (${report.commitSha})`);
  L.push('');
  L.push('---');
  L.push('');

  // Executive Summary — one-screen answer to "what's the state of this
  // repo's deps". Written for a PM / security reviewer who needs to
  // decide "can we ship?" without scrolling.
  writeExecutiveSummaryMd(L, report);

  // "This Week's Triage" — top advisories by riskScore, rendered
  // before the summary so the reader sees what to fix *first* above
  // the statistical overview. Only included when at least one
  // advisory crossed the moderate risk threshold (≥ 15). Limits
  // to 10 rows to keep it scannable; the full inventory follows.
  const triage = buildTriageRows(report, 10, 15);
  if (triage.length > 0) {
    L.push("## This Week's Triage");
    L.push('');
    L.push(
      `Top ${triage.length} advisor${triage.length === 1 ? 'y' : 'ies'} by composite ` +
        'risk score (CVSS × KEV × EPSS × reachable). Fix from the top of this list — ' +
        'higher score = more signal that it matters *right now*.',
    );
    L.push('');
    L.push('| Risk | ID | Package@Version | Rationale | Fix |');
    L.push('|-----:|----|-----------------|-----------|-----|');
    for (const row of triage) {
      L.push(
        `| **${row.risk.toFixed(0)}** | \`${row.id}\` | \`${row.packageAtVersion}\` | ${row.rationale} | ${row.fix} |`,
      );
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Summary
  const s = report.summary;
  L.push('## Summary');
  L.push('');
  if (s.projectRoots.length > 1) {
    L.push(
      `**Aggregated across ${s.projectRoots.length} project roots** — ` +
        s.projectRoots.map((r) => `\`${r}\``).join(', ') +
        '. Each row unions the roots that installed the package (see `sources`).',
    );
    L.push('');
  }
  if (s.filter === 'top-level') {
    L.push(
      `**${s.totalPackages} top-level packages** (of ${s.unfilteredTotalPackages} installed) across the active language pack(s). ` +
        `Transitive rows are hidden; the advisory rollup under "Top-Level Dep Groups" ` +
        `still reflects the full blast radius.`,
    );
  } else {
    L.push(`**${s.totalPackages} packages** indexed across the active language pack(s).`);
  }
  L.push('');
  if (s.vulnerablePackages > 0) {
    L.push(
      `**${s.vulnerablePackages} packages** carry known vulnerabilities — ` +
        `**${s.totalAdvisories} advisories** in total ` +
        `(one package can have many advisories, e.g. multiple CVEs against ` +
        `the same installed version). ` +
        `**${s.actionableVulns}** of those packages have a Tier-1 upgrade proposal.`,
    );
    L.push('');
    L.push(
      `> The numbers reconcile with \`vyuh-dxkit vulnerabilities\`: ` +
        `that command reports per-advisory (${s.totalAdvisories}); bom collapses ` +
        `them per-package (${s.vulnerablePackages}) so each row of the ` +
        `xlsx is one upgrade decision.`,
    );
    L.push('');
    L.push('| Severity (worst-of-package) | Vulnerable Packages |');
    L.push('|-----------------------------|--------------------:|');
    L.push(`| CRITICAL | ${s.bySeverity.critical} |`);
    L.push(`| HIGH     | ${s.bySeverity.high} |`);
    L.push(`| MEDIUM   | ${s.bySeverity.medium} |`);
    L.push(`| LOW      | ${s.bySeverity.low} |`);
    L.push('');
  }
  if (s.vulnOnlyPackages > 0) {
    L.push(
      `> ⚠️ ${s.vulnOnlyPackages} package(s) reported only by the vulnerability scanner — ` +
        `the license scanner missed them (likely a workspace / sub-package). ` +
        `These rows show "UNKNOWN" license; verify manually before shipping.`,
    );
    L.push('');
  }
  L.push('---');
  L.push('');

  // Snyk-style top-level dep rollup — upgrade-oriented view answering
  // "which single `npm install X` / `go get Y` resolves the most
  // advisories". Only rendered when at least one finding carried
  // topLevelDep attribution (packs that can't parse a lockfile/graph
  // simply don't populate it).
  const topLevelEntries = Object.entries(s.byTopLevelDep);
  if (topLevelEntries.length > 0) {
    L.push('## Top-Level Dep Groups');
    L.push('');
    L.push(
      'Grouped by direct manifest dep so each row is one upgrade decision. ' +
        'Sorted by severity, then advisory count — the top row is the single ' +
        'upgrade that resolves the most critical/highest-volume issues.',
    );
    L.push('');
    L.push(
      '> **Scope note:** this section walks **transitive** advisories too, so its numbers ' +
        "intentionally don't sum to the Summary totals above. `Rolled-up Advisories` counts " +
        'each CVE once per top-level parent it reaches through — the same CVE under two ' +
        'parents is counted twice, because upgrading either parent resolves it. A CRITICAL ' +
        'here can exist even when zero directly-listed packages are CRITICAL — it means ' +
        'a transitive dep is critical and upgrading this top-level clears it.',
    );
    L.push('');
    const SEV_RANK: Record<BomSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = topLevelEntries.sort(
      (a, b) =>
        SEV_RANK[a[1].maxSeverity] - SEV_RANK[b[1].maxSeverity] ||
        b[1].advisoryCount - a[1].advisoryCount ||
        a[0].localeCompare(b[0]),
    );
    const cap = 30;
    const shown = sorted.slice(0, cap);
    L.push('| Worst Severity | Top-Level Dep | Rolled-up Advisories | Vulnerable Packages |');
    L.push('|----------------|---------------|---------------------:|---------------------|');
    for (const [top, r] of shown) {
      const pkgCap = 8;
      const pkgList =
        r.packages.length > pkgCap
          ? `${r.packages.slice(0, pkgCap).join(', ')}, +${r.packages.length - pkgCap} more`
          : r.packages.join(', ');
      L.push(`| ${SEV_BADGE[r.maxSeverity]} | \`${top}\` | ${r.advisoryCount} | ${pkgList} |`);
    }
    if (sorted.length > cap) {
      L.push('');
      L.push(`_Showing ${cap} of ${sorted.length} top-level deps with rolled-up advisories._`);
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Vulnerable packages section — worst-first, one row per package
  if (s.vulnerablePackages > 0) {
    L.push('## Vulnerable Packages');
    L.push('');
    L.push(
      'Sorted by **composite risk score** (CVSS × KEV × EPSS × reachable) when available, ' +
        'falling back to severity + alphabetical. Resolution shows the Tier-1 derived upgrade ' +
        'target (or "No fix available" when an advisory has no published patch).',
    );
    L.push('');
    const SEV_RANK: Record<BomSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const maxRisk = (e: BomEntry): number => {
      let best = -1;
      for (const v of e.vulns) {
        if (typeof v.riskScore === 'number' && v.riskScore > best) best = v.riskScore;
      }
      return best;
    };
    const vuln: BomEntry[] = report.entries
      .filter((e) => e.maxSeverity)
      .sort((a, b) => {
        const ra = maxRisk(a);
        const rb = maxRisk(b);
        if (ra !== rb) return rb - ra; // higher risk first
        return (
          SEV_RANK[a.maxSeverity!] - SEV_RANK[b.maxSeverity!] || a.package.localeCompare(b.package)
        );
      });
    const cap = 50;
    const shown = vuln.slice(0, cap);
    L.push(
      '| Risk | Severity | CVSS | Package@Version | License | # Vulns | KEV | Reach | EPSS | Resolution |',
    );
    L.push(
      '|-----:|----------|-----:|-----------------|---------|--------:|:---:|:-----:|-----:|------------|',
    );
    for (const e of shown) {
      const advice = e.upgradeAdvice.replace(/\|/g, '\\|');
      const epssScores = e.vulns
        .map((v) => v.epssScore)
        .filter((s): s is number => typeof s === 'number');
      // Max EPSS across the package's advisories — "how likely is *something*
      // in this package to get hit this month". Rendered as pct for
      // human readability (2 decimals so low-but-nonzero scores remain
      // visible), dash when no CVE had an EPSS entry.
      const epssCell =
        epssScores.length > 0 ? `${(Math.max(...epssScores) * 100).toFixed(2)}%` : '—';
      // Max CVSS across the package's advisories — exposes the raw
      // numeric severity alongside the categorical bucket so readers
      // can distinguish 7.1 from 9.8 when both bucket as HIGH. Dash
      // when no advisory had CVSS data.
      const cvssScores = e.vulns
        .map((v) => v.cvssScore)
        .filter((s): s is number => typeof s === 'number');
      const cvssCell = cvssScores.length > 0 ? Math.max(...cvssScores).toFixed(1) : '—';
      // KEV cell: `⚠` when any advisory is in the CISA KEV catalog —
      // the strongest "fix now" signal we can surface. Empty otherwise.
      const kevCell = e.vulns.some((v) => v.kev) ? '⚠' : '';
      // Reach cell: `✓` when the repo's source imports this package
      // (any advisory on it is reachable); empty cell when every
      // advisory's `reachable === false`. Unset → blank (treated as
      // "don't know", which is safer than implying non-reachability).
      const reachCell = e.vulns.some((v) => v.reachable === true) ? '✓' : '';
      // Risk: max composite riskScore across the package's advisories.
      // Leading column so the eye catches priority first. Dash when
      // no advisory had a CVSS (riskScore uncomputable).
      const risk = maxRisk(e);
      const riskCell = risk >= 0 ? `**${risk.toFixed(0)}**` : '—';
      L.push(
        `| ${riskCell} | ${SEV_BADGE[e.maxSeverity!]} | ${cvssCell} | \`${e.package}@${e.version}\` | ${e.licenseType} | ${e.vulns.length} | ${kevCell} | ${reachCell} | ${epssCell} | ${advice} |`,
      );
    }
    if (vuln.length > cap) {
      L.push('');
      L.push(
        `_Showing ${cap} of ${vuln.length} vulnerable packages. Run with \`--detailed\` for the full inventory + per-advisory CVE list._`,
      );
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Footer
  L.push(`**Tools used:** ${report.toolsUsed.join(', ') || '(none)'}`);
  if (report.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${report.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push('*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit)*');

  return L.join('\n');
}

// ─── Executive Summary (top of bom markdown) ────────────────────────────────

/**
 * One-screen exec summary. Four question-driven lines:
 *   1. Can we ship? (0 blockers if no KEV + high-risk reachable finding)
 *   2. What's the sprint list? (count of risk-tier findings)
 *   3. License compliance exposure? (count of copyleft-strong + unknown)
 *   4. Staleness? (count of deps > 2 years old)
 * Plus the single upgrade with biggest blast-radius win (byTopLevelDep top).
 */
function writeExecutiveSummaryMd(L: string[], report: BomReport): void {
  const s = report.summary;
  L.push('## 🎯 Executive Summary');
  L.push('');
  // Ship-blockers: Critical or High + (KEV or reachable) — this is the "drop
  // everything" bucket. Anything severe + evidence of real-world risk.
  let shipBlockers = 0;
  let actionable = 0;
  for (const e of report.entries) {
    for (const v of e.vulns) {
      const sev = v.severity === 'critical' || v.severity === 'high';
      const realRisk = v.kev === true || v.reachable === true;
      if (sev && realRisk) shipBlockers++;
      if (typeof v.riskScore === 'number' && v.riskScore >= 40) actionable++;
    }
  }

  const blockerLine =
    shipBlockers === 0
      ? '✅ **0 ship-blockers** (no critical/high advisories are KEV-listed AND reachable)'
      : `🚫 **${shipBlockers} ship-blocker${shipBlockers === 1 ? '' : 's'}** — critical/high severity + (KEV or reachable). See "This Week's Triage" below.`;
  L.push(`- ${blockerLine}`);

  L.push(
    `- 🔥 **${actionable} finding${actionable === 1 ? '' : 's'} for this sprint** (risk score ≥ 40)`,
  );

  // License exposure
  const licByClass = new Map<LicenseClass, number>();
  for (const e of report.entries) {
    const c = licenseClass(e.licenseType);
    licByClass.set(c, (licByClass.get(c) ?? 0) + 1);
  }
  const strong = licByClass.get('copyleft-strong') ?? 0;
  const unknownLic = licByClass.get('unknown') ?? 0;
  const licBits: string[] = [];
  if (strong > 0) licBits.push(`${strong} copyleft-strong (review obligations)`);
  if (unknownLic > 0) licBits.push(`${unknownLic} unknown (needs classification)`);
  L.push(
    `- 📜 **License exposure:** ${licBits.length > 0 ? licBits.join('; ') : 'all permissive — no action needed'}`,
  );

  // Staleness
  const now = new Date();
  const staleCount = report.entries.filter(
    (e) => stalenessTier(e.releaseDate, now) === 'stale',
  ).length;
  L.push(
    `- 🗓️ **Staleness:** ${staleCount} package${staleCount === 1 ? '' : 's'} released > 3 years ago`,
  );

  // Highest-leverage upgrade
  const rollup = Object.entries(s.byTopLevelDep).sort((a, b) => {
    const SEV_RANK: Record<BomSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    return (
      SEV_RANK[a[1].maxSeverity] - SEV_RANK[b[1].maxSeverity] ||
      b[1].advisoryCount - a[1].advisoryCount
    );
  });
  if (rollup.length > 0) {
    const [name, r] = rollup[0];
    L.push(
      `- 🎯 **Highest-leverage upgrade:** \`${name}\` — resolves up to ${r.advisoryCount} transitive advisor${r.advisoryCount === 1 ? 'y' : 'ies'} (worst ${SEV_BADGE[r.maxSeverity]})`,
    );
  }
  L.push('');
  L.push('---');
  L.push('');
}
