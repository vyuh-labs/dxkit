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
 * So the answer mirrors the workflow's own precedence (the App id
 * variable decides the mode, then the PAT, then the default token), and
 * a negative is asserted only when every scope the lane could read was
 * actually ENUMERATED IN FULL. The list endpoints paginate (GitHub caps
 * the variables endpoints at 30 per page), so enumeration follows pages
 * until `total_count` is accounted for and a truncated listing reads as
 * unreadable, never as absence:
 *
 *   - `configured`       a tier was seen (which tier, in which scope);
 *   - `half-configured`  the App tier has exactly one of its two halves,
 *                        in either direction: the id without the key
 *                        makes the mint step die loudly on every run, the
 *                        key without the id silently never picks App mode;
 *   - `not-configured`   every applicable scope was fully enumerated and
 *                        none of the names is present: the remedy is honest;
 *   - `unobservable`     some applicable scope could not be enumerated
 *                        (a 403/404 on the org endpoints, no admin scope,
 *                        a truncated listing, no gh, offline): "could not
 *                        verify", with the unreadable scopes named, never
 *                        a negative. `cause` separates "no GitHub here"
 *                        (the caller stays silent, the old fail-open
 *                        contract) from a permissions gap (advice).
 *
 * The names probed come from lane-token.ts: this module holds no second
 * tier table. Consumers: `doctor` (6d). The probe is injected so every
 * state is testable without a network.
 */

import { type ApiProbe, makeGhApiProbe, probeJson, repoView } from './delivery-preconditions';
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
    }
  | {
      readonly state: 'half-configured';
      /** Which App-tier half is definitively absent. */
      readonly missing: 'app-id-variable' | 'app-private-key-secret';
      readonly evidence: string;
    }
  | {
      readonly state: 'not-configured';
      readonly evidence: string;
    }
  | {
      readonly state: 'unobservable';
      /** `no-github`: not a GitHub checkout / no gh CLI, the caller stays
       *  silent (fail-open, the pre-#325 contract). `permissions`: GitHub
       *  answered for some scopes but not all, advice, never a negative. */
      readonly cause: 'no-github' | 'permissions';
      /** Which scopes could not be enumerated, so why no negative is asserted. */
      readonly reason: string;
    };

/** One scope's full enumeration: the names, or null when unreadable. */
type ScopeRead = ReadonlySet<string> | null;

/** Follow-the-pages ceiling: 20 pages of 30 covers 600 variables, far past
 *  any real Actions configuration; beyond it the scope reads as unreadable
 *  (never as absence). */
const MAX_SCOPE_PAGES = 20;

/**
 * Fully enumerate one Actions list endpoint (`{ total_count, variables|
 * secrets: [{ name }] }`), following pagination. GitHub caps the variables
 * endpoints at 30 per page (secrets at 100). Returns null when the scope
 * cannot be READ IN FULL (an error, an unparseable payload, or a listing
 * that never accounts for `total_count`), because a partial listing cannot
 * back an absence claim (the #325 class, one page deeper).
 */
function readScope(probe: ApiProbe, basePath: string, key: 'variables' | 'secrets'): ScopeRead {
  const perPage = key === 'variables' ? 30 : 100;
  const names = new Set<string>();
  let total = 0;
  for (let page = 1; page <= MAX_SCOPE_PAGES; page++) {
    const parsed = probeJson(probe, `${basePath}?per_page=${perPage}&page=${page}`);
    if (parsed === null || typeof parsed !== 'object') return null;
    const rec = parsed as Record<string, unknown>;
    if (typeof rec.total_count !== 'number') return null;
    total = rec.total_count;
    const list = rec[key];
    if (!Array.isArray(list)) return null;
    for (const item of list) {
      const name = (item as { name?: unknown })?.name;
      if (typeof name === 'string') names.add(name);
    }
    if (names.size >= total || list.length === 0) break;
  }
  return names.size >= total ? names : null;
}

const EMPTY_SCOPE: ReadonlySet<string> = new Set();

/**
 * Probe the tier against the repo AND org scopes, mirroring the workflow
 * chain's precedence. Pure over the injected probe: every state is
 * reachable from fixture payloads.
 *
 * `ownerInOrganization` comes from the caller's one `gh repo view` call
 * (`repoView`): `false` confirms a user-owned repo (no org scope exists,
 * so empty repo scopes ARE a genuine absence); `true` or null keeps the
 * org scopes applicable, the probe never assumes "no org" to reach a
 * negative.
 */
