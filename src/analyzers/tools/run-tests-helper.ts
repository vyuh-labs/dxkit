/**
 * Shared spawn helper for per-pack `runTests()` implementations (D021).
 *
 * Each language pack's `coverage` capability declares an optional
 * `runTests()` method that materializes the on-disk artifact its
 * `gather()` later reads. The actual mechanics — spawn a shell
 * command, bracket with Date.now() for duration, surface exit code +
 * post-run artifact check, format the `RunTestsOutcome` discriminated
 * union — are identical across packs. This module owns those mechanics
 * so per-pack code stays compact (just "what command + what artifact").
 *
 * Stdio is inherited so the user sees test output stream live —
 * `vyuh-dxkit coverage` is a side-effecting CLI command, the user is
 * watching their test suite run, not consuming JSON.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { RunTestsOutcome } from '../../languages/capabilities/provider';

export interface RunTestsArgs {
  /** Display name for logging — usually the pack id. */
  pack: string;
  /** Shell command to invoke. Run via `/bin/bash -c "<cmd>"`. */
  cmd: string;
  /** Working directory for the spawn. */
  cwd: string;
  /**
   * Relative path to the expected coverage artifact, OR a function that
   * locates it post-run (for tools that pick non-deterministic output
   * paths — e.g. .NET's `TestResults/<guid>/coverage.cobertura.xml`).
   * The function form returns the discovered relative path or `null` if
   * the artifact wasn't produced.
   */
  artifact: string | ((cwd: string) => string | null);
  /** Wall-clock cap. Default 600s (10 min) per the design doc. */
  timeoutMs?: number;
  /**
   * Optional pre-flight check. When defined and returns a non-null
   * reason, `runTests` skips the spawn and returns `unavailable` with
   * that reason. Use this to short-circuit "tool isn't installed" or
   * "project isn't configured" without paying the spawn cost.
   */
  preflight?: (cwd: string) => string | null;
}

/**
 * Spawn a test-with-coverage command, time it, classify the outcome.
 *
 * Outcome rules:
 *   - `preflight` returned a reason → `unavailable`
 *   - spawn signals ENOENT (binary missing)   → `unavailable`
 *   - exit non-zero (test fail / compile err) → `failed`
 *   - exit zero AND artifact present         → `success`
 *   - exit zero BUT artifact missing          → `failed`
 *     (the user ran the right command but it didn't produce coverage —
 *     usually means simplecov / coverage-py / similar isn't actually
 *     wired into the test setup. The hint they need is "your test
 *     run succeeded but produced no coverage report" not "no test
 *     runner found.")
 */
export function runTestsWithCoverage(args: RunTestsArgs): RunTestsOutcome {
  const { pack, cmd, cwd, artifact, timeoutMs = 600_000, preflight } = args;

  if (preflight) {
    const reason = preflight(cwd);
    if (reason) {
      return { kind: 'unavailable', reason };
    }
  }

  const start = Date.now();
  const result = spawnSync('/bin/bash', ['-c', cmd], {
    cwd,
    stdio: 'inherit',
    timeout: timeoutMs,
    // Some test runners parse TTY-ness for colorized output. Inheriting
    // stdio already plumbs TTY status through naturally.
  });
  const durationMs = Date.now() - start;

  // spawn-level failure: usually means /bin/bash is missing, or the
  // command's first token isn't on PATH. We treat these as "unavailable"
  // because they describe an environment problem the user can fix —
  // distinct from "tests ran and failed."
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return {
        kind: 'unavailable',
        reason: `command not found: ${cmd.split(/\s+/)[0]}`,
      };
    }
    return {
      kind: 'failed',
      reason: `spawn error: ${err.message}`,
      durationMs,
    };
  }

  // Test runner returned non-zero. Could be compile failure, test
  // failure, or coverage-config errors. The user already saw the
  // output (inherited stdio); we just record the disposition.
  //
  // Special cases by bash convention: 127 = "command not found",
  // 126 = "found but not executable". These describe an environment
  // problem (a binary is missing from PATH) rather than a test failure,
  // so they get the `unavailable` framing — same as the direct-spawn
  // ENOENT path above. Without this re-mapping, the user sees
  // "test command exited with status 127" which is opaque; routing
  // through `unavailable` surfaces the actual binary name in the
  // CLI table.
  if (typeof result.status === 'number' && result.status !== 0) {
    const firstWord = cmd.trim().split(/\s+/)[0];
    if (result.status === 127) {
      return { kind: 'unavailable', reason: `command not found: ${firstWord}` };
    }
    if (result.status === 126) {
      return { kind: 'unavailable', reason: `command not executable: ${firstWord}` };
    }
    return {
      kind: 'failed',
      reason: `${pack}: test command exited with status ${result.status}`,
      durationMs,
    };
  }

  // Signal-terminated (timeout, SIGKILL, ...).
  if (result.signal) {
    return {
      kind: 'failed',
      reason: `${pack}: test command killed by signal ${result.signal}`,
      durationMs,
    };
  }

  // Locate the artifact. Function form takes precedence over string
  // form so packs with non-deterministic output paths can implement
  // arbitrary discovery logic.
  const artifactPath = typeof artifact === 'function' ? artifact(cwd) : artifact;
  if (!artifactPath || !fs.existsSync(path.join(cwd, artifactPath))) {
    return {
      kind: 'failed',
      reason:
        `${pack}: test command succeeded but no coverage artifact was produced. ` +
        `Expected ${typeof artifact === 'function' ? '<computed at runtime>' : artifact}. ` +
        `If this is a Ruby project, simplecov must be required + started in spec_helper.rb. ` +
        `If TypeScript, the test script may not be passing --coverage to the runner. ` +
        `If Python, ensure pytest --cov is configured.`,
      durationMs,
    };
  }

  return { kind: 'success', artifact: artifactPath, durationMs };
}
