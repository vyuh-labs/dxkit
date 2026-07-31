/**
 * Newer `.dxkit/policy.json` section shapes + their ONE normalizers, split
 * from `policy.ts` at the large-file bar. Leaf module: it imports only the
 * shared severity type, and `policy.ts` re-exports everything here, so every
 * consumer's `from './policy'` import keeps working and each normalizer
 * stays the single reader of its section (Rule 2).
 */

import type { FindingSeverity } from './types';

/**
 * One declared paired-change rule in `.dxkit/policy.json:pairedChecks` — a
 * "changing X requires also changing Y" invariant evaluated over the diff by
 * the paired-change gate: when the change touches a path matching `if` but no
 * path matching `then`, the gate mints one `paired-change` finding for the
 * rule. Canonical uses: a data model changed but no migration did; a public
 * API changed but no docs did.
 *
 * Purely declarative — no command is executed, nothing is spawned, so the
 * gate is safe on every surface including untrusted fork PRs, and works in
 * ref-based mode (unlike command checks, which need a provisioned toolchain).
 *
 * Globs support `**` / `*` / `?` against repo-relative POSIX paths; deletions
 * count as touches on both sides (removing a model warrants a migration too).
 *
 * Schema example:
 *
 *   "pairedChecks": [
 *     { "name": "model-needs-migration",
 *       "if": ["src/models/**"], "then": ["migrations/**"],
 *       "message": "a data-model change ships with its migration" }
 *   ]
 */
export interface PairedCheckConfig {
  /** Stable rule name — the finding's whole identity (Rule 9). Required. */
  readonly name?: string;
  /** Glob(s) selecting the trigger surface. Required, at least one. */
  readonly if?: string | readonly string[];
  /** Glob(s) selecting the required companion surface. Required, at least one. */
  readonly then?: string | readonly string[];
  /** Human-facing explanation rendered with a violation. */
  readonly message?: string;
  /** A violation blocks (default true) or only warns (false). */
  readonly blocking?: boolean;
}

/** `newAdvisories.*` block in `.dxkit/policy.json` (the D4 tier knob). */
export interface NewAdvisoriesPolicy {
  /** Severities that BLOCK when a dep-vuln is classified
   *  `newly_published_advisory`. An explicit empty array is a legitimate
   *  warn-everything posture. Unknown values are dropped by the ONE
   *  normalizer `newAdvisoryBlockSeverities`. */
  readonly blockSeverities?: ReadonlyArray<FindingSeverity>;
  /**
   * Install the `dxkit-comment-defer` workflow: a reviewer with write access
   * can defer blocking dep-vuln advisories from the PR conversation
   * (`/dxkit defer …` — strict grammar, commenter attributed, committed to
   * the PR branch). Opt-in, default off: the workflow reacts to comments and
   * pushes commits, which a repo must choose deliberately.
   */
  readonly commentCommands?: boolean;
}

/** The default advisory block tier: a live high/critical advisory must not
 *  silently ride in even though the PR did not cause it; medium/low warn —
 *  visible pressure without a false hard-block. */
export const DEFAULT_NEW_ADVISORY_BLOCK_SEVERITIES: ReadonlyArray<FindingSeverity> = Object.freeze([
  'critical',
  'high',
]);

const VALID_SEVERITIES: ReadonlyArray<FindingSeverity> = ['critical', 'high', 'medium', 'low'];

/**
 * The ONE normalizer of the advisory tier (Rule 2): the classifier, the
 * renderers, and the doctor probe all read the effective block set through
 * this. A missing/malformed field falls back to the default; a present array
 * is filtered to known severities (an explicit `[]` means warn-everything —
 * a deliberate posture, not an error).
 */
export function newAdvisoryBlockSeverities(policy: {
  readonly newAdvisories?: NewAdvisoriesPolicy;
}): ReadonlySet<FindingSeverity> {
  const declared = policy.newAdvisories?.blockSeverities;
  if (!Array.isArray(declared)) return new Set(DEFAULT_NEW_ADVISORY_BLOCK_SEVERITIES);
  return new Set(
    declared.filter((s): s is FindingSeverity => (VALID_SEVERITIES as string[]).includes(s)),
  );
}

