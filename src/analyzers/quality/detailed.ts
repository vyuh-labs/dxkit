/**
 * Detailed quality report — JSON schema + markdown formatter.
 *
 * The JSON is the canonical, agent-consumable artifact. The markdown is
 * generated from the JSON so they never diverge.
 */
import { QualityReport, QualityMetrics } from './types';
import { RankedAction, rank } from '../remediation';
import { buildSlopActions } from './actions';
import { qualityMetricsToScoreInput } from './index';
import { QUALITY_SCORING_SPEC, evaluateSpec } from '../../scoring';
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

export interface QualityDetailedReport extends QualityReport {
  /** Schema version for agent consumers. Bump on breaking shape changes. */
  schemaVersion: string;
  /** Ranked remediation actions with simulated score deltas. */
  actions: Array<RankedAction<QualityMetrics>>;
  /**
   * Per-offender-file graph context (module + blast radius), keyed by
   * file path. Present only when `--graph-context` ran AND a graph
   * loaded.
   */
  graphContext?: DetailedGraphContext;
  /** Per-file "who to ask" (owner), keyed by file path. Present only when
   *  the run passed `--attribute`. */
  attribution?: DetailedAttribution;
}

export function buildQualityDetailed(
  report: QualityReport,
  graphContext?: DetailedGraphContext,
  attribution?: DetailedAttribution,
): QualityDetailedReport {
  const actions = rank(buildSlopActions(report.metrics), report.metrics, (m) =>
    evaluateSpec(QUALITY_SCORING_SPEC, qualityMetricsToScoreInput(m)),
  );
  return {
    ...report,
    schemaVersion: '11',
    actions,
    ...(graphContext ? { graphContext } : {}),
    ...(attribution ? { attribution } : {}),
  };
}

export function formatQualityDetailedMarkdown(
  detailed: QualityDetailedReport,
  elapsed: string,
): string {
  const L: string[] = [];
  const m = detailed.metrics;

  L.push('# Code Quality Review — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch} (${detailed.commitSha})`);
  L.push(`**Slop Score:** ${detailed.slopScore}/100`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push('---');
  L.push('');

  // Ranked actions
  L.push('## Recommended Actions');
  L.push('');
  if (detailed.actions.length === 0) {
    L.push('No remediation actions suggested — slop score has no actionable deductions.');
  } else {
    L.push(
      'Actions are ranked by projected score improvement. Each delta is computed by simulating the scorer with the patched metrics.',
    );
    L.push('');
    L.push('| # | Action | Score Δ | Projected | Evidence |');
    L.push('|---|--------|--------:|----------:|----------|');
    detailed.actions.forEach((a, i) => {
      const evSuffix = a.evidence.length
        ? `${a.evidence.length} item${a.evidence.length === 1 ? '' : 's'}`
        : '—';
      L.push(
        `| ${i + 1} | ${a.title} | +${a.scoreDelta} | ${a.projectedScore}/100 | ${evSuffix} |`,
      );
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
        L.push('- **Evidence:**');
        for (const e of a.evidence.slice(0, 10)) {
          const loc = e.line ? `:${e.line}${e.endLine ? `-${e.endLine}` : ''}` : '';
          L.push(`  - \`${e.file}${loc}\` — ${e.message || e.rule}`);
        }
        if (a.evidence.length > 10) {
          L.push(`  - … and ${a.evidence.length - 10} more`);
        }
      }
      L.push('');
    }
  }
  L.push('---');
  L.push('');

  // Top duplicate clones
  if (m.duplication?.topClones && m.duplication.topClones.length > 0) {
    L.push('## Top Duplicate Clones');
    L.push('');
    L.push('| Lines | File A | File B |');
    L.push('|------:|--------|--------|');
    for (const c of m.duplication.topClones) {
      L.push(
        `| ${c.lines} | \`${c.a.file}:${c.a.startLine}-${c.a.endLine}\` | \`${c.b.file}:${c.b.startLine}-${c.b.endLine}\` |`,
      );
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  // Top offenders — enriched with graph context (module + blast radius)
  // when --graph-context ran, so a reader sees how central each
  // offender file is before deciding to touch it.
  const gc = detailed.graphContext;
  const attr = detailed.attribution;
  let provenancePrinted = false;
  const offenderProvenance = () => {
    if (provenancePrinted) return;
    if (gc) L.push(graphContextProvenanceLine(gc));
    if (attr) L.push(attributionProvenanceLine());
    if (gc || attr) L.push('');
    provenancePrinted = true;
  };

  // Column-driven offender table — graph context + attribution compose.
  const offenderTable = (files: ReadonlyArray<{ file: string; count: number }>) => {
    const headers = ['File', 'Count'];
    if (gc) headers.push('Graph context');
    if (attr) headers.push('Who to ask');
    L.push(`| ${headers.join(' | ')} |`);
    L.push(`|${headers.map((h) => (h === 'Count' ? '-----:' : '---')).join('|')}|`);
    for (const f of files) {
      const cells = [`\`${f.file}\``, String(f.count)];
      if (gc) cells.push(formatGraphContextCell(gc.contexts[locationKey(f.file)]));
      if (attr) cells.push(formatAttributionCell(attr.attributions[locationKey(f.file)]));
      L.push(`| ${cells.join(' | ')} |`);
    }
  };

  if (m.topConsoleFiles && m.topConsoleFiles.length > 0) {
    L.push('## Files with Most Console Statements');
    L.push('');
    offenderProvenance();
    offenderTable(m.topConsoleFiles);
    L.push('');
  }

  if (m.topTodoFiles && m.topTodoFiles.length > 0) {
    L.push('## Files with Most TODO/FIXME/HACK');
    L.push('');
    offenderProvenance();
    offenderTable(m.topTodoFiles);
    L.push('');
  }

  if (m.staleFiles.length > 0) {
    L.push('## Stale Files Committed to Git');
    L.push('');
    for (const f of m.staleFiles) L.push(`- \`${f}\``);
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
