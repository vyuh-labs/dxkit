/**
 * The advisory-detail join for the work-order plan (4.4.5 estate fix): the
 * override-pin recipe's `matches` needs a CONCRETE `fixedVersion` on every
 * finding, but the sources the planner reads often cannot carry one — a
 * baseline debt entry stores identity only, and a raw dependency-scan
 * finding gets its fix version from OSV enrichment the plan path never paid
 * for. On the rehearsal estate that tiered EVERY dep-advisory order to the
 * agent, deferrals with known pins included: determinism lost to a missing
 * join, not to a missing fact.
 *
 * This module builds the `advisoryDetails` map the planner fills from:
 *
 *   1. the live/BoM/injected scan the deferral join already paid for — its
 *      findings enrich BASELINE DEBT entries by fingerprint (the deferral
 *      side already prefers the live copy at join time);
 *   2. the ONE OSV client's `resolveFixVersions` (session-cached,
 *      alias-aware, installed-version-correct) for advisories STILL missing
 *      a fix version, deferrals first then debt (value order), capped and
 *      disclosed.
 *
 * Fail-open throughout: an unreachable OSV leaves fields absent (the order
 * honestly stays agent-tier), disclosed, never a crash and never a guess.
 */
import {
  fixResolutionKey,
  resolveFixVersions,
  type FixResolutionInput,
  type OsvFetcher,
} from '../../analyzers/tools/osv';
import type { RichBaselineEntry } from '../../baseline/types';
import type { DepVulnFinding } from '../../languages/capabilities/types';
import type { AdvisoryDetail, DeferredInput } from './planner';

/** The most advisories one plan pays OSV fix resolution for (each id is one
 *  cached HTTP lookup). Deferrals outrank debt; a capped tail is disclosed
 *  and simply stays agent-tier. */
export const OSV_FIX_RESOLUTION_CAP = 100;

interface NeedsFix {
  /** The finding id the detail map is keyed by. */
  readonly id: string;
  /** What OSV is asked: (advisory, package, installed version), the ONE
   *  key the client answers under. Two findings sharing an advisory (two
   *  packages, two roots at different versions) are two questions. */
  readonly resolution: FixResolutionInput;
}

export interface AdvisoryDetailArgs {
  readonly deferred: readonly DeferredInput[];
  readonly debt: readonly RichBaselineEntry[];
  /** The dependency-scan findings the deferral join read, by fingerprint. */
  readonly scanned: ReadonlyMap<string, DepVulnFinding>;
  /** Injected in tests; defaults to the OSV client's session-cached fetch. */
  readonly osvFetcher?: OsvFetcher;
  readonly disclosures: string[];
}

/**
 * Build the planner's `advisoryDetails` join. Pays OSV lookups only for
 * dep-vuln findings still missing a fix version after the scan join, and
 * only up to the cap.
 */
export async function advisoryDetailMap(
  args: AdvisoryDetailArgs,
): Promise<Map<string, AdvisoryDetail>> {
  const details = new Map<string, AdvisoryDetail>();
  const needsFix: NeedsFix[] = [];

  // Deferrals first (value order): the join already preferred the live
  // copy, so only a fix-less advisory needs OSV.
  for (const d of args.deferred) {
    if (d.kind !== 'dep-vuln' || d.advisory.fixedVersion !== undefined) continue;
    const scanned = args.scanned.get(d.advisory.id);
    needsFix.push({
      id: d.advisory.id,
      resolution: {
        primaryId: d.advisory.advisoryId,
        aliases: scanned?.aliases ?? [],
        package: d.advisory.package,
        ...(d.advisory.installedVersion !== undefined
          ? { installedVersion: d.advisory.installedVersion }
          : {}),
      },
    });
  }

  // Baseline debt: enrich from the scan the deferral join already paid for
  // (fingerprints share the one identity scheme), then OSV for the rest.
  for (const e of args.debt) {
    if (e.kind !== 'dep-vuln') continue;
    const scanned = args.scanned.get(e.id);
    if (scanned) {
      details.set(e.id, {
        ...(scanned.fixedVersion !== undefined ? { fixedVersion: scanned.fixedVersion } : {}),
        ...(scanned.reachable !== undefined ? { reachable: scanned.reachable } : {}),
        ...(scanned.installedVersion !== undefined
          ? { installedVersion: scanned.installedVersion }
          : {}),
        ...(scanned.packId !== undefined ? { pack: scanned.packId } : {}),
      });
    }
    if (scanned?.fixedVersion !== undefined) continue;
    needsFix.push({
      id: e.id,
      resolution: {
        primaryId: e.advisoryId,
        aliases: scanned?.aliases ?? [],
        package: e.package,
        ...(e.installedVersion !== undefined ? { installedVersion: e.installedVersion } : {}),
      },
    });
  }

  if (needsFix.length === 0) return details;
  const within = needsFix.slice(0, OSV_FIX_RESOLUTION_CAP);
  if (needsFix.length > within.length) {
    args.disclosures.push(
      `fix-version resolution capped at ${OSV_FIX_RESOLUTION_CAP} advisories ` +
        `(${needsFix.length - within.length} more stay without one and tier to the agent)`,
    );
  }
  const resolved = await resolveFixVersions(
    within.map((n) => n.resolution),
    ...(args.osvFetcher ? [args.osvFetcher] : []),
  );
  let hits = 0;
  for (const n of within) {
    const fixedVersion = resolved.get(fixResolutionKey(n.resolution));
    if (fixedVersion === undefined) continue;
    hits += 1;
    details.set(n.id, { ...details.get(n.id), fixedVersion });
  }
  args.disclosures.push(
    `fix-version resolution: ${hits} of ${within.length} advisories resolved via OSV ` +
      '(an unresolved advisory keeps its order agent-tier)',
  );
  return details;
}
