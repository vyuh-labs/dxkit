/**
 * `policy render` — the reconciliation primitive behind "policy.json is the
 * interface" (4.3.4). The managed workflows are rendered FROM the committed
 * policy; this command is what the CI parity gate, the pre-push hook, and the
 * opt-in render bot all call. Pins, both directions:
 *
 *   - `--check` detects a policy edit whose workflows were not re-rendered,
 *     names the files, carries a diff — and leaves the tree BYTE-IDENTICAL
 *     (safe on dirty trees and inside hooks), including cleaning up any
 *     sidecars the refresh emitted along the way;
 *   - `--apply` is the one-command fix;
 *   - a repo without a dxkit install is clean by definition (the gate must
 *     pass there);
 *   - a hand-modified managed file is deliberate divergence, NOT drift — the
 *     provenance rule that keeps update from clobbering it keeps this check
 *     from flagging it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { resolvePolicyRender } from '../src/policy-render';
import { installCiBaselineRefresh } from '../src/ship-installers';
import { SHELL_FALLBACK_FN } from '../src/install/shell';
import { VERSION } from '../src/constants';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'dxkit-policy-render-'));
  mkdirSync(join(repo, '.dxkit'), { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function installRefreshSurface(cadence?: string): void {
  writeFileSync(
    join(repo, '.dxkit', 'policy.json'),
    JSON.stringify({
      baseline: { anchor: 'branch', ...(cadence ? { refreshCadence: cadence } : {}) },
    }),
  );
  writeFileSync(
    join(repo, '.vyuh-dxkit.json'),
    JSON.stringify({ generatedAt: 'x', mode: 'full', files: [] }),
  );
  installCiBaselineRefresh(repo, { policyAnchor: 'branch' });
  // Settle the full managed set (ignore files etc.) the way a real install
  // does, so each scenario starts from a rendered-clean state.
  resolvePolicyRender(repo, 'apply');
}

const REFRESH_YML = '.github/workflows/dxkit-baseline-refresh.yml';

describe('resolvePolicyRender', () => {
  it('a repo without a dxkit install is clean by definition', () => {
    const out = resolvePolicyRender(repo, 'check');
    expect(out).toMatchObject({ ok: true, clean: true, drifted: [] });
  });

  it('freshly rendered files check clean', () => {
    installRefreshSurface();
    const out = resolvePolicyRender(repo, 'check');
    expect(out.clean).toBe(true);
    expect(out.drifted).toEqual([]);
  });

  it('a policy edit without a re-render drifts — named, diffed, and the tree untouched', () => {
    installRefreshSurface();
    const before = readFileSync(join(repo, REFRESH_YML), 'utf8');
    expect(before).toContain("cron: '0 6 * * 1'");
    // The hand edit the parity gate exists for: cadence changed, no render.
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { anchor: 'branch', refreshCadence: 'daily' } }),
    );

    const out = resolvePolicyRender(repo, 'check');
    expect(out.ok).toBe(false);
    expect(out.clean).toBe(false);
    expect(out.drifted).toContain(REFRESH_YML);
    expect(out.diffs.join('\n')).toContain('0 6 * * *');
    expect(out.message).toContain('policy render --apply');
    // Byte-identical restore — the load-bearing hook-safety property.
    expect(readFileSync(join(repo, REFRESH_YML), 'utf8')).toBe(before);
  });

  // Item-7 (4.4.6): the CI install chain is rendered under the repo's
  // tolerances at install/update time; the SAME parity surface that catches
  // a cadence edit catches a dependencies.tolerate edit (policy render
  // re-renders under the CURRENT tolerance inputs, .npmrc included), so a
  // baked chain cannot silently fork from a later policy change.
  it('a dependencies.tolerate edit without a re-render drifts the workflow install chain', () => {
    installRefreshSurface();
    const before = readFileSync(join(repo, REFRESH_YML), 'utf8');
    expect(before).toContain(`npm ci || ${SHELL_FALLBACK_FN} npm ci --legacy-peer-deps`);
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { anchor: 'branch' }, dependencies: { tolerate: [] } }),
    );
    const out = resolvePolicyRender(repo, 'check');
    expect(out.clean).toBe(false);
    expect(out.drifted).toContain(REFRESH_YML);
    // The withdrawn tolerance renders a chain with no unconditional retry.
    expect(out.diffs.join('\n')).toContain('npm ci');
    expect(readFileSync(join(repo, REFRESH_YML), 'utf8')).toBe(before);
    // And --apply re-renders it: the fallback is gone from the chain.
    const applied = resolvePolicyRender(repo, 'apply');
    expect(applied.ok).toBe(true);
    const after = readFileSync(join(repo, REFRESH_YML), 'utf8');
    expect(after).not.toContain(`npm ci || ${SHELL_FALLBACK_FN} npm ci --legacy-peer-deps`);
    expect(after).toContain('npm ci');
  });

  it('--apply is the one-command fix; the follow-up check is clean', () => {
    installRefreshSurface();
    writeFileSync(
      join(repo, '.dxkit', 'policy.json'),
      JSON.stringify({ baseline: { anchor: 'branch', refreshCadence: 'daily' } }),
    );
    const applied = resolvePolicyRender(repo, 'apply');
    expect(applied.ok).toBe(true);
    expect(applied.drifted).toContain(REFRESH_YML);
    expect(readFileSync(join(repo, REFRESH_YML), 'utf8')).toContain("cron: '0 6 * * *'");
    expect(resolvePolicyRender(repo, 'check').clean).toBe(true);
  });

  it('a hand-modified managed file is deliberate divergence, not drift — and sidecars are cleaned', () => {
    installRefreshSurface();
    // The user rewrote the workflow their way; provenance says never clobber.
    writeFileSync(join(repo, REFRESH_YML), 'name: my own refresh\non: {}\n');
    const out = resolvePolicyRender(repo, 'check');
    // The workflow itself is divergence, never drift: not flagged, not touched.
    expect(out.drifted).not.toContain(REFRESH_YML);
    expect(readFileSync(join(repo, REFRESH_YML), 'utf8')).toContain('my own refresh');
    // Any sidecar the refresh emitted during the check was cleaned up.
    expect(existsSync(join(repo, `${REFRESH_YML}.dxkit`))).toBe(false);
    // The DERIVED runbook reads the modified workflow as repo truth, so it
    // legitimately drifts (its rendered content changed) until re-applied —
    // the same "derived file catches up" semantics as a policy edit. The
    // check itself still leaves the tree byte-identical.
    expect(out.drifted).toEqual(['RUNBOOK.dxkit.md']);
    resolvePolicyRender(repo, 'apply');
    expect(resolvePolicyRender(repo, 'check').clean).toBe(true);
    expect(readFileSync(join(repo, REFRESH_YML), 'utf8')).toContain('my own refresh');
  });

  // The upgrade path (4.5.0): generated files that install dxkit unpinned
  // pick up a newer dxkit on the next container build or CI run without being
  // regenerated. Their drift from the newer render is dxkit's template change
  // as much as any policy edit, so the check cannot attribute it and must not
  // start failing the existing hook and parity step. Strict again once
  // `update` records the running version.
  describe('files generated by another dxkit version', () => {
    function setGeneratedBy(version: string | undefined): void {
      const manifestPath = join(repo, '.vyuh-dxkit.json');
      const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      if (version === undefined) delete m.version;
      else m.version = version;
      writeFileSync(manifestPath, JSON.stringify(m));
    }
    function editCadence(): void {
      writeFileSync(
        join(repo, '.dxkit', 'policy.json'),
        JSON.stringify({ baseline: { anchor: 'branch', refreshCadence: 'daily' } }),
      );
    }

    it('drift is advice, not a failure, and names both versions and the remedy', () => {
      installRefreshSurface();
      setGeneratedBy('0.0.1');
      editCadence();
      const before = readFileSync(join(repo, REFRESH_YML), 'utf8');
      const out = resolvePolicyRender(repo, 'check');
      expect(out.ok).toBe(true);
      expect(out.clean).toBe(false);
      expect(out.generatedBy).toBe('0.0.1');
      expect(out.drifted).toContain(REFRESH_YML);
      expect(out.message).toContain('generated by dxkit 0.0.1');
      expect(out.message).toContain(`dxkit ${VERSION}`);
      expect(out.message).toContain('update');
      // Still byte-identical afterwards.
      expect(readFileSync(join(repo, REFRESH_YML), 'utf8')).toBe(before);
    });

    it('the same drift fails when the files were generated by the running version', () => {
      installRefreshSurface();
      setGeneratedBy(VERSION);
      editCadence();
      const out = resolvePolicyRender(repo, 'check');
      expect(out.ok).toBe(false);
      expect(out.generatedBy).toBeUndefined();
    });

    it('a manifest with no recorded version stays strict', () => {
      installRefreshSurface();
      setGeneratedBy(undefined);
      editCadence();
      expect(resolvePolicyRender(repo, 'check').ok).toBe(false);
    });

    it('no drift reads clean whatever version generated the files', () => {
      installRefreshSurface();
      setGeneratedBy('0.0.1');
      const out = resolvePolicyRender(repo, 'check');
      expect(out).toMatchObject({ ok: true, clean: true, drifted: [] });
    });

    it('--apply is unaffected: it re-renders regardless of the generating version', () => {
      installRefreshSurface();
      setGeneratedBy('0.0.1');
      editCadence();
      const applied = resolvePolicyRender(repo, 'apply');
      expect(applied.ok).toBe(true);
      expect(applied.drifted).toContain(REFRESH_YML);
    });
  });
});