export function probeLaneTokenTier(
  probe: ApiProbe,
  slug: string,
  ownerInOrganization: boolean | null,
): LaneTokenTierProbe {
  const repoVars = readScope(probe, `repos/${slug}/actions/variables`, 'variables');
  const repoSecrets = readScope(probe, `repos/${slug}/actions/secrets`, 'secrets');

  // Short-circuit: a fully-configured App tier in the repo scope needs no
  // org reads (positive evidence already decides the mode).
  if (
    repoVars?.has(LANE_TOKEN_APP_ID_VARIABLE_NAME) === true &&
    repoSecrets?.has(LANE_TOKEN_APP_KEY_SECRET_NAME) === true
  ) {
    return { state: 'configured', tier: 'app', scope: 'repo' };
  }

  const orgApplies = ownerInOrganization !== false;
  const orgVars: ScopeRead = orgApplies
    ? readScope(probe, `repos/${slug}/actions/organization-variables`, 'variables')
    : EMPTY_SCOPE;
  const orgSecrets: ScopeRead = orgApplies
    ? readScope(probe, `repos/${slug}/actions/organization-secrets`, 'secrets')
    : EMPTY_SCOPE;

  const appIdScope: LaneTokenScope | null = repoVars?.has(LANE_TOKEN_APP_ID_VARIABLE_NAME)
    ? 'repo'
    : orgVars?.has(LANE_TOKEN_APP_ID_VARIABLE_NAME)
      ? 'org'
      : null;
  const varsFullyRead = repoVars !== null && orgVars !== null;
  const secretsFullyRead = repoSecrets !== null && orgSecrets !== null;
  const keySeen =
    repoSecrets?.has(LANE_TOKEN_APP_KEY_SECRET_NAME) === true ||
    orgSecrets?.has(LANE_TOKEN_APP_KEY_SECRET_NAME) === true;
  const patScope: LaneTokenScope | null = repoSecrets?.has(LANE_TOKEN_PAT_SECRET_NAME)
    ? 'repo'
    : orgSecrets?.has(LANE_TOKEN_PAT_SECRET_NAME)
      ? 'org'
      : null;

  // The workflow's mode expression picks App mode on the id ALONE, so the
  // id's presence decides first, exactly as at runtime.
  if (appIdScope !== null) {
    if (keySeen) return { state: 'configured', tier: 'app', scope: appIdScope };
    if (secretsFullyRead) {
      return {
        state: 'half-configured',
        missing: 'app-private-key-secret',
        evidence:
          `the ${LANE_TOKEN_APP_ID_VARIABLE_NAME} variable is set (${appIdScope}-level) but no ` +
          `${LANE_TOKEN_APP_KEY_SECRET_NAME} secret exists in the repo or org scope`,
      };
    }
    return {
      state: 'unobservable',
      cause: 'permissions',
      reason:
        `the ${LANE_TOKEN_APP_ID_VARIABLE_NAME} variable is set (${appIdScope}-level) but ` +
        `${unreadableScopes(repoVars, repoSecrets, orgVars, orgSecrets)} could not be ` +
        `enumerated with this token, so the ${LANE_TOKEN_APP_KEY_SECRET_NAME} secret ` +
        `cannot be verified`,
    };
  }

  // No id seen. A PAT is positive evidence of a working tier.
  if (patScope !== null) return { state: 'configured', tier: 'pat', scope: patScope };

  // The other half-configured direction: the key exists but the id is
  // definitively absent, so the workflow never picks App mode.
  if (keySeen && varsFullyRead) {
    return {
      state: 'half-configured',
      missing: 'app-id-variable',
      evidence:
        `a ${LANE_TOKEN_APP_KEY_SECRET_NAME} secret exists but the ` +
        `${LANE_TOKEN_APP_ID_VARIABLE_NAME} variable is absent from the repo and org scope`,
    };
  }

  if (varsFullyRead && secretsFullyRead) {
    return {
      state: 'not-configured',
      evidence:
        `neither ${LANE_TOKEN_APP_ID_VARIABLE_NAME} + ${LANE_TOKEN_APP_KEY_SECRET_NAME} nor ` +
        `${LANE_TOKEN_PAT_SECRET_NAME} is present in the repo or org scope`,
    };
  }

  return {
    state: 'unobservable',
    cause: 'permissions',
    reason:
      `${unreadableScopes(repoVars, repoSecrets, orgVars, orgSecrets)} could not be enumerated ` +
      `with this token (an org-level ${LANE_TOKEN_APP_ID_VARIABLE_NAME} / ` +
      `${LANE_TOKEN_APP_KEY_SECRET_NAME} or ${LANE_TOKEN_PAT_SECRET_NAME} would be invisible here)`,
  };
}

function unreadableScopes(
  repoVars: ScopeRead,
  repoSecrets: ScopeRead,
  orgVars: ScopeRead,
  orgSecrets: ScopeRead,
): string {
  const unreadable: string[] = [];
  if (repoVars === null) unreadable.push('repo variables');
  if (repoSecrets === null) unreadable.push('repo secrets');
  if (orgVars === null) unreadable.push('org variables');
  if (orgSecrets === null) unreadable.push('org secrets');
  return unreadable.join(', ');
}

/**
 * The probe for a checkout. `slug` / `ownerInOrganization` are injectable
 * so a caller that already ran `repoView` (doctor resolves it once and
 * shares it across its lane checks) never triggers a second gh shell; an
 * explicit `slug: null` means "resolved, and there is none". No GitHub
 * repo or no gh CLI is `unobservable` with cause `no-github`, never a
 * negative.
 */
export function probeLaneTokenTierHere(
  cwd: string,
  opts: {
    readonly probe?: ApiProbe;
    readonly slug?: string | null;
    readonly ownerInOrganization?: boolean | null;
  } = {},
): LaneTokenTierProbe {
  let slug: string | null;
  let ownerInOrganization: boolean | null;
  if (opts.slug !== undefined) {
    slug = opts.slug;
    ownerInOrganization = opts.ownerInOrganization ?? null;
  } else {
    const view = repoView(cwd);
    slug = view?.slug ?? null;
    ownerInOrganization = opts.ownerInOrganization ?? view?.inOrganization ?? null;
  }
  if (slug === null) {
    return {
      state: 'unobservable',
      cause: 'no-github',
      reason: 'not a GitHub repo here, or the gh CLI is unavailable',
    };
  }
  return probeLaneTokenTier(opts.probe ?? makeGhApiProbe(cwd), slug, ownerInOrganization);
}
