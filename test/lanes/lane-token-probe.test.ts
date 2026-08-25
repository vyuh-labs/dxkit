import { describe, it, expect } from 'vitest';
import { probeLaneTokenTier, probeLaneTokenTierHere } from '../../src/lanes/lane-token-probe';
import {
  LANE_TOKEN_APP_ID_REMEDY_COMMAND,
  LANE_TOKEN_APP_ID_VARIABLE_NAME,
  LANE_TOKEN_APP_KEY_REMEDY_COMMAND,
  LANE_TOKEN_APP_KEY_SECRET_NAME,
  LANE_TOKEN_MODE_EXPR,
  LANE_TOKEN_PAT_SECRET_NAME,
  LANE_TOKEN_REMEDY_COMMAND,
  LANE_TOKEN_STEPS,
  LANE_TOKEN_TASK_STEPS,
} from '../../src/lanes/lane-token';
import { laneTokenTierCheck } from '../../src/doctor';
import type { ApiProbe } from '../../src/lanes/delivery-preconditions';

/**
 * dxkit #325: doctor asserted "no lane token tier is configured" when the
 * tier lived at the ORG level (or the token could not list it). The probe
 * mirrors the workflow chain's precedence and answers configured /
 * half-configured / not-configured / unobservable; these tests pin every
 * state from fixture payloads, the pagination-honesty rule (a truncated
 * listing can never back a negative), and both directions of the doctor
 * rendering.
 */

const SLUG = 'acme/widgets';

type Payloads = Partial<Record<string, string | null>>;

/** A gh-api stand-in keyed by path (query string stripped); unlisted paths
 *  are unreachable (null), like a 403/404. */
function fakeProbe(payloads: Payloads): ApiProbe {
  return (apiPath) => {
    const key = apiPath.replace(/\?.*$/, '');
    return key in payloads ? (payloads[key] ?? null) : null;
  };
}

const vars = (...names: string[]) =>
  JSON.stringify({ total_count: names.length, variables: names.map((name) => ({ name })) });
const secrets = (...names: string[]) =>
  JSON.stringify({ total_count: names.length, secrets: names.map((name) => ({ name })) });

const P = {
  repoVars: `repos/${SLUG}/actions/variables`,
  repoSecrets: `repos/${SLUG}/actions/secrets`,
  orgVars: `repos/${SLUG}/actions/organization-variables`,
  orgSecrets: `repos/${SLUG}/actions/organization-secrets`,
};

describe('probeLaneTokenTier: the states', () => {
  it('org-level App tier reads as configured (the #325 repro)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(),
        [P.orgVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.orgSecrets]: secrets(LANE_TOKEN_APP_KEY_SECRET_NAME),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'org' });
  });

  it('repo-level PAT tier reads as configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_PAT_SECRET_NAME),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'pat', scope: 'repo' });
  });

  it('a repo-level App tier short-circuits the org reads', () => {
    let orgReads = 0;
    const probe: ApiProbe = (apiPath) => {
      if (apiPath.includes('organization-')) {
        orgReads++;
        return null;
      }
      if (apiPath.includes('/variables')) return vars(LANE_TOKEN_APP_ID_VARIABLE_NAME);
      return secrets(LANE_TOKEN_APP_KEY_SECRET_NAME);
    };
    const r = probeLaneTokenTier(probe, SLUG, true);
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'repo' });
    expect(orgReads).toBe(0);
  });

  it('the App id split across scopes (org variable, repo secret) still reads as configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_APP_KEY_SECRET_NAME),
        [P.orgVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'org' });
  });

  it('every applicable scope fully enumerated and empty is the only way to reach not-configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars('OTHER'),
        [P.repoSecrets]: secrets('NPM_TOKEN'),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r.state).toBe('not-configured');
  });

  it('repo scopes empty + org scopes unreadable is UNOBSERVABLE, never absent (the #325 bug)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(),
        // org endpoints 403/404 (unlisted)
      }),
      SLUG,
      true,
    );
    expect(r.state).toBe('unobservable');
    if (r.state === 'unobservable') {
      expect(r.cause).toBe('permissions');
      expect(r.reason).toContain('org variables');
      expect(r.reason).toContain('org secrets');
      expect(r.reason).not.toContain('repo variables');
    }
  });

  it('an unknown owner shape keeps the org scopes applicable (no negative from an assumption)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({ [P.repoVars]: vars(), [P.repoSecrets]: secrets() }),
      SLUG,
      null,
    );
    expect(r.state).toBe('unobservable');
  });

  it('a user-owned repo has no org scope: empty repo scopes are a genuine absence', () => {
    const r = probeLaneTokenTier(
      fakeProbe({ [P.repoVars]: vars(), [P.repoSecrets]: secrets() }),
      SLUG,
      false,
    );
    expect(r.state).toBe('not-configured');
  });

  it('an unparseable payload counts as unreadable', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: 'not json',
        [P.repoSecrets]: secrets(),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'unobservable', cause: 'permissions' });
    if (r.state === 'unobservable') expect(r.reason).toContain('repo variables');
  });
});

