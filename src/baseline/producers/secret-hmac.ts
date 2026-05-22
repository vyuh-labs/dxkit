/**
 * Secret-HMAC → baseline-entry producer.
 *
 * Companion to the location-based `secret` producer. A secret detected
 * by gitleaks gets two baseline entries: the `secret` entry pins its
 * file + line (stable across re-runs at the same position); the
 * `secret-hmac` entry pins its HMAC (stable when the same secret value
 * appears at a different file or line, e.g., a leaked token moved
 * from `.env` to `src/config.ts`).
 *
 * The HMAC is computed via the canonical `computeSecretHmac` helper
 * with the per-repo salt resolved by `resolveSalt`. The raw secret
 * value lives only in the gitleaks outcome (`GitleaksRawSecret`)
 * carried through process memory; this producer hashes it once and
 * discards it. Nothing reaches disk except the 16-char HMAC.
 *
 * Producer scope: this module is consumed exclusively by
 * `dxkit baseline create` (and, in C3, by `guardrail check` for the
 * current-side scan). It is NOT consumed by the security analyzer's
 * normal report path — those code paths never see the raw secret
 * value, so the HMAC machinery stays out of the public envelope.
 */

import { computeSecretHmac } from '../../analyzers/tools/fingerprint';
import type { GitleaksRawSecret } from '../../analyzers/tools/gitleaks';
import { identityFor } from '../finding-identity';
import type { RichBaselineEntry, SecretHmacIdentityInput } from '../types';

export interface SecretHmacProducerInput {
  /** Raw secrets from `gatherGitleaksResult(cwd).rawSecrets`. */
  readonly rawSecrets: ReadonlyArray<GitleaksRawSecret>;
  /** Resolved repo salt (from `resolveSalt(cwd)`). The producer
   *  doesn't care which mode resolved it — the baseline file's
   *  `saltMode` is recorded separately so consumers know how to
   *  re-derive the same salt at check time. */
  readonly salt: string;
}

/**
 * Build `secret-hmac` baseline entries from a list of raw secrets +
 * the repo salt. The output preserves the input order so a baseline
 * regenerated against the same scan is byte-stable.
 *
 * Tool name on every emitted entry is `'gitleaks'` — the only
 * upstream source today. Future scanners (trufflehog-compatible
 * etc.) would add their own producer; the canonical-rule mapping
 * collapses cross-tool overlaps inside `identityFor`.
 */
export function rawSecretsToBaselineEntries(input: SecretHmacProducerInput): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];
  // Identity is `(rule, hmac)` — two raw secrets that map to the same
  // `(rule, hmac)` (the same value detected at multiple lines, or by
  // overlapping gitleaks rules pointing at the same canonical kind)
  // collapse to one baseline entry. The location-based `secret`
  // producer still records each occurrence separately.
  const seen = new Set<string>();
  for (const raw of input.rawSecrets) {
    if (!raw.secret) continue;
    const hmac = computeSecretHmac(raw.secret, input.salt);
    const identityInput: SecretHmacIdentityInput = {
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: raw.rule,
      hmac,
    };
    const id = identityFor(identityInput);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind: 'secret-hmac',
      tool: 'gitleaks',
      rule: raw.rule,
      hmac,
    });
  }
  return out;
}
