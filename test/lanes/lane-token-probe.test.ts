import { describe, it, expect } from 'vitest';
import {
  probeLaneTokenTier,
  probeLaneTokenTierHere,
  LANE_TOKEN_REMEDY_COMMAND,
} from '../../src/lanes/lane-token-probe';
import {
  LANE_TOKEN_APP_ID_VARIABLE_NAME,
  LANE_TOKEN_APP_KEY_SECRET_NAME,
  LANE_TOKEN_PAT_SECRET_NAME,
  LANE_TOKEN_MODE_EXPR,
  LANE_TOKEN_STEPS,
} from '../../src/lanes/lane-token';
import { laneTokenTierCheck } from '../../src/doctor';
import type { ApiProbe } from '../../src/lanes/delivery-preconditions';

/**
 * dxkit #325: doctor asserted "no lane token tier is configured" when the
 * tier lived at the ORG level (or the token could not list it). The probe
 * is tri-state; these tests pin every state from fixture payloads and both
 * directions of the doctor rendering: configured-but-unreadable yields the
 * "could not verify" advice, genuinely absent yields the remedy.
 */

const SLUG = 'acme/widgets';

type Payloads = Partial<Record<string, string | null>>;

/** A gh-api stand-in: unlisted paths are unreachable (null), like a 403/404. */
function fakeProbe(payloads: Payloads): ApiProbe {
  return (apiPath) => {
    const key = apiPath.replace(/\?per_page=\d+$/, '');
    return key in payloads ? (payloads[key] ?? null) : null;
  };
}

const vars = (...names: string[]) => JSON.stringify({ variables: names.map((name) => ({ name })) });
const secrets = (...names: string[]) =>
  JSON.stringify({ secrets: names.map((name) => ({ name })) });
const orgOwner = JSON.stringify({ owner: { type: 'Organization' } });
const userOwner = JSON.stringify({ owner: { type: 'User' } });

const P = {
  repo: `repos/${SLUG}`,
  repoVars: `repos/${SLUG}/actions/variables`,
  repoSecrets: `repos/${SLUG}/actions/secrets`,
  orgVars: `repos/${SLUG}/actions/organization-variables`,
  orgSecrets: `repos/${SLUG}/actions/organization-secrets`,
};

describe('probeLaneTokenTier: the three states', () => {
  it('org-level App tier reads as configured (the #325 repro)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(),
        [P.orgVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.orgSecrets]: secrets(LANE_TOKEN_APP_KEY_SECRET_NAME),
      }),
      SLUG,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'org' });
  });

  it('repo-level PAT tier reads as configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_PAT_SECRET_NAME),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'pat', scope: 'repo' });
  });

  it('the App id split across scopes (org variable, repo secret) still reads as configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_APP_KEY_SECRET_NAME),
        [P.orgVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'org' });
  });

  it('a configured tier wins even when another scope is unreadable', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.repoSecrets]: secrets(LANE_TOKEN_APP_KEY_SECRET_NAME),
        // org endpoints 403 (unlisted)
      }),
      SLUG,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'repo' });
  });

  it('every applicable scope enumerated and empty is the only way to reach not-configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars('OTHER'),
        [P.repoSecrets]: secrets('NPM_TOKEN'),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
    );
    expect(r.state).toBe('not-configured');
  });

  it('repo scopes empty + org scopes unreadable is UNOBSERVABLE, never absent (the #325 bug)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(),
        // org endpoints 403/404 (unlisted)
      }),
      SLUG,
    );
    expect(r.state).toBe('unobservable');
    if (r.state === 'unobservable') {
      expect(r.reason).toContain('org variables');
      expect(r.reason).toContain('org secrets');
      expect(r.reason).not.toContain('repo variables');
    }
  });

  it('an unknown owner type keeps the org scopes applicable (no negative from an assumption)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        // repos/{slug} unreachable
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(),
      }),
      SLUG,
    );
    expect(r.state).toBe('unobservable');
  });

  it('a user-owned repo has no org scope: empty repo scopes are a genuine absence', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: userOwner,
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(),
      }),
      SLUG,
    );
    expect(r.state).toBe('not-configured');
  });

  it('the App id without its key, with secrets unreadable, is unobservable', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.orgVars]: vars(),
      }),
      SLUG,
    );
    expect(r.state).toBe('unobservable');
  });

  it('an unparseable payload counts as unreadable', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: 'not json',
        [P.repoSecrets]: secrets(),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
    );
    expect(r).toMatchObject({ state: 'unobservable' });
    if (r.state === 'unobservable') expect(r.reason).toContain('repo variables');
  });

  it('no GitHub repo / no gh is unobservable', () => {
    const r = probeLaneTokenTierHere('/nonexistent', {
      probe: () => null,
      slug: undefined,
    });
    // repoSlug on a nonexistent dir fails -> null slug
    expect(r.state).toBe('unobservable');
  });

  it('probeLaneTokenTierHere routes an injected slug + probe to the pure probe', () => {
    const r = probeLaneTokenTierHere('/nonexistent', {
      slug: SLUG,
      probe: fakeProbe({
        [P.repo]: orgOwner,
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_PAT_SECRET_NAME),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
    });
    expect(r).toMatchObject({ state: 'configured', tier: 'pat' });
  });
});

describe('one name set: the probe and the workflow chain read the same names', () => {
  it('the mode expression and mint step use the constants the probe reads', () => {
    expect(LANE_TOKEN_MODE_EXPR).toContain(`vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME}`);
    expect(LANE_TOKEN_MODE_EXPR).toContain(`secrets.${LANE_TOKEN_PAT_SECRET_NAME}`);
    expect(LANE_TOKEN_STEPS).toContain(`secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME}`);
    expect(LANE_TOKEN_REMEDY_COMMAND).toContain(LANE_TOKEN_APP_ID_VARIABLE_NAME);
    expect(LANE_TOKEN_REMEDY_COMMAND).toContain(LANE_TOKEN_APP_KEY_SECRET_NAME);
  });
});

describe('doctor rendering (laneTokenTierCheck), both directions', () => {
  it('configured: no finding', () => {
    expect(
      laneTokenTierCheck({ state: 'configured', tier: 'app', scope: 'org', evidence: 'x' }),
    ).toBeNull();
  });

  it('not-configured: the red finding with the remedy command', () => {
    const c = laneTokenTierCheck({ state: 'not-configured', evidence: 'nothing present' });
    expect(c).not.toBeNull();
    expect(c!.ok).toBe(false);
    expect(c!.advisory).toBeUndefined();
    expect(c!.label).toContain('no lane token tier is configured');
    expect(c!.fix?.command).toBe(LANE_TOKEN_REMEDY_COMMAND);
  });

  it('unobservable: "could not be verified" advice, never the negative assertion', () => {
    const c = laneTokenTierCheck({
      state: 'unobservable',
      reason: 'could not enumerate org variables',
    });
    expect(c).not.toBeNull();
    expect(c!.advisory).toBe(true);
    expect(c!.label).toContain('could not be verified');
    expect(c!.label).not.toContain('no lane token tier is configured');
    expect(c!.fix?.hint).toContain('org variables');
    expect(c!.fix?.hint).toContain('Disclose token mode');
    // Advice carries no "go configure it" command: the tier may already exist.
    expect(c!.fix?.command).toBeUndefined();
  });
});
