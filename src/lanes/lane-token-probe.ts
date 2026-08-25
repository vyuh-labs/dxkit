/**
 * The ONE "is a lane token tier configured here?" probe (dxkit #325).
 *
 * The lanes resolve their tier at runtime from whatever GitHub exposes to
 * the workflow (`LANE_TOKEN_MODE_EXPR` in lane-token.ts), and GitHub
 * exposes BOTH repo-level and org-level Actions variables/secrets to a
 * run. A local probe that lists only the repo scope therefore sees a
 * strict subset of what the lane sees, and a probe whose token cannot
 * enumerate a scope sees nothing at all. Folding either gap into "not
 * configured" is the Rule 19 mistake applied to setup advice: an
 * unobserved input cannot back a negative claim. The shipped symptom: an
 * org that configured the App tier (and whose lane runs disclosed
 * "token tier: GitHub App" the same day) was told by `doctor` to go
 * configure it.
 *
 * So the answer is a TRI-STATE, and the negative is asserted only when
 * every scope the lane could read was actually read:
 *
 *   - `configured`      a tier was seen (with which tier and in which scope);
 *   - `not-configured`  every applicable scope was enumerated and none of
 *                       the names is present: the remedy is honest;
 *   - `unobservable`    some applicable scope could not be enumerated (a
 *                       403/404 on the org endpoints, no admin scope, no
 *                       gh, offline): "could not verify", with the scopes
 *                       that were unreadable named, never a negative.
 *
 * The names probed come from lane-token.ts: this module holds no second
 * tier table. Consumers: `doctor` (6d). The probe is injected so every
 * state is testable without a network.
 */

import { type ApiProbe, makeGhApiProbe, repoSlug } from './delivery-preconditions';
import {
  LANE_TOKEN_APP_ID_VARIABLE_NAME,
  LANE_TOKEN_APP_KEY_SECRET_NAME,
  LANE_TOKEN_PAT_SECRET_NAME,
} from './lane-token';

export type LaneTokenTier = 'app' | 'pat';

/** Where a configuration name lives; a run sees both. */
export type LaneTokenScope = 'repo' | 'org';

export type LaneTokenTierProbe =
  | {
      readonly state: 'configured';
      readonly tier: LaneTokenTier;
      /** The scope the deciding name was found in (`app`: the App id variable). */
      readonly scope: LaneTokenScope;
      readonly evidence: string;
    }
  | {
      readonly state: 'not-configured';
      readonly evidence: string;
    }
  | {
      readonly state: 'unobservable';
      /** Which scopes could not be enumerated, and so why no negative is asserted. */
      readonly reason: string;
    };

/** The remedy for a genuinely absent tier, derived from the one name set. */
export const LANE_TOKEN_REMEDY_COMMAND = `gh variable set ${LANE_TOKEN_APP_ID_VARIABLE_NAME} && gh secret set ${LANE_TOKEN_APP_KEY_SECRET_NAME}`;

/** One scope's enumeration: the names seen, or null when unreadable. */
type ScopeRead = ReadonlySet<string> | null;

/** Names from an Actions list payload (`{ variables: [...] }` or
 *  `{ secrets: [...] }`); null when the read failed or is unparseable. */
