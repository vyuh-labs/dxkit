/**
 * The repo/system flow-model boundary — `gatherRepoFlowModel` vs
 * `gatherSystemFlowModel`.
 *
 * These are two concepts, and collapsing them breaks in BOTH directions:
 *
 *   - Reading only this repo on an ANALYSIS surface declares a split-repo
 *     system's whole API unconsumed, because the UI that calls it lives in
 *     another repo. That shipped as the dead-surface false positive: live,
 *     actively-called endpoints presented as `removable`.
 *   - Reading participants on an AUTHORING surface writes another repo's calls
 *     into this repo's committed `consumed.json`, under `../sibling/...`
 *     locators that mean nothing on another machine — breaking the
 *     environment-independence the artifact's identity contract rests on
 *     (Rule 9).
 *
 * So the boundary is pinned from both sides here, plus the round-trip through
 * `flow refresh` (the real writer).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { gatherRepoFlowModel, gatherSystemFlowModel } from '../src/analyzers/flow/gather';
import { sawParticipantConsumers } from '../src/analyzers/flow/model';
import { runFlowRefresh } from '../src/flow-contract-cli';
import { readConsumedContract } from '../src/analyzers/flow/contract';
import { trustedLocalContext } from '../src/analysis-trust';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A provider repo serving `/teams`, with one in-repo server-to-server call. */
function makeProvider(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-mesh-p-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'provider', version: '0.0.0' }));
  mkdirSync(join(dir, 'src/api'), { recursive: true });
  writeFileSync(
    join(dir, 'src/api/ctrl.ts'),
    `class TeamsController {\n  @get('/teams') listTeams(){ return 1; }\n}\n`,
  );
  mkdirSync(join(dir, 'src/services'), { recursive: true });
  writeFileSync(
    join(dir, 'src/services/sync.ts'),
    `export function s(){ return fetch('/teams'); }\n`,
  );
  return dir;
}

/** A sibling SPA consuming the provider through its own base-URL helper, with
 *  the policy that makes the helper strippable. */
function makeConsumer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-mesh-c-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ui', version: '0.0.0' }));
  mkdirSync(join(dir, 'src/components'), { recursive: true });
  writeFileSync(
    join(dir, 'src/components/TeamList.tsx'),
    'export function T(){ return fetch(`${Config.api()}/teams`); }\n',
  );
  mkdirSync(join(dir, '.dxkit'), { recursive: true });
  writeFileSync(
    join(dir, '.dxkit/policy.json'),
    JSON.stringify({ flow: { mode: 'warn', stripUrlPrefixes: ['${Config.api()}'] } }),
  );
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

describe('flow model scope — repo vs system', () => {
  it('gatherRepoFlowModel NEVER reaches across the workspace boundary', async () => {
    const provider = makeProvider();
    declareParticipant(provider, makeConsumer());
    const model = await gatherRepoFlowModel(provider, { trust: trustedLocalContext() });
    // Only this repo's own call. The participant is declared and on disk, and
    // must still be invisible here.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0].file).toContain('src/services/sync.ts');
    expect(model.calls.some((c) => c.file.includes('TeamList'))).toBe(false);
    // No provenance at all — the repo model has no opinion about participants.
    expect(model.participantConsumers).toBeUndefined();
    expect(sawParticipantConsumers(model)).toBe(false);
  });

  it('gatherSystemFlowModel merges the participant consumed side, normalized by the PARTICIPANT policy', async () => {
    const provider = makeProvider();
    declareParticipant(provider, makeConsumer());
    const model = await gatherSystemFlowModel(provider, { trust: trustedLocalContext() });
    const fromConsumer = model.calls.filter((c) => c.file.includes('TeamList'));
    expect(fromConsumer).toHaveLength(1);
    // `${Config.api()}/teams` only strips to `/teams` under the CONSUMER's own
    // stripUrlPrefixes. If the provider's (empty) config were used, this would
    // be `/{var}/teams` and would not bind — the silent-inertness class.
    expect(fromConsumer[0].path).toBe('/teams');
    expect(model.participantConsumers).toEqual([
      { name: 'ui', source: 'local', calls: 1, bound: 1 },
    ]);
    expect(sawParticipantConsumers(model)).toBe(true);
  });

  it('a repo with no participants is identical under both entries (single-repo path unchanged)', async () => {
    const provider = makeProvider();
    const repo = await gatherRepoFlowModel(provider, { trust: trustedLocalContext() });
    const system = await gatherSystemFlowModel(provider, { trust: trustedLocalContext() });
    expect(system.calls).toHaveLength(repo.calls.length);
    expect(system.routes).toHaveLength(repo.routes.length);
    expect(system.participantConsumers).toBeUndefined();
  });

  it('flow refresh authors a REPO-ONLY consumed contract — a participant never leaks into it', async () => {
    const provider = makeProvider();
    declareParticipant(provider, makeConsumer());
    await runFlowRefresh({ trust: trustedLocalContext(), cwd: provider, json: true });

    const consumed = readConsumedContract(provider);
    expect(consumed).toBeDefined();
    // The committed artifact describes THIS repo only.
    expect(consumed!.bindings).toHaveLength(1);
    expect(consumed!.bindings[0].file).toBe('src/services/sync.ts');
    // The regression: a participant's call written as our own, under a
    // `../sibling/...` locator that is meaningless on another machine.
    for (const b of consumed!.bindings) {
      expect(b.file.startsWith('..')).toBe(false);
      expect(b.file).not.toContain('TeamList');
    }
    expect(existsSync(join(provider, '.dxkit/flow/consumed.json'))).toBe(true);
  });
});

