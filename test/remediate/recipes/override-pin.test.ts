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
