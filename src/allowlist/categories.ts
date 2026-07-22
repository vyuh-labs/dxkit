/**
 * Allowlist category taxonomy. Single source of truth for:
 *   - Which categories exist
 *   - Which categories require an expiry date
 *   - Which categories may be expressed via inline source annotation
 *   - Which categories apply to each `IdentityKind`
 *   - Which finding kinds support inline annotations at all
 *
 * Pure module — no I/O, no analyzer dependencies. Consumed by the
 * allowlist file reader/writer, the inline-annotation parser, the
 * CLI, the block-time hint formatter, and the new `allowlistHits`
 * baseline producer.
 */

import type { IdentityKind } from '../baseline/producers';

/**
 * Single source of truth for category values. The `AllowlistCategory`
 * union type is derived from this array via `(typeof ...)[number]`,
 * so adding a new category means appending one string here and every
 * type-level check (Record-keyed tables, switch exhaustiveness,
 * function parameter types) auto-updates. No two-place drift.
 */
export const ALL_CATEGORIES = [
  'false-positive',
  'test-fixture',
  'mitigated-externally',
  'accepted-risk',
  'deferred',
] as const;

export type AllowlistCategory = (typeof ALL_CATEGORIES)[number];

/**
 * Categories that REQUIRE a finite expiry date. The file-level
 * allowlist write-path rejects entries in these categories without
 * an `expiresAt`. The CLI defaults `expiresAt` to 90 days out for
 * these — see `defaultExpiryDate`.
 *
 * Categories OUTSIDE this set represent stable assertions about the
 * code that don't naturally stale (a test fixture remains a test
 * fixture; a false positive remains a false positive until the
 * scanner rule changes). They may carry an `expiresAt` if the
 * customer chooses, but it's not enforced.
 */
export const EXPIRING_CATEGORIES: ReadonlySet<AllowlistCategory> = new Set([
  'accepted-risk',
  'deferred',
]);

/**
 * Categories that may be expressed via inline source annotation
 * (`// dxkit-allow:<category> reason="..."`). The complement
 * (`accepted-risk`, `deferred`) is file-only because those categories
 * need fields (expiresAt, acknowledgedSeverity) that don't fit
 * cleanly into a code comment.
 */
export const INLINE_COMPATIBLE_CATEGORIES: ReadonlySet<AllowlistCategory> = new Set([
  'false-positive',
  'test-fixture',
  'mitigated-externally',
]);

/**
 * Finding kinds that have a stable single-line attachment point and
 * therefore support inline annotations. Kinds outside this set are
 * file-only (whole-file findings, cross-file findings, gap findings).
 *
 * Inline-compatible:
 *   - `secret` / `secret-hmac`: the source line is the credential
 *   - `code` / `config`: the source line is the flagged pattern
 *   - `dep-vuln`: annotate the import or first-use line
 *   - `hygiene`: the source line carries the TODO/FIXME/HACK marker
 *
 * File-only (no single-line site):
 *   - `duplication`: two locations across files
 *   - `coverage-gap` / `test-gap` / `test-file-degradation`: file or
 *     symbol-range level, not single-line
 *   - `god-file` / `large-file` / `stale-file`: whole-file findings
 */
export const INLINE_COMPATIBLE_KINDS: ReadonlySet<IdentityKind> = new Set<IdentityKind>([
  'secret',
  'secret-hmac',
  'code',
  'config',
  'dep-vuln',
  'hygiene',
]);

/**
 * Categories applicable to each `IdentityKind`. Reflects what
 * suppression rationales the kind can plausibly carry — a
 * `coverage-gap` is rarely a "false positive" in the same way a
 * scanner finding is; a `dep-vuln` is rarely a "test fixture."
 *
 * The CLI presents the applicable list as a multiple-choice prompt
 * when the customer runs `vyuh-dxkit allowlist add` against a
 * finding.
 *
 * The `Record<IdentityKind, ...>` ties this table to the canonical
 * union: TypeScript fails the build when a new `IdentityKind`
 * variant lands without a corresponding entry here.
 */
