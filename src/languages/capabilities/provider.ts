/**
 * Capability provider contract.
 *
 * Anything that can produce a capability result implements this — language
 * packs (`LanguageSupport.capabilities.depVulns`, …) and global gatherers
 * (`gitleaks`, `semgrep`, …) alike. Returning `null` means "this provider
 * has nothing to contribute for this cwd" (e.g. the Python pack on a
 * Go-only repo); the dispatcher filters nulls before aggregating.
 */

import type { CapabilityEnvelope } from './types';

/**
 * Outcome of a side-effecting `runTests()` invocation (D021).
 *
 * Discriminated so the CLI can render per-pack status (success/skip/fail)
 * AND so the report orchestrator can decide whether downstream consumers
 * (health, test-gaps) will find a usable coverage artifact afterwards.
 *
 *   - `success`     — the test runner exited cleanly AND the expected
 *                     coverage artifact is on disk. `artifact` is the
 *                     relative path so the CLI summary can name it.
 *   - `unavailable` — the pack can't run tests in this repo (test runner
 *                     missing, project config absent, no `.cov` setup).
 *                     `reason` is the human-readable explanation. Not a
 *                     failure — the user just doesn't have the prereqs.
 *   - `failed`      — the test runner ran but exited non-zero (tests
 *                     failed) OR exited zero but produced no artifact.
 *                     `reason` carries the exit message; `durationMs`
 *                     records wall-clock so the CLI can surface the
 *                     "tests ran for 8 min then failed" framing.
 */
export type RunTestsOutcome =
  | { kind: 'success'; artifact: string; durationMs: number }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'failed'; reason: string; durationMs: number };

export interface CapabilityProvider<T extends CapabilityEnvelope> {
  /** Source name for attribution in logs and errors (usually the language id). */
  readonly source: string;
  gather(cwd: string): Promise<T | null>;
  /**
   * Optional side-effecting hook that materializes the artifact this
   * provider's `gather()` later reads. Only meaningful on coverage
   * providers today (D021's `vyuh-dxkit coverage` subcommand iterates
   * every active pack's coverage capability and calls `runTests()` if
   * defined). Other capabilities can adopt the same shape if a similar
   * "run the upstream tool to produce input" need arises.
   *
   * Implementations should be idempotent: re-invoking on an already-
   * populated repo should produce the same outcome (rerunning the test
   * suite is fine; the upstream tool typically truncates+rewrites its
   * output file).
   */
  runTests?(cwd: string): Promise<RunTestsOutcome>;
}
