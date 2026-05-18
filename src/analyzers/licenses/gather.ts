/**
 * Licenses analyzer data-gather. D031 (2.4.7): mirrors the D025b
 * pattern for dep-vulns — bypasses the dispatcher cache to harvest
 * per-pack `LicensesGatherOutcome` discriminants. The dispatcher's
 * `gather()` collapses every non-success outcome to null, which
 * makes the licenses report unable to differentiate "0 packages —
 * scan ran cleanly" from "0 packages — tool not installed" (the F12
 * customer-credibility class observed on the .NET WinForms benchmark).
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
import { DEFAULT_PROVIDER_DEADLINE_MS, withDeadline } from '../tools/deadline';

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

  // Every per-pack gatherOutcome is wrapped in a deadline (mirrors the
  // dispatcher's per-provider deadline) so a single pack that hangs
  // can't keep the cross-pack `Promise.allSettled` pending forever.
  // A stall is materialised as an `unavailable` outcome with a
  // deadline reason, so the framing-notice path surfaces it.
  const outcomes = await Promise.allSettled(
    activePacks.map((l) =>
      withDeadline(l.capabilities!.licenses!.gatherOutcome(cwd), DEFAULT_PROVIDER_DEADLINE_MS).then(
        (deadlineOutcome) => {
          if (deadlineOutcome.stalled) {
            const seconds = Math.round(deadlineOutcome.stalledMs / 1000);
            process.stderr.write(
              `[dxkit] licenses provider "${l.id}" stalled after >${seconds}s (deadline) — treating as unavailable\n`,
            );
            return {
              kind: 'unavailable' as const,
              reason: `stalled at >${seconds}s (deadline)`,
            };
          }
          return deadlineOutcome.value;
        },
      ),
    ),
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