export const CATEGORIES_BY_KIND: Readonly<Record<IdentityKind, readonly AllowlistCategory[]>> = {
  // Source-level security findings: every category applies
  secret: ['false-positive', 'test-fixture', 'mitigated-externally', 'accepted-risk', 'deferred'],
  'secret-hmac': [
    'false-positive',
    'test-fixture',
    'mitigated-externally',
    'accepted-risk',
    'deferred',
  ],
  code: ['false-positive', 'test-fixture', 'mitigated-externally', 'accepted-risk', 'deferred'],
  config: ['false-positive', 'test-fixture', 'mitigated-externally', 'accepted-risk', 'deferred'],

  // Dependency vulnerabilities: rarely a test fixture (the dep is real);
  // every other category applies
  'dep-vuln': ['false-positive', 'mitigated-externally', 'accepted-risk', 'deferred'],

  // Duplicate blocks: occasionally a false positive (jscpd matched
  // generated code); otherwise accepted-risk or deferred
  duplication: ['false-positive', 'accepted-risk', 'deferred'],

  // Coverage / test gaps: not "false-positive" in any practical sense;
  // only accepted-risk or deferred
  'coverage-gap': ['accepted-risk', 'deferred'],
  'test-gap': ['accepted-risk', 'deferred'],
  'test-file-degradation': ['accepted-risk', 'deferred'],

  // Whole-file findings: false-positive (file IS not actually large /
  // stale / god when reviewed); otherwise accepted-risk or deferred
  'god-file': ['false-positive', 'accepted-risk', 'deferred'],
  'large-file': ['false-positive', 'accepted-risk', 'deferred'],
  'stale-file': ['false-positive', 'accepted-risk', 'deferred'],

  // TODO / FIXME / HACK / console-log / any-type markers: only
  // accepted-risk or deferred (the marker IS the hygiene issue)
  hygiene: ['accepted-risk', 'deferred'],

  // Broken integration: false-positive (a cross-repo consumer exists that the
  // scan didn't see, so the binding isn't actually dead); otherwise
  // accepted-risk or deferred
  'flow-binding': ['false-positive', 'accepted-risk', 'deferred'],

  // Schema drift: accepted-risk is THE intended escape hatch (a deliberate
  // breaking change shipping with its migration, ideally with an expiry);
  // false-positive covers a misread declaration; deferred parks a decision
  'model-schema-drift': ['false-positive', 'accepted-risk', 'deferred'],

  // Structural duplicate: false-positive (a sanctioned by-design parallel — two
  // per-pack gathers that legitimately share a call shape); otherwise
  // accepted-risk (we know it's a duplicate and accept it) or deferred
  'code-reimplementation': ['false-positive', 'accepted-risk', 'deferred'],

  // Stale-allow (orphaned inline allowlist annotation): never
  // allowlisted. The right response is always "remove the stale
  // annotation" — allowlisting the warning that an annotation is
  // stale would defeat the entire strict-stale-detection model
  // (TypeScript's @ts-expect-error pattern). Empty array means the
  // CLI rejects with a hint pointing at the annotation's source
  // location.
  'stale-allow': [],

  // Custom-check / lint findings: false-positive (the check fired
  // spuriously — a lint rule the team disagrees with, a flaky command);
  // otherwise accepted-risk or deferred. Never test-fixture (the check
  // is real code the team declared). File-only for now (a binary check
  // has no single-line site), so not inline-compatible.
  'custom-check': ['false-positive', 'accepted-risk', 'deferred'],
};

/**
 * Whether a (kind, category) tuple may be expressed as an inline
 * annotation. Both the kind AND the category must be inline-compatible.
 *
 * Examples:
 *   canUseInline('secret', 'test-fixture')      // true
 *   canUseInline('secret', 'accepted-risk')     // false (category file-only)
 *   canUseInline('large-file', 'false-positive') // false (kind file-only)
 *   canUseInline('hygiene', 'accepted-risk')    // false (category file-only)
 */
export function canUseInline(kind: IdentityKind, category: AllowlistCategory): boolean {
  return INLINE_COMPATIBLE_KINDS.has(kind) && INLINE_COMPATIBLE_CATEGORIES.has(category);
}

/**
 * Whether a category requires `expiresAt` on the file-level entry.
 * Source of truth for the write-path validation rule.
 */
export function requiresExpiry(category: AllowlistCategory): boolean {
  return EXPIRING_CATEGORIES.has(category);
}

/**
 * Whether a (kind, category) tuple is semantically valid. The CLI
 * uses this to reject incoherent combinations like
 * `coverage-gap + false-positive` with a clear error pointing at
 * the applicable categories for that kind.
 */
export function isCategoryValidForKind(kind: IdentityKind, category: AllowlistCategory): boolean {
  return CATEGORIES_BY_KIND[kind].includes(category);
}

/**
 * Number of days into the future the CLI defaults `expiresAt` to
 * when the customer doesn't specify one. Locked at 90 in Sprint 0
 * (Snyk + Dependabot industry default). Per-category overrides will
 * land in `.dxkit/policy.json` (`allowlist.defaultExpiryDays`) in a
 * follow-up commit if real customer signal demands it.
 */
export const DEFAULT_EXPIRY_DAYS = 90;

/**
 * Compute the default expiry date as an ISO `YYYY-MM-DD` string,
 * `DEFAULT_EXPIRY_DAYS` from `now`. UTC-anchored to keep the date
 * stable across timezone-different developers on the same team.
 *
 * `now` is injected for deterministic testing — production callers
 * pass `new Date()` (the default).
 */
export function defaultExpiryDate(now: Date = new Date()): string {
  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + DEFAULT_EXPIRY_DAYS);
  return expires.toISOString().slice(0, 10);
}

/**
 * Default expiry window for `allowlist defer` — the bulk deferral of newly
 * published dep-vuln advisories (D4). Deliberately SHORT: the expiry is the
 * forcing function back into the fix lane, so a live advisory a time-sensitive
 * change deferred re-blocks within days, not the 90-day accepted-risk horizon.
 * Matches the window the incident bridge script shipped to customers.
 */
export const DEFER_ADVISORY_EXPIRY_DAYS = 7;

/** ISO `YYYY-MM-DD` expiry `DEFER_ADVISORY_EXPIRY_DAYS` from `now` (UTC-
 *  anchored like `defaultExpiryDate`; `now` injected for tests). */
export function deferAdvisoryExpiryDate(now: Date = new Date()): string {
  const expires = new Date(now);
  expires.setUTCDate(expires.getUTCDate() + DEFER_ADVISORY_EXPIRY_DAYS);
  return expires.toISOString().slice(0, 10);
}
