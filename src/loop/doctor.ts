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
import { loopGateActive } from './gate-cache';
import { dxkitCli, resolveDxkitCli } from '../self-invocation';
import { addDevCommand, detectPackageManager } from '../package-manager';
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
 * The registered Stop-gate hook command, or null if none. Reads
 * `.claude/settings.json` defensively (absent / malformed → null) and returns
 * the first Stop hook command that invokes `hook stop-gate`. This is the check
 * that catches the silent-failure class: a loop with no registered Stop hook
 * runs with no gate at all.
 */
function stopHookCommand(cwd: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      hooks?: { Stop?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    for (const entry of parsed.hooks?.Stop ?? []) {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command === 'string' && /hook\s+stop-gate/.test(h.command)) return h.command;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Does the registered Stop hook command actually resolve here? Handles both
 * forms: the customer npx/binary form (the `vyuh-dxkit` binary must resolve),
 * and a local-build / monorepo `node <path>.js` form (the script must exist) —
 * the latter is how this repo dogfoods its own gate, mirroring the
 * self-guardrail CI.
 */
function stopHookResolves(cwd: string, command: string): { ok: boolean; how: string } {
  const nodeMatch = command.match(/\bnode\s+(\S+\.(?:js|mjs|cjs))\b/);
  if (nodeMatch) {
    const rel = nodeMatch[1];
    const target = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    return fs.existsSync(target)
      ? { ok: true, how: `local script ${rel}` }
      : { ok: false, how: `${rel} not found (build it first)` };
  }
  const res = resolveDxkitCli(cwd);
  return {
    ok: res.ok,
    how: res.ok
      ? res.how === 'local'
        ? 'project-local node_modules/.bin'
        : 'global install'
      : 'not installed',
  };
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
  const hookCmd = stopHookCommand(cwd);
  const hook = !!hookCmd;
  checks.push({
    label: 'Stop-gate hook registered',
    status: hook ? 'pass' : 'fail',
    detail: hook
      ? `.claude/settings.json invokes the gate on Stop (\`${hookCmd}\`)`
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
  if (hookCmd) {
    const res = stopHookResolves(cwd, hookCmd);
    checks.push({
      label: 'Stop-gate hook resolvable',
      status: res.ok ? 'pass' : 'fail',
      detail: res.ok
        ? `the hook command resolves (${res.how}) — it can run`
        : `the hook command does not resolve (${res.how}) — it would fail on every Stop`,
      ...(res.ok
        ? {}
        : {
            fix: {
              hint: 'Make the Stop hook runnable: install dxkit as a devDependency, or build the local dist if the hook runs `node dist/...`.',
              command: addDevCommand(detectPackageManager(cwd), '@vyuhlabs/dxkit'),
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

  // 4b. Loop-scoped activation — informational. The Stop-gate no-ops on
  // interactive turns and runs only for unattended loops, so an operator
  // should not assume an interactive session is gated. It auto-activates when
  // Claude Code reports `permission_mode=bypassPermissions` (a headless run),
  // or when forced via `DXKIT_LOOP_ACTIVE=1` / a `.dxkit/loop/active` sentinel.
  const forcedActive = loopGateActive(cwd);
  checks.push({
    label: 'gate activation: loop-scoped',
    status: 'pass',
    detail: forcedActive
      ? `forced active here (${
          process.env.DXKIT_LOOP_ACTIVE === '1'
            ? 'DXKIT_LOOP_ACTIVE=1'
            : '.dxkit/loop/active sentinel'
        }); unattended runs also auto-activate via permission_mode=bypassPermissions`
      : 'interactive turns no-op; unattended runs auto-activate (permission_mode=bypassPermissions). For a hard guarantee, set DXKIT_LOOP_ACTIVE=1 or touch .dxkit/loop/active',
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
