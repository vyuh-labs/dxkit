/**
 * Detailed health report — JSON schema + markdown formatter.
 *
 * Aggregates per-dimension remediation plans with projected deltas, plus
 * cross-references into the per-analyzer detailed reports for deep evidence
 * (top clones, all CVEs, full gap lists, etc.).
 */
import { HealthReport, HealthMetrics } from '../types';
import { buildHealthPlans, DimensionPlan } from './actions';
import { computeOverall, ScoreInput } from '../scoring';

export interface HealthDetailedReport extends HealthReport {
  schemaVersion: string;
  plans: DimensionPlan[];
  /** Projected overall if every ranked action is applied. */
  projectedOverallScore: number;
  projectedGrade: 'A' | 'B' | 'C' | 'D' | 'F';
  /** Relative paths to the dimension-specific detailed reports, if generated. */
  crossRefs: {
    vulnerabilities: string;
    testGaps: string;
    quality: string;
    developer: string;
  };
}

const DIM_TO_KEY: Record<string, keyof HealthReport['dimensions']> = {
  Testing: 'testing',
  Quality: 'quality',
  Documentation: 'documentation',
  Security: 'security',
  Maintainability: 'maintainability',
  'Developer Experience': 'developerExperience',
};

export function buildHealthDetailed(
  report: HealthReport,
  metrics: HealthMetrics,
): HealthDetailedReport {
  // Plans depend on capability-owned fields too; pull them from the report
  // (always populated on real runs, defaults to {} for hand-built fixtures
  // until C.7 narrows the type).
  const scoreInput: ScoreInput = { metrics, capabilities: report.capabilities ?? {} };
  const plans = buildHealthPlans(scoreInput);

  // Build the "ideal" dimension scores by starting from the current report's
  // dimensions and swapping each dimension's score for its plan ideal.
  const projectedDims = {
    testing: { ...report.dimensions.testing, score: 0 },
    quality: { ...report.dimensions.quality, score: 0 },
    documentation: { ...report.dimensions.documentation, score: 0 },
    security: { ...report.dimensions.security, score: 0 },
    maintainability: { ...report.dimensions.maintainability, score: 0 },
    developerExperience: { ...report.dimensions.developerExperience, score: 0 },
  };
  for (const p of plans) {
    const k = DIM_TO_KEY[p.dimension];
    if (k) projectedDims[k].score = p.ideal;
  }
  const { overallScore: projected, grade: projectedGrade } = computeOverall(projectedDims);

  // Date prefix used for cross-refs so they match the sibling detailed filenames.
  const date = report.analyzedAt.slice(0, 10);
  const crossRefs = {
    vulnerabilities: `vulnerability-scan-${date}-detailed.md`,
    testGaps: `test-gaps-${date}-detailed.md`,
    quality: `quality-review-${date}-detailed.md`,
    developer: `developer-report-${date}-detailed.md`,
  };

  return {
    ...report,
    schemaVersion: '10c.1',
    plans,
    projectedOverallScore: projected,
    projectedGrade,
    crossRefs,
  };
}

