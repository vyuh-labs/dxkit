/**
 * Integration test for `gatherDeadSurfaces` — proves the REAL flow-extraction →
 * tier → convergence pipeline end-to-end, so the convergence "removable" positive
 * is pinned, not just unit-asserted on the pure join.
 *
 * Real `diagnoseFlow` runs against an on-disk decorator-route fixture (the same
 * extraction the flow tests exercise); the structural-duplicate graph is INJECTED
 * (as `dupFindings`) so the test is deterministic + CI-portable without graphify's
 * Python. The manual real-graphify run this mirrors observed the identical result:
 * a co-located `.tsx` consumer makes consumers visible, `/teams` is consumed,
 * `/teams-legacy` (a copy-paste) is unconsumed AND a duplicate → `removable`,
 * and convergence names the twin.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  consumerVisibilityNudge,
  gatherDeadSurfaces,
} from '../../../src/analyzers/convergence/dead-surface-gather';
import { convergeSeams } from '../../../src/analyzers/convergence';
import type { DuplicateFinding } from '../../../src/analyzers/duplication/findings';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A full-stack repo: a controller serving `/teams` (consumed) + `/teams-legacy`
 * (a dead copy-paste of it), and a frontend `.tsx` component that fetches
 * `/teams` — so `frontendConsumers > 0` and consumers are VISIBLE.
 */
function makeRepo(withFrontend: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-deadgather-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fx', version: '0.0.0' }));
  mkdirSync(join(dir, 'src/api'), { recursive: true });
  mkdirSync(join(dir, 'src/components'), { recursive: true });
  writeFileSync(
    join(dir, 'src/api/ctrl.ts'),
    `class TeamsController {\n` +
      `  @get('/teams') listTeams(){ return 1; }\n` +
      `  @get('/teams-legacy') listTeamsLegacy(){ return 1; }\n` +
      `}\n`,
  );
  if (withFrontend) {
    writeFileSync(
      join(dir, 'src/components/TeamList.tsx'),
      `export function TeamList(){ return fetch('/teams'); }\n`,
    );
  } else {
    // A server-to-server call from a service file — NOT a frontend consumer.
    mkdirSync(join(dir, 'src/services'), { recursive: true });
    writeFileSync(
      join(dir, 'src/services/sync.ts'),
      `export function sync(){ return fetch('/teams'); }\n`,
    );
  }
  return dir;
}

/** The structural-duplicate the graph would surface for the two handlers, both
 *  in `src/api/ctrl.ts`. Injected so the test needs no graphify. */
const dupFindings: DuplicateFinding[] = [
  {
    id: 'aaaabbbbccccdddd',
    anchors: [
      { file: 'src/api/ctrl.ts', symbol: 'listTeams', line: 2 },
      { file: 'src/api/ctrl.ts', symbol: 'listTeamsLegacy', line: 3 },
    ],
    score: 0.9,
  },
];

describe('gatherDeadSurfaces — real flow extraction → tier → convergence', () => {
  it('converges a dead copy-paste route to removable when a co-located UI makes consumers visible', async () => {
    const dir = makeRepo(true);
    const res = await gatherDeadSurfaces(dir, { dupFindings });
    // Consumers visible via the co-located .tsx frontend.
    expect(res.crossRepoConsumersVisible).toBe(true);
    // /teams is consumed → not in the unconsumed set; /teams-legacy is dead.
    const paths = res.surfaces.map((s) => s.route.path);
    expect(paths).toContain('/teams-legacy');
    expect(paths).not.toContain('/teams');
    // The dead copy-paste lands removable (dead ∩ duplicate, consumers visible).
    const legacy = res.surfaces.find((s) => s.route.path === '/teams-legacy')!;
    expect(legacy.tier).toBe('removable');
    expect(legacy.reason).toBe('converged-dead');
    expect(legacy.convergesWithDuplicate).toBe(true);
    // Convergence names it, with the twin.
    const conv = convergeSeams(res.surfaces, dupFindings);
    expect(conv).toHaveLength(1);
    expect(conv[0].route.path).toBe('/teams-legacy');
    expect(conv[0].duplicate.anchors.map((a) => a.symbol).sort()).toEqual([
      'listTeams',
      'listTeamsLegacy',
    ]);
  });

  it('the SAME dead copy-paste stays likely (never removable) on a backend with no visible UI consumer', async () => {
    const dir = makeRepo(false);
    const res = await gatherDeadSurfaces(dir, { dupFindings });
    // A server-to-server call is not a frontend consumer → consumers not visible.
    expect(res.crossRepoConsumersVisible).toBe(false);
    const legacy = res.surfaces.find((s) => s.route.path === '/teams-legacy')!;
    expect(legacy.tier).toBe('likely'); // deadness unconfirmed cross-repo → never shout
    expect(legacy.convergesWithDuplicate).toBe(true); // the dup fact is still recorded
    // Convergence does NOT fire on an unconfirmed dead route.
    expect(convergeSeams(res.surfaces, dupFindings)).toHaveLength(0);
  });
});

