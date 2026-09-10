/**
 * The override-pin recipe: applied (npm override written, resync, re-audit
 * clean), the OSV pre-check refusal with the advisory named (a fake
 * fetcher), the direct-dependency refusal, the non-npm declared refusal,
 * and the verify failure when the re-audit still reports the package.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { executeOverridePin } from '../../../src/remediate/recipes/override-pin';

// The Rule 20 gate probes the REAL machine (`currentEnvironment` is not an
// injected seam), so a test host without the go/rust/php toolchain would
// turn every applied-path assertion into an environment refusal. The mock
// reports every toolchain present and healthy; the gate's own behavior is
// covered by the execution-platform and recipe-playbook tests.
vi.mock('../../../src/execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/execution')>();
  return {
    ...actual,
    currentEnvironment: () => ({
      host: 'linux' as const,
      hasToolchain: () => true,
      toolchainProblem: () => null,
    }),
  };
});
import {
  compareConcreteSemver,
  isConcreteSemver,
  pickPinVersion,
} from '../../../src/remediate/recipes/shared';
import { MAX_PIN_RAISES } from '../../../src/remediate/recipes/override-pin';
import { DEFAULT_BROWNFIELD_POLICY, type BrownfieldPolicy } from '../../../src/baseline/policy';
import { policyForPreset } from '../../../src/baseline/presets';
import { addedDepVulnVerdict } from '../../../src/baseline/candidate-verdict';
import type { OsvVuln } from '../../../src/analyzers/tools/osv';
import { rubyRemediation } from '../../../src/languages/ruby-remediation';
import type { PinTransitiveProvider } from '../../../src/languages/capabilities/remediation';
import { advisoryFinding, depFinding, fakeExec, makeCtx, makeOrder, tempRepo } from './helpers';

const PKG = JSON.stringify({ name: 'fx', version: '1.0.0', dependencies: { top: '^1.0.0' } });

function pinOrder() {
  return makeOrder({
    id: 'dep-advisory:js-yaml',
    class: 'dep-advisory',
    findings: [
      advisoryFinding('f1', 'js-yaml', 'GHSA-aaaa', '4.1.0'),
      advisoryFinding('f2', 'js-yaml', 'GHSA-bbbb', '4.1.1'),
    ],
  });
}

describe('the pin choice (semver precedence, prerelease rules included)', () => {
  it('a release outranks its own prereleases and prerelease identifiers order per semver', () => {
    expect(pickPinVersion(['1.2.3-beta.1', '1.2.3'])).toBe('1.2.3');
    expect(pickPinVersion(['1.2.3-alpha', '1.2.3-alpha.1', '1.2.3-beta'])).toBe('1.2.3-beta');
    expect(pickPinVersion(['4.1.0', '4.1.1'])).toBe('4.1.1');
    expect(compareConcreteSemver('1.2.3-2', '1.2.3-10')).toBeLessThan(0); // numeric ids
    expect(compareConcreteSemver('1.2.3-alpha.beta', '1.2.3-alpha.1')).toBeGreaterThan(0);
    expect(compareConcreteSemver('1.2.3+build.1', '1.2.3')).toBe(0); // build metadata ignored
  });

  it('a range-shaped fixed string is refused, never guessed at', () => {
    expect(isConcreteSemver('>=4.1.0')).toBe(false);
    expect(isConcreteSemver('^4.1.0')).toBe(false);
    expect(pickPinVersion(['4.1.0', '>=4.1.1'])).toBeNull();
  });

  it('honors a pack-declared version grammar: RubyGems 4-segment fixes pick numerically', () => {
    const scheme = (rubyRemediation.pinTransitive as { provider: PinTransitiveProvider }).provider
      .versions!;
    // The default x.y.z grammar refuses the rails-family fix shape...
    expect(pickPinVersion(['6.1.7.10', '6.1.7.9'])).toBeNull();
    // ...the owning pack's grammar pins it, ordered numerically.
    expect(pickPinVersion(['6.1.7.10', '6.1.7.9'], scheme)).toBe('6.1.7.10');
    expect(pickPinVersion(['7.0.8', '7.0.8.7'], scheme)).toBe('7.0.8.7');
    expect(pickPinVersion(['7.0.8.7', '>= 7.0.8'], scheme)).toBeNull();
  });
});

describe('override-pin recipe (php pack: composer require pin + churn disclosure)', () => {
  const COMPOSER = JSON.stringify(
    { name: 'acme/app', require: { 'guzzlehttp/guzzle': '^7.8' } },
    null,
    2,
  );

  it('applies through the composer declarations and carries the deliberate-churn note', async () => {
    const cwd = tempRepo({ 'composer.json': COMPOSER + '\n', 'composer.lock': '{}' });
    const { exec, calls } = fakeExec();
    const order = makeOrder({
      id: 'dep-advisory:guzzlehttp/psr7',
      class: 'dep-advisory',
      findings: [advisoryFinding('f1', 'guzzlehttp/psr7', 'GHSA-pppp', '2.7.1')],
      envelope: { paths: ['composer.json', 'composer.lock'], manifests: true },
    });
    const outcome = await executeOverridePin(order, makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'composer.json'), 'utf8')) as {
      require: Record<string, string>;
    };
    expect(manifest.require['guzzlehttp/psr7']).toBe('2.7.1');
    expect(calls.some((c) => c.cmd.bin === 'composer' && c.cmd.args[0] === 'update')).toBe(true);
    if (outcome.kind === 'applied') {
      expect(outcome.changedFiles).toEqual(['composer.json', 'composer.lock']);
      expect(outcome.notes?.join(' ')).toContain('unrelated packages');
      expect(outcome.revert).toContain('guzzlehttp/psr7');
    }
  });
});

describe('override-pin recipe', () => {
  it('applies: writes the npm override at the highest fixed version, resyncs, re-audits clean', async () => {
    const cwd = tempRepo({ 'package.json': PKG + '\n', 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    const outcome = await executeOverridePin(pinOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    expect(manifest.overrides['js-yaml']).toBe('4.1.1');
    // Trailing newline preserved; the resync install ran.
    expect(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8').endsWith('\n')).toBe(true);
    expect(calls.some((c) => c.cmd.bin === 'npm' && c.cmd.args[0] === 'install')).toBe(true);
    if (outcome.kind === 'applied') {
      expect(outcome.changedFiles).toEqual(['package.json', 'package-lock.json']);
    }
  });

  it('the applied outcome carries the pack-declared revert prose (rendered in the ledger)', async () => {
    const cwd = tempRepo({ 'package.json': PKG + '\n', 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeOverridePin(pinOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.revert).toContain('remove the "overrides" entry for \'js-yaml\'');
      expect(outcome.revert).toContain('package.json');
    }
  });

  it('REFUSES with the advisory named when the pin itself carries a block-tier vuln ($0, tree untouched)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, {
        exec,
        queryOsv: async () => [{ id: 'GHSA-new-block', database_specific: { severity: 'HIGH' } }],
      }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('GHSA-new-block');
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).toBe(PKG);
  });

  // The pre-check's verdict IS the guardrail's (Rule 2.30, #371): every case
  // below states the guardrail's own answer through `addedDepVulnVerdict`
  // first, then asserts the recipe agrees. A finding the guardrail would
  // block is refused before apply; one it would only warn on is not.
  const SECURITY_ONLY: BrownfieldPolicy = policyForPreset(
    'security-only',
    DEFAULT_BROWNFIELD_POLICY,
  ).policy;
  const withNoFix = (id: string, severity: string): OsvVuln => ({
    id,
    database_specific: { severity },
  });
  async function precheck(policy: BrownfieldPolicy, vulns: OsvVuln[]) {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, policy, queryOsv: async () => vulns }),
    );
    return { outcome, calls };
  }

  it('PARITY: a candidate the guardrail would block is refused; one it would only warn on is not', async () => {
    // security-only: a HIGH advisory on an UNREACHABLE package warns (no
    // generic `added` block; the high rule needs reachability).
    const highUnreachable = addedDepVulnVerdict(SECURITY_ONLY, { severity: 'high' });
    expect(highUnreachable.blocks).toBe(false);
    expect(highUnreachable.warns).toBe(true);
    const warned = await precheck(SECURITY_ONLY, [withNoFix('GHSA-high', 'HIGH')]);
    expect(warned.outcome.kind).toBe('applied');
    if (warned.outcome.kind === 'applied') {
      // Disclosed, never silent: the advisory is still named in the ledger.
      expect(warned.outcome.notes?.join(' ')).toContain('GHSA-high');
    }
    // security-only: a CRITICAL advisory blocks through its armed rule.
    expect(addedDepVulnVerdict(SECURITY_ONLY, { severity: 'critical' }).blocks).toBe(true);
    const refused = await precheck(SECURITY_ONLY, [withNoFix('GHSA-crit', 'CRITICAL')]);
    expect(refused.outcome.kind).toBe('refused');
    if (refused.outcome.kind === 'refused') {
      // The ledger names which advisory on which version drove the refusal.
      expect(refused.outcome.reason).toContain('GHSA-crit on 4.1.1');
    }
    expect(refused.calls).toHaveLength(0);
  });

  it('PARITY: the default policy blocks EVERY added dep-vuln, so a medium advisory refuses too', async () => {
    expect(addedDepVulnVerdict(DEFAULT_BROWNFIELD_POLICY, { severity: 'medium' }).blocks).toBe(
      true,
    );
    const { outcome, calls } = await precheck(DEFAULT_BROWNFIELD_POLICY, [
      withNoFix('GHSA-med', 'MODERATE'),
    ]);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('GHSA-med');
    expect(calls).toHaveLength(0);
  });

  it('PARITY: reachability reaches the predicate from the order (security-only high + reachable blocks)', async () => {
    expect(addedDepVulnVerdict(SECURITY_ONLY, { severity: 'high', reachable: true }).blocks).toBe(
      true,
    );
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    const reachableOrder = makeOrder({
      id: 'dep-advisory:js-yaml',
      class: 'dep-advisory',
      findings: [
        {
          ...advisoryFinding('f1', 'js-yaml', 'GHSA-aaaa', '4.1.1'),
          evidence: {
            type: 'dep-vuln',
            package: 'js-yaml',
            advisoryId: 'GHSA-aaaa',
            fixedVersion: '4.1.1',
            reachable: true,
          },
        },
      ],
    });
    const outcome = await executeOverridePin(
      reachableOrder,
      makeCtx(cwd, {
        exec,
        policy: SECURITY_ONLY,
        queryOsv: async () => [withNoFix('GHSA-high', 'HIGH')],
      }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('GHSA-high');
    expect(calls).toHaveLength(0);
  });

  it('newAdvisories.blockSeverities: [] no longer disarms the pre-check (the #371 class)', async () => {
    // The post-capture advisory tier is a DIFFERENT knob; the guardrail
    // still blocks an `added` dep-vuln the change introduced.
    const disarmedTier: BrownfieldPolicy = {
      ...DEFAULT_BROWNFIELD_POLICY,
      newAdvisories: { blockSeverities: [] },
    };
    expect(addedDepVulnVerdict(disarmedTier, { severity: 'high' }).blocks).toBe(true);
    const { outcome, calls } = await precheck(disarmedTier, [withNoFix('GHSA-5p4m', 'HIGH')]);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('GHSA-5p4m');
    expect(calls).toHaveLength(0);
  });

  it('a malicious-package advisory refuses under every posture, at any severity', async () => {
    expect(addedDepVulnVerdict(SECURITY_ONLY, { severity: 'low', malicious: true }).blocks).toBe(
      true,
    );
    const { outcome } = await precheck(SECURITY_ONLY, [withNoFix('MAL-2026-0001', 'LOW')]);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('MAL-2026-0001');
  });

  // ---- the raise walk (#371) ------------------------------------------
  /** An OSV record whose one affected range is `[introduced, fixed)`. */
  const withFix = (id: string, severity: string, introduced: string, fixed: string): OsvVuln => ({
    id,
    database_specific: { severity },
    affected: [{ ranges: [{ type: 'SEMVER', events: [{ introduced }, { fixed }] }] }],
  });
  /** OSV answers keyed by the queried version; unknown versions are clean. */
  const osvByVersion = (table: Record<string, OsvVuln[]>) => {
    const queried: string[] = [];
    const queryOsv = async (_pkg: string, version: string) => {
      queried.push(version);
      return table[version] ?? [];
    };
    return { queried, queryOsv };
  };

  it("RAISES the pin to the advisory's fixed version and re-checks; the note says so", async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    // The order's own fixes pick 4.1.1; that version carries a HIGH advisory
    // fixed in 4.3.1 (the js-yaml shape from the issue).
    const osv = osvByVersion({ '4.1.1': [withFix('GHSA-5p4m', 'HIGH', '4.0.0', '4.3.1')] });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('applied');
    expect(osv.queried).toEqual(['4.1.1', '4.3.1']);
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    expect(pkg.overrides['js-yaml']).toBe('4.3.1');
    if (outcome.kind === 'applied') {
      expect(outcome.notes).toContain('raised from 4.1.1 to 4.3.1: GHSA-5p4m on 4.1.1');
    }
  });

  it('raises to the HIGHEST fix across several advisories on the pin, under the pack scheme', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    // Two advisories on 4.1.1: one fixed in 4.2.0, one in 4.3.1; a backport
    // event below the pin (3.14.2) is never a raise target.
    const a = withFix('GHSA-one', 'HIGH', '4.0.0', '4.2.0');
    const b: OsvVuln = {
      id: 'GHSA-two',
      database_specific: { severity: 'HIGH' },
      affected: [
        { ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.14.2' }] }] },
        { ranges: [{ type: 'SEMVER', events: [{ introduced: '4.0.0' }, { fixed: '4.3.1' }] }] },
      ],
    };
    const osv = osvByVersion({ '4.1.1': [a, b] });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('applied');
    expect(osv.queried).toEqual(['4.1.1', '4.3.1']);
    if (outcome.kind === 'applied') {
      expect(outcome.notes).toContain(
        'raised from 4.1.1 to 4.3.1: GHSA-one on 4.1.1, GHSA-two on 4.1.1',
      );
    }
  });

  it('walks hop by hop when the raised version carries its own advisory', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const osv = osvByVersion({
      '4.1.1': [withFix('GHSA-a', 'HIGH', '4.0.0', '4.2.0')],
      '4.2.0': [withFix('GHSA-b', 'HIGH', '4.2.0', '4.3.1')],
    });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('applied');
    expect(osv.queried).toEqual(['4.1.1', '4.2.0', '4.3.1']);
    if (outcome.kind === 'applied') {
      expect(outcome.notes).toEqual([
        'raised from 4.1.1 to 4.2.0: GHSA-a on 4.1.1',
        'raised from 4.2.0 to 4.3.1: GHSA-b on 4.2.0',
      ]);
    }
  });

  it('a blocking advisory with NO concrete fix above the pin refuses, naming advisory + version', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    // A range whose only fixed event is BELOW the pin (a backport), so no
    // version this recipe can pick clears it.
    const osv = osvByVersion({ '4.1.1': [withFix('GHSA-nofix', 'HIGH', '0', '3.14.2')] });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.reason).toContain('GHSA-nofix on 4.1.1');
      expect(outcome.reason).toContain('no concrete fixed version above 4.1.1');
    }
    expect(calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).toBe(PKG);
  });

  it('a raise that lands on an unfixable blocking advisory refuses and discloses the raise chain', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    const osv = osvByVersion({
      '4.1.1': [withFix('GHSA-a', 'HIGH', '4.0.0', '4.2.0')],
      '4.2.0': [withFix('GHSA-b', 'HIGH', '0', '3.14.2')],
    });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.reason).toContain('GHSA-b on 4.2.0');
      expect(outcome.reason).toContain('raised from 4.1.1 to 4.2.0: GHSA-a on 4.1.1');
    }
    expect(calls).toHaveLength(0);
  });

  it(`is bounded: after ${MAX_PIN_RAISES} raises the walk refuses rather than continuing`, async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec, calls } = fakeExec();
    // Every version carries a further advisory with a fix: an endless ladder.
    const osv = osvByVersion({
      '4.1.1': [withFix('GHSA-1', 'HIGH', '4.0.0', '4.2.0')],
      '4.2.0': [withFix('GHSA-2', 'HIGH', '4.2.0', '4.3.0')],
      '4.3.0': [withFix('GHSA-3', 'HIGH', '4.3.0', '4.4.0')],
      '4.4.0': [withFix('GHSA-4', 'HIGH', '4.4.0', '4.5.0')],
      '4.5.0': [withFix('GHSA-5', 'HIGH', '4.5.0', '4.6.0')],
    });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('refused');
    expect(osv.queried).toHaveLength(MAX_PIN_RAISES + 1);
    if (outcome.kind === 'refused') {
      expect(outcome.reason).toContain(`after ${MAX_PIN_RAISES} raises`);
      expect(outcome.reason).toContain('GHSA-4');
    }
    expect(calls).toHaveLength(0);
  });

  it('a warn-tier advisory with a fix still raises (the re-audit demands a clean package)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const securityOnly = policyForPreset('security-only', DEFAULT_BROWNFIELD_POLICY).policy;
    // High + unreachable warns under security-only, so this would not
    // refuse; but it has a fix, so the pin walks past it instead of applying
    // a version the verify would then report.
    const osv = osvByVersion({ '4.1.1': [withFix('GHSA-warn', 'HIGH', '4.0.0', '4.3.1')] });
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, policy: securityOnly, queryOsv: osv.queryOsv }),
    );
    expect(outcome.kind).toBe('applied');
    expect(osv.queried).toEqual(['4.1.1', '4.3.1']);
  });

  it('a null OSV answer on a raised hop stays a disclosed note, never read as clean', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const queryOsv = async (_pkg: string, version: string) =>
      version === '4.1.1' ? [withFix('GHSA-a', 'HIGH', '4.0.0', '4.3.1')] : null;
    const outcome = await executeOverridePin(pinOrder(), makeCtx(cwd, { exec, queryOsv }));
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.notes).toEqual([
        'raised from 4.1.1 to 4.3.1: GHSA-a on 4.1.1',
        'OSV pre-check for js-yaml@4.3.1 could not be reached; the re-audit verifies',
      ]);
    }
  });

  it('a range-shaped fixed version refuses at runtime too (the defensive rail behind matches)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const order = makeOrder({
      id: 'dep-advisory:js-yaml',
      class: 'dep-advisory',
      findings: [advisoryFinding('f1', 'js-yaml', 'GHSA-aaaa', '>=4.1.0')],
    });
    const outcome = await executeOverridePin(order, makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('concrete');
  });

  it('an unreachable OSV pre-check is a DISCLOSED note, never read as clean', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, queryOsv: async () => null }),
    );
    expect(outcome.kind).toBe('applied');
    if (outcome.kind === 'applied') {
      expect(outcome.notes?.join(' ')).toContain('could not be reached');
    }
  });

  it('refuses a DIRECT dependency (upgrade it, do not override it)', async () => {
    const direct = JSON.stringify({ name: 'fx', dependencies: { 'js-yaml': '^3.0.0' } });
    const cwd = tempRepo({ 'package.json': direct, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeOverridePin(pinOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('direct');
  });

  it('refuses the pnpm/yarn override mechanisms this round, with the reason named', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'pnpm-lock.yaml': '' });
    const { exec } = fakeExec();
    const outcome = await executeOverridePin(pinOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('pnpm');
  });

  it('fails verify when the re-audit still reports the package (diff will be discarded)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, auditDepVulns: async () => [depFinding('js-yaml', 'GHSA-cccc')] }),
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.step).toBe('verify-audit');
      expect(outcome.output).toContain('GHSA-cccc');
    }
  });

  it('fails verify when the re-audit cannot run (an unobserved clean is never claimed)', async () => {
    const cwd = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec } = fakeExec();
    const outcome = await executeOverridePin(
      pinOrder(),
      makeCtx(cwd, { exec, auditDepVulns: async () => null }),
    );
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.step).toBe('verify-audit');
  });
});

