/**
 * `vyuh-dxkit loop doctor` — preflight for an autonomous coding loop.
 *
 * The Stop-gate only protects a loop if three things are true before the
 * loop starts: there is a baseline to diff against, the gate is actually
 * wired into Claude Code (a registered Stop hook), and the guardrail can
 * run. If any is missing the loop runs UNPROTECTED — and silently, because
 * an unregistered hook never fires. This command makes that failure mode
 * visible up front instead of after an unattended run shipped debt.
 *
 * It mirrors the structured shape of `src/doctor.ts` (label + ok + fix)
 * so `dxkit-loop` / `dxkit-fix` can drive repairs conversationally, but it
 * is loop-scoped: every check here is a precondition for safe unattended
 * looping, not general install health.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { resolveBaselineMode } from '../baseline/modes';
import { resolveLoopPreset } from './policy';
import { LEDGER_FILE } from './ledger';
import { dxkitCli, resolveDxkitCli } from '../self-invocation';
import * as logger from '../logger';

/** Severity of one preflight check. `fail` = the loop is unsafe to run
 *  unattended; `warn` = a degraded-but-usable condition; `pass` = good. */
export type LoopCheckStatus = 'pass' | 'fail' | 'warn';

export interface LoopCheck {
  readonly label: string;
  readonly status: LoopCheckStatus;
  /** One-line detail shown under the label. */
  readonly detail: string;
  /** Repair metadata — present when status !== 'pass' and a fix is known. */
  readonly fix?: {
    readonly hint: string;
    readonly command?: string;
    readonly skill?: string;
  };
}

export interface LoopDoctorReport {
  readonly schema: 'loop-doctor.v1';
  readonly generatedAt: string;
  readonly cwd: string;
  /** Active loop posture (`security-only` / `full-debt`). */
  readonly preset: string;
  readonly checks: ReadonlyArray<LoopCheck>;
  /** True when no check failed (warnings allowed). The loop is safe to
   *  run unattended only when this is true. */
  readonly ok: boolean;
}

