/**
 * Enforcement-path detection — the ONE place dxkit learns whether its guardrail
 * is actually ENFORCED on the default branch, as opposed to merely wired.
 *
 * The wiring (a `dxkit-guardrails.yml` on `pull_request`, a pre-push hook) can
 * be present and green while the real enforcement is zero: if the branch takes
 * direct pushes, or nothing requires the `dxkit-guardrails` check to pass, a PR
 * can merge — or a commit can land — without the guardrail ever blocking it.
 * `doctor` reads this to tell the truth instead of reporting a hollow "wired
 * end-to-end", and the baseline-refresh installer reads it to avoid shipping a
 * direct-push refresh workflow onto a protected branch (a guaranteed deadlock:
 * the push is rejected, and a `[skip ci]` commit can never earn the required
 * checks).
 *
 * A branch can be protected by TWO independent GitHub mechanisms, and dxkit
 * reads BOTH — reading only one is the bug that shipped once (a repository
 * ruleset protects `main`, dxkit read only the classic endpoint, saw a 404, and
 * concluded "unprotected" — then auto-selected the direct-push refresh transport
 * that deadlocks):
 *   1. CLASSIC branch protection — `repos/{o}/{r}/branches/{b}/protection`
 *      (404 when no classic rule exists).
 *   2. Repository RULESETS — `repos/{o}/{r}/rules/branches/{b}` returns the
 *      effective rules from all rulesets that match the branch (`[]` when none).
 *      This endpoint does NOT include classic protection, so it is a UNION with
 *      (1), never a replacement.
 *
 * Probing shells `gh api` for each. It is fail-open — a missing / unauthenticated
 * `gh`, no read scope, or an error on BOTH reads yields `probed: false`
 * (unknown), never a throw and never a false "enforced". If either mechanism is
 * successfully read and shows protection, that is a definitive `probed: true`
 * even when the other read failed (so a non-admin who can read rulesets but not
 * classic protection still gets a correct answer). Results are cached per
 * resolved cwd, mirroring `visibility.ts`.
 */

import * as path from 'path';
import { ghApi, ghCliAvailable, resolveDefaultBranch, GhError } from './setup-gh';

/** The guardrail status check dxkit installs + expects a protected branch to
 *  require. Kept in sync with `setup-branch-protection.ts`. */
export const GUARDRAIL_CHECK = 'dxkit-guardrails';

/** Minimal subset of GitHub's CLASSIC branch-protection payload dxkit reads. */
interface ClassicProtection {
  required_status_checks?: { contexts?: string[] } | null;
  required_pull_request_reviews?: unknown | null;
  enforce_admins?: { enabled?: boolean } | boolean | null;
}

/** Minimal subset of one effective RULESET rule object (from the rules-for-a-
 *  branch endpoint). Only the fields dxkit classifies on. */
interface EffectiveRule {
  type?: string;
  parameters?: {
    /** For `required_status_checks` rules — the checks the ruleset requires.
     *  Note the shape differs from classic (`contexts: string[]`): rulesets nest
     *  each check as `{ context }`. */
    required_status_checks?: { context?: string }[] | null;
  } | null;
}

/** Raw reads from both protection mechanisms + whether each read succeeded. The
 *  pure classifier turns this into the enforcement facts. */
export interface EnforcementReads {
  /** Classic branch-protection payload, or `null` for "no classic rule" (404). */
  readonly classic: ClassicProtection | null;
  /** Did the classic-protection read succeed (a definitive answer, incl. 404)? */
  readonly classicKnown: boolean;
  /** Effective ruleset rules matching the branch (`[]` when none apply). */
  readonly rules: EffectiveRule[];
  /** Did the ruleset read succeed? */
  readonly rulesKnown: boolean;
}

export interface EnforcementState {
  /** The branch probed (the repo's default branch). */
  readonly branch: string;
  /** Whether dxkit could get a definitive answer. `false` when `gh` is
   *  absent/unauthenticated or BOTH protection reads failed (no read scope,
   *  network). Consumers must treat `false` as "unknown", never "unprotected". */
  readonly probed: boolean;
  /** Direct pushes to `branch` are blocked — a protection rule (classic OR a
   *  ruleset) requires a PR and/or passing status checks, so a bare `git push`
   *  is rejected. */
  readonly directPushBlocked: boolean;
  /** The `dxkit-guardrails` check is a REQUIRED status check on `branch` (via
   *  classic protection or a ruleset), i.e. the guardrail actually gates merges
   *  rather than running informationally. */
  readonly guardrailRequired: boolean;
  /** A repository RULESET governs `branch` (at least one effective rule). When
   *  true, `protect` must not create a conflicting classic rule — the guardrail
   *  belongs in the ruleset. */
  readonly rulesetGoverned: boolean;
}

/** Rule types that reject a direct push (mirror of classic requiresChecks ||
 *  requiresPr). Ref-integrity rules (`non_fast_forward`, `creation`,
 *  `deletion`) are deliberately excluded — they don't block a normal commit. */
const PUSH_BLOCKING_RULE_TYPES = new Set(['pull_request', 'required_status_checks']);

function classicBlocksDirectPush(classic: ClassicProtection | null): boolean {
  if (!classic) return false;
  const requiresChecks = (classic.required_status_checks?.contexts ?? []).length > 0;
  const requiresPr = classic.required_pull_request_reviews != null;
  return requiresChecks || requiresPr;
}

