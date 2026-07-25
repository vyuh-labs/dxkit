/**
 * Prohibited-license baseline producer (pure half).
 *
 * Turns the cached license inventory + the repo's `licenses.prohibited` list
 * into `license` baseline entries — one per dependency whose SPDX expression
 * matches the list, through the ONE matcher (`licenseMatchesAny`) the
 * risk-category tiers already use. Only MATCHES become findings: the
 * inventory itself never enters the baseline, so an unconfigured repo (empty
 * list — the default) contributes nothing.
 *
 * False-negative bias, deliberately: a degraded gather reports `UNKNOWN`
 * licenses, and `UNKNOWN` never matches a declared prefix unless the repo
 * explicitly lists it — an unresolvable license is a disclosure problem, not
 * a violation to block on.
 */

import type { LicenseFinding } from '../../languages/capabilities/types';
import { licenseMatchesAny } from '../../analyzers/licenses/detailed';
import { identityFor } from '../finding-identity';
import type { RichBaselineEntry } from '../types';

export function prohibitedLicensesToBaselineEntries(
  findings: ReadonlyArray<LicenseFinding> | undefined,
  prohibited: ReadonlyArray<string>,
): RichBaselineEntry[] {
  if (!findings || findings.length === 0 || prohibited.length === 0) return [];
  const entries: RichBaselineEntry[] = [];
  const seen = new Set<string>();
  for (const f of findings) {
    if (!f.package || !f.licenseType) continue;
    if (!licenseMatchesAny(f.licenseType, prohibited)) continue;
    const id = identityFor({ kind: 'license', package: f.package, licenseType: f.licenseType });
    // The aggregate concatenates per-pack results and a package can appear at
    // several versions; identity is version-free, so dedupe on it.
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({
      id,
      kind: 'license',
      package: f.package,
      licenseType: f.licenseType,
      ...(f.version ? { version: f.version } : {}),
    });
  }
  return entries;
}
