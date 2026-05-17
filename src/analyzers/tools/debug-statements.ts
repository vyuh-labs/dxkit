/**
 * Print-family debug-statement counter — shared between health and
 * quality so the cross-report `consoleLogCount` metric cannot drift.
 *
 * D079 + cross-report convergence (2.4.7 class-fix release): pre-fix
 * health summed JS console + Py print + Go fmt.Print across
 * language-scoped file lists, while quality counted only
 * console.(log|error|warn) across all extensions. Result on platform:
 * health=698, quality=675 (23-finding gap = Python `print(` matches).
 * Same label, different aggregations.
 *
 * Post-fix: ONE function with the canonical multi-pattern definition.
 * Both reports route through it; they cannot disagree.
 *
 * Pattern set (skipComments: true on each):
 *   `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs`  → console.(log|error|warn)
 *   `.py`                                     → \bprint\(
 *   `.go`                                     → fmt\.Print
 */
import { walkSourceFiles, countLineMatches } from './walk-source-files';

export interface DebugStatementsResult {
  /** Total count across all patterns + extensions. */
  count: number;
  /** Top N offenders (most matches per file). Empty if topN was 0. */
  topOffenders: Array<{ file: string; count: number }>;
}

/**
 * Count print-family debug statements project-wide. Pass `topN > 0`
 * to populate `topOffenders` (e.g. for quality's `topConsoleFiles`).
 */
export function gatherDebugStatements(
  cwd: string,
  opts: { topN?: number } = {},
): DebugStatementsResult {
  const topN = opts.topN ?? 0;

  // includeTests: true preserves pre-migration scope — debug statements
  // in test fixtures were detected before, still are.
  const tsFiles = walkSourceFiles(cwd, {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    includeTests: true,
  });
  const pyFiles = walkSourceFiles(cwd, { extensions: ['.py'], includeTests: true });
  const goFiles = walkSourceFiles(cwd, { extensions: ['.go'], includeTests: true });

  const tsResult = countLineMatches(cwd, tsFiles, ['console\\.(log|error|warn)'], {
    skipComments: true,
    perFileTopN: topN,
  });
  const pyResult = countLineMatches(cwd, pyFiles, ['\\bprint\\('], {
    skipComments: true,
    perFileTopN: topN,
  });
  const goResult = countLineMatches(cwd, goFiles, ['fmt\\.Print'], {
    skipComments: true,
    perFileTopN: topN,
  });

  const count = tsResult.lines + pyResult.lines + goResult.lines;

  if (topN === 0) {
    return { count, topOffenders: [] };
  }

  const merged = [...tsResult.perFile, ...pyResult.perFile, ...goResult.perFile];
  merged.sort((a, b) => b.count - a.count);
  return { count, topOffenders: merged.slice(0, topN) };
}
