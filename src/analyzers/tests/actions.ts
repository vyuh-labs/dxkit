/**
 * Test-gap remediation actions — ranked by projected score impact.
 */
import { Evidence } from '../evidence';
import { RemediationAction } from '../remediation';
import { TestGapsReport, SourceFile, RiskTier } from './types';
import { TestGapsCounts } from './scoring';

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
    rationale: `These ${tier} files carry the largest untested risk. Start with the largest by LOC.`,
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
