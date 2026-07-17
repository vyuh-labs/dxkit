/**
 * `vyuh-dxkit checks [list|run] [path]` — the discovery + dry-run surface for
 * the custom-check gate (CLAUDE.md Rule 16).
 *
 * The custom-check seam (user-declared `.dxkit/policy.json:checks` + the
 * pack-declared built-in `lint` gate) is a first-class gate citizen: its
 * failures are fingerprinted, baselined, and gated net-new-only exactly like
 * secrets / SAST / dep-vulns. But because it is opt-in and default-off, a user
 * needs a way to SEE what is configured and what the gate would find WITHOUT
 * running the whole guardrail. That is this command:
 *
 *   - `checks list` (default): the configured checks + active lint gates,
 *     resolved through the ONE `resolveCustomCheckSpecs` entry point the
 *     baseline producer and guardrail use (Rule 2), so what you see here is
 *     exactly what the gate sees. Surfaces normalizer warnings (a dropped
 *     malformed entry) so a silently-ignored check is visible.
 *   - `checks run`: a DRY-RUN — actually executes each check and reports
 *     pass/fail/skip + findings, but never touches the baseline or blocks.
 *     "What would the gate see right now?" It does NOT decide net-new-ness —
 *     that is the guardrail's job against the baseline.
 *
 * SECURITY: `checks run` executes the repo's OWN committed check commands —
 * same trust boundary as its npm scripts / CI config. dxkit never runs a check
 * from a CLI flag or an untrusted source (the runner enforces this; this
 * command only ever passes it specs resolved from the committed policy + packs).
 */
import * as logger from './logger';
import { loadPolicyFromCwd } from './baseline/policy';
import {
  resolveCustomCheckSpecs,
  gatherCustomCheckFindings,
} from './analyzers/custom-checks/gather';
import { runCustomChecks, describeCustomChecks } from './analyzers/custom-checks/run';
import { normalizeCustomChecks, LINT_CHECK_PREFIX } from './analyzers/custom-checks/config';
import type { CustomCheckSpec } from './analyzers/custom-checks/types';

export type ChecksSubcommand = 'list' | 'run';

export interface ChecksOptions {
  readonly json?: boolean;
}

/** Is this spec a pack-declared built-in lint gate (vs a user-authored check)? */
function isLintSpec(spec: CustomCheckSpec): boolean {
  return spec.name.startsWith(LINT_CHECK_PREFIX);
}

function renderCommand(spec: CustomCheckSpec): string {
  return [spec.command.bin, ...spec.command.args].join(' ');
}

export function runChecks(cwd: string, sub: ChecksSubcommand, opts: ChecksOptions = {}): void {
  const policy = loadPolicyFromCwd(cwd);
  const specs = resolveCustomCheckSpecs({ cwd, policy });
  const { warnings } = normalizeCustomChecks(policy.checks);

  if (sub === 'run') {
    runChecksDryRun(cwd, policy, specs, warnings, opts);
    return;
  }
  listChecks(specs, warnings, opts);
}

/** `checks list` — show the configured checks + active lint gates. */
function listChecks(
  specs: readonly CustomCheckSpec[],
  warnings: readonly string[],
  opts: ChecksOptions,
): void {
  if (opts.json) {
    const payload = {
      schema: 'checks.v1',
      checks: specs.map((s) => ({
        name: s.name,
        source: isLintSpec(s) ? 'built-in-lint' : 'user-check',
        command: renderCommand(s),
        blocking: s.blocking,
        parse: s.parse.mode, // 'exit' (binary) | 'regex' | 'structured' (located)
        expectedExit: s.expectedExit,
      })),
      warnings,
    };
    console.log(JSON.stringify(payload, null, 2)); // slop-ok
    return;
  }

  logger.header('dxkit checks');
  if (specs.length === 0) {
    console.log(''); // slop-ok
    logger.info('No custom checks configured.');
    logger.dim('  Declare repo invariants in .dxkit/policy.json:checks, or enable the built-in');
    logger.dim('  lint gate with .dxkit/policy.json:lint.enabled. The guardrail then blocks');
    logger.dim('  only NET-NEW failures — pre-existing debt is grandfathered.');
    renderWarnings(warnings);
    return;
  }

  const user = specs.filter((s) => !isLintSpec(s));
  const lint = specs.filter(isLintSpec);
  renderGroup('User checks (.dxkit/policy.json:checks)', user);
  renderGroup('Built-in lint gate (.dxkit/policy.json:lint)', lint);
  renderWarnings(warnings);

  console.log(''); // slop-ok
  logger.dim('Run `vyuh-dxkit checks run` to see what the gate would find right now.');
}

