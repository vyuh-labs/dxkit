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
import {
  classifyEnforcement,
  detectEnforcement,
  clearEnforcementCache,
  type EnforcementState,
  type EnforcementReads,
} from '../src/enforcement';
import {
  baselineRefreshInstallPlan,
  installCiBaselineRefresh,
  detectInstalledRefreshTransport,
  installCiGuardrails,
} from '../src/ship-installers';
import { hydrateAnchorFromBranch } from '../src/baseline/anchor';

const PROTECTED: EnforcementState = {
  branch: 'main',
  probed: true,
  directPushBlocked: true,
  guardrailRequired: true,
  guardrailContextLegacyOnly: false,
  rulesetGoverned: false,
};
const UNPROTECTED: EnforcementState = {
  branch: 'main',
  probed: true,
  directPushBlocked: false,
  guardrailRequired: false,
  guardrailContextLegacyOnly: false,
  rulesetGoverned: false,
};
const UNKNOWN: EnforcementState = {
  branch: 'main',
  probed: false,
  directPushBlocked: false,
  guardrailRequired: false,
  guardrailContextLegacyOnly: false,
  rulesetGoverned: false,
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
  const reads = (r: Partial<EnforcementReads>): EnforcementReads => ({
    classic: null,
    classicKnown: true,
    rules: [],
    rulesKnown: true,
    ...r,
  });

  it('nothing readable → "unknown", never a false "unprotected"', () => {
    const s = classifyEnforcement('main', null);
    expect(s.probed).toBe(false);
    expect(s.directPushBlocked).toBe(false);
    expect(s.guardrailRequired).toBe(false);
    expect(s.rulesetGoverned).toBe(false);
  });
  it('both mechanisms read, neither protects → confidently unprotected', () => {
    const s = classifyEnforcement('main', reads({}));
    expect(s.probed).toBe(true);
    expect(s.directPushBlocked).toBe(false);
    expect(s.guardrailRequired).toBe(false);
    expect(s.rulesetGoverned).toBe(false);
  });

  // Classic branch protection
  it('classic required status checks block direct pushes; dxkit-guardrails is detected', () => {
    const s = classifyEnforcement(
      'main',
      reads({ classic: { required_status_checks: { contexts: ['dxkit-guardrails', 'build'] } } }),
    );
    expect(s.directPushBlocked).toBe(true);
    expect(s.guardrailRequired).toBe(true);
    expect(s.rulesetGoverned).toBe(false);
  });
  it('a classic required PR review alone blocks direct pushes (guardrail may be absent)', () => {
    const s = classifyEnforcement(
      'main',
      reads({ classic: { required_pull_request_reviews: {} } }),
    );
    expect(s.directPushBlocked).toBe(true);
    expect(s.guardrailRequired).toBe(false);
  });

  // Repository RULESETS — the ruleset-blind bug (#12). A ruleset-protected repo
  // 404s the classic endpoint (classic: null) but the rules endpoint sees it.
  it('a ruleset pull_request rule blocks direct pushes and marks the branch ruleset-governed', () => {
    const s = classifyEnforcement(
      'main',
      reads({ classic: null, rules: [{ type: 'pull_request' }] }),
    );
    expect(s.probed).toBe(true);
    expect(s.directPushBlocked).toBe(true);
    expect(s.guardrailRequired).toBe(false);
    expect(s.rulesetGoverned).toBe(true);
  });
  it('a ruleset required_status_checks rule detects the dxkit-guardrails context (nested shape)', () => {
    const s = classifyEnforcement(
      'main',
      reads({
        classic: null,
        rules: [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'dxkit-guardrails' }] },
          },
        ],
      }),
    );
    expect(s.directPushBlocked).toBe(true);
    expect(s.guardrailRequired).toBe(true);
    expect(s.rulesetGoverned).toBe(true);
  });
  // Legacy check-name recognition (#16). The pre-fix workflow emitted the job
  // id `guardrail`; a protection requiring it must still read as "guardrail
  // required" (not BYPASSABLE), flagged legacy-only so doctor prompts a rename.
  it('a legacy `guardrail` classic context counts as required, flagged legacy-only', () => {
    const s = classifyEnforcement(
      'main',
      reads({ classic: { required_status_checks: { contexts: ['guardrail'] } } }),
    );
    expect(s.guardrailRequired).toBe(true);
    expect(s.guardrailContextLegacyOnly).toBe(true);
  });
  it('a legacy `guardrail` ruleset context counts as required, flagged legacy-only', () => {
    const s = classifyEnforcement(
      'main',
      reads({
        classic: null,
        rules: [
          {
            type: 'required_status_checks',
            parameters: { required_status_checks: [{ context: 'guardrail' }] },
          },
        ],
      }),
    );
    expect(s.guardrailRequired).toBe(true);
    expect(s.guardrailContextLegacyOnly).toBe(true);
  });
  it('the canonical `dxkit-guardrails` context is NOT legacy-only', () => {
    const s = classifyEnforcement(
      'main',
      reads({ classic: { required_status_checks: { contexts: ['dxkit-guardrails'] } } }),
    );
    expect(s.guardrailRequired).toBe(true);
    expect(s.guardrailContextLegacyOnly).toBe(false);
  });
  it('both canonical + legacy present → required, not legacy-only', () => {
    const s = classifyEnforcement(
      'main',
      reads({
        classic: { required_status_checks: { contexts: ['guardrail', 'dxkit-guardrails'] } },
      }),
    );
    expect(s.guardrailRequired).toBe(true);
    expect(s.guardrailContextLegacyOnly).toBe(false);
  });

  it('ref-integrity-only ruleset rules (non_fast_forward) do NOT count as a push block', () => {
    const s = classifyEnforcement('main', reads({ rules: [{ type: 'non_fast_forward' }] }));
    expect(s.directPushBlocked).toBe(false);
    // still ruleset-governed — protect must not fight it
    expect(s.rulesetGoverned).toBe(true);
    expect(s.probed).toBe(true);
  });

  // Partial reads — a non-admin can read rulesets but not classic protection.
  it('a blocking ruleset with classic unread is still a definitive "protected"', () => {
    const s = classifyEnforcement('main', {
      classic: null,
      classicKnown: false,
      rules: [{ type: 'pull_request' }],
      rulesKnown: true,
    });
    expect(s.probed).toBe(true);
    expect(s.directPushBlocked).toBe(true);
  });
  it('no protection seen but a mechanism was unreadable → unknown, not "unprotected"', () => {
    const s = classifyEnforcement('main', {
      classic: null,
      classicKnown: true,
      rules: [],
      rulesKnown: false,
    });
    expect(s.probed).toBe(false);
    expect(s.directPushBlocked).toBe(false);
  });
});

