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
import { splitTools, toolRecall } from './recall-inputs';
import type { BaselineProducer } from './index';
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

/**
 * The registered producer half (moved here from `producers/index.ts` at the
 * large-file bar — the recall-inputs precedent: the registry stays a listing
 * of producers). Type-only import back into the registry module is erased at
 * compile time, so no runtime cycle exists.
 */
export const LICENSES_PRODUCER: BaselineProducer = {
  name: 'licenses',
  contributes: ['license'],
  produce(ctx) {
    return prohibitedLicensesToBaselineEntries(
      ctx.analysisResult.capabilities.licenses?.findings,
      ctx.prohibitedLicenses,
    );
  },
  recallContexts(ctx) {
    const base = toolRecall(
      'license',
      splitTools(ctx.analysisResult.capabilities.licenses?.tool),
      ctx.cwd,
    );
    // The prohibited list is itself a recall input (Rule 19, cause 6):
    // widening it makes previously-invisible standing violations appear, and
    // that delta is a policy change, never the next PR author's fault — the
    // drift demotion is what keeps the brownfield promise when a repo
    // tightens its legal posture. Normalized (sorted, deduped) upstream so
    // a policy reformat is byte-stable.
    return new Map([
      [
        'license',
        {
          epoch: base.epoch,
          inputs: { ...base.inputs, 'licenses.prohibited': ctx.prohibitedLicenses.join(',') },
        },
      ],
    ]);
  },
};