/**
 * CROSS-STACK proof — the mesh must not be TypeScript-shaped.
 *
 * The fix is framework-agnostic BY CONSTRUCTION: a participant is gathered
 * through `gatherRepoFlowModel`, whose scan is `allFlowSourceExtensions(LANGUAGES)`
 * — every pack declaring an httpFlow descriptor — and the evidence predicate
 * counts calls without ever asking what produced them. But "by construction" is
 * an argument, not evidence, and the tests above are TypeScript on both sides:
 * exactly the shape that hides an overfit (CLAUDE.md's fixture-analysis harness
 * is a TS+Python+Go MATRIX for this reason — a fix that works for one stack
 * fails there).
 *
 * So: a PYTHON provider consumed by a TYPESCRIPT client, and a GO provider
 * consumed by a PYTHON client. Neither language appears in the fix. If the mesh
 * were secretly TS-only, or the evidence predicate secretly counted a TS-shaped
 * call, these fail.
 */
describe('flow mesh — cross-stack (the anti-overfit net)', () => {
  it('a PYTHON provider is bound by a TYPESCRIPT participant', async () => {
    const provider = mkdtempSync(join(tmpdir(), 'dxkit-mesh-py-'));
    dirs.push(provider);
    writeFileSync(join(provider, 'requirements.txt'), 'fastapi\n');
    writeFileSync(
      join(provider, 'main.py'),
      ['@app.get("/teams")', 'def list_teams():', '    return []', ''].join('\n'),
    );

    const consumer = mkdtempSync(join(tmpdir(), 'dxkit-mesh-tsc-'));
    dirs.push(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'ui', version: '0.0.0' }));
    mkdirSync(join(consumer, 'src/components'), { recursive: true });
    writeFileSync(
      join(consumer, 'src/components/TeamList.tsx'),
      'export function T(){ return fetch(`${Config.api()}/teams`); }\n',
    );
    mkdirSync(join(consumer, '.dxkit'), { recursive: true });
    writeFileSync(
      join(consumer, '.dxkit/policy.json'),
      JSON.stringify({ flow: { stripUrlPrefixes: ['${Config.api()}'] } }),
    );

    declareParticipant(provider, consumer);
    const model = await gatherSystemFlowModel(provider, { trust: trustedLocalContext() });
    expect(model.routes.some((r) => r.path === '/teams' && r.method === 'GET')).toBe(true);
    // The TS client's call bound to the Python route — the join is stack-blind.
    expect(model.participantConsumers).toEqual([
      { name: 'ui', source: 'local', calls: 1, bound: 1 },
    ]);
    expect(sawParticipantConsumers(model)).toBe(true);
  });

  it('a GO provider is bound by a PYTHON participant', async () => {
    const provider = mkdtempSync(join(tmpdir(), 'dxkit-mesh-go-'));
    dirs.push(provider);
    writeFileSync(join(provider, 'go.mod'), 'module example.com/api\n\ngo 1.22\n');
    writeFileSync(
      join(provider, 'main.go'),
      ['package main', 'func register(r *chi.Mux) {', '\tr.Get("/teams", listTeams)', '}', ''].join(
        '\n',
      ),
    );

    const consumer = mkdtempSync(join(tmpdir(), 'dxkit-mesh-pyc-'));
    dirs.push(consumer);
    writeFileSync(join(consumer, 'requirements.txt'), 'requests\n');
    writeFileSync(
      join(consumer, 'client.py'),
      ['import requests', 'def fetch_teams():', '    return requests.get("/teams")', ''].join('\n'),
    );

    declareParticipant(provider, consumer);
    const model = await gatherSystemFlowModel(provider, { trust: trustedLocalContext() });
    expect(model.routes.some((r) => r.path === '/teams')).toBe(true);
    const prov = model.participantConsumers![0];
    expect(prov.source).toBe('local');
    expect(prov.calls).toBeGreaterThan(0);
    // A Python `requests.get` bound to a Go chi route: neither language is named
    // anywhere in the mesh code.
    expect(prov.bound).toBeGreaterThan(0);
    expect(sawParticipantConsumers(model)).toBe(true);
  });
});