describe('override-pin recipe (command plans: the tool-owned ecosystems, 4.4.7 V3)', () => {
  const GO_MOD =
    'module example.com/app\n\ngo 1.22\n\nrequire golang.org/x/text v0.3.7 // indirect\n';

  function goOrder(fixedVersion = '0.3.8') {
    return makeOrder({
      id: 'dep-advisory:golang.org/x/text',
      class: 'dep-advisory',
      findings: [advisoryFinding('f1', 'golang.org/x/text', 'GHSA-gggg', fixedVersion)],
      envelope: { paths: ['go.mod', 'go.sum'], manifests: true },
    });
  }

  it('go: runs the pack-declared `go get` at the root, no separate resync, re-audits clean', async () => {
    const cwd = tempRepo({ 'go.mod': GO_MOD, 'go.sum': '' });
    const { exec, calls } = fakeExec();
    const outcome = await executeOverridePin(goOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    // The ONE spawn is the tool's own pin command; the tool leaves the tree
    // consistent, so no lock resync follows.
    expect(calls.map((c) => [c.cmd.bin, ...c.cmd.args].join(' '))).toEqual([
      'go get golang.org/x/text@v0.3.8',
    ]);
    expect(calls[0].cwd).toBe(cwd);
    if (outcome.kind === 'applied') {
      expect(outcome.changedFiles).toEqual(['go.mod', 'go.sum']);
      expect(outcome.revert).toContain('go mod tidy');
    }
  });

  it('go: a failing pin command is a named step failure (diff will be discarded)', async () => {
    const cwd = tempRepo({ 'go.mod': GO_MOD, 'go.sum': '' });
    const { exec } = fakeExec((cmd) => {
      if (cmd.bin === 'go') return { code: 1, output: 'go: module not found' };
    });
    const outcome = await executeOverridePin(goOrder(), makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') {
      expect(outcome.step).toBe('apply-pin');
      expect(outcome.output).toContain('module not found');
    }
  });

  it('go: the OSV block-tier pre-check refuses BEFORE the command spawns ($0)', async () => {
    const cwd = tempRepo({ 'go.mod': GO_MOD, 'go.sum': '' });
    const { exec, calls } = fakeExec();
    const outcome = await executeOverridePin(
      goOrder(),
      makeCtx(cwd, {
        exec,
        queryOsv: async () => [{ id: 'GO-2026-9999', database_specific: { severity: 'HIGH' } }],
      }),
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('GO-2026-9999');
    expect(calls).toHaveLength(0);
  });

  it('go: the OSV pre-check queries the BARE version form the Go ecosystem stores', async () => {
    const cwd = tempRepo({ 'go.mod': GO_MOD, 'go.sum': '' });
    const { exec } = fakeExec();
    const queried: string[] = [];
    const outcome = await executeOverridePin(
      goOrder('v0.3.8'),
      makeCtx(cwd, {
        exec,
        queryOsv: async (_pkg, version) => {
          queried.push(version);
          return [];
        },
      }),
    );
    expect(outcome.kind).toBe('applied');
    // A v-prefixed query would silently match nothing and read as clean.
    expect(queried).toEqual(['0.3.8']);
  });

  it('rust: runs `cargo update -p --precise` at the root and reports the lockfile as the one write', async () => {
    const cwd = tempRepo({
      'Cargo.toml': '[package]\nname = "fx"\n\n[dependencies]\ntop = "1.0"\n',
      'Cargo.lock': '',
    });
    const { exec, calls } = fakeExec();
    const order = makeOrder({
      id: 'dep-advisory:smallvec',
      class: 'dep-advisory',
      findings: [advisoryFinding('f1', 'smallvec', 'RUSTSEC-2026-0001', '1.13.2')],
      envelope: { paths: ['Cargo.toml', 'Cargo.lock'], manifests: true },
    });
    const outcome = await executeOverridePin(order, makeCtx(cwd, { exec }));
    expect(outcome.kind).toBe('applied');
    expect(calls.map((c) => [c.cmd.bin, ...c.cmd.args].join(' '))).toEqual([
      'cargo update -p smallvec --precise 1.13.2',
    ]);
    if (outcome.kind === 'applied') {
      expect(outcome.changedFiles).toEqual(['Cargo.lock']);
    }
  });
});