function renderGroup(title: string, specs: readonly CustomCheckSpec[]): void {
  if (specs.length === 0) return;
  console.log(''); // slop-ok
  logger.info(title);
  for (const s of specs) {
    if (s.unavailable) {
      // A policy-enabled gate whose linter isn't resolvable here — declared,
      // disclosed, never silent (VERIFY-40 F-9). The sentinel command is an
      // implementation detail, not something a user should see or run.
      logger.dim(`  ${s.name.padEnd(22)} unavailable`);
      logger.dim(`    ↳ ${s.unavailable}`);
      continue;
    }
    const intent = s.blocking ? 'blocking' : 'warn-only';
    const shape = s.parse.mode === 'exit' ? 'binary' : 'located';
    logger.dim(`  ${s.name.padEnd(22)} ${intent} · ${shape}`);
    logger.dim(`    $ ${renderCommand(s)}`);
  }
}

function renderWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  console.log(''); // slop-ok
  logger.warn('Some check entries were skipped:');
  for (const w of warnings) logger.dim(`  • ${w}`);
}

/** `checks run` — execute each check and report; never gates, never baselines. */
function runChecksDryRun(
  cwd: string,
  policy: ReturnType<typeof loadPolicyFromCwd>,
  specs: readonly CustomCheckSpec[],
  warnings: readonly string[],
  opts: ChecksOptions,
): void {
  if (specs.length === 0) {
    // Nothing to run — reuse the list path's "nothing configured" guidance.
    listChecks(specs, warnings, opts);
    return;
  }

  const result = runCustomChecks({ cwd, specs });

  if (opts.json) {
    const payload = {
      schema: 'checks-run.v1',
      ran: result.ran,
      results: result.results.map((r) => ({
        name: r.name,
        status: r.status,
        findings: r.findings.length,
        ...(r.reason ? { reason: r.reason } : {}),
      })),
      findings: result.findings,
      warnings,
    };
    console.log(JSON.stringify(payload, null, 2)); // slop-ok
    return;
  }

  logger.header('dxkit checks run (dry-run — does not gate)');
  console.log(''); // slop-ok
  for (const r of result.results) {
    const line = `  ${r.name.padEnd(22)} ${r.status}${r.findings.length ? ` (${r.findings.length})` : ''}`;
    if (r.status === 'fail') logger.warn(line);
    else logger.dim(line);
    // An environment boundary is always disclosed with its remedy/placement
    // (Rule 20) — a check that cannot run HERE never skips silently.
    if (r.reason) logger.dim(`    ↳ ${r.reason}`);
  }
  console.log(''); // slop-ok
  logger.info(describeCustomChecks(result));
  logger.dim('This is a dry-run. The guardrail blocks only findings that are NET-NEW vs the');
  logger.dim('baseline — a pre-existing failure shown here is grandfathered.');
  renderWarnings(warnings);
}

/**
 * The findings the gate would see, for programmatic callers (doctor / tests).
 * Thin wrapper over the ONE gather entry point so callers never re-resolve.
 */
export function checksFindingCount(cwd: string): number {
  const policy = loadPolicyFromCwd(cwd);
  return gatherCustomCheckFindings({ cwd, policy }).length;
}