describe('half-configured App tier, both directions', () => {
  it('the id without the key is half-configured (the mint step dies loudly)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.repoSecrets]: secrets(),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'half-configured', missing: 'app-private-key-secret' });
  });

  it('the id wins over a present PAT, mirroring the mode expression precedence', () => {
    // The workflow picks App mode on the id alone: a half-configured App
    // tier breaks lane runs even when a PAT is also set.
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.repoSecrets]: secrets(LANE_TOKEN_PAT_SECRET_NAME),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'half-configured', missing: 'app-private-key-secret' });
  });

  it('the key without the id is half-configured (App mode is never picked)', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_APP_KEY_SECRET_NAME),
        [P.orgVars]: vars(),
        [P.orgSecrets]: secrets(),
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'half-configured', missing: 'app-id-variable' });
  });

  it('the id with UNREADABLE secret scopes is unobservable, not half-configured', () => {
    const r = probeLaneTokenTier(
      fakeProbe({
        [P.repoVars]: vars(LANE_TOKEN_APP_ID_VARIABLE_NAME),
        [P.orgVars]: vars(),
        // both secret scopes unreadable
      }),
      SLUG,
      true,
    );
    expect(r).toMatchObject({ state: 'unobservable', cause: 'permissions' });
    if (r.state === 'unobservable') expect(r.reason).toContain(LANE_TOKEN_APP_KEY_SECRET_NAME);
  });
});

