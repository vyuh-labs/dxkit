/**
 * PM-oriented derived signals for bom renderers (2.3.2).
 *
 * Pure helpers that project raw finding fields into categorical
 * signals a non-technical reviewer can sort/filter/decide on without
 * domain expertise:
 *
 *   - `licenseClass(licenseType)` — SPDX-id → permissive / copyleft-
 *     weak / copyleft-strong / proprietary / unknown. Lets a PM
 *     filter the inventory for "anything I need a lawyer to sign off".
 *
 *   - `stalenessTier(releaseDate)` — ISO date → fresh (< 1y) / aging
 *     (1–3y) / stale (≥ 3y). Lets a PM see deps that may no longer
 *     be maintained without knowing semver or npm-registry API.
 *
 *   - `effortEstimate(entry)` — packs the entry's upgrade path into
 *     trivial / moderate / major / blocked. Derived from
 *     installedVersion → fixedVersion semver delta or "no fix available".
 *     Helps scope sprint commitments.
 *
 * These deliberately live OUTSIDE `capabilities/types.ts` so the
 * finding types stay the analyzer contract and these are strictly
 * rendering helpers. If downstream consumers later need them in the
 * JSON output, they can be promoted to type fields in a minor bump.
 */

import type { BomEntry } from './types';

// ─── license classification ──────────────────────────────────────────────────

export type LicenseClass =
  | 'permissive'
  | 'copyleft-weak'
  | 'copyleft-strong'
  | 'proprietary'
  | 'unknown';

/** Known-permissive SPDX ids. Matching is forgiving — `MIT`, `MIT license`,
 *  `MIT (fork)` all map to the same class. Bench xlsx was full of
 *  human-readable suffixes; this logic normalises them away. */
const PERMISSIVE = new Set([
  'mit',
  'mit-0',
  'apache-2.0',
  'apache 2.0',
  'apache-1.1',
  'bsd',
  'bsd-2-clause',
  'bsd-3-clause',
  'bsd-3-clause-clear',
  '0bsd',
  'isc',
  'zlib',
  'unlicense',
  'cc0-1.0',
  'wtfpl',
  'python-2.0',
  'python',
  'psf-2.0',
  'artistic-2.0',
  'artistic-1.0',
  'boost',
  'bsl-1.0',
  'upl-1.0', // Universal Permissive License
]);

const COPYLEFT_STRONG = new Set([
  'gpl-2.0',
  'gpl-3.0',
  'gpl',
  'agpl-3.0',
  'agpl-1.0',
  'agpl',
  'sspl-1.0',
]);

const COPYLEFT_WEAK = new Set([
  'lgpl-2.1',
  'lgpl-3.0',
  'lgpl',
  'mpl-1.1',
  'mpl-2.0',
  'epl-1.0',
  'epl-2.0',
  'cddl-1.0',
  'cddl-1.1',
]);

const PROPRIETARY_MARKERS = ['UNLICENSED', 'SEE LICENSE IN', 'PROPRIETARY', 'COMMERCIAL'];

/**
 * Classify a license string from a `LicenseFinding`. Accepts raw SPDX
 * ids, compound expressions (`"MIT OR Apache-2.0"` — classifies by the
 * first recognised token), and human-readable variants. Unrecognised
 * input returns `'unknown'` so the caller can surface the raw string
 * for human review.
 */