function namesFrom(raw: string | null, key: 'variables' | 'secrets'): ScopeRead {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const list = parsed[key];
    if (!Array.isArray(list)) return null;
    const names = new Set<string>();
    for (const item of list) {
      const name = (item as { name?: unknown })?.name;
      if (typeof name === 'string') names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

/** Is the repo owned by an organization? null when the API could not say
 *  (then the org scopes are treated as applicable: the probe must not
 *  assume "no org" to reach a negative). */
function ownerIsOrganization(probe: ApiProbe, slug: string): boolean | null {
  const raw = probe(`repos/${slug}`);
  if (raw === null) return null;
  try {
    const type = (JSON.parse(raw) as { owner?: { type?: unknown } })?.owner?.type;
    return typeof type === 'string' ? type === 'Organization' : null;
  } catch {
    return null;
  }
}

/**
 * Probe the tier against the repo AND org scopes. Pure over the injected
 * probe: every state is reachable from fixture payloads.
 */
export function probeLaneTokenTier(probe: ApiProbe, slug: string): LaneTokenTierProbe {
  const page = '?per_page=100';
  const repoVars = namesFrom(probe(`repos/${slug}/actions/variables${page}`), 'variables');
  const repoSecrets = namesFrom(probe(`repos/${slug}/actions/secrets${page}`), 'secrets');

  // A user-owned repo has no org scope: an unreadable org endpoint there is
  // expected, not a gap. Only a CONFIRMED user owner narrows the scopes.
  const orgApplies = ownerIsOrganization(probe, slug) !== false;
  const orgVars: ScopeRead = orgApplies
    ? namesFrom(probe(`repos/${slug}/actions/organization-variables${page}`), 'variables')
    : new Set();
  const orgSecrets: ScopeRead = orgApplies
    ? namesFrom(probe(`repos/${slug}/actions/organization-secrets${page}`), 'secrets')
    : new Set();

  const appIdScope: LaneTokenScope | null = repoVars?.has(LANE_TOKEN_APP_ID_VARIABLE_NAME)
    ? 'repo'
    : orgVars?.has(LANE_TOKEN_APP_ID_VARIABLE_NAME)
      ? 'org'
      : null;
  const appKeySeen =
    repoSecrets?.has(LANE_TOKEN_APP_KEY_SECRET_NAME) === true ||
    orgSecrets?.has(LANE_TOKEN_APP_KEY_SECRET_NAME) === true;
  const patScope: LaneTokenScope | null = repoSecrets?.has(LANE_TOKEN_PAT_SECRET_NAME)
    ? 'repo'
    : orgSecrets?.has(LANE_TOKEN_PAT_SECRET_NAME)
      ? 'org'
      : null;

  // Positive evidence wins regardless of what else was unreadable: a tier
  // seen is a tier the lane will use (the mint step keys on the same names).
  if (appIdScope !== null && appKeySeen) {
    return {
      state: 'configured',
      tier: 'app',
      scope: appIdScope,
      evidence: `GitHub App tier: ${LANE_TOKEN_APP_ID_VARIABLE_NAME} (${appIdScope}-level) + ${LANE_TOKEN_APP_KEY_SECRET_NAME}`,
    };
  }
  if (patScope !== null) {
    return {
      state: 'configured',
      tier: 'pat',
      scope: patScope,
      evidence: `PAT tier: ${LANE_TOKEN_PAT_SECRET_NAME} (${patScope}-level secret)`,
    };
  }

  const unreadable: string[] = [];
  if (repoVars === null) unreadable.push('repo variables');
  if (repoSecrets === null) unreadable.push('repo secrets');
  if (orgVars === null) unreadable.push('org variables');
  if (orgSecrets === null) unreadable.push('org secrets');
  if (unreadable.length > 0) {
    return {
      state: 'unobservable',
      reason:
        `could not enumerate ${unreadable.join(', ')} with this token (an org-level ` +
        `${LANE_TOKEN_APP_ID_VARIABLE_NAME} / ${LANE_TOKEN_APP_KEY_SECRET_NAME} or ${LANE_TOKEN_PAT_SECRET_NAME} ` +
        `would be invisible here); the lane run's "Disclose token mode" step shows the tier ` +
        `actually used`,
    };
  }
  return {
    state: 'not-configured',
    evidence:
      `neither ${LANE_TOKEN_APP_ID_VARIABLE_NAME} + ${LANE_TOKEN_APP_KEY_SECRET_NAME} nor ` +
      `${LANE_TOKEN_PAT_SECRET_NAME} is present in the repo or org scope`,
  };
}

/**
 * The probe for a checkout: resolves the slug and the gh-backed probe,
 * both injectable. No GitHub repo or no gh CLI is `unobservable`, never a
 * negative.
 */
export function probeLaneTokenTierHere(
  cwd: string,
  opts: { readonly probe?: ApiProbe; readonly slug?: string } = {},
): LaneTokenTierProbe {
  const slug = opts.slug ?? repoSlug(cwd);
  if (slug === null) {
    return {
      state: 'unobservable',
      reason: 'not a GitHub repo here, or the gh CLI is unavailable',
    };
  }
  return probeLaneTokenTier(opts.probe ?? makeGhApiProbe(cwd), slug);
}