describe('pagination honesty (the #325 class one page deeper)', () => {
  const fill = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}_${i}`);

  it('a name past the first variables page (GitHub caps at 30) is still found', () => {
    const all = [...fill(30, 'V'), LANE_TOKEN_APP_ID_VARIABLE_NAME];
    const probe: ApiProbe = (apiPath) => {
      if (apiPath.startsWith(`${P.repoVars}?`)) {
        const page = Number(/page=(\d+)$/.exec(apiPath)?.[1] ?? '1');
        const slice = all.slice((page - 1) * 30, page * 30);
        return JSON.stringify({
          total_count: all.length,
          variables: slice.map((name) => ({ name })),
        });
      }
      if (apiPath.startsWith(`${P.repoSecrets}?`)) return secrets(LANE_TOKEN_APP_KEY_SECRET_NAME);
      return null;
    };
    const r = probeLaneTokenTier(probe, SLUG, true);
    expect(r).toMatchObject({ state: 'configured', tier: 'app', scope: 'repo' });
  });

  it('a TRUNCATED listing (total_count never accounted for) reads as unobservable, never as absence', () => {
    const probe: ApiProbe = (apiPath) => {
      if (apiPath.startsWith(`${P.repoVars}?`)) {
        // Claims 31 variables but only ever serves the same first page.
        return JSON.stringify({
          total_count: 31,
          variables: fill(30, 'V').map((name) => ({ name })),
        });
      }
      if (apiPath.startsWith(`${P.repoSecrets}?`)) return secrets();
      if (apiPath.includes('organization-variables')) return vars();
      if (apiPath.includes('organization-secrets')) return secrets();
      return null;
    };
    const r = probeLaneTokenTier(probe, SLUG, true);
    expect(r).toMatchObject({ state: 'unobservable', cause: 'permissions' });
    if (r.state === 'unobservable') expect(r.reason).toContain('repo variables');
  });
});

describe('probeLaneTokenTierHere', () => {
  it('an explicit null slug (no GitHub repo resolved) is unobservable with cause no-github', () => {
    const r = probeLaneTokenTierHere('/nonexistent', { probe: () => null, slug: null });
    expect(r).toMatchObject({ state: 'unobservable', cause: 'no-github' });
  });

  it('routes an injected slug + owner shape + probe to the pure probe', () => {
    const r = probeLaneTokenTierHere('/nonexistent', {
      slug: SLUG,
      ownerInOrganization: false,
      probe: fakeProbe({
        [P.repoVars]: vars(),
        [P.repoSecrets]: secrets(LANE_TOKEN_PAT_SECRET_NAME),
      }),
    });
    expect(r).toMatchObject({ state: 'configured', tier: 'pat' });
  });
});

describe('one name set: probe, workflow chain, and remedies read the same names', () => {
  it('the mode expression and mint steps use the constants the probe reads', () => {
    expect(LANE_TOKEN_MODE_EXPR).toContain(`vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME}`);
    expect(LANE_TOKEN_MODE_EXPR).toContain(`secrets.${LANE_TOKEN_PAT_SECRET_NAME}`);
    expect(LANE_TOKEN_STEPS).toContain(`secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME}`);
    expect(LANE_TOKEN_TASK_STEPS).toContain(`vars.${LANE_TOKEN_APP_ID_VARIABLE_NAME}`);
    expect(LANE_TOKEN_TASK_STEPS).toContain(`secrets.${LANE_TOKEN_APP_KEY_SECRET_NAME}`);
    expect(LANE_TOKEN_REMEDY_COMMAND).toContain(LANE_TOKEN_APP_ID_VARIABLE_NAME);
    expect(LANE_TOKEN_REMEDY_COMMAND).toContain(LANE_TOKEN_APP_KEY_SECRET_NAME);
  });
});

describe('doctor rendering (laneTokenTierCheck), every state', () => {
  it('configured: no finding', () => {
    expect(laneTokenTierCheck({ state: 'configured', tier: 'app', scope: 'org' })).toBeNull();
  });

  it('not-configured: the red finding with the remedy command', () => {
    const c = laneTokenTierCheck({ state: 'not-configured', evidence: 'nothing present' });
    expect(c).not.toBeNull();
    expect(c!.ok).toBe(false);
    expect(c!.advisory).toBeUndefined();
    expect(c!.label).toContain('no lane token tier is configured');
    expect(c!.fix?.command).toBe(LANE_TOKEN_REMEDY_COMMAND);
  });

  it('half-configured (missing key): red, names the missing half, remedies the key', () => {
    const c = laneTokenTierCheck({
      state: 'half-configured',
      missing: 'app-private-key-secret',
      evidence: 'id set, key absent',
    });
    expect(c).not.toBeNull();
    expect(c!.ok).toBe(false);
    expect(c!.advisory).toBeUndefined();
    expect(c!.label).toContain(`${LANE_TOKEN_APP_KEY_SECRET_NAME} secret is missing`);
    expect(c!.fix?.command).toBe(LANE_TOKEN_APP_KEY_REMEDY_COMMAND);
  });

  it('half-configured (missing id): red, names the missing half, remedies the variable', () => {
    const c = laneTokenTierCheck({
      state: 'half-configured',
      missing: 'app-id-variable',
      evidence: 'key set, id absent',
    });
    expect(c).not.toBeNull();
    expect(c!.label).toContain(`${LANE_TOKEN_APP_ID_VARIABLE_NAME} variable is missing`);
    expect(c!.fix?.command).toBe(LANE_TOKEN_APP_ID_REMEDY_COMMAND);
  });

  it('unobservable (permissions): "could not be verified" advice, never the negative assertion', () => {
    const c = laneTokenTierCheck({
      state: 'unobservable',
      cause: 'permissions',
      reason: 'org variables, org secrets could not be enumerated with this token',
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

  it('unobservable (no-github): SILENT, the pre-#325 fail-open contract', () => {
    expect(
      laneTokenTierCheck({
        state: 'unobservable',
        cause: 'no-github',
        reason: 'not a GitHub repo here, or the gh CLI is unavailable',
      }),
    ).toBeNull();
  });
});