describe('detectEnforcement (probe wiring + fail-open)', () => {
  beforeEach(() => clearEnforcementCache());
  afterEach(() => clearEnforcementCache());

  it('routes an injected probe through the classifier', () => {
    const s = detectEnforcement(join(tmpdir(), 'dxkit-enf-a'), {
      probe: () => ({
        classic: null,
        classicKnown: true,
        rules: [{ type: 'pull_request' }],
        rulesKnown: true,
      }),
    });
    expect(s.directPushBlocked).toBe(true);
    expect(s.rulesetGoverned).toBe(true);
  });

  it('a throwing probe fails open to unknown (never a false "unprotected")', () => {
    const s = detectEnforcement(join(tmpdir(), 'dxkit-enf-b'), {
      probe: () => {
        throw new Error('gh boom');
      },
    });
    expect(s.probed).toBe(false);
    expect(s.directPushBlocked).toBe(false);
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

describe('CI workflow templates audit the right artifact (item #3 anti-recurrence)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dxkit-wfpm-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const read = (name: string): string =>
    readFileSync(join(dir, '.github', 'workflows', name), 'utf8');

  // Every workflow that installs deps + runs the dep audit must (a) install with
  // the repo's package manager (not a hardcoded npm that fabricates a tree) and
  // (b) put the scanner bin dirs on PATH so the audit finds its native scanner
  // rather than falling back to a wrong-artifact one.
  const auditWorkflows: Array<[string, () => void]> = [
    ['dxkit-guardrails.yml', () => installCiGuardrails(dir)],
    [
      'dxkit-baseline-refresh.yml',
      () =>
        installCiBaselineRefresh(dir, { baselineMode: 'committed-full', enforcement: PROTECTED }),
    ],
  ];

  it.each(auditWorkflows)('%s is package-manager-aware (not npm-only)', (name, install) => {
    install();
    const yml = read(name);
    expect(yml).toContain('pnpm install --frozen-lockfile');
    expect(yml).toContain('yarn install');
    expect(yml).toContain('bun install');
    // The npm path survives as a branch, but must not be the ONLY install form.
    expect(yml).toMatch(/if \[ -f pnpm-lock\.yaml \]/);
  });

  it.each(auditWorkflows)('%s puts the scanner bin dirs on $GITHUB_PATH', (name, install) => {
    install();
    const yml = read(name);
    expect(yml).toContain('GITHUB_PATH');
    expect(yml).toContain('.local/bin');
    expect(yml).toContain('go/bin');
    expect(yml).toContain('.cargo/bin');
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