/**
 * The split-repo consumer mesh: a provider repo whose UI lives in a SIBLING repo,
 * declared via `.dxkit/workspace.json`.
 *
 * This is the regression net for the worst false positive this module can
 * produce. `consumersVisible` once read `participants.length > 0` — the
 * DECLARATION — as proof consumers were visible, while nothing gathered the
 * participant's calls. A user following dxkit's own printed nudge ("declare
 * workspace.json to confirm deadness") thereby graduated every
 * cross-repo-consumed route to `removable`, the tier that says "safe to delete".
 * Reproduced on a real pair: live endpoints marked removable purely because a
 * participant had been NAMED.
 *
 * The three cases below pin the honest ladder across the whole spectrum:
 * declared-but-absent (no evidence), declared-and-read-but-unbindable (no
 * evidence — the misconfigured-client inversion), declared-and-bound (evidence).
 */
function makeProvider(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-mesh-provider-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'provider', version: '0.0.0' }));
  mkdirSync(join(dir, 'src/api'), { recursive: true });
  writeFileSync(
    join(dir, 'src/api/ctrl.ts'),
    `class TeamsController {\n` +
      `  @get('/teams') listTeams(){ return 1; }\n` +
      `  @get('/teams-legacy') listTeamsLegacy(){ return 1; }\n` +
      `}\n`,
  );
  return dir;
}

/** A sibling SPA that consumes the provider. `viaHelper` writes its calls
 *  through a base-URL helper (`${Config.api()}/teams`), which only strips to a
 *  bindable path when the CLIENT's own flow policy declares the helper. */
