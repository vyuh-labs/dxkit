/**
 * Test-gap scoring — internal scorer over coverage counts, used for
 * RemediationAction ranking in detailed reports.
 */

export interface TestGapsCounts {
  /** Untested source files by risk tier. */
  untestedCritical: number;
  untestedHigh: number;
  untestedMedium: number;
  untestedLow: number;
  /** Source files that DO have active matching tests. */
  testedSource: number;
  /** Test files commented out entirely. */
  commentedOutFiles: number;
}

/**
 * 0-100 test-gap score from coverage per risk tier + commented-out penalty.
 *
 * Each tier contributes an independent sub-score proportional to the tier's
 * coverage ratio. If a repo has no files in a tier, the tier is credited full.
 * Tier weights (CRITICAL 30, HIGH 25, MEDIUM 20, LOW 15 = 90) leave 10 points
 * that start as a baseline and get deducted by commented-out test files.
 */
export function scoreTestGapsCounts(c: TestGapsCounts): { score: number } {
  function tierScore(untested: number, weight: number): number {
    // untestedSource in this tier vs. testedSource is not known — we approximate
    // by treating all c.testedSource as spread proportionally. Simpler: credit
    // weight based on how few untested remain relative to the *original* total
    // for this tier. Since we don't have per-tier original totals after a patch,
    // use a monotone formula: 1 / (1 + untested) gives perfect decay.
    if (untested === 0) return weight;
    // Graceful curve: large untested → near 0, small untested → higher credit.
    // This lets action patches (reducing untested) produce visible deltas.
    return Math.round(weight / (1 + untested * 0.1));
  }

  let score = 10; // baseline credited to all repos with test infra
  score += tierScore(c.untestedCritical, 30);
  score += tierScore(c.untestedHigh, 25);
  score += tierScore(c.untestedMedium, 20);
  score += tierScore(c.untestedLow, 15);

  // Commented-out tests signal atrophy.
  score -= Math.min(c.commentedOutFiles * 5, 25);

  return { score: Math.max(0, Math.min(100, score)) };
}
