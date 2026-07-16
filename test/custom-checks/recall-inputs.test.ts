/**
 * Recall inputs for the custom-check seam (CLAUDE.md Rule 19).
 *
 * The property under test is MACHINE stability, not run stability. A baseline
 * is captured on one machine (a laptop, a refresh job) and compared on another
 * (CI). An input that encodes where something happens to be installed differs
 * between the two, so it reads as drift on every single CI run — and because
 * drift is fail-open, the gate degrades to warn-only forever while looking
 * perfectly healthy. That is the OVER-drift failure: strictly worse than the
 * misattribution Rule 19 fixes, because nothing ever announces it.
 *
 * This shipped in the first cut of Rule 19 and was caught by running the real
 * binary against a real repo, not by a test — on a single machine both sides
 * see the same absolute paths, so the bug is invisible. These cases encode the
 * lesson so it cannot come back.
 */
import { describe, it, expect } from 'vitest';
import { customCheckRecallInputs } from '../../src/analyzers/custom-checks/gather';
import type { BrownfieldPolicy } from '../../src/baseline/policy';

function policyWithCheck(command: string | string[]): BrownfieldPolicy {
  return {
    checks: [{ name: 'probe', command }],
  } as unknown as BrownfieldPolicy;
}

const NO_PACKS = { packs: [], cwd: '/tmp/does-not-exist-recall-fixture' };

describe('customCheckRecallInputs — machine stability', () => {
  it('reduces an absolute bin path to its basename', () => {
    // A pack resolves its linter through findTool, so `bin` is an absolute
    // path into a venv / Homebrew prefix / ~/.cargo/bin — all machine-specific.
    const a = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck(['/home/alice/.venv/bin/ruff', 'check', '.']),
    });
    const b = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck(['/opt/ci/tools/bin/ruff', 'check', '.']),
    });
    expect(a['probe/cmd']).toBe('ruff check .');
    expect(a['probe/cmd']).toBe(b['probe/cmd']);
  });

  it('reduces an absolute path ARGUMENT to its basename', () => {
    // The class case (shipped pre-3.9, when the TS gate passed dxkit's own
    // eslint formatter by absolute path): an argument that resolves under
    // wherever a tool is installed differs per machine.
    const local = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck(
        'npx --no-install eslint . --format /home/me/dxkit-repo/dist/formatters/eslint-unix.cjs',
      ),
    });
    const ci = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck(
        'npx --no-install eslint . --format /build/repo/node_modules/@vyuhlabs/dxkit/dist/formatters/eslint-unix.cjs',
      ),
    });
    expect(local['probe/cmd']).toBe('npx --no-install eslint . --format eslint-unix.cjs');
    expect(local['probe/cmd']).toBe(ci['probe/cmd']);
  });

  it('reduces an absolute path in a --flag=value argument', () => {
    const a = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck('mytool --config=/home/alice/cfg/rules.yml'),
    });
    expect(a['probe/cmd']).toBe('mytool --config=rules.yml');
  });

  it('still discriminates a REAL command change — normalization is not blindness', () => {
    // Dropping the directory must not drop the meaning. Swapping which config
    // a check reads changes what it can see, and must still drift.
    const a = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck('mytool --config /etc/dxkit/strict.yml'),
    });
    const b = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck('mytool --config /etc/dxkit/loose.yml'),
    });
    expect(a['probe/cmd']).not.toBe(b['probe/cmd']);
    expect(a['probe/cmd']).toBe('mytool --config strict.yml');
  });

  it('leaves relative paths and flags alone', () => {
    const a = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck('npm run check:arch -- --strict ./src'),
    });
    expect(a['probe/cmd']).toBe('npm run check:arch -- --strict ./src');
  });
});

describe('customCheckRecallInputs — what determines extraction', () => {
  it('records the parse mode of a binary check', () => {
    const inputs = customCheckRecallInputs({
      ...NO_PACKS,
      policy: policyWithCheck('make lint'),
    });
    expect(inputs['probe/parse']).toBe('exit');
    expect(inputs['probe/exit']).toBe('0');
  });

  it('a changed parse REGEX changes recall — it decides what is extractable', () => {
    // The multi-line react-hooks blindness in one assertion: the pattern is
    // not cosmetic, it is the upper bound on what the check can ever report.
    const loose = customCheckRecallInputs({
      ...NO_PACKS,
      policy: {
        checks: [
          { name: 'probe', command: 'lint', parse: { regex: '(?<file>[^:]+):(?<line>\\d+)' } },
        ],
      } as unknown as BrownfieldPolicy,
    });
    const tight = customCheckRecallInputs({
      ...NO_PACKS,
      policy: {
        checks: [
          {
            name: 'probe',
            command: 'lint',
            parse: { regex: '(?<file>[^:]+):(?<line>\\d+):(?<rule>\\S+)' },
          },
        ],
      } as unknown as BrownfieldPolicy,
    });
    expect(loose['probe/parse']).not.toBe(tight['probe/parse']);
    expect(loose['probe/parse']).toMatch(/^regex:[0-9a-f]{16}$/);
  });

  it('a repo with nothing configured has no check inputs (and pays nothing)', () => {
    const inputs = customCheckRecallInputs({
      ...NO_PACKS,
      policy: {} as unknown as BrownfieldPolicy,
    });
    expect(inputs).toEqual({});
  });
});