function makeConsumer(opts: { viaHelper: boolean; withPolicy: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-mesh-consumer-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ui', version: '0.0.0' }));
  mkdirSync(join(dir, 'src/components'), { recursive: true });
  const url = opts.viaHelper ? '`${Config.api()}/teams`' : `'/teams'`;
  writeFileSync(
    join(dir, 'src/components/TeamList.tsx'),
    `export function TeamList(){ return fetch(${url}); }\n`,
  );
  if (opts.withPolicy) {
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(
      join(dir, '.dxkit/policy.json'),
      JSON.stringify({ flow: { mode: 'warn', stripUrlPrefixes: ['${Config.api()}'] } }),
    );
  }
  return dir;
}

function declareParticipant(provider: string, consumerPath: string): void {
  mkdirSync(join(provider, '.dxkit'), { recursive: true });
  writeFileSync(
    join(provider, '.dxkit/workspace.json'),
    JSON.stringify({
      schemaVersion: 1,
      participants: [{ name: 'ui', path: consumerPath }],
      external: [],
    }),
  );
}

describe('gatherDeadSurfaces — cross-repo consumer mesh (workspace participants)', () => {
  it('a DECLARED but not-checked-out participant is not evidence — routes stay likely', async () => {
    const provider = makeProvider();
    declareParticipant(provider, '../does-not-exist-on-disk');
    const res = await gatherDeadSurfaces(provider, { dupFindings });
    // The declaration alone must never satisfy the predicate.
    expect(res.crossRepoConsumersVisible).toBe(false);
    expect(res.byTier.removable).toBe(0);
    const legacy = res.surfaces.find((s) => s.route.path === '/teams-legacy')!;
    expect(legacy.tier).toBe('likely');
  });

  it('a participant READ but whose calls bind nothing is not evidence — the misconfigured-client inversion', async () => {
    const provider = makeProvider();
    // Calls go through a base-URL helper, but the consumer declares no
    // stripUrlPrefixes → every call normalizes to `/{var}/teams` and binds
    // nothing. Plenty of calls, zero connection: that means the join is broken,
    // NOT that the provider's whole surface is dead.
    const consumer = makeConsumer({ viaHelper: true, withPolicy: false });
    declareParticipant(provider, consumer);
    const res = await gatherDeadSurfaces(provider, { dupFindings });
    expect(res.crossRepoConsumersVisible).toBe(false);
    expect(res.byTier.removable).toBe(0);
    // Even /teams — which the consumer genuinely calls — is only `likely`, never
    // presented as removable. Bias to false-negative on deadness.
    expect(res.surfaces.find((s) => s.route.path === '/teams-legacy')!.tier).toBe('likely');
  });

  // The SECOND door into the same bug, found only by re-auditing the arms that
  // looked like peers. `consumersVisible` also returned true when this repo's own
  // `.dxkit/flow/served.json` existed — but publishing what I SERVE says nothing
  // about who CONSUMES me. It is reachable only on repos that serve routes, i.e.
  // exactly where the question matters, so it was never right. Worse, the
  // documented cross-repo setup tells a backend to commit `served.json` so a
  // frontend can gate against it — following our own instructions re-armed the
  // bug. Verified on the real pair: `flow refresh` alone resurrected all 593.
  it('this repo publishing its OWN served.json is not consumer evidence', async () => {
    const provider = makeProvider();
    // No workspace, no consumer — only our own published contract.
    mkdirSync(join(provider, '.dxkit/flow'), { recursive: true });
    writeFileSync(
      join(provider, '.dxkit/flow/served.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: '2026-07-01T00:00:00Z',
        routes: [{ method: 'GET', path: '/teams', file: 'src/api/ctrl.ts', line: 2 }],
      }),
    );
    const res = await gatherDeadSurfaces(provider, { dupFindings });
    expect(res.crossRepoConsumersVisible).toBe(false);
    expect(res.byTier.removable).toBe(0);
    expect(res.surfaces.find((s) => s.route.path === '/teams-legacy')!.tier).toBe('likely');
  });

  it('a participant whose calls BIND is evidence — the dead twin reaches removable, the live route is consumed', async () => {
    const provider = makeProvider();
    const consumer = makeConsumer({ viaHelper: true, withPolicy: true });
    declareParticipant(provider, consumer);
    const res = await gatherDeadSurfaces(provider, { dupFindings });
    // The consumer's calls normalize under ITS OWN policy and bind → real evidence.
    expect(res.crossRepoConsumersVisible).toBe(true);
    const paths = res.surfaces.map((s) => s.route.path);
    // The cross-repo-consumed route is bound, so it is not unconsumed at all.
    expect(paths).not.toContain('/teams');
    // Only the genuinely dead twin converges to removable.
    expect(paths).toContain('/teams-legacy');
    expect(res.surfaces.find((s) => s.route.path === '/teams-legacy')!.tier).toBe('removable');
  });
});

/**
 * The nudge must name the ACTUAL blocker. `crossRepoConsumersVisible` is false
 * for three different reasons and the old single string ("declare
 * workspace.json") was right for only one — telling a user who already declared
 * a workspace to declare a workspace sends them to fix a thing that is not
 * broken. Same confidently-wrong class as the false-`removable` bug itself.
 */
describe('consumerVisibilityNudge — the reason must be true', () => {
  it('is silent when consumers were read', () => {
    expect(consumerVisibilityNudge({ crossRepoConsumersVisible: true })).toBeNull();
  });

  it('no participants declared → the classic "declare workspace.json"', () => {
    const n = consumerVisibilityNudge({ crossRepoConsumersVisible: false });
    expect(n).toContain('declare workspace.json');
  });

  it('declared but NOT checked out → names the participant, never says "declare"', () => {
    const n = consumerVisibilityNudge({
      crossRepoConsumersVisible: false,
      participantConsumers: [{ name: 'ui', source: 'not-checked-out', calls: 0, bound: 0 }],
    });
    expect(n).toContain('ui');
    expect(n).toContain('not checked out');
    // The workspace IS declared — repeating that advice would be a dead end.
    expect(n).not.toContain('declare workspace.json');
  });

  it('read but bound nothing → points at the PARTICIPANT’s strip config', () => {
    const n = consumerVisibilityNudge({
      crossRepoConsumersVisible: false,
      participantConsumers: [{ name: 'ui', source: 'local', calls: 1636, bound: 0 }],
    });
    expect(n).toContain('1636');
    expect(n).toContain('stripUrlPrefixes');
    expect(n).not.toContain('declare workspace.json');
  });

  it('never invents a cause when the state is unrecognized', () => {
    const n = consumerVisibilityNudge({
      crossRepoConsumersVisible: false,
      participantConsumers: [{ name: 'ui', source: 'local', calls: 5, bound: 5 }],
    });
    expect(n).toBe('cross-repo consumers unverified');
  });
});
