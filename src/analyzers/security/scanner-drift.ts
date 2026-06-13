/**
 * C-D3: scanner-coverage drift detection across runs.
 *
 * Root cause of the customer "my score got worse after fixing things"
 * support case: between two runs the active scanner set grew (`gitleaks`
 * → `gitleaks, grep-secrets` + `snyk-code`), which surfaced 7
 * pre-existing hardcoded credentials that older dxkit simply couldn't
 * see. The Security score dropped 65 → 40 on an UNCHANGED commit, with
 * nothing in the report explaining that the findings were newly
 * *visible*, not newly *introduced*.
 *
 * This module compares the current run's scanner set against the most
 * recent prior vulnerability-scan report persisted under
 * `.dxkit/reports/`. When the current run added scanners, the report
 * renders an honest note so a reader attributes any movement to improved
 * measurement rather than regressed code.
 *
 * Read-only + fail-open: an fs or parse problem yields `null` (no note),
 * never an error — drift disclosure is a nicety, not a gate.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface ScannerCoverageDrift {
  /** Scanners present this run but absent from the most recent prior
   *  report — the tools whose findings are newly visible. */
  readonly added: string[];
  /** Date (YYYY-MM-DD) of the prior report compared against. */
  readonly previousDate: string;
}

const PREFIX = 'vulnerability-scan-';
const SUFFIX = '-detailed.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Detect scanners added since the most recent prior vuln-scan report.
 * Returns `null` when there is no prior report, none is readable, or the
 * scanner set did not grow (a shrinking or identical set is not the
 * confusing case this note addresses).
 *
 * `currentDate` is this run's report date (YYYY-MM-DD); prior reports on
 * a strictly earlier date are eligible. Same-day files are skipped: a
 * report dated today is either this run's own prior invocation (already
 * the post-expansion set — comparing would hide the drift) or about to
 * be overwritten, so an earlier day is the honest comparison point.
 */
export function detectScannerCoverageDrift(
  repoPath: string,
  currentTools: readonly string[],
  currentDate: string,
): ScannerCoverageDrift | null {
  const reportDir = path.join(repoPath, '.dxkit', 'reports');
  let files: string[];
  try {
    files = fs.readdirSync(reportDir);
  } catch {
    return null; // no reports dir → first run, nothing to compare
  }

  const prior = files
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .map((f) => ({ file: f, date: f.slice(PREFIX.length, f.length - SUFFIX.length) }))
    .filter((e) => DATE_RE.test(e.date) && e.date < currentDate)
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // most recent first

  const currentSet = [...new Set(currentTools)];
  for (const entry of prior) {
    const prevTools = readToolsUsed(path.join(reportDir, entry.file));
    if (!prevTools) continue; // unreadable → try the next-most-recent
    const prevSet = new Set(prevTools);
    const added = currentSet.filter((t) => !prevSet.has(t)).sort();
    // First readable prior report is the comparison point, added-or-not.
    return added.length > 0 ? { added, previousDate: entry.date } : null;
  }
  return null;
}

/** Parse `toolsUsed` from a persisted detailed report. Fail-open → null. */
function readToolsUsed(filePath: string): string[] | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { toolsUsed?: unknown };
    if (Array.isArray(parsed.toolsUsed)) {
      return parsed.toolsUsed.filter((t): t is string => typeof t === 'string');
    }
  } catch {
    // unreadable / malformed → skip
  }
  return null;
}
