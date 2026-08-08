/**
 * Policy NAMING (4.4.0 P0-3) — split from `policy.ts` at the
 * large-file bar, the `policy-sections.ts` precedent. Re-exported from
 * `./policy` so that module stays the single import surface for policy
 * concepts.
 */

import { createHash } from 'crypto';
import type { BrownfieldPolicy } from './policy';

/**
 * Content hash of a RESOLVED policy — the reproducibility anchor a
 * `verdict.v1` document names. Key-sorted before hashing so two
 * semantically identical documents (same fields, different key order)
 * hash the same; sha1[0:16], the repo's short-hash convention. The ONE
 * policy-naming hash — the envelope's `policyHash` is a different,
 * older concept (drift detection) and must not be reused for naming.
 * Pure.
 */
export function policyContentHash(policy: BrownfieldPolicy): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = sortKeys((v as Record<string, unknown>)[k]);
      }
      return out;
    }
    return v;
  };
  // Names a policy document, never a finding identity.
  return createHash('sha1') // fingerprint-helper-ok
    .update(JSON.stringify(sortKeys(policy)))
    .digest('hex')
    .slice(0, 16);
}
