/**
 * The ONE phrasing of a `no-tests` floor check (4.5.0) — a test command that
 * ran and executed ZERO tests. Split from the runner for module size; the
 * runner re-exports it so every surface imports floor rendering from one
 * place. Never a pass, never a failure: every surface that summarizes a
 * floor names these lines.
 */
import type { CorrectnessScope } from '../../languages/capabilities/correctness';
import type { CorrectnessFloorResult } from './run';

/**
 * The ONE phrasing of a `no-tests` check, scope-aware: at `affected` scope
 * the selection for this change matched zero tests (the repo may well have
 * tests); at `full` scope the test command itself found none. Neither is a
 * pass. Every surface that names a no-tests check routes through here.
 */
export function describeNoTestsCheck(
  c: { readonly pack: string; readonly label: string },
  scope: CorrectnessScope | undefined,
): string {
  return scope === 'affected'
    ? `${c.pack} ${c.label}: no tests ran for this change (the affected selection matched zero tests; not a pass, the full suite in CI is the backstop)`
    : `${c.pack} ${c.label}: no tests ran (the test command found zero tests; not a pass)`;
}

/** Every `no-tests` disclosure in a floor result, one line per check
 *  (empty when none). Rendered beside `describeEnvironmentSkips` by every
 *  surface that summarizes a floor run. */
export function describeNoTestsRan(result: CorrectnessFloorResult): string[] {
  return result.checks
    .filter((c) => c.status === 'no-tests')
    .map((c) => describeNoTestsCheck(c, result.scope));
}

/** True when a floor result carries at least one `no-tests` check. */
export function hasNoTests(result: CorrectnessFloorResult): boolean {
  return result.checks.some((c) => c.status === 'no-tests');
}