function isGitRepo(cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

function refResolves(cwd: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Does `.claude/settings.json` register the Stop-gate hook? Reads the
 * file defensively (absent / malformed → not registered) and looks for a
 * Stop hook whose command invokes `hook stop-gate`. This is the check
 * that catches the silent-failure class: a loop with no registered Stop
 * hook runs with no gate at all.
 */
function stopHookRegistered(cwd: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const stop = parsed.hooks?.Stop ?? [];
    return stop.some((entry) =>
      (entry.hooks ?? []).some(
        (h) => typeof h.command === 'string' && /hook\s+stop-gate/.test(h.command),
      ),
    );
  } catch {
    return false;
  }
}

/** Build the structured preflight report (pure of process I/O). */
export function buildLoopDoctorReport(cwd: string): LoopDoctorReport {
  const checks: LoopCheck[] = [];
  const preset = resolveLoopPreset(cwd);

  // 1. Git repo — the gate diffs the working tree against a baseline.
  const git = isGitRepo(cwd);
  checks.push({
    label: 'git repository',
    status: git ? 'pass' : 'fail',
    detail: git ? 'inside a git work tree' : 'not a git repository',
    ...(git
      ? {}
      : { fix: { hint: 'Run the loop from inside a git repository.', command: 'git init' } }),
  });

  // 2. Baseline present / resolvable. Without a prior side the gate
  // fail-closes (block-operator) on every Stop — the loop can never
  // cleanly finish. Ref-based modes need a resolvable ref, not a file.
  const mode = resolveBaselineMode({ cwd });
  if (mode.mode === 'ref-based') {
    const ref = mode.ref ?? 'origin/main';
    const ok = !git ? false : refResolves(cwd, ref);
    checks.push({
      label: `baseline (ref-based: ${ref})`,
      status: ok ? 'pass' : 'fail',
      detail: ok ? 'comparison ref resolves' : `comparison ref ${ref} does not resolve`,
      ...(ok
        ? {}
        : {
            fix: {
              hint: `Fetch the comparison ref so the gate can recompute the prior side, or pin a reachable ref in .dxkit/policy.json.`,
              command: `git fetch origin`,
              skill: 'dxkit-config',
            },
          }),
    });
  } else {
    const baselinePath = path.join(cwd, '.dxkit', 'baselines', 'main.json');
    const ok = fs.existsSync(baselinePath);
    checks.push({
      label: `baseline (.dxkit/baselines/main.json, mode: ${mode.mode})`,
      status: ok ? 'pass' : 'fail',
      detail: ok ? 'committed baseline present' : 'no committed baseline',
      ...(ok
        ? {}
        : {
            fix: {
              hint: 'Capture the current state as the loop baseline; existing debt is locked in, only net-new findings block.',
              command: dxkitCli('baseline create'),
              skill: 'dxkit-init',
            },
          }),
    });
  }

  // 3. Stop hook registered. The safety guarantee is entirely contingent
  // on this — an unregistered hook never fires, so the loop runs with no
  // gate and no error.
  const hook = stopHookRegistered(cwd);
  checks.push({
    label: 'Stop-gate hook registered',
    status: hook ? 'pass' : 'fail',
    detail: hook
      ? '.claude/settings.json invokes `vyuh-dxkit hook stop-gate` on Stop'
      : 'no Stop hook invoking the gate — the loop would run UNPROTECTED',
    ...(hook
      ? {}
      : {
          fix: {
            hint: 'Register the Stop-gate hook in .claude/settings.json (additive — your existing hooks are preserved).',
            command: dxkitCli('init --claude-loop'),
            skill: 'dxkit-loop',
          },
        }),
  });

  // 3b. Stop hook RESOLVABLE. The registered hook invokes the dxkit CLI;
  // verify it actually resolves here. A registered-but-unresolvable hook
  // 404s on every Stop — the failure mode of a pure-npx install whose
  // devDependency was never provisioned (or a non-Node repo with no global
  // dxkit). Only meaningful once a hook is registered; if it isn't, the
  // check above already fails.
  if (hook) {
    const res = resolveDxkitCli(cwd);
    checks.push({
      label: 'Stop-gate hook resolvable',
      status: res.ok ? 'pass' : 'fail',
      detail: res.ok
        ? `\`vyuh-dxkit\` resolves (${
            res.how === 'local' ? 'project-local node_modules/.bin' : 'global install'
          }) — the hook can run`
        : '`vyuh-dxkit` does not resolve — the Stop hook would fail on every Stop (dxkit is not installed here)',
      ...(res.ok
        ? {}
        : {
            fix: {
              hint: 'Install dxkit so the Stop hook can run. The blessed path installs it as a devDependency; then `npm install` provisions it.',
              command: 'npm install --save-dev @vyuhlabs/dxkit',
              skill: 'dxkit-loop',
            },
          }),
    });
  }

  // 4. Active preset — informational. Surfaces the posture so an operator
  // knows what the loop will block on before trusting it unattended.
  checks.push({
    label: `loop preset: ${preset}`,
    status: 'pass',
    detail:
      preset === 'security-only'
        ? 'blocks net-new secrets + crit/high security + reachable dep-vulns; test-gap + quality warn only'
        : 'blocks every net-new finding incl. test-gap + quality (can drive open-ended repair)',
  });

  // 5. Postflight test command — optional. When unset the gate skips the
  // post-pass test run; that is a real reduction in coverage, so warn.
  const testCmd = process.env.DXKIT_LOOP_TEST_COMMAND;
  checks.push({
    label: 'postflight test command',
    status: testCmd && testCmd.trim() ? 'pass' : 'warn',
    detail:
      testCmd && testCmd.trim()
        ? `DXKIT_LOOP_TEST_COMMAND set (${testCmd.trim().slice(0, 60)})`
        : 'DXKIT_LOOP_TEST_COMMAND unset — the gate will not run tests after the guardrail passes',
    ...(testCmd && testCmd.trim()
      ? {}
      : {
          fix: {
            hint: 'Optionally export DXKIT_LOOP_TEST_COMMAND so the gate also blocks completion on a failing test suite.',
          },
        }),
  });

  // 6. Graph freshness — only relevant when a graph is present (the
  // feature/orientation surface). Stale is usable (fail-open), so warn.
  const graphPath = path.join(cwd, '.dxkit', 'reports', 'graph.json');
  if (fs.existsSync(graphPath)) {
    const fresh = git ? graphFresh(cwd, graphPath) : true;
    checks.push({
      label: 'code graph freshness',
      status: fresh ? 'pass' : 'warn',
      detail: fresh
        ? 'graph.json is newer than the last commit'
        : 'graph.json predates the last commit — orientation context may be stale',
      ...(fresh
        ? {}
        : {
            fix: {
              hint: 'Regenerate the code graph so orientation context matches current code.',
              command: dxkitCli('explore graph'),
              skill: 'dxkit-feature',
            },
          }),
    });
  }

  const ledgerExists = fs.existsSync(path.join(cwd, LEDGER_FILE));
  checks.push({
    label: 'loop ledger',
    status: 'pass',
    detail: ledgerExists
      ? `audit trail present (${LEDGER_FILE})`
      : 'no ledger yet — created on the first Stop event',
  });

  const ok = !checks.some((c) => c.status === 'fail');
  return {
    schema: 'loop-doctor.v1',
    generatedAt: new Date().toISOString(),
    cwd,
    preset,
    checks,
    ok,
  };
}

/**
 * CLI entry for `vyuh-dxkit loop doctor`. Renders the preflight report
 * (or JSON with `--json`) and exits non-zero when any check failed so it
 * can gate a CI loop-setup step.
 */
export async function runLoopDoctor(cwd: string, opts: { json?: boolean } = {}): Promise<void> {
  const report = buildLoopDoctorReport(cwd);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(report.ok ? 0 : 1);
  }

  logger.header('vyuh-dxkit loop doctor');
  for (const c of report.checks) {
    const line = `${c.label} — ${c.detail}`;
    if (c.status === 'pass') logger.success(line);
    else if (c.status === 'warn') logger.warn(line);
    else logger.fail(line);
    if (c.fix && c.status !== 'pass') {
      logger.dim(`  → ${c.fix.hint}`);
      if (c.fix.command) logger.dim(`    ${c.fix.command}`);
    }
  }
  console.log(''); // slop-ok
  if (report.ok) {
    logger.success('Loop preflight passed — safe to run unattended.');
  } else {
    logger.fail('Loop preflight failed — fix the items above before running unattended.');
  }
  process.exit(report.ok ? 0 : 1);
}

/** Graph is fresh when its mtime is at or after the last commit time. */
function graphFresh(cwd: string, graphPath: string): boolean {
  try {
    const committedAt = execFileSync('git', ['log', '-1', '--format=%ct'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const commitMs = parseInt(committedAt, 10) * 1000;
    if (!Number.isFinite(commitMs)) return true; // can't tell → don't cry wolf
    return fs.statSync(graphPath).mtimeMs >= commitMs;
  } catch {
    return true;
  }
}
