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
import { describeTrustSkip, type AnalysisTrustContext } from '../../analysis-trust';
import {
  classifyEnvironmentFailure,
  currentEnvironment,
  describeUnmetRequirement,
  unmetRequirement,
  type ExecutionEnvironment,
} from '../../execution';
import { binaryFinding, parseLocated, parseStructuredLocated } from './parse';
import type {
  CustomCheckFinding,
  CustomCheckResult,
  CustomCheckSpec,
  CustomChecksRunResult,
} from './types';

export interface RunCustomChecksOptions {
  readonly cwd: string;
  /** REQUIRED (4.2): whose tree is this? A check command is repo-declared
   *  executable content — spawning it against untrusted content (a fork PR)
   *  executes whatever that tree put in reach. With
   *  `trust.repoExecutionAllowed` false every spec is a disclosed
   *  `skipped-untrusted`, decided before any spawn. Required so an omission
   *  is a compile error, never a silent default to trusted (the class that
   *  shipped for plugins and, unpinned, for this exact sink). */
  readonly trust: AnalysisTrustContext;
  /** Normalized checks to run (user policy + pack lint, already merged). */
  readonly specs: readonly CustomCheckSpec[];
  /** Per-command wall-clock budget (ms). A command that exceeds it is a
   *  fail-OPEN skip, never a block. Undefined → no timeout. Ignored when `exec`
   *  is injected. */
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to real PATH resolution + execFileSync. */
  readonly exec?: CommandExec;
  /** Injected for tests; defaults to the real local host + toolchain probes. */
  readonly env?: ExecutionEnvironment;
}

/**
 * Run every configured check. Never throws — a missing binary / timeout is a
 * `skipped-*` status (fail-open), a non-expected exit is a `fail` with findings.
 */
export function runCustomChecks(opts: RunCustomChecksOptions): CustomChecksRunResult {
  const exec = opts.exec ?? makeCommandExec(opts.timeoutMs);
  const env = opts.env ?? currentEnvironment();
  const results: CustomCheckResult[] = [];
  const findings: CustomCheckFinding[] = [];

  for (const spec of opts.specs) {
    // Trust tier FIRST (4.2): untrusted content never spawns a repo-declared
    // command — decided before every other boundary, disclosed per spec.
    if (!opts.trust.repoExecutionAllowed) {
      results.push({
        name: spec.name,
        status: 'skipped-untrusted',
        findings: [],
        reason: describeTrustSkip(`check '${spec.name}'`),
      });
      continue;
    }
    // Rule 20: a check with a declared execution requirement is checked
    // against the environment BEFORE spawning — an unrunnable command must
    // not execute just to fail in a way the parser reads as a finding (the
    // half-provisioned-SDK class), and the skip is disclosed, never silent.
    if (spec.execution) {
      const unmet = unmetRequirement(spec.execution, env);
      if (unmet !== null) {
        results.push({
          name: spec.name,
          status: 'skipped-environment',
          findings: [],
          reason: describeUnmetRequirement(unmet, env.host),
        });
        continue;
      }
    }
    // A declared check whose tool is unresolvable (the pack's lintCommand
    // returned null) is disclosed, never spawned and never silent — the user
    // enabled this gate in policy and deserves to know why it isn't gating
    // (VERIFY-40 F-9). After the env check: a wrong host is the more
    // fundamental boundary and its remedy supersedes "install the linter".
    if (spec.unavailable) {
      results.push({
        name: spec.name,
        status: 'skipped-unavailable',
        findings: [],
        reason: spec.unavailable,
      });
      continue;
    }
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

    // Post-failure tier of the F-14 fix: a failed check whose output is
    // ENVIRONMENT-shaped (the registry-declared signatures of the toolchains
    // this check runs on — SDK resolution, toolchain-too-old) is a disclosed
    // boundary, never a binary FINDING that would enter the baseline as if
    // the repo were broken. Only declaration-carrying (pack lint) checks
    // participate; the classifier defaults to null, so a real linter error
    // stays a failure.
    if (!passedExit && spec.execution) {
      const envFailure = classifyEnvironmentFailure(spec.execution.toolchains, outcome.output);
      if (envFailure !== null) {
        results.push({
          name: spec.name,
          status: 'skipped-environment',
          findings: [],
          reason: describeUnmetRequirement(
            { kind: 'unhealthy-toolchain', ...envFailure },
            env.host,
          ),
        });
        continue;
      }
    }

    let checkFindings: CustomCheckFinding[];
    if (spec.parse.mode === 'exit') {
      // Binary check: the exit code IS the signal. Finding iff it failed.
      // `tail` here is DISPLAY: the message is human-facing, never hashed (Rule 9).
      checkFindings = passedExit
        ? []
        : [binaryFinding(spec.name, spec.blocking, tail(outcome.output))];
    } else {
      // Located check: parse ALWAYS (many linters exit 0 with findings — C#/Java
      // build analyzers, eslint warnings). "Clean" = zero matches, not exit 0.
      // Parses the COMPLETE output — the parse boundary owns the finding cap,
      // and it discloses when it bites.
      const located =
        spec.parse.mode === 'regex'
          ? parseLocated(spec.name, spec.blocking, spec.parse.pattern, outcome.output, opts.cwd)
          : parseStructuredLocated(
              spec.name,
              spec.blocking,
              spec.parse.parse,
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
