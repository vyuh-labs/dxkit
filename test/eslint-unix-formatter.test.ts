/**
 * Regression net for the ESLint-v9 lint-gate break found by validating the
 * lint gate against a real repo running a current ESLint (v9/v10).
 *
 * ESLint v9 removed the core `unix` formatter, so `eslint --format unix`
 * printed a warning and emitted nothing parseable — the TS lint gate fell back
 * to a useless binary finding. The `lint-formats` test kept passing because it
 * fed the regex a captured unix SAMPLE string; the real command was the broken
 * part. The fix ships a bundled formatter and points `--format` at it.
 *
 * This test pins the load-bearing contract those two pieces share: the bundled
 * formatter's OUTPUT must be parseable by the SAME regex the gate applies. If
 * either drifts, this fails here instead of silently in a user's guardrail.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { TS_ESLINT_UNIX_PARSE, ESLINT_UNIX_FORMATTER } from '../src/languages/typescript';

describe('bundled eslint-unix formatter ↔ TS_ESLINT_UNIX_PARSE contract', () => {
  it('the formatter path the gate references actually exists', () => {
    expect(ESLINT_UNIX_FORMATTER.endsWith('formatters/eslint-unix.cjs')).toBe(true);
    expect(fs.existsSync(ESLINT_UNIX_FORMATTER)).toBe(true);
  });

  it('formatter output for a real eslint result parses via the gate regex', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const format = require(ESLINT_UNIX_FORMATTER) as (r: unknown[]) => string;
    // Shape of an ESLint result object (filePath + messages[]), as eslint hands
    // a formatter. Absolute filePath under cwd so the formatter relativizes it.
    const results = [
      {
        filePath: `${process.cwd()}/src/a.ts`,
        messages: [
          { severity: 2, line: 2, column: 7, message: "'x' is unused", ruleId: 'no-unused-vars' },
          { severity: 1, line: 5, column: 1, message: 'prefer const', ruleId: 'prefer-const' },
        ],
      },
    ];
    const out = format(results);
    const re = new RegExp(TS_ESLINT_UNIX_PARSE);
    const lines = out.split('\n').filter((l) => l.trim());
    expect(lines).toHaveLength(2);

    const m0 = re.exec(lines[0]);
    expect(m0, `line did not match: ${lines[0]}`).not.toBeNull();
    expect(m0!.groups!.file).toBe('src/a.ts'); // repo-relative, not absolute
    expect(m0!.groups!.line).toBe('2');
    expect(m0!.groups!.rule).toBe('no-unused-vars');

    const m1 = re.exec(lines[1]);
    expect(m1!.groups!.rule).toBe('prefer-const');
  });

  it('emits empty output for a clean run (no messages → no findings)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const format = require(ESLINT_UNIX_FORMATTER) as (r: unknown[]) => string;
    expect(format([{ filePath: '/x/clean.ts', messages: [] }])).toBe('');
  });
});
