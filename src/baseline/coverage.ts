/**
 * Scan coverage — which scanners were actually available when a
 * baseline was captured.
 *
 * The baseline file is the durable contract between today's scan and
 * tomorrow's guardrail check. That contract is only honest if the check
 * can tell whether a category was *scanned and clean* versus *never
 * scanned because the tool was missing*. Without this record, a baseline
 * captured on a machine where (say) gitleaks wasn't detected looks
 * identical to one captured with gitleaks present and zero secrets —
 * and every future guardrail check silently inherits the blind spot.
 *
 * Coverage is derived from the stack's required-tool statuses
 * (`checkAllTools`), so it reflects real detection — including the
 * Windows / locked-down case where a tool is installed but lives
 * outside the probed locations. A tool that simply doesn't apply to the
 * stack (`source: 'n/a'`) is recorded but is NOT a gap: there's nothing
 * to scan, so nothing is missing.
 */

import type { ToolStatus } from '../analyzers/tools/tool-registry';

/** One scanner's availability at scan time. */
export interface ScannerCoverage {
  readonly tool: string;
  readonly available: boolean;
  /** How/where it resolved: 'path' | 'brew' | … | 'missing' | 'n/a'. */
  readonly source: ToolStatus['source'];
}

export interface ScanCoverage {
  readonly scanners: ReadonlyArray<ScannerCoverage>;
}

/**
 * Build coverage from the stack's required-tool statuses. Sorted by
 * tool name for stable, git-friendly serialization.
 */
export function coverageFromToolStatuses(statuses: ReadonlyArray<ToolStatus>): ScanCoverage {
  const scanners = statuses
    .map((s) => ({ tool: s.name, available: s.available, source: s.source }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
  return { scanners };
}

/**
 * Scanners that are genuinely missing — installed-but-undetected or not
 * installed at all (`source === 'missing'`). Excludes not-applicable
 * tools. These are the coverage gaps a baseline would silently omit, so
 * they drive the create-time warning and the check-time drift signal.
 */
export function missingScanners(coverage: ScanCoverage): ReadonlyArray<ScannerCoverage> {
  return coverage.scanners.filter((s) => s.source === 'missing');
}

/**
 * Tools whose availability flipped between the baseline capture and the
 * current scan. A tool that was missing at baseline but is present now
 * means the baseline never captured that category — its findings can't
 * be diffed reliably and should be treated as newly-surfaced rather
 * than pre-existing. The reverse (present then missing) means the
 * current check can't re-verify that category at all.
 */
export interface CoverageDrift {
  readonly tool: string;
  readonly baselineAvailable: boolean;
  readonly currentAvailable: boolean;
}

export function diffCoverage(
  baseline: ScanCoverage | undefined,
  current: ScanCoverage,
): ReadonlyArray<CoverageDrift> {
  // A baseline written before coverage existed has nothing to diff
  // against — silence rather than a flood of false "newly available"
  // drifts on first upgrade.
  if (!baseline) return [];
  const baseAvail = new Map(baseline.scanners.map((s) => [s.tool, s.available]));
  const drifts: CoverageDrift[] = [];
  for (const cur of current.scanners) {
    if (!baseAvail.has(cur.tool)) continue;
    const baselineAvailable = baseAvail.get(cur.tool)!;
    if (baselineAvailable !== cur.available) {
      drifts.push({ tool: cur.tool, baselineAvailable, currentAvailable: cur.available });
    }
  }
  return drifts.sort((a, b) => a.tool.localeCompare(b.tool));
}
