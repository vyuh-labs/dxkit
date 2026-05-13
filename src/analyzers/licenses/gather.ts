/**
 * Licenses analyzer data-gather. D031 (2.4.7): mirrors the D025b
 * pattern for dep-vulns — bypasses the dispatcher cache to harvest
 * per-pack `LicensesGatherOutcome` discriminants. The dispatcher's
 * `gather()` collapses every non-success outcome to null, which
 * makes the licenses report unable to differentiate "0 packages —
 * scan ran cleanly" from "0 packages — tool not installed" (the F12
 * dpl-studio customer-credibility class).
 *
 * Per-pack helpers live in `src/languages/{typescript,python,go,
 * rust,csharp}.ts` (kotlin/java/ruby don't declare a licenses
 * capability — no canonical CLI license tool for those ecosystems
 * yet). Each pack's `LicensesProvider.gatherOutcome` returns the
 * discriminant; we aggregate success envelopes via the existing
 * LICENSES descriptor + track first-unavailable for the framing
 * notice.
 */

import { detectActiveLanguages } from '../../languages';
import { PER_PACK_REGISTRY } from '../../languages/capabilities/descriptors';
import type { LicensesResult } from '../../languages/capabilities/types';

/**
 * Shared primitive for availability-aware licenses aggregation. Used
 * by both the standalone licenses analyzer and the BoM report.
 *
 * `envelope` is null only when NO pack contributed a success outcome.
 * `available` is false when at least one active pack with a licenses
 * provider returned `'unavailable'`. `'no-manifest'` outcomes do NOT
 * degrade availability — polyglot repos where one pack activates but
 * has nothing to license (e.g. python pack on a Python-tooling-only
 * repo with no `requirements.txt`) are clean "nothing to license."
 */
export async function gatherLicensesWithAvailability(cwd: string): Promise<{
  envelope: LicensesResult | null;
  available: boolean;
  unavailableReason: string;
}> {
  const activePacks = detectActiveLanguages(cwd).filter((l) => l.capabilities?.licenses);
  if (activePacks.length === 0) {
    return { envelope: null, available: true, unavailableReason: '' };
  }

  const outcomes = await Promise.allSettled(
    activePacks.map((l) => l.capabilities!.licenses!.gatherOutcome(cwd)),
  );
  const successEnvelopes: LicensesResult[] = [];
  let firstUnavailable: { pack: string; reason: string } | null = null;
  for (let i = 0; i < outcomes.length; i++) {
    const r = outcomes[i];
    if (r.status === 'rejected') {
      if (!firstUnavailable) {
        firstUnavailable = {
          pack: activePacks[i].id,
          reason: `provider threw: ${(r.reason as Error)?.message ?? 'unknown error'}`,
        };
      }
      continue;
    }
    const outcome = r.value;
    if (outcome.kind === 'success') {
      successEnvelopes.push(outcome.envelope);
    } else if (outcome.kind === 'unavailable' && !firstUnavailable) {
      firstUnavailable = { pack: activePacks[i].id, reason: outcome.reason };
    }
  }

  const envelope =
    successEnvelopes.length > 0 ? PER_PACK_REGISTRY.licenses.aggregate(successEnvelopes) : null;
  return {
    envelope,
    available: firstUnavailable === null,
    unavailableReason: firstUnavailable
      ? `${firstUnavailable.pack}: ${firstUnavailable.reason}`
      : '',
  };
}

/**
 * Legacy entry point — preserved for callers that don't need the
 * availability metadata. New callers should use
 * `gatherLicensesWithAvailability` directly so the framing notice
 * + degraded-inventory fallback paths can engage.
 */
export async function gatherLicensesResult(cwd: string): Promise<LicensesResult | null> {
  const { envelope } = await gatherLicensesWithAvailability(cwd);
  return envelope;
}