function classicRequiresGuardrail(classic: ClassicProtection | null): boolean {
  return (classic?.required_status_checks?.contexts ?? []).includes(GUARDRAIL_CHECK);
}

function rulesBlockDirectPush(rules: EffectiveRule[]): boolean {
  return rules.some((r) => r.type != null && PUSH_BLOCKING_RULE_TYPES.has(r.type));
}

function rulesRequireGuardrail(rules: EffectiveRule[]): boolean {
  return rules.some(
    (r) =>
      r.type === 'required_status_checks' &&
      (r.parameters?.required_status_checks ?? []).some((c) => c.context === GUARDRAIL_CHECK),
  );
}

/**
 * Pure classifier: given the raw reads from both protection mechanisms (or
 * `null` when nothing could be read), decide the enforcement facts. Exported for
 * direct unit testing without shelling to `gh`.
 *
 * `probed` is true when we have a trustworthy answer: either a read showed
 * protection (definitive "enforced"), or BOTH reads succeeded and showed none
 * (definitive "unprotected"). It is false only when the reads that succeeded
 * showed nothing AND at least one read failed — we cannot then rule out
 * protection we couldn't see.
 */
export function classifyEnforcement(
  branch: string,
  reads: EnforcementReads | null,
): EnforcementState {
  if (!reads) {
    return {
      branch,
      probed: false,
      directPushBlocked: false,
      guardrailRequired: false,
      rulesetGoverned: false,
    };
  }
  const directPushBlocked =
    classicBlocksDirectPush(reads.classic) || rulesBlockDirectPush(reads.rules);
  const guardrailRequired =
    classicRequiresGuardrail(reads.classic) || rulesRequireGuardrail(reads.rules);
  const rulesetGoverned = reads.rulesKnown && reads.rules.length > 0;

  const sawProtection = directPushBlocked || guardrailRequired || rulesetGoverned;
  const bothRead = reads.classicKnown && reads.rulesKnown;
  const probed = sawProtection || bothRead;

  return { branch, probed, directPushBlocked, guardrailRequired, rulesetGoverned };
}

const CACHE = new Map<string, EnforcementState>();

/** Test seam — drop the per-cwd cache. */
export function clearEnforcementCache(): void {
  CACHE.clear();
}

/**
 * Read both protection mechanisms via `gh api`. Each read is independently
 * fail-soft: a 404 is a definitive "no rule of this kind"; any other error
 * leaves that mechanism `*Known: false`. Throws only when `gh` is unavailable or
 * NEITHER mechanism could be read (a total inability to answer), which the
 * caller maps to `probed: false`. This is the ONE place both protection
 * endpoints are shelled — `protect` and `detectEnforcement` both route here.
 */
export function probeEnforcementReads(cwd: string, branch: string): EnforcementReads {
  if (!ghCliAvailable()) throw new GhError('gh unavailable');

  let classic: ClassicProtection | null = null;
  let classicKnown = false;
  try {
    classic = ghApi(`repos/{owner}/{repo}/branches/${branch}/protection`, {
      cwd,
      method: 'GET',
    }) as ClassicProtection;
    classicKnown = true;
  } catch (e) {
    // 404 = no classic protection rule (definitive). Anything else (403 without
    // admin scope, network) leaves classic unknown.
    if (e instanceof GhError && e.httpStatus === 404) classicKnown = true;
  }

  let rules: EffectiveRule[] = [];
  let rulesKnown = false;
  try {
    const raw = ghApi(`repos/{owner}/{repo}/rules/branches/${branch}`, {
      cwd,
      method: 'GET',
    });
    rules = Array.isArray(raw) ? (raw as EffectiveRule[]) : [];
    rulesKnown = true;
  } catch (e) {
    // The rules endpoint returns `[]` (200) when no ruleset matches; a 404 means
    // the branch/repo path resolved to nothing — treat as "no ruleset rules".
    if (e instanceof GhError && e.httpStatus === 404) rulesKnown = true;
  }

  if (!classicKnown && !rulesKnown) {
    throw new GhError('could not read branch protection (classic or ruleset)');
  }
  return { classic, classicKnown, rules, rulesKnown };
}

/**
 * Probe how the default branch is protected. Cached per resolved cwd. Fail-open:
 * an inability to answer → `probed: false`. An injected `probe` (for tests)
 * bypasses `gh`; production reads both classic protection and rulesets.
 */
export function detectEnforcement(
  cwd: string,
  opts: { probe?: (cwd: string, branch: string) => EnforcementReads } = {},
): EnforcementState {
  const key = path.resolve(cwd);
  const cached = CACHE.get(key);
  if (cached) return cached;

  const probeFn = opts.probe ?? probeEnforcementReads;

  const branch = safeDefaultBranch(cwd);
  let state: EnforcementState;
  try {
    const reads = probeFn(cwd, branch);
    state = classifyEnforcement(branch, reads);
  } catch {
    state = classifyEnforcement(branch, null);
  }
  CACHE.set(key, state);
  return state;
}

/** Resolve the default branch without letting a gh failure escape. */
function safeDefaultBranch(cwd: string): string {
  try {
    return resolveDefaultBranch(cwd);
  } catch {
    return 'main';
  }
}