/** The default refresh cadence: weekly, Monday 06:00 UTC — matches the cron
 *  the refresh workflow templates have always shipped with. */
export const DEFAULT_BASELINE_REFRESH_CRON = '0 6 * * 1';

/** Named cadences a repo can declare instead of a raw cron. */
const NAMED_REFRESH_CADENCES: Readonly<Record<string, string>> = Object.freeze({
  weekly: DEFAULT_BASELINE_REFRESH_CRON,
  daily: '0 6 * * *',
});

/** One 5-field cron expression, fields limited to the numeric/step/range/list
 *  forms GitHub's scheduler accepts. Deliberately strict: the value is
 *  interpolated into a workflow YAML the repo executes, so anything outside
 *  this shape (quotes, names, newlines) is rejected, never passed through. */
const CRON_FIELD = String.raw`(\*|\d+(-\d+)?)(\/\d+)?(,(\*|\d+(-\d+)?)(\/\d+)?)*`;
const CRON_RE = new RegExp(`^${CRON_FIELD}( ${CRON_FIELD}){4}$`);

/**
 * The ONE normalizer of the baseline-refresh cadence (Rule 2): the workflow
 * installer renders whatever this returns, and every other reader (docs
 * tooling, future surfaces) goes through it too. Named cadences map to their
 * cron; a raw value must pass the strict 5-field validation; anything else —
 * absent, malformed, unsafe — falls back to the weekly default.
 */
export function baselineRefreshCron(policy: {
  readonly baseline?: { readonly refreshCadence?: string };
}): string {
  return cronFromCadence(policy.baseline?.refreshCadence);
}

/**
 * The cadence GRAMMAR itself, shared by every scheduled-lane knob (baseline
 * refresh, remediate schedule): a named cadence, a strictly-validated raw
 * 5-field cron, or the weekly default. One grammar, so "weekly" means the
 * same thing on every surface that schedules anything.
 */
export function cronFromCadence(
  declared: string | undefined,
  fallback: string = DEFAULT_BASELINE_REFRESH_CRON,
): string {
  if (typeof declared !== 'string') return fallback;
  const trimmed = declared.trim();
  const named = NAMED_REFRESH_CADENCES[trimmed];
  if (named) return named;
  if (CRON_RE.test(trimmed)) return trimmed;
  return fallback;
}

/** The dep-bump lane's default: weekly, Monday 07:00 UTC — an hour after the
 *  refresh/remediate default so the lanes do not pile onto one runner window.
 *  A declared `depBump.schedule` goes through the ONE cadence grammar above
 *  (note "weekly" is the shared Mon 06:00 — the 07:00 offset is the ABSENT
 *  default, not a named cadence). */
export const DEFAULT_DEPBUMP_CRON = '0 7 * * 1';

/** `licenses.*` block in `.dxkit/policy.json`. */
export interface LicensesPolicy {
  /**
   * SPDX license ids or family prefixes this repo prohibits in its dependency
   * tree (e.g. `["GPL-", "AGPL-3.0"]`). Matching is prefix-based per SPDX
   * term, with compound expressions (`"GPL-3.0 OR MIT"`) split so a
   * dual-licensed package still matches — the one canonical matcher
   * (`licenseMatchesAny`). Empty/absent ⟹ the prohibited-license rule is
   * inert (the default). `UNKNOWN` never matches unless explicitly listed —
   * an unresolvable license is a disclosure problem, not a violation (the
   * false-negative bias).
   */
  readonly prohibited?: ReadonlyArray<string>;
}

/**
 * The ONE normalizer of the prohibited-license list (Rule 2): the baseline
 * producer, the recall inputs, and every renderer read the effective list
 * through this. Non-strings and blanks are dropped; order is normalized so
 * the recall input is byte-stable across policy reformats.
 */
export function prohibitedLicensePatterns(policy: {
  readonly licenses?: LicensesPolicy;
}): ReadonlyArray<string> {
  const declared = policy.licenses?.prohibited;
  if (!Array.isArray(declared)) return [];
  return [
    ...new Set(
      declared
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}
