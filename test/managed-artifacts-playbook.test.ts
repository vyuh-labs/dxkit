/**
 * The managed-artifact registry playbook — the enforcement that a NEW ship
 * surface cannot silently skip update or uninstall (CLAUDE.md Rule 2, the
 * "one concept, one code path" fix for the recurring lifecycle-drift bug).
 *
 * Mirror of `recipe-playbook.test.ts` (language packs) and
 * `producer-playbook.test.ts` (baseline producers): it injects a SYNTHETIC
 * surface into a copy of the registry and asserts every lifecycle consumer
 * picks it up. If a consumer ever stops iterating the registry (goes back to a
 * hand-maintained list), the synthetic surface won't flow through it and this
 * test fails — the empirical guard that the architecture stayed registry-driven.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  MANAGED_SHIP_SURFACES,
  managedGatedArtifacts,
  refreshManagedSurfaces,
  surfaceEnabled,
  type ManagedShipSurface,
} from '../src/managed-artifacts';
import type { ManifestInstallFlags, Manifest } from '../src/types';
import type { ShipInstallResult } from '../src/ship-installers';

const ALL_OFF: ManifestInstallFlags = {
  withDxkitAgents: false,
  withHooks: false,
  withPrecommit: false,
  withDevcontainer: false,
  withCiGuardrails: false,
  withBaselineRefresh: false,
  withPrReview: false,
  withClaudeLoop: false,
  withCiPushTrigger: false,
  withDeepSastRefresh: false,
};

const SENTINEL_ARTIFACT = '.dxkit-synthetic-surface-sentinel';

/** A fully synthetic surface: an `always` gate (so it needs no real flag), a
 *  sentinel delete-artifact, and an installer that writes a sentinel file. */
const SYNTHETIC: ManagedShipSurface = {
  id: 'synthetic-playbook-surface',
  gate: { kind: 'always' },
  artifacts: () => [SENTINEL_ARTIFACT],
  uninstallDetection: 'flag',
  refreshOnUpdate: true,
  install: (cwd): ShipInstallResult => {
    fs.writeFileSync(path.join(cwd, SENTINEL_ARTIFACT), 'sentinel', 'utf8');
    return { installed: [SENTINEL_ARTIFACT], skipped: [], sidecars: [], notes: [] };
  },
};

describe('managed-artifact registry — contract', () => {
  it('every surface is well-formed (unique id, array artifacts, flag surfaces detectable + real keys)', () => {
    const ids = new Set<string>();
    for (const s of MANAGED_SHIP_SURFACES) {
      expect(s.id, 'surface has an id').toBeTruthy();
      expect(ids.has(s.id), `duplicate surface id ${s.id}`).toBe(false);
      ids.add(s.id);
      expect(Array.isArray(s.artifacts(ALL_OFF))).toBe(true);
      expect(typeof s.install).toBe('function');
      if (s.gate.kind === 'flag') {
        // A flag-gated surface must be detectable (legacy fallback) and its
        // flag must be a real ManifestInstallFlags key.
        expect(typeof s.detectPresent, `${s.id} flag surface needs detectPresent`).toBe('function');
        expect(ALL_OFF, `${s.id} gates on unknown flag ${s.gate.flag}`).toHaveProperty(s.gate.flag);
      }
    }
  });

  it('managedGatedArtifacts lists each surface artifact when its gate flag is on', () => {
    const cases: Array<[keyof ManifestInstallFlags, string]> = [
      ['withHooks', '.githooks/pre-push'],
      ['withCiGuardrails', '.github/workflows/dxkit-guardrails.yml'],
      ['withBaselineRefresh', '.github/workflows/dxkit-baseline-refresh.yml'],
      ['withPrReview', '.github/workflows/pr-review.yml'],
      ['withDevcontainer', '.devcontainer/devcontainer.json'],
    ];
    for (const [flag, artifact] of cases) {
      expect(managedGatedArtifacts({ ...ALL_OFF, [flag]: true })).toContain(artifact);
    }
  });

  it('deep-SAST refresh is registered, refreshed on update, and removed by presence', () => {
    const s = MANAGED_SHIP_SURFACES.find((x) => x.id === 'ci-deep-sast-refresh');
    expect(s, 'deep-SAST surface must be registered').toBeDefined();
    expect(s!.refreshOnUpdate, 'the drift bug was: update never refreshed it').toBe(true);
    expect(s!.uninstallDetection).toBe('presence');
    // Removed even with the flag off — legacy installs recorded no flag for it.
    expect(managedGatedArtifacts(ALL_OFF)).toContain(
      '.github/workflows/dxkit-deep-sast-refresh.yml',
    );
  });
});

describe('managed-artifact registry — synthetic surface flows through every lifecycle path', () => {
  let tmp: string;
  const cleanups: string[] = [];
  afterEach(() => {
    for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  function scratch(): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-managed-playbook-'));
    cleanups.push(tmp);
    return tmp;
  }

  it('WITHOUT the synthetic surface, nothing produces the sentinel (proves the registry drives it)', () => {
    expect(managedGatedArtifacts(ALL_OFF)).not.toContain(SENTINEL_ARTIFACT);
  });

  it('uninstall (managedGatedArtifacts) removes a newly-registered surface', () => {
    const withFake = [...MANAGED_SHIP_SURFACES, SYNTHETIC];
    expect(managedGatedArtifacts(ALL_OFF, withFake)).toContain(SENTINEL_ARTIFACT);
  });

  it('update (refreshManagedSurfaces) re-runs a newly-registered surface', () => {
    const dir = scratch();
    const withFake = [...MANAGED_SHIP_SURFACES, SYNTHETIC];
    const results: ShipInstallResult[] = [];
    refreshManagedSurfaces(dir, { force: false, flags: ALL_OFF }, (r) => results.push(r), withFake);
    expect(fs.existsSync(path.join(dir, SENTINEL_ARTIFACT)), 'installer ran').toBe(true);
    expect(results.flatMap((r) => r.installed)).toContain(SENTINEL_ARTIFACT);
  });

  it('surfaceEnabled honors every gate kind', () => {
    expect(surfaceEnabled(SYNTHETIC, ALL_OFF)).toBe(true); // always
    const flagSurface = MANAGED_SHIP_SURFACES.find((s) => s.gate.kind === 'flag')!;
    expect(surfaceEnabled(flagSurface, ALL_OFF)).toBe(false);
    // derived: the devDependency surface turns on once a self-invocation flag is set.
    const derived = MANAGED_SHIP_SURFACES.find((s) => s.gate.kind === 'derived')!;
    expect(surfaceEnabled(derived, ALL_OFF)).toBe(false);
    expect(surfaceEnabled(derived, { ...ALL_OFF, withCiGuardrails: true })).toBe(true);
  });
});

/** Guards the type surface stays importable (used by consumers). */
const _typecheck: Manifest['installFlags'] = ALL_OFF;
void _typecheck;
