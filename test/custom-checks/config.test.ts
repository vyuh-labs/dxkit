import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { lintGateSpecs, normalizeCustomChecks } from '../../src/analyzers/custom-checks/config';
import { recallInputsForSpecs } from '../../src/analyzers/custom-checks/gather';
import { resolvePolicy } from '../../src/baseline/policy';
import type { CustomCheckConfig } from '../../src/baseline/policy';

describe('normalizeCustomChecks', () => {
  it('normalizes a string command (whitespace-split) with defaults', () => {
    const { specs, warnings } = normalizeCustomChecks([
      { name: 'check:seam', command: 'npm run check:seam' },
    ]);
    expect(warnings).toEqual([]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toEqual({
      name: 'check:seam',
      command: { bin: 'npm', args: ['run', 'check:seam'] },
      blocking: true, // default
      expectedExit: 0, // default
      parse: { mode: 'exit' }, // default
    });
  });

  it('normalizes an argv-array command and explicit fields', () => {
    const { specs } = normalizeCustomChecks([
      { name: 'licenses', command: ['make', 'check-licenses'], blocking: false, expectedExit: 2 },
    ]);
    expect(specs[0].command).toEqual({ bin: 'make', args: ['check-licenses'] });
    expect(specs[0].blocking).toBe(false);
    expect(specs[0].expectedExit).toBe(2);
  });

  it('normalizes a regex parse spec', () => {
    const { specs } = normalizeCustomChecks([
      { name: 'unix-lint', command: 'eslint .', parse: { regex: '^(?<file>[^:]+):(?<line>\\d+)' } },
    ]);
    expect(specs[0].parse).toEqual({ mode: 'regex', pattern: '^(?<file>[^:]+):(?<line>\\d+)' });
  });

  it('drops entries with no name, no command, reserved prefix, or duplicate name (with warnings)', () => {
    const configs = [
      { command: 'x' } as unknown as CustomCheckConfig, // no name
      { name: 'ok', command: '' }, // empty command
      { name: 'lint:typescript', command: 'x' }, // reserved prefix
      { name: 'dup', command: 'a' },
      { name: 'dup', command: 'b' }, // duplicate
    ];
    const { specs, warnings } = normalizeCustomChecks(configs);
    expect(specs.map((s) => s.name)).toEqual(['dup']);
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).toMatch(/no `name`/);
    expect(warnings.join('\n')).toMatch(/no runnable `command`/);
    expect(warnings.join('\n')).toMatch(/reserved 'lint:' prefix/);
    expect(warnings.join('\n')).toMatch(/duplicate check name 'dup'/);
  });

  it('returns empty for undefined / empty config', () => {
    expect(normalizeCustomChecks(undefined)).toEqual({ specs: [], warnings: [] });
    expect(normalizeCustomChecks([])).toEqual({ specs: [], warnings: [] });
  });

  it('a malformed parse falls back to exit mode', () => {
    const { specs } = normalizeCustomChecks([
      { name: 'c', command: 'x', parse: { regex: '' } },
      // @ts-expect-error — exercising a runtime-malformed parse value
      { name: 'd', command: 'x', parse: 42 },
    ]);
    expect(specs[0].parse).toEqual({ mode: 'exit' });
    expect(specs[1].parse).toEqual({ mode: 'exit' });
  });
});

describe('resolvePolicy — checks/lint passthrough', () => {
  let tmp: string;
  function withPolicy(json: unknown): string {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-policy-'));
    fs.mkdirSync(path.join(tmp, '.dxkit'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.dxkit', 'policy.json'), JSON.stringify(json));
    return tmp;
  }

  it('carries checks + lint through resolvePolicy', () => {
    const cwd = withPolicy({
      checks: [{ name: 'check:seam', command: 'npm run check:seam' }],
      lint: { enabled: true, blocking: false },
    });
    const policy = resolvePolicy(undefined, cwd);
    expect(policy.checks).toHaveLength(1);
    expect(policy.checks?.[0].name).toBe('check:seam');
    expect(policy.lint).toEqual({ enabled: true, blocking: false });
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('checks/lint are absent when the policy omits them (default off)', () => {
    const cwd = withPolicy({ mode: 'brownfield' });
    const policy = resolvePolicy(undefined, cwd);
    expect(policy.checks).toBeUndefined();
    expect(policy.lint).toBeUndefined();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('carries a valid largeFileThreshold through resolvePolicy', () => {
    const cwd = withPolicy({ largeFileThreshold: 800 });
    expect(resolvePolicy(undefined, cwd).largeFileThreshold).toBe(800);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it('ignores a malformed largeFileThreshold (string / zero / negative) → default applies', () => {
    for (const bad of ['800', 0, -1, Number.NaN, null, {}]) {
      const cwd = withPolicy({ largeFileThreshold: bad });
      expect(resolvePolicy(undefined, cwd).largeFileThreshold).toBeUndefined();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('largeFileThreshold is absent when the policy omits it (default 500 applies downstream)', () => {
    const cwd = withPolicy({ mode: 'brownfield' });
    expect(resolvePolicy(undefined, cwd).largeFileThreshold).toBeUndefined();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe('lintGateSpecs — unresolvable linter becomes a disclosed stub (VERIFY-40 F-9)', () => {
  const nullPack = {
    id: 'ruby',
    lintGate: {
      execution: () => ({
        hosts: ['any'],
        toolchains: ['ruby'],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      }),
      lintCommand: () => null,
      recallInputs: () => ({ rubocop: '9.9.9' }),
    },
  } as unknown as import('../../src/languages/types').LanguageSupport;

  it('a policy-enabled gate whose lintCommand returns null still exists, marked unavailable', () => {
    const specs = lintGateSpecs([nullPack], { cwd: '/repo', changedFiles: [] }, { enabled: true });
    expect(specs).toHaveLength(1);
    expect(specs[0].name).toBe('lint:ruby');
    expect(specs[0].unavailable).toContain('tools install');
    // The sentinel command must be unexecutable by construction.
    expect(specs[0].command.bin).toBe('dxkit-lint-unavailable');
  });

  it('the stub contributes NO recall inputs (unobserved reads as absent)', () => {
    const specs = lintGateSpecs([nullPack], { cwd: '/repo', changedFiles: [] }, { enabled: true });
    expect(recallInputsForSpecs(specs)).toEqual({});
  });

  it('lint disabled still yields nothing (the stub only exists for an ENABLED gate)', () => {
    expect(lintGateSpecs([nullPack], { cwd: '/repo', changedFiles: [] }, undefined)).toEqual([]);
  });
});
