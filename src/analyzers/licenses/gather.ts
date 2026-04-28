/**
 * Licenses analyzer data-gather — a thin wrapper around the capability
 * dispatcher. The work of invoking per-pack license tools lives in
 * `src/languages/{typescript,python,go,rust,csharp}.ts`; this module
 * just routes through the dispatcher and unpacks the aggregated
 * envelope so the analyzer index can compute its cross-report summary.
 */

import { defaultDispatcher } from '../dispatcher';
import { PER_PACK_REGISTRY } from '../../languages/capabilities/descriptors';
import { providersFor } from '../../languages/capabilities';
import type { LicensesResult } from '../../languages/capabilities/types';

/**
 * Dispatch the LICENSES capability against `cwd`. Returns null when no
 * pack contributed (e.g. a polyglot-negative repo) so the caller can
 * emit an empty-but-shaped report rather than fabricating data.
 */
export async function gatherLicensesResult(cwd: string): Promise<LicensesResult | null> {
  const descriptor = PER_PACK_REGISTRY.licenses;
  const providers = providersFor(descriptor, cwd);
  return defaultDispatcher.gather(cwd, descriptor, providers);
}
