/**
 * The capture primitive, driven for REAL — no injected `exec`.
 *
 * Every other custom-check / correctness test injects a `CommandExec`, which is
 * right for exercising runner POLICY but structurally blind to the capture
 * itself. That blindness shipped: `makeCommandExec` tail-truncated its output to
 * 4 KB ("so a block message stays readable" — a DISPLAY affordance), and the gate
 * regex-parsed that tail as its DATA SOURCE. A repo with a large lint backlog
 * emits megabytes; the gate saw the last 4 KB of it and reported a two-digit
 * count. Because the baseline producer and the guardrail share this runner
 * (Rule 17), the 4 KB window SLID between runs and minted false net-new findings.
 *
 * dxkit's own repo lints clean (0 bytes), so no fixture could ever reach the
 * window — the same structural blindness the fixture-analysis harness exists for,
 * recurring at a new boundary. Hence: a real subprocess, at real scale.
 *
 * These tests fail against the pre-fix code with `expected 4001 to be greater
 * than 2000000` — the `…` + 4000-byte tail, byte-exact — and with a finding
 * count of ~45 where the whole stream holds 30,000.
 */

import { describe, it, expect } from 'vitest';
import { makeCommandExec } from '../../src/analyzers/tools/bounded-exec';
import { runCustomChecks } from '../../src/analyzers/custom-checks/run';
import { parseLocated } from '../../src/analyzers/custom-checks/parse';
import { TS_ESLINT_UNIX_PARSE } from '../../src/languages/typescript';

/** A real child emitting a real eslint-unix stream at brownfield scale (~2.6 MB).
 *  `exitCode` (not `exit()`) so stdout flushes — a linter with a backlog exits
 *  non-zero, which is the path that matters. */
const LINES = 30_000;
const EMIT_BACKLOG = `let s='';for(let i=0;i<${LINES};i++)s+='src/file'+String(i).padStart(6,'0')+'.ts:'+(i+1)+':1: Unexpected any. [error/@typescript-eslint/no-explicit-any]\\n';process.stdout.write(s);process.exitCode=1;`;

const lintSpec = {
  name: 'lint:typescript',
  command: { bin: 'node', args: ['-e', EMIT_BACKLOG] },
  blocking: false,
  expectedExit: 0,
  parse: { mode: 'regex' as const, pattern: TS_ESLINT_UNIX_PARSE },
};

describe('command output capture (real exec, real scale)', () => {
  it('captures the COMPLETE stream, not a readable tail', () => {
    const outcome = makeCommandExec()({ bin: 'node', args: ['-e', EMIT_BACKLOG] }, process.cwd());

    expect(outcome.available).toBe(true);
    expect(outcome.overflowed ?? false).toBe(false);
    expect(outcome.code).toBe(1);
    // Pre-fix this was 4001. The point is not the exact size but that NOTHING was
    // dropped: every emitted line survives to the parser.
    expect(outcome.output.length).toBeGreaterThan(2_000_000);
    const matching = outcome.output
      .split('\n')
      .filter((l) => new RegExp(TS_ESLINT_UNIX_PARSE).test(l)).length;
    expect(matching).toBe(LINES);
  });

  it('the gate itemizes EVERY finding in the stream', () => {
    const res = runCustomChecks({ cwd: process.cwd(), specs: [lintSpec] });

    // Every finding is itemized so the baseline can grandfather each one. The
    // old code returned 501 here (a 500-finding prefix + a catch-all) and, before
    // that, ~45 (the 4 KB tail). A PREFIX is the bug: fix one pre-existing error
    // and the next slides into the window as a false net-new.
    expect(res.findings).toHaveLength(LINES);
    expect(res.results[0].status).toBe('fail');
    expect(res.findings.every((f) => f.file !== undefined)).toBe(true);
  });

  it('a clean command yields no findings (the dogfood case still works)', () => {
    const res = runCustomChecks({
      cwd: process.cwd(),
      specs: [{ ...lintSpec, command: { bin: 'node', args: ['-e', ''] } }],
    });

    expect(res.results[0].status).toBe('pass');
    expect(res.findings).toHaveLength(0);
  });
});

describe('the itemization ceiling never slides (MAX_LOCATED)', () => {
  const P = TS_ESLINT_UNIX_PARSE;
  const emit = (n: number, skip = -1) =>
    Array.from({ length: n }, (_, i) => i)
      .filter((i) => i !== skip)
      .map(
        (i) => `src/f${String(i).padStart(5, '0')}.ts:1:1: Unexpected any. [error/no-explicit-any]`,
      )
      .join('\n');

  it('fixing ONE pre-existing finding mints ZERO net-new', () => {
    // The exact regression the old 500-prefix produced: baseline the first 500,
    // fix one, and #501 slid in as "net-new" — blocking a developer for FIXING
    // a lint error.
    const id = (o: string) =>
      new Set(
        parseLocated('lint', false, P, o, '/repo')
          .filter((f) => f.file)
          .map((f) => `${f.file}:${f.rule}`),
      );
    const before = id(emit(600));
    const after = id(emit(600, 2)); // developer fixes finding #3

    const netNew = [...after].filter((x) => !before.has(x));
    expect(before.size).toBe(600); // all itemized, not a 500-prefix
    expect(netNew).toEqual([]);
  });

  it('a pathological run gates as ONE stable binary finding, not a prefix', () => {
    const huge = parseLocated('lint', false, P, emit(50_001), '/repo');
    expect(huge).toHaveLength(1);
    expect(huge[0].file).toBeUndefined(); // binary => identity is the check name
    expect(huge[0].message).toMatch(/above the .* itemization ceiling/);
  });
});
