/**
 * Licenses analyzer report shape.
 *
 * Thin wrapper over the LICENSES capability envelope (one per active
 * language pack, aggregated by the dispatcher's descriptor). Adds the
 * cross-report metadata every vyuh-dxkit analyzer ships (repo, commit,
 * timestamps, toolsUsed/Unavailable) plus a small summary pre-computed
 * at gather time so consumers don't have to walk the full findings
 * array just to pick a grade.
 */

import type { LicenseFinding } from '../../languages/capabilities/types';

export interface LicensesReport {
  repo: string;
  analyzedAt: string;
  commitSha: string;
  branch: string;
  /** Bumps when the report shape changes incompatibly. */
  schemaVersion: '1';
  summary: {
    totalPackages: number;
    /** Count per canonical SPDX identifier — e.g. { 'MIT': 45, 'Apache-2.0': 23, 'UNKNOWN': 2 }. */
    byLicense: Record<string, number>;
    /** Count of packages lacking a license field (or reported as 'UNKNOWN'). */
    unknownCount: number;
  };
  findings: ReadonlyArray<LicenseFinding>;
  toolsUsed: string[];
  toolsUnavailable: string[];
  /**
   * D031 (2.4.7): availability metadata for the licenses aggregation.
   * `available === false` only when at least one active pack's
   * licenses provider returned an `'unavailable'` outcome (tool
   * missing, no output, parse fail). `'no-manifest'` outcomes do NOT
   * degrade availability (polyglot legit "nothing to license").
   * `unavailableReason` carries the pack name + reason for the
   * markdown framing notice. Empty when available.
   *
   * Optional for backwards compat with pre-D031 report JSONs.
   */
  availability?: { available: boolean; unavailableReason: string };
}
