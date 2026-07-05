import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_LOOP_PRESET,
  resolveLoopPolicy,
  resolveLoopPreset,
  resolveLoopTestCommand,
} from '../../src/loop/policy';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-loop-policy-'));
}

function writePolicy(cwd: string, obj: unknown): void {
  fs.mkdirSync(path.join(cwd, '.dxkit'), { recursive: true });
  fs.writeFileSync(path.join(cwd, '.dxkit', 'policy.json'), JSON.stringify(obj));
}

describe('loop policy presets', () => {
  const savedEnv = process.env.DXKIT_LOOP_PRESET;
  let repo: string;

  beforeEach(() => {
    delete process.env.DXKIT_LOOP_PRESET;
    repo = tmpRepo();
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.DXKIT_LOOP_PRESET;
    else process.env.DXKIT_LOOP_PRESET = savedEnv;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('defaults to security-only when nothing is configured', () => {
    expect(resolveLoopPreset(repo)).toBe('security-only');
    expect(DEFAULT_LOOP_PRESET).toBe('security-only');
  });

  describe('resolveLoopTestCommand precedence', () => {
    const savedCmd = process.env.DXKIT_LOOP_TEST_COMMAND;
    afterEach(() => {
      if (savedCmd === undefined) delete process.env.DXKIT_LOOP_TEST_COMMAND;
      else process.env.DXKIT_LOOP_TEST_COMMAND = savedCmd;
    });

    it('is undefined when neither env nor policy sets it', () => {
      delete process.env.DXKIT_LOOP_TEST_COMMAND;
      expect(resolveLoopTestCommand(repo)).toBeUndefined();
    });
    it('reads the durable policy field when the env var is unset', () => {
      delete process.env.DXKIT_LOOP_TEST_COMMAND;
      writePolicy(repo, { loop: { testCommand: 'pnpm test:int' } });
      expect(resolveLoopTestCommand(repo)).toBe('pnpm test:int');
    });
    it('the env var overrides the policy field', () => {
      writePolicy(repo, { loop: { testCommand: 'pnpm test:int' } });
      process.env.DXKIT_LOOP_TEST_COMMAND = 'npm test';
      expect(resolveLoopTestCommand(repo)).toBe('npm test');
    });
    it('ignores a blank/whitespace policy value', () => {
      delete process.env.DXKIT_LOOP_TEST_COMMAND;
      writePolicy(repo, { loop: { testCommand: '   ' } });
      expect(resolveLoopTestCommand(repo)).toBeUndefined();
    });
  });

  it('security-only does NOT block test-gap or quality, but DOES block the security class', () => {
    const { preset, policy, flowMode } = resolveLoopPolicy(repo);
    expect(preset).toBe('security-only');
    // Flow integration breakage warns (not a security class; a cross-repo false
    // positive must never wedge an unattended loop).
    expect(flowMode).toBe('warn');
    // No generic status-based block — debt findings (added) warn, never block.
    expect(policy.block).toEqual([]);
    // Open-ended debt off.
    expect(policy.blockRules.newUntestedChangedSource).toBe(false);
    expect(policy.blockRules.newSevereQualityIssueInChangedFiles).toBe(false);
    // Security class on.
    expect(policy.blockRules.newSecret).toBe(true);
    expect(policy.blockRules.newCriticalSecurity).toBe(true);
    expect(policy.blockRules.newHighSecurity).toBe(true);
    expect(policy.blockRules.newCriticalDependencyVulnerability).toBe(true);
    expect(policy.blockRules.newHighReachableDependencyVulnerability).toBe(true);
  });

  it('full-debt blocks every net-new finding incl. test-gap + quality', () => {
    writePolicy(repo, { loop: { preset: 'full-debt' } });
    const { preset, policy, flowMode } = resolveLoopPolicy(repo);
    expect(preset).toBe('full-debt');
    expect(policy.block).toEqual(['added']);
    expect(policy.blockRules.newUntestedChangedSource).toBe(true);
    expect(policy.blockRules.newSevereQualityIssueInChangedFiles).toBe(true);
    // Full-debt blocks integration breakage too.
    expect(flowMode).toBe('block');
  });

  it('reads loop.preset from .dxkit/policy.json', () => {
    writePolicy(repo, { loop: { preset: 'full-debt' } });
    expect(resolveLoopPreset(repo)).toBe('full-debt');
  });

  it('env var overrides the policy file', () => {
    writePolicy(repo, { loop: { preset: 'full-debt' } });
    process.env.DXKIT_LOOP_PRESET = 'security-only';
    expect(resolveLoopPreset(repo)).toBe('security-only');
  });

  it('ignores a malformed preset value and falls back to default', () => {
    writePolicy(repo, { loop: { preset: 'bogus' } });
    expect(resolveLoopPreset(repo)).toBe('security-only');
  });

  it('preserves the base policy confidence + baseline-mode while swapping block rules', () => {
    writePolicy(repo, {
      confidence: { critical: 0.99 },
      baseline: { mode: 'committed-full' },
      loop: { preset: 'security-only' },
    });
    const { policy } = resolveLoopPolicy(repo);
    // Base fields survive the overlay…
    expect(policy.confidence.critical).toBe(0.99);
    expect(policy.baseline?.mode).toBe('committed-full');
    // …while block/blockRules come from the preset.
    expect(policy.block).toEqual([]);
  });
});
