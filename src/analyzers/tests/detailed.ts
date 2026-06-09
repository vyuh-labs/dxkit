/**
 * Detailed test-gaps report — JSON schema + markdown formatter.
 */
import { TestGapsReport, SourceFile, RiskTier } from './types';
import { RankedAction, rank } from '../remediation';
import { buildTestGapsActions, countsFromReport, weightGapsByBlastRadius } from './actions';
import { TestGapsCounts, scoreTestGapsCounts } from './scoring';
import { renderToolsUnavailableLines } from '../tools/tools-unavailable-prose';
import {
  formatGraphContextCell,
  graphContextProvenanceLine,
  locationKey,
  type DetailedGraphContext,
} from '../../explore/finding-context';
import {
  formatAttributionCell,
  attributionProvenanceLine,
  type DetailedAttribution,
} from '../../attribution/attribute';

export interface TestGapsDetailedReport extends TestGapsReport {
  schemaVersion: string;
  coverageScore: number;
  actions: Array<RankedAction<TestGapsCounts>>;
  /**
   * Per-gap graph context (module + blast radius), keyed by file path.
   * A high-blast-radius untested file is higher-stakes than a leaf.
   * Present only when `--graph-context` ran AND a graph loaded.
   */
  graphContext?: DetailedGraphContext;
  /** Per-gap "who to ask" (file owner), keyed by file path. Present only
   *  when the run passed `--attribute`. */
  attribution?: DetailedAttribution;
}

export function buildTestGapsDetailed(
  report: TestGapsReport,
  graphContext?: DetailedGraphContext,
  attribution?: DetailedAttribution,
): TestGapsDetailedReport {
  const counts = countsFromReport(report);
  // When a graph is present, re-rank the gap worklist by blast radius so
  // the most-depended-on untested files surface first (within tier). This
  // re-orders only — `counts` (and therefore the score) come from the
  // summary, untouched by gap order.
  const weighted = graphContext
    ? { ...report, gaps: weightGapsByBlastRadius(report.gaps, graphContext) }
    : report;
  const actions = rank(buildTestGapsActions(weighted), counts, scoreTestGapsCounts);
  return {
    ...weighted,
    schemaVersion: '11',
    coverageScore: scoreTestGapsCounts(counts).score,
    actions,
    ...(graphContext ? { graphContext } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

const TIER_ORDER: Record<RiskTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function formatTestGapsDetailedMarkdown(
  detailed: TestGapsDetailedReport,
  elapsed: string,
): string {
  const L: string[] = [];
  const s = detailed.summary;

  L.push('# Test Gap Analysis — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch} (${detailed.commitSha})`);
  L.push(`**Effective Coverage:** ${s.effectiveCoverage}%`);
  L.push(`**Risk-Weighted Score:** ${detailed.coverageScore}/100`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push('---');
  L.push('');

  // Summary
  L.push('## Summary');
  L.push('');
  L.push('| Metric | Value |');
  L.push('|--------|------:|');
  L.push(
    `| Test files | ${s.testFiles} (active: ${s.activeTestFiles}, commented-out: ${s.commentedOutFiles}) |`,
  );
  L.push(`| Source files | ${s.sourceFiles} |`);
  L.push(`| Untested (CRITICAL) | ${s.untestedCritical} |`);
  L.push(`| Untested (HIGH) | ${s.untestedHigh} |`);
  L.push(`| Untested (MEDIUM) | ${s.untestedMedium} |`);
  L.push(`| Untested (LOW) | ${s.untestedLow} |`);
  L.push('');
  L.push('---');
  L.push('');

  // Actions
  L.push('## Recommended Actions');
  L.push('');
  if (detailed.actions.length === 0) {
    L.push('No gaps to close.');
  } else {
    L.push('Actions are ranked by projected risk-weighted score improvement.');
    L.push('');
    L.push('| # | Action | Score Δ | Projected |');
    L.push('|---|--------|--------:|----------:|');
    detailed.actions.forEach((a, i) => {
      L.push(`| ${i + 1} | ${a.title} | +${a.scoreDelta} | ${a.projectedScore}/100 |`);
    });
    L.push('');
    for (const a of detailed.actions) {
      L.push(`### ${a.title} (+${a.scoreDelta})`);
      L.push('');
      L.push(`- **ID:** \`${a.id}\``);
      L.push(`- **Baseline:** ${a.baselineScore}/100`);
      L.push(`- **Projected:** ${a.projectedScore}/100`);
      if (a.rationale) L.push(`- **Why:** ${a.rationale}`);
      if (a.evidence.length) {
        L.push('- **Files:**');
        for (const e of a.evidence.slice(0, 20)) {
          L.push(`  - \`${e.file}\` — ${e.message || e.rule}`);
        }
        if (a.evidence.length > 20) L.push(`  - … and ${a.evidence.length - 20} more`);
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // Gaps inventory by risk tier
  L.push('## All Gaps by Risk Tier');
  L.push('');
  const gc = detailed.graphContext;
  const attr = detailed.attribution;
  if (gc) L.push(graphContextProvenanceLine(gc));
  if (attr) L.push(attributionProvenanceLine());
  if (gc || attr) L.push('');
  // Within a tier, prefer higher blast radius (most-depended-on first)
  // when the graph stamped it, falling back to LOC. Mirrors the worklist
  // ranking so the table and the actions agree on ordering.
  const sorted: SourceFile[] = [...detailed.gaps].sort(
    (a, b) =>
      TIER_ORDER[a.risk] - TIER_ORDER[b.risk] ||
      (b.blastRadius ?? -1) - (a.blastRadius ?? -1) ||
      b.lines - a.lines,
  );
  const grouped: Record<RiskTier, SourceFile[]> = {
    critical: [],
    high: [],
    medium: [],
    low: [],
  };
  for (const g of sorted) grouped[g.risk].push(g);

  for (const tier of ['critical', 'high', 'medium', 'low'] as RiskTier[]) {
    const items = grouped[tier];
    if (items.length === 0) continue;
    L.push(`### ${tier.toUpperCase()} (${items.length})`);
    L.push('');
    const headers = ['File', 'Type', 'Lines'];
    if (gc) headers.push('Graph context');
    if (attr) headers.push('Who to ask');
    L.push(`| ${headers.join(' | ')} |`);
    L.push(`|${headers.map((h) => (h === 'Lines' ? '-----:' : '---')).join('|')}|`);
    for (const g of items.slice(0, 50)) {
      const cells = [`\`${g.path}\``, g.type, String(g.lines)];
      if (gc) cells.push(formatGraphContextCell(gc.contexts[locationKey(g.path)]));
      if (attr) cells.push(formatAttributionCell(attr.attributions[locationKey(g.path)]));
      L.push(`| ${cells.join(' | ')} |`);
    }
    if (items.length > 50) {
      L.push(
        `| … and ${items.length - 50} more |${headers
          .slice(1)
          .map(() => ' |')
          .join('')}`,
      );
    }
    L.push('');
  }
  L.push('---');
  L.push('');

  L.push(`**Tools used:** ${detailed.toolsUsed.join(', ')}`);
  L.push(...renderToolsUnavailableLines(detailed.toolsUnavailable));
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push(
    '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) — detailed mode*',
  );
  return L.join('\n');
}
