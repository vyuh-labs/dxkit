/**
 * The guardrail entry point (`dxkit-guardrails.sh`) — the ONE check sequence
 * a developer, an agent, the git hooks and the CI pipeline all run.
 *
 * The class this closes (Rule 2.30, the lexical-duplicate variant at the
 * generated-artifact level): the pre-push hook and the guardrails workflow
 * each carried their own copy of the sequence, in a different ORDER (hook:
 * floor → parity → guardrail; workflow: guardrail → parity → floor) with
 * their own binary resolution and exit handling, so a change could pass
 * locally and fail in the pipeline for reasons inside the repo.
 *
 * Nets:
 *   1. Parity: the hooks and the workflow (template AND rendered) call the
 *      script and carry no CLI check invocation of their own; the script
 *      holds each check in one function, run in the pipeline's order.
 *   2. Behaviour: the script, EXECUTED against a stub dxkit, runs the checks
 *      in order, aggregates exit codes, stops early only in the hook tiers,
 *      keeps the no-baseline path, the non-default-base and cold-cache
 *      fallbacks, and assembles the PR-comment report.
 *   3. The hooks and the workflow's own step, EXECUTED, reach the script with
 *      their tier / plumbing (delete-only skip and DXKIT_SKIP_HOOKS kept).
 *   4. The installer: render, ownership, refresh.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

import { installCiGuardrails, installGuardrailEntryPoint } from '../src/ship-installers';
import {
  GUARDRAIL_ENTRY_POINT,
  GUARDRAIL_ENTRY_POINT_MARKER,
  guardrailEntryPointWanted,
} from '../src/self-invocation';
import { MANAGED_SHIP_SURFACES, managedGatedArtifacts } from '../src/managed-artifacts';
import type { ManifestInstallFlags } from '../src/types';

const SRC_TEMPLATES = path.join(__dirname, '..', 'src-templates');
const SCRIPT_TEMPLATE = fs.readFileSync(path.join(SRC_TEMPLATES, GUARDRAIL_ENTRY_POINT), 'utf8');
const PRE_PUSH = fs.readFileSync(path.join(SRC_TEMPLATES, '.githooks', 'pre-push'), 'utf8');
const PRE_COMMIT = fs.readFileSync(path.join(SRC_TEMPLATES, '.githooks', 'pre-commit'), 'utf8');
const WORKFLOW = fs.readFileSync(
  path.join(SRC_TEMPLATES, '.github', 'workflows', 'dxkit-guardrails.yml'),
  'utf8',
);

/** The three checks, as the CLI invocations that define them. */
const CHECK_INVOCATIONS = ['guardrail check', 'policy render --check', 'floor check'];

/** Executable lines only: comments and echoed messages are prose and may
 *  name a check or the CLI. */
function code(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo\b/.test(l))
    .join('\n');
}

/** The body of a shell function `name() { … }` (up to the next column-0 `}`). */
function fnBody(text: string, name: string): string {
  const start = text.indexOf(`${name}() {`);
  expect(start, `${name}() is defined`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf('\n}\n', start));
}

const POSIX = process.platform !== 'win32';

