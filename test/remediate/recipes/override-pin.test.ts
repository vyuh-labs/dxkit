/**
 * The override-pin recipe: applied (npm override written, resync, re-audit
 * clean), the OSV pre-check refusal with the advisory named (a fake
 * fetcher), the direct-dependency refusal, the non-npm declared refusal,
 * and the verify failure when the re-audit still reports the package.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { executeOverridePin } from '../../../src/remediate/recipes/override-pin';
import {
  compareConcreteSemver,
  isConcreteSemver,
  pickPinVersion,
} from '../../../src/remediate/recipes/shared';
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
