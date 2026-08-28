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

  it('the block tier comes from POLICY through the one normalizer: medium refuses when the repo says so', async () => {
    const mediumVuln = [{ id: 'GHSA-med', database_specific: { severity: 'MODERATE' } }];
    // Default tier (critical + high): a medium advisory on the pin does NOT refuse.
    const cwdA = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec: execA } = fakeExec();
    const relaxed = await executeOverridePin(
      pinOrder(),
      makeCtx(cwdA, { exec: execA, queryOsv: async () => mediumVuln }),
    );
    expect(relaxed.kind).toBe('applied');
    // A repo whose policy blocks medium too: the SAME advisory now refuses.
    const cwdB = tempRepo({ 'package.json': PKG, 'package-lock.json': '{}' });
    const { exec: execB, calls } = fakeExec();
    const strict = await executeOverridePin(
      pinOrder(),
      makeCtx(cwdB, {
        exec: execB,
        queryOsv: async () => mediumVuln,
        blockSeverities: new Set(['critical', 'high', 'medium'] as const),
      }),
    );
    expect(strict.kind).toBe('refused');
    if (strict.kind === 'refused') expect(strict.reason).toContain('GHSA-med');
    expect(calls).toHaveLength(0);
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