describe('one sequence: the hooks and the workflow call the script, never a copy', () => {
  it('the script holds each check in one function, run in the order guardrail → parity → floor', () => {
    const body = code(SCRIPT_TEMPLATE);
    const owners = ['check_guardrail', 'check_parity', 'check_floor'];
    CHECK_INVOCATIONS.forEach((inv, i) => {
      // Every invocation of a check (one per tier at most) sits in its own
      // function, so a tier changes flags, never the sequence.
      const total = body.split(inv).length - 1;
      expect(total, `${inv} is invoked`).toBeGreaterThan(0);
      expect(fnBody(body, owners[i]).split(inv).length - 1, `${inv} only in ${owners[i]}`).toBe(
        total,
      );
    });
    // …and the three run in that order from main().
    const main = body.slice(body.indexOf('main() {'));
    const calls = ['check_guardrail', 'check_parity', 'check_floor'].map((c) => main.indexOf(c));
    expect(calls.every((i) => i > 0)).toBe(true);
    expect(calls).toEqual([...calls].sort((a, b) => a - b));
  });

  it('the script owns dxkit binary resolution; the hooks no longer resolve it', () => {
    expect(SCRIPT_TEMPLATE).toContain('./node_modules/.bin/vyuh-dxkit');
    for (const hook of [PRE_PUSH, PRE_COMMIT]) {
      expect(code(hook)).not.toContain('vyuh-dxkit');
    }
  });

  it.each([
    ['pre-push', PRE_PUSH, '--quick'],
    ['pre-commit', PRE_COMMIT, '--changed-only'],
  ])('the %s hook calls the script with its tier and no check of its own', (_n, hook, tier) => {
    expect(hook).toContain(`exec sh ./${GUARDRAIL_ENTRY_POINT} ${tier}`);
    for (const inv of CHECK_INVOCATIONS) expect(code(hook)).not.toContain(inv);
  });

  it('the workflow (template and rendered) calls the script and runs no check itself', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ep-wf-'));
    try {
      installCiGuardrails(dir);
      const rendered = fs.readFileSync(
        path.join(dir, '.github', 'workflows', 'dxkit-guardrails.yml'),
        'utf8',
      );
      for (const wf of [WORKFLOW, rendered]) {
        expect(wf).toContain(`sh ./${GUARDRAIL_ENTRY_POINT} --report guardrail-report.md`);
        for (const inv of CHECK_INVOCATIONS) expect(code(wf)).not.toContain(inv);
        // The per-step exit capture + aggregation moved into the script.
        expect(wf).not.toContain('Fail if guardrail blocked');
        expect(wf).not.toContain('exit_code=');
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A throwaway repo root with the rendered script and a stub dxkit that logs
 *  each invocation and exits with a per-check code from the environment. */
function stubRepo(): { dir: string; log: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ep-run-'));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(
    path.join(dir, GUARDRAIL_ENTRY_POINT),
    SCRIPT_TEMPLATE.split('__DXKIT_DEFAULT_BRANCH__').join("'main'"),
  );
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  const stub = path.join(dir, 'node_modules', '.bin', 'vyuh-dxkit');
  fs.writeFileSync(
    stub,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "floor check")
    want=""
    for a in "$@"; do
      if [ -n "$want" ]; then printf '\\nFLOOR-DISCLOSURE\\n' >> "$a"; want=""; fi
      [ "$a" = "--report-md" ] && want=1
    done
    exit "\${STUB_FLOOR:-0}" ;;
  "policy render") echo "PARITY-DIFF"; exit "\${STUB_PARITY:-0}" ;;
  "policy get") echo "\${STUB_ANCHOR:-tree}"; exit 0 ;;
  "guardrail check") echo "GUARDRAIL-VERDICT"; exit "\${STUB_GUARDRAIL:-0}" ;;
esac
exit 0
`,
  );
  fs.chmodSync(stub, 0o755);
  fs.mkdirSync(path.join(dir, '.dxkit', 'baselines'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.dxkit', 'baselines', 'main.json'), '{}');
  return { dir, log };
}

function run(
  dir: string,
  args: string[],
  env: Record<string, string> = {},
): { status: number | null; out: string } {
  const r = spawnSync('sh', [path.join(dir, GUARDRAIL_ENTRY_POINT), ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: os.tmpdir(),
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function calls(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe.skipIf(!POSIX)('the script, executed', () => {
  let dir: string;
  let log: string;
  beforeEach(() => ({ dir, log } = stubRepo()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('no arguments = the pipeline tier: full guardrail, parity, full floor, in order', () => {
    const r = run(dir, []);
    expect(r.status).toBe(0);
    expect(calls(log)).toEqual([
      'guardrail check --name main',
      'policy render --check',
      'floor check --surface ci',
    ]);
  });

  it('the full tier runs every check after a failure and exits with the FIRST failure', () => {
    const r = run(dir, [], { STUB_GUARDRAIL: '3', STUB_FLOOR: '1' });
    expect(r.status).toBe(3);
    expect(calls(log).map((c) => c.split(' ').slice(0, 2).join(' '))).toEqual([
      'guardrail check',
      'policy render',
      'floor check',
    ]);
    expect(r.out).toMatch(/findings guardrail\s+FAILED \(exit 3\)/);
    expect(r.out).toMatch(/correctness floor\s+FAILED \(exit 1\)/);
  });

  it('a failure anywhere fails the run (no check is advisory)', () => {
    expect(run(dir, [], { STUB_PARITY: '1' }).status).toBe(1);
    expect(run(dir, [], { STUB_FLOOR: '1' }).status).toBe(1);
  });

  it('--quick: incremental guardrail, parity, affected floor; stops at the first failure and says so', () => {
    expect(run(dir, ['--quick']).status).toBe(0);
    expect(calls(log)).toEqual([
      'guardrail check --name main --incremental',
      'policy render --check',
      'floor check --surface pre-push',
    ]);
    fs.writeFileSync(log, '');
    const r = run(dir, ['--quick'], { STUB_GUARDRAIL: '1' });
    expect(r.status).toBe(1);
    expect(calls(log)).toEqual(['guardrail check --name main --incremental']);
    expect(r.out).toMatch(/correctness floor\s+did not run: the findings guardrail failed first/);
  });

  it('--changed-only: the guardrail on changed lines only', () => {
    expect(run(dir, ['--changed-only']).status).toBe(0);
    expect(calls(log)).toEqual(['guardrail check --name main --changed-only']);
  });

  it('the no-baseline path: the hook tiers skip the guardrail, not blocking, and say so', () => {
    fs.rmSync(path.join(dir, '.dxkit', 'baselines', 'main.json'));
    for (const tier of ['--quick', '--changed-only']) {
      fs.writeFileSync(log, '');
      const r = run(dir, [tier]);
      expect(r.status).toBe(0);
      expect(calls(log).some((c) => c.startsWith('guardrail check'))).toBe(false);
      expect(r.out).toContain('No baseline at .dxkit/baselines/main.json');
    }
    // …and a brand-new repo still gets push-time liveness: the floor runs.
    expect(run(dir, ['--quick'], { STUB_FLOOR: '1' }).status).toBe(1);
    expect(calls(log)).toContain('floor check --surface pre-push');
  });

  it('DXKIT_BASELINE_NAME selects the baseline in every tier', () => {
    fs.writeFileSync(path.join(dir, '.dxkit', 'baselines', 'release.json'), '{}');
    run(dir, ['--quick'], { DXKIT_BASELINE_NAME: 'release' });
    expect(calls(log)).toContain('guardrail check --name release --incremental');
  });

  it('pipeline plumbing: a non-default base gates ref-based against it; --untrusted reaches the guardrail', () => {
    run(dir, ['--base', 'develop', '--untrusted']);
    expect(calls(log)).toEqual([
      'guardrail check --name main --mode ref-based --ref origin/develop --untrusted',
      'policy render --check',
      'floor check --surface ci --base origin/develop',
    ]);
  });

  it('a base is the literal branch name GitHub passes (a branch may itself start with origin/)', () => {
    run(dir, ['--base', 'origin/release']);
    expect(calls(log)).toContain('floor check --surface ci --base origin/origin/release');
  });

  it('a default branch with shell metacharacters stays a literal', () => {
    // Rendered by the installer as a single-quoted literal; `$X` must not expand.
    const script = path.join(dir, GUARDRAIL_ENTRY_POINT);
    fs.writeFileSync(script, SCRIPT_TEMPLATE.split('__DXKIT_DEFAULT_BRANCH__').join("'rel$X'"));
    run(dir, ['--base', 'rel$X'], { X: 'oops' });
    expect(calls(log)).toContain('guardrail check --name main');
  });

  it('a PR into the default branch gates against the committed baseline', () => {
    run(dir, ['--base', 'main']);
    expect(calls(log)).toContain('guardrail check --name main');
  });

  it('cache transport with no anchor here falls back to ref-based at the base', () => {
    fs.rmSync(path.join(dir, '.dxkit', 'baselines', 'main.json'));
    run(dir, [], { STUB_ANCHOR: 'cache' });
    expect(calls(log)).toContain('guardrail check --name main --mode ref-based --ref origin/main');
    // tree transport, no anchor: no silent fallback — the guardrail reports it.
    fs.writeFileSync(log, '');
    run(dir, [], { STUB_ANCHOR: 'tree' });
    expect(calls(log)).toContain('guardrail check --name main');
  });

  it('cache transport: the fallback reads the SELECTED baseline, not any baseline file', () => {
    // Another baseline in the directory must not suppress the fallback when
    // the one this run gates against is missing.
    fs.renameSync(
      path.join(dir, '.dxkit', 'baselines', 'main.json'),
      path.join(dir, '.dxkit', 'baselines', 'other.json'),
    );
    run(dir, [], { STUB_ANCHOR: 'cache' });
    expect(calls(log)).toContain('guardrail check --name main --mode ref-based --ref origin/main');
  });

  it('--report: the PR comment leads with the guardrail verdict, then drift, then the floor', () => {
    const report = path.join(dir, 'guardrail-report.md');
    const r = run(dir, ['--report', 'guardrail-report.md'], {
      STUB_PARITY: '1',
      STUB_FLOOR: '1',
    });
    expect(r.status).toBe(1);
    const md = fs.readFileSync(report, 'utf8');
    const order = ['GUARDRAIL-VERDICT', '### Policy drift', 'PARITY-DIFF', 'FLOOR-DISCLOSURE'].map(
      (s) => md.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(calls(log)).toContain('guardrail check --name main --markdown');
  });

  it('under Actions: annotations, a blocked report printed to the log, and a step summary', () => {
    const summary = path.join(dir, 'summary.md');
    fs.writeFileSync(summary, '');
    const r = run(dir, ['--report', 'r.md'], {
      GITHUB_ACTIONS: 'true',
      GITHUB_STEP_SUMMARY: summary,
      STUB_GUARDRAIL: '1',
    });
    expect(r.out).toContain('::group::dxkit guardrail BLOCKED');
    expect(r.out).toContain('GUARDRAIL-VERDICT');
    expect(r.out).toContain('::error::dxkit guardrail blocked');
    expect(fs.readFileSync(summary, 'utf8')).toMatch(
      /\| findings guardrail \| FAILED \(exit 1\) \|/,
    );
  });

  it('a report that cannot be written fails the run, even when every check passed', () => {
    const r = run(dir, ['--report', path.join(dir, 'missing-dir', 'r.md')]);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('could not write the report');
  });

  it('no resolvable dxkit: exit 1 and NO report, so the PR comment says the gate did not run', () => {
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
    const r = run(dir, ['--report', 'r.md'], { PATH: '/usr/bin:/bin' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('vyuh-dxkit not found');
    expect(fs.existsSync(path.join(dir, 'r.md'))).toBe(false);
  });

  it('a usage error exits 2 before running anything', () => {
    expect(run(dir, ['--quick', '--changed-only']).status).toBe(2);
    expect(run(dir, ['--bogus']).status).toBe(2);
    expect(calls(log)).toEqual([]);
  });
});

describe.skipIf(!POSIX)('the hooks and the workflow step, executed, reach the script', () => {
  let dir: string;
  let log: string;
  beforeEach(() => ({ dir, log } = stubRepo()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function hook(name: string, stdin: string, env: Record<string, string> = {}) {
    const file = path.join(dir, `${name}.hook`);
    fs.writeFileSync(file, name === 'pre-push' ? PRE_PUSH : PRE_COMMIT);
    return spawnSync('sh', [file], {
      cwd: dir,
      input: stdin,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', TMPDIR: os.tmpdir(), ...env },
    });
  }
  const PUSH_LINE = `refs/heads/x ${'a'.repeat(40)} refs/heads/x ${'0'.repeat(40)}\n`;
  const DELETE_LINE = `(delete) ${'0'.repeat(40)} refs/heads/x ${'b'.repeat(40)}\n`;

  it('pre-push runs the quick tier', () => {
    expect(hook('pre-push', PUSH_LINE).status).toBe(0);
    expect(calls(log)).toEqual([
      'guardrail check --name main --incremental',
      'policy render --check',
      'floor check --surface pre-push',
    ]);
  });

  it('pre-push propagates a failing check as a blocked push', () => {
    expect(hook('pre-push', PUSH_LINE, { STUB_GUARDRAIL: '1' }).status).toBe(1);
  });

  it('pre-push keeps the delete-only skip and DXKIT_SKIP_HOOKS', () => {
    expect(hook('pre-push', DELETE_LINE).status).toBe(0);
    expect(hook('pre-push', PUSH_LINE, { DXKIT_SKIP_HOOKS: '1' }).status).toBe(0);
    expect(calls(log)).toEqual([]);
  });

  it('pre-commit runs the changed-only tier', () => {
    expect(hook('pre-commit', '').status).toBe(0);
    expect(calls(log)).toEqual(['guardrail check --name main --changed-only']);
  });

  it('a missing script blocks with the remedy rather than silently passing', () => {
    fs.rmSync(path.join(dir, GUARDRAIL_ENTRY_POINT));
    const r = hook('pre-push', PUSH_LINE);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('vyuh-dxkit update');
  });

  it("a file at that path that is not dxkit's is refused, never run in the checks' place", () => {
    fs.writeFileSync(path.join(dir, GUARDRAIL_ENTRY_POINT), '#!/bin/sh\nexit 0\n');
    for (const name of ['pre-push', 'pre-commit']) {
      const r = hook(name, PUSH_LINE);
      expect(r.status, name).toBe(1);
      expect(r.stderr).toContain("is not dxkit's");
    }
  });

  it("the workflow's own step hands the script the PR plumbing", () => {
    // The RENDERED workflow (the template carries install-time placeholders).
    installCiGuardrails(dir);
    const rendered = fs.readFileSync(
      path.join(dir, '.github', 'workflows', 'dxkit-guardrails.yml'),
      'utf8',
    );
    const wf = yaml.load(rendered) as {
      jobs: Record<string, { steps: Array<{ id?: string; run?: string }> }>;
    };
    const step = Object.values(wf.jobs)[0].steps.find((s) => s.id === 'guardrail');
    expect(step?.run).toBeDefined();
    const script = step!.run!.split('${{ steps.trust.outputs.flag }}').join('--untrusted');
    const r = spawnSync('sh', ['-e', '-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', TMPDIR: os.tmpdir(), DXKIT_PR_BASE: 'develop' },
    });
    expect(r.status).toBe(0);
    expect(calls(log)).toEqual([
      'guardrail check --name main --mode ref-based --ref origin/develop --untrusted --markdown',
      'policy render --check',
      expect.stringMatching(/^floor check --surface ci --base origin\/develop --report-md /),
    ]);
    expect(fs.readFileSync(path.join(dir, 'guardrail-report.md'), 'utf8')).toContain(
      'GUARDRAIL-VERDICT',
    );
  });
});

describe('installGuardrailEntryPoint', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-ep-install-'));
    // Pin the default branch the way init does, so the render is deterministic.
    fs.writeFileSync(
      path.join(dir, '.vyuh-dxkit.json'),
      JSON.stringify({ defaultBranch: 'trunk' }),
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dest = () => path.join(dir, GUARDRAIL_ENTRY_POINT);

  it('writes an executable script with the default branch rendered in', () => {
    const r = installGuardrailEntryPoint(dir);
    expect(r.installed).toEqual([GUARDRAIL_ENTRY_POINT]);
    const body = fs.readFileSync(dest(), 'utf8');
    expect(body).toContain("DEFAULT_BRANCH='trunk'");
    expect(body).not.toContain('__DXKIT_DEFAULT_BRANCH__');
    expect(body).toContain(GUARDRAIL_ENTRY_POINT_MARKER);
    if (POSIX) expect(fs.statSync(dest()).mode & 0o111).not.toBe(0);
  });

  it('identical content is a no-op; a stale dxkit-owned script is refreshed', () => {
    installGuardrailEntryPoint(dir);
    expect(installGuardrailEntryPoint(dir).skipped).toEqual([GUARDRAIL_ENTRY_POINT]);
    fs.writeFileSync(dest(), `#!/bin/sh\n# ${GUARDRAIL_ENTRY_POINT_MARKER}\n# STALE\n`);
    expect(installGuardrailEntryPoint(dir).installed).toEqual([GUARDRAIL_ENTRY_POINT]);
    expect(fs.readFileSync(dest(), 'utf8')).not.toContain('STALE');
  });

  it('a user-owned file at the path is never clobbered without --force', () => {
    fs.writeFileSync(dest(), '#!/bin/sh\necho mine\n');
    const r = installGuardrailEntryPoint(dir);
    expect(r.installed).toEqual([]);
    expect(r.notes.join(' ')).toContain('left alone');
    expect(fs.readFileSync(dest(), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    installGuardrailEntryPoint(dir, { force: true });
    expect(fs.readFileSync(dest(), 'utf8')).toContain(GUARDRAIL_ENTRY_POINT_MARKER);
  });
});

describe('lifecycle registration', () => {
  const OFF = {
    withHooks: false,
    withCiGuardrails: false,
  } as unknown as ManifestInstallFlags;

  it('is a managed ship surface present exactly when a caller (hooks or CI) is', () => {
    expect(MANAGED_SHIP_SURFACES.some((s) => s.id === 'guardrail-entry-point')).toBe(true);
    expect(managedGatedArtifacts(OFF)).not.toContain(GUARDRAIL_ENTRY_POINT);
    expect(managedGatedArtifacts({ ...OFF, withHooks: true })).toContain(GUARDRAIL_ENTRY_POINT);
    expect(managedGatedArtifacts({ ...OFF, withCiGuardrails: true })).toContain(
      GUARDRAIL_ENTRY_POINT,
    );
  });

  it('the one predicate gates both registries', () => {
    expect(guardrailEntryPointWanted({})).toBe(false);
    expect(guardrailEntryPointWanted({ gitHooks: true })).toBe(true);
    expect(guardrailEntryPointWanted({ ciGuardrails: true })).toBe(true);
  });
});