export function licenseClass(licenseType: string | undefined): LicenseClass {
  if (!licenseType || licenseType === 'UNKNOWN' || licenseType.trim().length === 0) {
    return 'unknown';
  }
  const upper = licenseType.toUpperCase();
  for (const marker of PROPRIETARY_MARKERS) {
    if (upper.includes(marker)) return 'proprietary';
  }
  // Compound expressions: split on OR/AND, classify each, take the
  // strictest class (copyleft > permissive > unknown). Prevents an
  // `MIT OR GPL-3.0` from reading as harmless MIT when the user can
  // also be tied to GPL obligations. Strip surrounding punctuation
  // (parens/brackets) that license-checker sometimes emits on
  // compound expressions like `(Apache-2.0 OR UPL-1.0)`.
  const cleaned = licenseType.replace(/[()[\]{}]/g, ' ').trim();
  const tokens = cleaned
    .split(/\s+(?:OR|AND|\/|\|)\s+|\s+license\s*$/i)
    .map((t) =>
      t
        .trim()
        .toLowerCase()
        .replace(/^apache\s+/, 'apache-')
        .replace(/\s+/g, '-'),
    )
    .filter(Boolean);
  let worst: LicenseClass = 'unknown';
  for (const norm of tokens) {
    if (COPYLEFT_STRONG.has(norm)) return 'copyleft-strong';
    if (COPYLEFT_WEAK.has(norm)) worst = 'copyleft-weak';
    else if (PERMISSIVE.has(norm) && worst === 'unknown') worst = 'permissive';
  }
  return worst;
}

// ─── staleness ──────────────────────────────────────────────────────────────

export type StalenessTier = 'fresh' | 'aging' | 'stale' | 'unknown';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Classify package freshness from an ISO-8601 release date. Threshold
 * picked for PM sensibility: "< 1 year" is current, "1–3 years" starts
 * getting stale, "≥ 3 years" warrants a "still maintained?" conversation.
 *
 * `now` is injectable so tests don't drift over time.
 */
export function stalenessTier(
  releaseDate: string | undefined,
  now: Date = new Date(),
): StalenessTier {
  if (!releaseDate) return 'unknown';
  const t = Date.parse(releaseDate);
  if (Number.isNaN(t)) return 'unknown';
  const ageMs = now.getTime() - t;
  if (ageMs < YEAR_MS) return 'fresh';
  if (ageMs < 3 * YEAR_MS) return 'aging';
  return 'stale';
}

// ─── upgrade effort estimate ────────────────────────────────────────────────

export type EffortEstimate = 'trivial' | 'moderate' | 'major' | 'blocked';

/**
 * Estimate the effort to remediate a vulnerable package.
 *
 *   - `blocked`: no advisory has a `fixedVersion` → requires a drop-in
 *     replacement or living-with-it exception.
 *   - `trivial`: every advisory's fix is a patch-version bump (same
 *     major+minor). Low-risk npm install away.
 *   - `moderate`: fix is a minor-version bump (same major). API-additive;
 *     contract-stable but light testing warranted.
 *   - `major`: fix is a major-version bump. Potential breaking changes;
 *     read the changelog before committing.
 *
 * Extracts semver by numeric parse of the first three dotted components
 * (strips a leading `v` Go-style). Non-parseable or multi-vuln mixtures
 * escalate to the highest effort tier seen.
 */
export function effortEstimate(entry: BomEntry): EffortEstimate {
  if (entry.vulns.length === 0) return 'trivial'; // unreachable under normal rendering
  const installed = parseSemverTriple(entry.version);
  let worst: 'trivial' | 'moderate' | 'major' = 'trivial';
  let anyFixMissing = false;
  for (const v of entry.vulns) {
    if (!v.fixedVersion) {
      anyFixMissing = true;
      continue;
    }
    const fix = parseSemverTriple(v.fixedVersion);
    if (!installed || !fix) {
      worst = worstOf(worst, 'major');
      continue;
    }
    if (fix[0] > installed[0]) worst = worstOf(worst, 'major');
    else if (fix[1] > installed[1]) worst = worstOf(worst, 'moderate');
    // patch bumps or lower stay 'trivial'
  }
  if (anyFixMissing) return 'blocked';
  return worst;
}

function parseSemverTriple(v: string): [number, number, number] | null {
  const stripped = v.replace(/^v/, '');
  const parts = stripped.split(/[.+-]/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return parts as [number, number, number];
}

function worstOf<T extends 'trivial' | 'moderate' | 'major'>(a: T, b: T): T {
  const rank: Record<'trivial' | 'moderate' | 'major', number> = {
    trivial: 0,
    moderate: 1,
    major: 2,
  };
  return rank[a] >= rank[b] ? a : b;
}