export function formatHealthDetailedMarkdown(
  detailed: HealthDetailedReport,
  elapsed: string,
): string {
  const L: string[] = [];
  L.push('# Codebase Health Audit — Detailed');
  L.push('');
  L.push(`**Date:** ${detailed.analyzedAt.slice(0, 10)}`);
  L.push(`**Repository:** ${detailed.repo}`);
  L.push(`**Branch:** ${detailed.branch}`);
  L.push(`**Commit:** ${detailed.commitSha}`);
  L.push(`**Schema version:** ${detailed.schemaVersion}`);
  L.push('');
  L.push(
    `## Overall Health: ${detailed.summary.overallScore}/100 (Grade ${detailed.summary.grade}) → projected ${detailed.projectedOverallScore}/100 (Grade ${detailed.projectedGrade}) if every action is taken`,
  );
  L.push('');
  L.push('---');
  L.push('');

  // Dimension summary
  L.push('## Dimension Summary');
  L.push('');
  L.push('| Dimension | Current | Projected | Δ | Actions |');
  L.push('|-----------|--------:|----------:|--:|--------:|');
  for (const p of detailed.plans) {
    L.push(
      `| ${p.dimension} | ${p.baseline}/100 | ${p.ideal}/100 | +${p.ideal - p.baseline} | ${p.actions.length} |`,
    );
  }
  L.push('');
  L.push('---');
  L.push('');

  // Cross-references
  L.push('## Cross-References (Dimension Deep Dives)');
  L.push('');
  L.push('For per-finding evidence (file:line, CVE lists, clone pairs, gap inventories), see:');
  L.push('');
  L.push(`- **Security** → \`${detailed.crossRefs.vulnerabilities}\``);
  L.push(`- **Testing** → \`${detailed.crossRefs.testGaps}\``);
  L.push(`- **Quality/Slop** → \`${detailed.crossRefs.quality}\``);
  L.push(`- **Developer Activity** → \`${detailed.crossRefs.developer}\``);
  L.push('');
  L.push(
    'Generate them together with: `vyuh-dxkit health --detailed && vyuh-dxkit vulnerabilities --detailed && vyuh-dxkit test-gaps --detailed && vyuh-dxkit quality --detailed && vyuh-dxkit dev-report --detailed`',
  );
  L.push('');
  L.push('---');
  L.push('');

  // Per-dimension plans
  for (const p of detailed.plans) {
    L.push(`## ${p.dimension} (${p.baseline} → ${p.ideal}/100)`);
    L.push('');
    if (p.actions.length === 0) {
      L.push('No actionable improvements suggested for this dimension at current state.');
      L.push('');
      L.push('---');
      L.push('');
      continue;
    }
    L.push('| # | Action | Score Δ | Projected |');
    L.push('|---|--------|--------:|----------:|');
    p.actions.forEach((a, i) => {
      L.push(`| ${i + 1} | ${a.title} | +${a.scoreDelta} | ${a.projectedScore}/100 |`);
    });
    L.push('');
    for (const a of p.actions) {
      L.push(`### ${a.title} (+${a.scoreDelta})`);
      L.push(`- **ID:** \`${a.id}\``);
      L.push(`- **Baseline:** ${a.baselineScore}/100`);
      L.push(`- **Projected:** ${a.projectedScore}/100`);
      if (a.rationale) L.push(`- **Why:** ${a.rationale}`);
      if (a.evidence.length > 0) {
        L.push('- **Evidence:**');
        for (const e of a.evidence.slice(0, 5)) {
          const loc = e.line ? `:${e.line}` : '';
          L.push(`  - \`${e.file}${loc}\` — ${e.message || e.rule}`);
        }
      }
      L.push('');
    }
    L.push('---');
    L.push('');
  }

  // Languages
  if (detailed.languages.length > 0) {
    L.push('## Language Breakdown');
    L.push('');
    L.push('| Language | Files | Lines | % |');
    L.push('|----------|------:|------:|--:|');
    for (const l of detailed.languages) {
      L.push(`| ${l.name} | ${l.files} | ${l.lines.toLocaleString()} | ${l.percentage}% |`);
    }
    L.push('');
    L.push('---');
    L.push('');
  }

  L.push(`**Tools used:** ${detailed.toolsUsed.join(', ')}`);
  if (detailed.toolsUnavailable.length > 0) {
    L.push(`**Tools unavailable:** ${detailed.toolsUnavailable.join(', ')}`);
  }
  L.push(`**Analysis time:** ${elapsed}s`);
  L.push('');
  L.push(
    '*Generated by [VyuhLabs DXKit](https://www.npmjs.com/package/@vyuhlabs/dxkit) — detailed mode*',
  );
  return L.join('\n');
}
