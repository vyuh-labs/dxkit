import { describe, it, expect } from 'vitest';

import { runCustomChecks, describeCustomChecks } from '../../src/analyzers/custom-checks/run';
import { parseLocated } from '../../src/analyzers/custom-checks/parse';
import type { CommandExec } from '../../src/analyzers/tools/bounded-exec';
import type { CustomCheckSpec } from '../../src/analyzers/custom-checks/types';
import { trustedLocalContext } from '../../src/analysis-trust';

const CWD = '/repo';

function spec(over: Partial<CustomCheckSpec> = {}): CustomCheckSpec {
  return {
    name: 'check:seam',
    command: { bin: 'faketool', args: [] },
    blocking: true,
    expectedExit: 0,
    parse: { mode: 'exit' },
    ...over,
  };
}

const pass: CommandExec = () => ({ available: true, code: 0, output: '' });
const failBinary: CommandExec = () => ({ available: true, code: 1, output: 'seam violated' });
const missing: CommandExec = () => ({ available: false, code: -1, output: '' });
const timedOut: CommandExec = () => ({ available: true, timedOut: true, code: -1, output: '' });

describe('runCustomChecks — exit-code policy', () => {
  it('a passing check yields no findings and status pass', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec()],
      exec: pass,
    });
    expect(r.ran).toBe(true);
    expect(r.results[0].status).toBe('pass');
    expect(r.findings).toEqual([]);
  });

  it('a binary failure yields one finding carrying the check name + message', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec()],
      exec: failBinary,
    });
    expect(r.results[0].status).toBe('fail');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      check: 'check:seam',
      blocking: true,
      message: 'seam violated',
    });
    expect(r.findings[0].file).toBeUndefined();
  });

  it('a missing binary is fail-OPEN (skipped-unavailable), never a failure', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec()],
      exec: missing,
    });
    expect(r.results[0].status).toBe('skipped-unavailable');
    expect(r.findings).toEqual([]);
    expect(r.ran).toBe(false);
  });

  it('a timeout is fail-OPEN (skipped-timeout), never a failure', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec()],
      exec: timedOut,
    });
    expect(r.results[0].status).toBe('skipped-timeout');
    expect(r.findings).toEqual([]);
    expect(r.ran).toBe(false);
  });

  it('honors a non-zero expectedExit (e.g. a check that "passes" with exit 2)', () => {
    const exec: CommandExec = () => ({ available: true, code: 2, output: '' });
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ expectedExit: 2 })],
      exec,
    });
    expect(r.results[0].status).toBe('pass');
    // And a DIFFERENT exit is a failure.
    const r0 = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ expectedExit: 2 })],
      exec: pass,
    });
    expect(r0.results[0].status).toBe('fail');
  });

  it('carries the per-check blocking flag onto its findings', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ blocking: false })],
      exec: failBinary,
    });
    expect(r.findings[0].blocking).toBe(false);
  });

  it('runs multiple checks and flattens findings', () => {
    const mixed: CommandExec = (cmd) =>
      cmd.args[0] === 'ok'
        ? { available: true, code: 0, output: '' }
        : { available: true, code: 1, output: 'bad' };
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [
        spec({ name: 'a', command: { bin: 'faketool', args: ['ok'] } }),
        spec({ name: 'b', command: { bin: 'faketool', args: ['no'] } }),
      ],
      exec: mixed,
    });
    expect(r.results.map((x) => x.status)).toEqual(['pass', 'fail']);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].check).toBe('b');
  });
});

describe('describeCustomChecks', () => {
  it('summarizes the failing checks', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec()],
      exec: failBinary,
    });
    expect(describeCustomChecks(r)).toMatch(/1 failed — check:seam \(1\)/);
  });
  it('reports all-passed', () => {
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec()],
      exec: pass,
    });
    expect(describeCustomChecks(r)).toBe('custom checks: all passed');
  });
});

