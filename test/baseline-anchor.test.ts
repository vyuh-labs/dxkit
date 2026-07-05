/**
 * Baseline anchor transport (2.31.0) — the fix for the refresh-vs-branch-
 * protection deadlock. The committed anchor's STORE is decoupled from the
 * protected default branch so the after-merge refresh stays fast + automated
 * without a direct push to `main`.
 *
 * Covers: the pure transport resolver, the enforcement classifier, the
 * install-plan + workflow-content selection (the anti-recurrence guard: a
 * committed+protected repo NEVER gets a workflow that direct-pushes to the
 * default branch), and the off-tree anchor hydration guard.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveAnchorTransport,
  DEFAULT_ANCHOR_REF,
  isBaselineAnchor,
} from '../src/baseline/modes';
import { classifyEnforcement, type EnforcementState } from '../src/enforcement';
import {
  baselineRefreshInstallPlan,
  installCiBaselineRefresh,
  detectInstalledRefreshTransport,
} from '../src/ship-installers';
import { hydrateAnchorFromBranch } from '../src/baseline/anchor';

const PROTECTED: EnforcementState = {
  branch: 'main',
  probed: true,
  directPushBlocked: true,
  guardrailRequired: true,
};
const UNPROTECTED: EnforcementState = {
  branch: 'main',
  probed: true,
  directPushBlocked: false,
  guardrailRequired: false,
};
const UNKNOWN: EnforcementState = {
  branch: 'main',
  probed: false,
  directPushBlocked: false,
  guardrailRequired: false,
};

describe('resolveAnchorTransport', () => {
  it('ref-based mode has no committed anchor (null)', () => {
    expect(resolveAnchorTransport({ mode: 'ref-based' })).toBeNull();
    expect(resolveAnchorTransport({ mode: 'ref-based', directPushBlocked: true })).toBeNull();
  });
  it('committed + protected default branch → branch transport (avoids the deadlock)', () => {
    expect(resolveAnchorTransport({ mode: 'committed-full', directPushBlocked: true })).toBe(
      'branch',
    );
  });
  it('committed + unprotected → tree transport (the simple direct push is fine)', () => {
    expect(resolveAnchorTransport({ mode: 'committed-full', directPushBlocked: false })).toBe(
      'tree',
    );
  });
  it('committed + protection UNKNOWN → tree (fail-open; never silently reconfigure)', () => {
    expect(resolveAnchorTransport({ mode: 'committed-sanitized' })).toBe('tree');
  });
  it('an explicit policy anchor wins over the protection-derived default', () => {
    expect(
      resolveAnchorTransport({
        mode: 'committed-full',
        policyAnchor: 'cache',
        directPushBlocked: true,
      }),
    ).toBe('cache');
    expect(
      resolveAnchorTransport({
        mode: 'committed-full',
        policyAnchor: 'tree',
        directPushBlocked: true,
      }),
    ).toBe('tree');
  });
});

describe('isBaselineAnchor', () => {
  it('accepts the three transports, rejects anything else', () => {
    for (const a of ['tree', 'branch', 'cache']) expect(isBaselineAnchor(a)).toBe(true);
    for (const a of ['', 'ref', 'main', undefined, 3]) expect(isBaselineAnchor(a)).toBe(false);
  });
});

describe('classifyEnforcement', () => {
  it('an unprobed answer is "unknown", never a false "unprotected"', () => {
    const s = classifyEnforcement('main', null, false);
    expect(s.probed).toBe(false);
    expect(s.directPushBlocked).toBe(false);
    expect(s.guardrailRequired).toBe(false);
  });
  it('no protection rule (404 → null) → not blocked, guardrail not required', () => {
    const s = classifyEnforcement('main', null, true);
    expect(s.probed).toBe(true);
    expect(s.directPushBlocked).toBe(false);
    expect(s.guardrailRequired).toBe(false);
  });
  it('required status checks block direct pushes; dxkit-guardrails presence is detected', () => {
    const s = classifyEnforcement(
      'main',
      { required_status_checks: { contexts: ['dxkit-guardrails', 'build'] } },
      true,
    );
    expect(s.directPushBlocked).toBe(true);
    expect(s.guardrailRequired).toBe(true);
  });
  it('a required PR review alone blocks direct pushes (guardrail may still be absent)', () => {
    const s = classifyEnforcement('main', { required_pull_request_reviews: {} }, true);
    expect(s.directPushBlocked).toBe(true);
    expect(s.guardrailRequired).toBe(false);
  });
});

describe('baselineRefreshInstallPlan', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-refreshplan-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ref-based → not installed, with guidance', () => {
    const plan = baselineRefreshInstallPlan(dir, { mode: 'ref-based', enforcement: UNKNOWN });
    expect(plan.install).toBe(false);
    if (!plan.install) expect(plan.reason).toMatch(/ref-based/);
  });
  it('committed + protected → install the branch transport', () => {
    const plan = baselineRefreshInstallPlan(dir, {
      mode: 'committed-full',
      enforcement: PROTECTED,
    });
    expect(plan).toEqual({ install: true, transport: 'branch', anchorRef: DEFAULT_ANCHOR_REF });
  });
  it('committed + unprotected → install the tree transport', () => {
    const plan = baselineRefreshInstallPlan(dir, {
      mode: 'committed-full',
      enforcement: UNPROTECTED,
    });
    expect(plan).toEqual({ install: true, transport: 'tree', anchorRef: DEFAULT_ANCHOR_REF });
  });
  it('an explicit policy anchor + anchorRef override the default', () => {
    const plan = baselineRefreshInstallPlan(dir, {
      mode: 'committed-full',
      enforcement: PROTECTED,
      policyAnchor: 'cache',
      anchorRef: 'my-anchors',
    });
    expect(plan).toEqual({ install: true, transport: 'cache', anchorRef: 'my-anchors' });
  });
});

describe('installCiBaselineRefresh — content per transport (anti-recurrence)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-refreshinstall-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const dest = (): string =>
    readFileSync(join(dir, '.github', 'workflows', 'dxkit-baseline-refresh.yml'), 'utf8');

  it('always writes the single dest filename regardless of transport', () => {
    const r = installCiBaselineRefresh(dir, {
      baselineMode: 'committed-full',
      enforcement: PROTECTED,
    });
    expect(r.installed).toContain('.github/workflows/dxkit-baseline-refresh.yml');
  });

  it('committed + protected → branch variant pushes to the side branch, NEVER to the default branch', () => {
    installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: PROTECTED });
    const yml = dest();
    // The anchor ref substitution landed, and the push targets that side branch...
    expect(yml).toContain(`ANCHOR="${DEFAULT_ANCHOR_REF}"`);
    expect(yml).toContain('git push --force origin "${ANCHOR}"');
    // ...and NEVER a bare `git push` (which defaults to the protected branch — the
    // deadlock) and never a [skip ci] COMMIT (the hack the side branch obviates).
    expect(yml).not.toMatch(/git push\s*$/m);
    expect(yml).not.toMatch(/-m "[^"]*\[skip ci\]/);
  });

  it('committed + unprotected → tree variant (the original direct-push refresh)', () => {
    installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: UNPROTECTED });
    const yml = dest();
    expect(yml).toContain('git push');
    expect(yml).not.toContain(DEFAULT_ANCHOR_REF);
  });

  it('cache transport → cache-save variant, no git push at all', () => {
    installCiBaselineRefresh(dir, {
      baselineMode: 'committed-full',
      enforcement: PROTECTED,
      policyAnchor: 'cache',
    });
    const yml = dest();
    expect(yml).toContain('actions/cache/save');
    expect(yml).not.toContain('git push');
  });

  it('ref-based → skipped, not installed', () => {
    const r = installCiBaselineRefresh(dir, { baselineMode: 'ref-based', enforcement: UNKNOWN });
    expect(r.installed).toHaveLength(0);
    expect(r.skipped).toContain('.github/workflows/dxkit-baseline-refresh.yml');
  });

  it('auto-migrates a legacy tree workflow to branch when the repo is now protected (no --force)', () => {
    // Simulate a 2.30 install: the old direct-push-to-main (tree) workflow.
    installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: UNPROTECTED });
    expect(dest()).toContain('git push');
    expect(dest()).not.toContain(DEFAULT_ANCHOR_REF);
    // The branch becomes protected; a plain re-run (no force) must MIGRATE the
    // deadlocking workflow to the branch transport, not skip it.
    const r = installCiBaselineRefresh(dir, {
      baselineMode: 'committed-full',
      enforcement: PROTECTED,
    });
    expect(r.installed).toContain('.github/workflows/dxkit-baseline-refresh.yml');
    expect(r.notes.join('\n')).toMatch(/Migrated the baseline-refresh workflow from the 'tree'/);
    expect(dest()).toContain(`ANCHOR="${DEFAULT_ANCHOR_REF}"`);
  });

  it('does NOT rewrite an up-to-date workflow (migration fires only on a transport change)', () => {
    installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: PROTECTED });
    const r = installCiBaselineRefresh(dir, {
      baselineMode: 'committed-full',
      enforcement: PROTECTED,
    });
    // Same transport → installWorkflow skips the existing file, no migration note.
    expect(r.installed).toHaveLength(0);
    expect(r.notes.join('\n')).not.toMatch(/Migrated/);
  });
});

describe('detectInstalledRefreshTransport', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-detecttransport-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns null when no refresh workflow is installed', () => {
    expect(detectInstalledRefreshTransport(dir)).toBeNull();
  });
  it('classifies each installed variant by its content shape', () => {
    installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: UNPROTECTED });
    expect(detectInstalledRefreshTransport(dir)).toBe('tree');
    installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: PROTECTED });
    expect(detectInstalledRefreshTransport(dir)).toBe('branch');
    installCiBaselineRefresh(dir, {
      baselineMode: 'committed-full',
      enforcement: PROTECTED,
      policyAnchor: 'cache',
    });
    expect(detectInstalledRefreshTransport(dir)).toBe('cache');
  });
});

describe('hydrateAnchorFromBranch', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-hydrate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is a no-op for non-branch transports (returns false)', () => {
    expect(hydrateAnchorFromBranch(dir, join(dir, '.dxkit/baselines/main.json'), undefined)).toBe(
      false,
    );
    expect(
      hydrateAnchorFromBranch(dir, join(dir, '.dxkit/baselines/main.json'), { anchor: 'tree' }),
    ).toBe(false);
    expect(
      hydrateAnchorFromBranch(dir, join(dir, '.dxkit/baselines/main.json'), { anchor: 'cache' }),
    ).toBe(false);
  });

  it('returns false (does not throw) when the anchor branch is unreachable', () => {
    // Non-git dir + anchor:'branch' → every git read fails → false, no throw.
    mkdirSync(join(dir, '.dxkit'), { recursive: true });
    writeFileSync(join(dir, '.dxkit', 'policy.json'), '{}');
    expect(
      hydrateAnchorFromBranch(dir, join(dir, '.dxkit/baselines/main.json'), {
        anchor: 'branch',
        anchorRef: 'dxkit-baselines',
      }),
    ).toBe(false);
  });
});
