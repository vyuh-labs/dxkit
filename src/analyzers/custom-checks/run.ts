/**
 * The custom-check gate runner — executes each configured check and folds its
 * exit code + output into `CustomCheckFinding`s.
 *
 * It is the exact analog of the correctness-floor runner
 * (`src/analyzers/correctness/run.ts`), and shares the SAME bounded-exec
 * primitive (Rule 2). The difference is downstream, not here: a correctness
 * failure is a bare pass/fail signal (no grandfathering — you can't grandfather
 * a syntax error), whereas a custom-check failure is a FINGERPRINTED finding
 * that flows into the baseline, so a pre-existing failure is grandfathered and
 * only a net-new one gates. This runner just produces the findings; the producer
 * + guardrail decide net-new-ness.
 *
 * Load-bearing policy (mirror of the correctness floor, in one place):
 *   - fail-OPEN on infrastructure: a missing binary or a timeout is a
 *     `skipped-*` status, never a failure — a hook must not block a developer
 *     who hasn't installed a linter locally; CI is the backstop.
 *   - a real non-`expectedExit` exit is a failure → findings.
 *
 * SECURITY: these commands come from the repo's OWN committed `.dxkit/policy.json`
 * (or a pack's built-in lint command), so running them is the same trust
 * boundary as the repo's npm scripts / CI config — dxkit never runs a check from
 * a CLI flag or an untrusted source. Command execution is injected so tests
 * exercise the policy without a real toolchain.
 */

import { makeCommandExec, tail, type CommandExec } from '../tools/bounded-exec';
import { binaryFinding, parseLocated } from './parse';
import type {
  CustomCheckFinding,
  CustomCheckResult,
  CustomCheckSpec,
  CustomChecksRunResult,
} from './types';

export interface RunCustomChecksOptions {
  readonly cwd: string;
  /** Normalized checks to run (user policy + pack lint, already merged). */
  readonly specs: readonly CustomCheckSpec[];
  /** Per-command wall-clock budget (ms). A command that exceeds it is a
   *  fail-OPEN skip, never a block. Undefined → no timeout. Ignored when `exec`
   *  is injected. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to real PATH resolution + execFileSync. */
  readonly exec?: CommandExec;
}

/**
 * Run every configured check. Never throws — a missing binary / timeout is a
 * `skipped-*` status (fail-open), a non-expected exit is a `fail` with findings.
 */
export function runCustomChecks(opts: RunCustomChecksOptions): CustomChecksRunResult {
  const exec = opts.exec ?? makeCommandExec(opts.timeoutMs);
  const results: CustomCheckResult[] = [];
  const findings: CustomCheckFinding[] = [];

  for (const spec of opts.specs) {
    const outcome = exec(spec.command, opts.cwd);
    if (!outcome.available) {
      results.push({ name: spec.name, status: 'skipped-unavailable', findings: [] });
      continue;
    }
    if (outcome.timedOut) {
      results.push({ name: spec.name, status: 'skipped-timeout', findings: [] });
      continue;
    }
    if (outcome.overflowed) {
      // The command outran the capture buffer, so its output is a fragment cut at
      // an arbitrary byte. Parsing it would report a count derived from a slice we
      // cannot measure — and because the baseline producer and the guardrail share
      // this runner, that count would shift between runs and mint false net-new
      // findings. Fail-OPEN: say nothing rather than something unfounded.
      results.push({ name: spec.name, status: 'skipped-overflow', findings: [] });
      continue;
    }

    const passedExit = outcome.code === spec.expectedExit;
    let checkFindings: CustomCheckFinding[];
    if (spec.parse.mode === 'exit') {
      // Binary check: the exit code IS the signal. Finding iff it failed.
      // `tail` here is DISPLAY: the message is human-facing, never hashed (Rule 9).
      checkFindings = passedExit
        ? []
        : [binaryFinding(spec.name, spec.blocking, tail(outcome.output))];
    } else {
      // Regex check: parse ALWAYS (many linters exit 0 with findings — C#/Java
      // build analyzers, eslint warnings). "Clean" = zero matches, not exit 0.
      // Parses the COMPLETE output — `parseLocated` owns the finding cap, and it
      // discloses when it bites.
      const located = parseLocated(
        spec.name,
        spec.blocking,
        spec.parse.pattern,
        outcome.output,
        opts.cwd,
      );
      if (located.length > 0) {
        checkFindings = located;
      } else if (!passedExit) {
        // Failed but parsed nothing — the linter/command errored (bad config,
        // crash). Surface it as a binary finding so the failure isn't lost.
        checkFindings = [binaryFinding(spec.name, spec.blocking, tail(outcome.output))];
      } else {
        checkFindings = [];
      }
    }

    results.push({
      name: spec.name,
      status: checkFindings.length > 0 ? 'fail' : 'pass',
      findings: checkFindings,
    });
    findings.push(...checkFindings);
  }

  const ran = results.some((r) => r.status === 'pass' || r.status === 'fail');
  return { ran, results, findings };
}

/** One-line human summary of a run (for a hook / Stop-gate block message). */
export function describeCustomChecks(result: CustomChecksRunResult): string {
  const failed = result.results.filter((r) => r.status === 'fail');
  if (failed.length === 0) return 'custom checks: all passed';
  const which = failed.map((r) => `${r.name} (${r.findings.length})`).join(', ');
  return `custom checks: ${failed.length} failed — ${which}`;
}
