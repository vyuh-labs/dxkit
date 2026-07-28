/**
 * The bump-lane orchestrator (injected exec/floor/guardrail/lander — no real
 * spawns). Pins the load-bearing policy:
 *   - dry-run by default (nothing executes without --apply);
 *   - the trust refusal (repo execution disallowed ⇒ disclosed refusal,
 *     nothing spawns);
 *   - section preservation: a devDependency bump carries the dev flag;
 *   - a RED floor after applying means NO landing (outcome floor-red);
 *   - a green floor + land='pr' routes manifest+lockfile through the shared
 *     lander with the ledger as the PR body;
 *   - the ledger names every skip (no silent caps).
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { runDepsBump, bumpArtifactPaths } from '../../src/deps-bump/run';
import { trustedLocalContext, untrustedContentContext } from '../../src/analysis-trust';
import type { DepVulnFinding } from '../../src/languages/capabilities/types';
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';

const FINDING: DepVulnFinding = {
  id: 'GHSA-test-0001',
  package: 'axios',
  tool: 'npm-audit',
  severity: 'high',
  packId: 'typescript',
  installedVersion: '1.7.0',
  fixedVersion: '1.8.2',
  topLevelDep: ['axios'],
} as DepVulnFinding;

const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, checks: [], blocks: false };
const RED_FLOOR: CorrectnessFloorResult = {
  ran: true,
  checks: [{ pack: 'typescript', label: 'tests', bin: 'npx', status: 'fail' }] as never,
  blocks: true,
};

function repoWithManifest(manifest: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dxkit-depbump-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(path.join(dir, 'package-lock.json'), '{}');
  return dir;
}

const gather = async () => ({ findings: [FINDING] });

describe('runDepsBump', () => {
  it('dry-run by default: plans, executes nothing', async () => {
    const dir = repoWithManifest({ dependencies: { axios: '^1.7.0' } });
    const calls: string[][] = [];
    try {
      const r = await runDepsBump({
        cwd: dir,
        trust: trustedLocalContext(),
        gather,
        execBump: (argv) => {
          calls.push([...argv]);
          return { ok: true, output: '' };
        },
      });
      expect(r.outcome).toBe('planned');
      expect(calls).toHaveLength(0);
      expect(r.ledger).toContain('dry run');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses under an untrusted context — disclosed, nothing spawns', async () => {
    const dir = repoWithManifest({ dependencies: { axios: '^1.7.0' } });
    const calls: string[][] = [];
    try {
      const r = await runDepsBump({
        cwd: dir,
        trust: untrustedContentContext(),
        apply: true,
        gather,
        execBump: (argv) => {
          calls.push([...argv]);
          return { ok: true, output: '' };
        },
      });
      expect(r.outcome).toBe('refused');
      expect(r.note).toContain('trust');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies with the PM section preserved and lands via the shared lander on a green floor', async () => {
    const dir = repoWithManifest({ devDependencies: { axios: '^1.7.0' } });
    const calls: string[][] = [];
    const landed: Array<Record<string, unknown>> = [];
    try {
      const r = await runDepsBump({
        cwd: dir,
        trust: trustedLocalContext(),
        apply: true,
        land: 'pr',
        gather,
        execBump: (argv) => {
          calls.push([...argv]);
          return { ok: true, output: '' };
        },
        runFloor: () => GREEN_FLOOR,
        runGuardrail: async () => 'PASSED',
        landPaths: (o) => {
          landed.push(o as unknown as Record<string, unknown>);
          return { outcome: 'pr-opened', mode: 'pr', prUrl: 'local://pr/1' };
        },
      });
      expect(r.outcome).toBe('landed');
      // devDependency stays a devDependency (npm --save-dev).
      expect(calls).toEqual([['npm', 'install', 'axios@1.8.2', '--save-dev']]);
      expect(landed).toHaveLength(1);
      expect(landed[0].branchName).toBe('dxkit/dep-bump');
      expect(landed[0].paths).toEqual(['package.json', 'package-lock.json']);
      expect(String(landed[0].prBody)).toContain('Correctness floor');
      expect(r.guardrailVerdict).toBe('PASSED');
      expect(r.ledger).toContain('axios');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a RED floor after applying lands NOTHING — outcome floor-red, exit path is a failure', async () => {
    const dir = repoWithManifest({ dependencies: { axios: '^1.7.0' } });
    const landed: unknown[] = [];
    try {
      const r = await runDepsBump({
        cwd: dir,
        trust: trustedLocalContext(),
        apply: true,
        land: 'pr',
        gather,
        execBump: () => ({ ok: true, output: '' }),
        runFloor: () => RED_FLOOR,
        runGuardrail: async () => 'BLOCKED',
        landPaths: (o) => {
          landed.push(o);
          return { outcome: 'pr-opened', mode: 'pr' };
        },
      });
      expect(r.outcome).toBe('floor-red');
      expect(landed).toHaveLength(0);
      expect(r.note).toContain('floor');
      expect(r.ledger).toContain('FAILED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ledger names every skip', async () => {
    const dir = repoWithManifest({ dependencies: {} });
    try {
      const r = await runDepsBump({
        cwd: dir,
        trust: trustedLocalContext(),
        gather: async () => ({
          findings: [
            { ...FINDING, id: 'A2', package: 'no-fix-lib', fixedVersion: undefined, topLevelDep: undefined },
          ] as DepVulnFinding[],
        }),
      });
      expect(r.outcome).toBe('nothing-to-do');
      expect(r.ledger).toContain('no-fix-available');
      expect(r.ledger).toContain('no-fix-lib');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('bumpArtifactPaths', () => {
  it('commits exactly the manifest + the PM lockfile', () => {
    expect(bumpArtifactPaths('npm')).toEqual(['package.json', 'package-lock.json']);
    expect(bumpArtifactPaths('pnpm')).toEqual(['package.json', 'pnpm-lock.yaml']);
    expect(bumpArtifactPaths('yarn')).toEqual(['package.json', 'yarn.lock']);
    expect(bumpArtifactPaths('bun')).toEqual(['package.json', 'bun.lockb', 'bun.lock']);
  });
});