describe('runCustomChecks — regex parse mode (lint)', () => {
  // An eslint-stylish-ish line: `src/a.ts:12:5  error  no-unused-vars  'x' is unused`
  const eslintish = {
    mode: 'regex' as const,
    pattern: '^(?<file>[^:]+):(?<line>\\d+):\\d+\\s+\\w+\\s+(?<rule>[\\w-]+)\\s+(?<message>.*)$',
  };

  it('extracts one located finding per matching line', () => {
    const output = [
      "src/a.ts:12:5  error  no-unused-vars  'x' is unused",
      'src/b.ts:3:1  error  no-explicit-any  avoid any',
    ].join('\n');
    const exec: CommandExec = () => ({ available: true, code: 1, output });
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ name: 'lint:typescript', parse: eslintish })],
      exec,
    });
    expect(r.findings).toHaveLength(2);
    expect(r.findings[0]).toMatchObject({
      check: 'lint:typescript',
      file: 'src/a.ts',
      line: 12,
      rule: 'no-unused-vars',
    });
    expect(r.findings[1]).toMatchObject({ file: 'src/b.ts', line: 3, rule: 'no-explicit-any' });
  });

  it('falls back to a binary finding when the pattern matches nothing (failure never lost)', () => {
    const exec: CommandExec = () => ({ available: true, code: 1, output: 'totally unparseable' });
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ name: 'lint:typescript', parse: eslintish })],
      exec,
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].file).toBeUndefined();
    expect(r.findings[0].message).toBe('totally unparseable');
  });

  it('a clean lint check (exit 0, no matching output) yields nothing', () => {
    const exec: CommandExec = () => ({ available: true, code: 0, output: '' });
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ name: 'lint:typescript', parse: eslintish })],
      exec,
    });
    expect(r.results[0].status).toBe('pass');
    expect(r.findings).toEqual([]);
  });

  it('a regex check that EXITS 0 but emits findings still gates (C#/Java build-analyzer case)', () => {
    // dotnet build / a warnings-only eslint exit 0 yet print diagnostics — the
    // runner parses regardless of exit, so these are NOT silently a pass.
    const output = 'Program.cs(12,5): warning CA1822: Member does not access instance data';
    const csharpParse = {
      mode: 'regex' as const,
      pattern:
        '^(?<file>.+?)\\((?<line>\\d+),\\d+\\):\\s+warning\\s+(?<rule>\\w+):\\s+(?<message>.*)$',
    };
    const exec: CommandExec = () => ({ available: true, code: 0, output });
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [spec({ name: 'lint:csharp', parse: csharpParse })],
      exec,
    });
    expect(r.results[0].status).toBe('fail');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ file: 'Program.cs', line: 12, rule: 'CA1822' });
  });
});

describe('parseLocated — dedupe + malformed regex', () => {
  it('dedupes identical (file,line,rule) diagnostics within one run', () => {
    const out = ['src/a.ts:1:  r1  x', 'src/a.ts:1:  r1  x'].join('\n');
    const found = parseLocated(
      'lint:x',
      true,
      '^(?<file>[^:]+):(?<line>\\d+):\\s+(?<rule>\\w+)\\s+(?<message>.*)$',
      out,
      '/repo',
    );
    expect(found).toHaveLength(1);
  });

  it('a malformed regex degrades to a binary finding (never crashes the gate)', () => {
    const found = parseLocated('lint:x', true, '(', 'some output', '/repo');
    expect(found).toHaveLength(1);
    expect(found[0].file).toBeUndefined();
    expect(found[0].message).toMatch(/invalid parse regex/);
  });
});

describe('declared-but-unresolvable lint gate (VERIFY-40 F-9 — disclosed, never silent)', () => {
  const stub = spec({
    name: 'lint:ruby',
    command: { bin: 'dxkit-lint-unavailable', args: [] },
    unavailable: "the ruby pack's linter is not installed or resolvable in this environment",
  });

  it('the runner discloses skipped-unavailable with the reason, without spawning', () => {
    let spawned = 0;
    const counting: CommandExec = () => {
      spawned++;
      return { available: true, code: 0, output: '' };
    };
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [stub],
      exec: counting,
    });
    expect(r.results[0].status).toBe('skipped-unavailable');
    expect(r.results[0].reason).toContain('not installed');
    expect(r.findings).toEqual([]);
    expect(spawned).toBe(0);
  });

  it('an unmet environment supersedes the unavailable reason (wrong host first)', () => {
    const winOnly = spec({
      name: 'lint:csharp',
      unavailable: 'linter missing',
      execution: {
        hosts: ['windows'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      },
    });
    const r = runCustomChecks({
      trust: trustedLocalContext(),
      cwd: CWD,
      specs: [winOnly],
      exec: pass,
      env: { host: 'linux', hasToolchain: () => true },
    });
    expect(r.results[0].status).toBe('skipped-environment');
  });
});
