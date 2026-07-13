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
import { gatherDeadSurfaces } from '../../../src/analyzers/convergence/dead-surface-gather';
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
