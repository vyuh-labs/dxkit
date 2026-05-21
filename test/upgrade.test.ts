/**
 * Tests for the upgrade CLI's pure helpers + plan-mode contract.
 * The execution path is shell-out heavy (npm install, vyuh-dxkit
 * update, vyuh-dxkit doctor) so we focus tests on the deterministic
 * surfaces: delta classification, plan shape invariants, and the
 * JSON-mode schema that dxkit-update consumes.
 */
import { describe, it, expect } from 'vitest';
import { classifyDelta, buildUpgradePlan } from '../src/upgrade';

describe('classifyDelta', () => {
  it('returns none when versions match', () => {
    expect(classifyDelta('2.5.2', '2.5.2')).toBe('none');
  });

  it('detects patch bumps', () => {
    expect(classifyDelta('2.5.1', '2.5.2')).toBe('patch');
    expect(classifyDelta('2.5.0', '2.5.5')).toBe('patch');
  });

  it('detects minor bumps', () => {
    expect(classifyDelta('2.5.1', '2.6.0')).toBe('minor');
    expect(classifyDelta('2.5.5', '2.7.0')).toBe('minor');
  });

  it('detects major bumps', () => {
    expect(classifyDelta('2.5.1', '3.0.0')).toBe('major');
    expect(classifyDelta('1.9.9', '2.0.0')).toBe('major');
  });

  it('detects downgrades at every level', () => {
    expect(classifyDelta('2.5.2', '2.5.1')).toBe('downgrade');
    expect(classifyDelta('2.6.0', '2.5.5')).toBe('downgrade');
    expect(classifyDelta('3.0.0', '2.5.5')).toBe('downgrade');
  });

  it('returns none on missing inputs (defensive)', () => {
    expect(classifyDelta(null, '2.5.2')).toBe('none');
    expect(classifyDelta('2.5.2', '')).toBe('none');
  });

  it('returns none on malformed versions (defensive)', () => {
    expect(classifyDelta('not-a-version', '2.5.2')).toBe('none');
    expect(classifyDelta('2.5.2', 'latest')).toBe('none');
  });
});

describe('buildUpgradePlan: schema invariants', () => {
  it('returns a plan with the upgrade-plan.v1 schema discriminator', () => {
    const plan = buildUpgradePlan(process.cwd(), {
      target: '99.99.99',
      _readBinary: () => '2.5.1',
      _readLatest: () => '99.99.99',
    });
    expect(plan.schema).toBe('upgrade-plan.v1');
  });

  it('includes the resolved cwd', () => {
    const plan = buildUpgradePlan('/tmp', {
      target: '99.99.99',
      _readBinary: () => null,
      _readLatest: () => '99.99.99',
    });
    expect(plan.cwd).toBe('/tmp');
  });

  it('uses the explicit --target when provided (skips npm view)', () => {
    const plan = buildUpgradePlan(process.cwd(), {
      target: '99.99.99',
      _readBinary: () => '2.5.1',
      _readLatest: () => '99.99.99',
    });
    expect(plan.target).toBe('99.99.99');
  });

  it('produces 3 main steps on a target with no devcontainer', () => {
    const plan = buildUpgradePlan('/tmp', {
      target: '99.99.99',
      _readBinary: () => '2.5.1',
      _readLatest: () => '99.99.99',
    });
    const required = plan.steps.filter((s) => !s.optional);
    expect(required.length).toBe(3);
    expect(required[0].command).toContain('npm install @vyuhlabs/dxkit@');
    expect(required[1].command).toContain('vyuh-dxkit update');
    expect(required[2].command).toContain('vyuh-dxkit doctor');
  });

  it('warns about major-version jumps', () => {
    const plan = buildUpgradePlan(process.cwd(), {
      target: '99.99.99',
      _readBinary: () => '2.5.1',
      _readLatest: () => '99.99.99',
    });
    expect(plan.delta).toBe('major');
    expect(plan.warnings.some((w) => w.includes('Major version jump'))).toBe(true);
  });

  it('warns about downgrades', () => {
    const plan = buildUpgradePlan(process.cwd(), {
      target: '0.0.1',
      _readBinary: () => '2.5.1',
      _readLatest: () => '0.0.1',
    });
    expect(plan.delta).toBe('downgrade');
    expect(plan.warnings.some((w) => w.includes('OLDER'))).toBe(true);
  });

  it('every step has a command + purpose', () => {
    const plan = buildUpgradePlan(process.cwd(), {
      target: '99.99.99',
      _readBinary: () => '2.5.1',
      _readLatest: () => '99.99.99',
    });
    for (const step of plan.steps) {
      expect(step.command).toBeTruthy();
      expect(step.purpose).toBeTruthy();
    }
  });

  it('exposes a changelogNote pointing at the canonical source', () => {
    const plan = buildUpgradePlan(process.cwd(), {
      target: '99.99.99',
      _readBinary: () => '2.5.1',
      _readLatest: () => '99.99.99',
    });
    expect(plan.changelogNote).toContain('CHANGELOG.md');
  });

  it('handles a cwd without manifest gracefully', () => {
    // /tmp has no .vyuh-dxkit.json; plan should still build without
    // throwing and report scaffold: null.
    const plan = buildUpgradePlan('/tmp', {
      target: '99.99.99',
      _readBinary: () => null,
      _readLatest: () => '99.99.99',
    });
    expect(plan.current.scaffold).toBeNull();
  });
});
