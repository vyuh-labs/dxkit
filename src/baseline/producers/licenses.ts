/**
 * Licenses → baseline-entry producer.
 *
 * One kind: `license` — per-package license attribution.
 * `(package, version, licenseType)` is the identity tuple, so a
 * re-licensing event on the same pinned version (compliance teams'
 * canonical concern) registers as a fresh finding even when no
 * version bump happened.
 *
 * Reads from `CapabilityReport.licenses.findings` — already in the
 * cached `AnalysisResult`, no extra gather work needed. Pure
 * function over its input.
 */

import { identityFor } from '../finding-identity';
import type { BaselineEntry, LicenseIdentityInput } from '../types';
import type { LicensesResult } from '../../languages/capabilities/types';

/**
 * Build `license` entries from a licenses capability envelope.
 * Findings with an empty `licenseType` are emitted with the literal
 * `'UNKNOWN'` so identity stays stable across runs even when the
 * underlying tool can't resolve the SPDX id.
 */
export function licensesToBaselineEntries(licenses: LicensesResult | undefined): BaselineEntry[] {
  if (!licenses) return [];
  const out: BaselineEntry[] = [];
  for (const f of licenses.findings) {
    const licenseType = f.licenseType.length > 0 ? f.licenseType : 'UNKNOWN';
    const input: LicenseIdentityInput = {
      kind: 'license',
      package: f.package,
      version: f.version,
      licenseType,
    };
    out.push({
      id: identityFor(input),
      kind: 'license',
      package: f.package,
      version: f.version,
      licenseType,
    });
  }
  return out;
}
