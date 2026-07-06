/**
 * `vyuh-dxkit checks` — the discovery + dry-run surface for the custom-check
 * gate (CLAUDE.md Rule 16). Asserts:
 *   - `checks list --json` resolves the configured user checks (through the ONE
 *     `resolveCustomCheckSpecs` entry point) and surfaces normalizer warnings;
 *   - `checks run --json` executes and reports pass/fail without gating;
 *   - the `recommendChecks` doctor probe fires on a lint signal and goes silent
 *     once the policy opts in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runChecks } from '../src/checks-cli';
import { gatherRecommendations } from '../src/discovery/commands';

const tmps: string[] = [];
function mkRepo(policy?: unknown, extra?: (dir: string) => void): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-checks-'));
  tmps.push(d);
  if (policy !== undefined) {
    fs.mkdirSync(path.join(d, '.dxkit'), { recursive: true });
    fs.writeFileSync(path.join(d, '.dxkit', 'policy.json'), JSON.stringify(policy));
  }
  extra?.(d);
  return d;
}

/** Capture stdout emitted while running `fn`, returning the joined text. */
function captureStdout(fn: () => void): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    lines.push(a.map(String).join(' '));
  });
  try {
    fn();
  } finally {
    spy.mockRestore();
  }
  return lines.join('\n');
}

afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('checks list', () => {
  it('--json resolves configured user checks and reports source/parse/intent', () => {
    const d = mkRepo({
      checks: [
        { name: 'check:seam', command: 'node scripts/seam.js', blocking: true },
        {
          name: 'eslint-strict',
          command: 'npx eslint --format unix src',
          blocking: false,
          parse: { regex: '^(?<file>[^:]+):(?<line>\\d+)' },
        },
      ],
    });
    const out = captureStdout(() => runChecks(d, 'list', { json: true }));
    const parsed = JSON.parse(out) as {
      schema: string;
      checks: Array<{ name: string; source: string; parse: string; blocking: boolean }>;
      warnings: string[];
    };
    expect(parsed.schema).toBe('checks.v1');
    const seam = parsed.checks.find((c) => c.name === 'check:seam');
    expect(seam).toMatchObject({ source: 'user-check', parse: 'exit', blocking: true });
    const eslint = parsed.checks.find((c) => c.name === 'eslint-strict');
    expect(eslint).toMatchObject({ source: 'user-check', parse: 'regex', blocking: false });
  });

  it('surfaces a normalizer warning for a malformed entry (a dropped check is visible)', () => {
    const d = mkRepo({ checks: [{ command: 'x' }] }); // no name → dropped
    const out = captureStdout(() => runChecks(d, 'list', { json: true }));
    const parsed = JSON.parse(out) as { checks: unknown[]; warnings: string[] };
    expect(parsed.checks).toHaveLength(0);
    expect(parsed.warnings.join(' ')).toContain('no `name`');
  });

  it('is a clean no-op when nothing is configured', () => {
    const d = mkRepo();
    const out = captureStdout(() => runChecks(d, 'list', { json: true }));
    const parsed = JSON.parse(out) as { checks: unknown[]; warnings: unknown[] };
    expect(parsed.checks).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });
});

describe('checks run (dry-run)', () => {
  it('executes each check and reports pass/fail, never gating', () => {
    // `node` is guaranteed present (we run under it), so these are deterministic.
    const d = mkRepo({
      checks: [
        { name: 'passes', command: 'node -e process.exit(0)', blocking: true },
        { name: 'fails', command: 'node -e process.exit(1)', blocking: true },
      ],
    });
    const out = captureStdout(() => runChecks(d, 'run', { json: true }));
    const parsed = JSON.parse(out) as {
      schema: string;
      ran: boolean;
      results: Array<{ name: string; status: string; findings: number }>;
    };
    expect(parsed.schema).toBe('checks-run.v1');
    expect(parsed.ran).toBe(true);
    expect(parsed.results.find((r) => r.name === 'passes')?.status).toBe('pass');
    const fails = parsed.results.find((r) => r.name === 'fails');
    expect(fails?.status).toBe('fail');
    expect(fails?.findings).toBe(1);
  });

  it('a missing binary is a fail-open skip, not a failure', () => {
    const d = mkRepo({
      checks: [{ name: 'absent', command: 'definitely-not-a-real-binary-xyz', blocking: true }],
    });
    const out = captureStdout(() => runChecks(d, 'run', { json: true }));
    const parsed = JSON.parse(out) as { results: Array<{ name: string; status: string }> };
    expect(parsed.results.find((r) => r.name === 'absent')?.status).toBe('skipped-unavailable');
  });
});

describe('recommendChecks probe (doctor advisor)', () => {
  it('recommends `checks` on a repo with a lint script but no gate config', () => {
    const d = mkRepo(undefined, (dir) => {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'eslint .' } }),
      );
    });
    expect(gatherRecommendations(d).map((r) => r.id)).toContain('checks');
  });

  it('recommends `checks` on an eslint-config repo', () => {
    const d = mkRepo(undefined, (dir) => {
      fs.writeFileSync(path.join(dir, '.eslintrc.json'), '{}');
    });
    expect(gatherRecommendations(d).map((r) => r.id)).toContain('checks');
  });

  it('goes silent once the lint gate is enabled in policy', () => {
    const d = mkRepo({ lint: { enabled: true } }, (dir) => {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ scripts: { lint: 'eslint .' } }),
      );
    });
    expect(gatherRecommendations(d).map((r) => r.id)).not.toContain('checks');
  });

  it('goes silent once a user check is declared', () => {
    const d = mkRepo({ checks: [{ name: 'x', command: 'true' }] }, (dir) => {
      fs.writeFileSync(path.join(dir, '.eslintrc.json'), '{}');
    });
    expect(gatherRecommendations(d).map((r) => r.id)).not.toContain('checks');
  });

  it('does not fire without a linter signal', () => {
    const d = mkRepo(undefined, (dir) => {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    });
    expect(gatherRecommendations(d).map((r) => r.id)).not.toContain('checks');
  });
});
