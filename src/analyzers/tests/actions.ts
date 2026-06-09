/**
 * Test-gap remediation actions — ranked by projected score impact.
 */
import { Evidence } from '../evidence';
import { RemediationAction } from '../remediation';
import { TestGapsReport, SourceFile, RiskTier } from './types';
import { TestGapsCounts } from './scoring';
import { locationKey, type DetailedGraphContext } from '../../explore/finding-context';

const TIER_RANK: Record<RiskTier, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Re-rank the test-gap worklist by code-graph blast radius so the
 * most-depended-on untested files surface first WITHIN their risk tier.
 * Pure function — it receives the pre-built graph context (CLAUDE.md
 * Rule 12: analyzers never load the graph themselves) and never touches
 * the Tests score (which comes from summary counts, not gap order).
 *
 * Blast radius is stamped only when the file is in the graph AND the
 * language's call graph is reliable — an untrustworthy `0` from a
 * language graphify can't resolve (e.g. C#) is treated as UNKNOWN, not
 * a leaf. Within a tier: known higher-blast first, then by LOC. Files
 * the graph couldn't resolve keep their LOC rank after the
 * graph-confirmed high-impact ones — they're re-ordered, never dropped
 * and never labelled "safe."
 */
export function weightGapsByBlastRadius(
  gaps: ReadonlyArray<SourceFile>,
  graphContext: DetailedGraphContext,
): SourceFile[] {
  const stamped = gaps.map((g) => {
    const ctx = graphContext.contexts[locationKey(g.path)];
    const reliable = ctx?.found && ctx.callGraphReliability !== 'unreliable';
    if (!reliable) return { ...g };
    return { ...g, blastRadius: ctx.blastRadius.callerFiles };
  });
  return stamped.sort((a, b) => {
    if (TIER_RANK[a.risk] !== TIER_RANK[b.risk]) return TIER_RANK[a.risk] - TIER_RANK[b.risk];
    const ba = a.blastRadius ?? -1;
    const bb = b.blastRadius ?? -1;
    if (ba !== bb) return bb - ba;
    return b.lines - a.lines;
  });
}

export function countsFromReport(report: TestGapsReport): TestGapsCounts {
  const s = report.summary;
  return {
    untestedCritical: s.untestedCritical,
    untestedHigh: s.untestedHigh,
    untestedMedium: s.untestedMedium,
    untestedLow: s.untestedLow,
    testedSource: s.sourceFiles - report.gaps.length,
    commentedOutFiles: s.commentedOutFiles,
  };
}

function fileToEvidence(f: SourceFile): Evidence {
  return {
    file: f.path,
    rule: `untested-${f.risk}`,
    tool: 'grep',
    message: `${f.type} (${f.lines} lines) — ${f.risk.toUpperCase()} risk`,
  };
}

const RISK_KEYS: Record<RiskTier, keyof TestGapsCounts> = {
  critical: 'untestedCritical',
  high: 'untestedHigh',
  medium: 'untestedMedium',
  low: 'untestedLow',
};

/** Action to test the top-K files at a given risk tier. */
function testTierAction(
  report: TestGapsReport,
  tier: RiskTier,
  topK: number,
): RemediationAction<TestGapsCounts> | null {
  const tierFiles = report.gaps.filter((g) => g.risk === tier).slice(0, topK);
  if (tierFiles.length === 0) return null;
  const key = RISK_KEYS[tier];
  return {
    id: `tests.add-${tier}-${tierFiles.length}`,
    title: `Add tests for top ${tierFiles.length} ${tier.toUpperCase()}-risk untested file${tierFiles.length === 1 ? '' : 's'}`,
    rationale: `These ${tier} files carry the largest untested risk. Start with the most-depended-on (highest blast radius), then the largest by LOC.`,
    evidence: tierFiles.map(fileToEvidence),
    patch: (c) => ({
      ...c,
      [key]: Math.max(0, c[key] - tierFiles.length),
      testedSource: c.testedSource + tierFiles.length,
    }),
  };
}

export function buildTestGapsActions(report: TestGapsReport): RemediationAction<TestGapsCounts>[] {
  const actions: RemediationAction<TestGapsCounts>[] = [];

  // 1. Restore commented-out test files (biggest atrophy signal)
  if (report.summary.commentedOutFiles > 0) {
    const commented = report.testFiles.filter((t) => t.status === 'commented-out');
    actions.push({
      id: 'tests.restore-commented-out',
      title: `Restore ${commented.length} commented-out test file${commented.length === 1 ? '' : 's'}`,
      rationale:
        'Tests commented out en-masse are usually broken-but-fixable. Restore or delete — do not leave atrophied.',
      evidence: commented.map(
        (t): Evidence => ({
          file: t.path,
          rule: 'commented-out-test',
          tool: 'grep',
          message: `Test file with every line commented out (framework: ${t.framework || 'unknown'})`,
        }),
      ),
      patch: (c) => ({ ...c, commentedOutFiles: 0 }),
    });
  }

  // 2-5. Per-tier actions, top 5 critical, top 10 high, etc.
  const tiers: Array<[RiskTier, number]> = [
    ['critical', 5],
    ['high', 10],
    ['medium', 10],
    ['low', 10],
  ];
  for (const [tier, topK] of tiers) {
    const a = testTierAction(report, tier, topK);
    if (a) actions.push(a);
  }

  return actions;
}
