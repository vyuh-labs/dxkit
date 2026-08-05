/**
 * The configured-run SEQUENCING LOOP (X-1) + its git seams — pure policy,
 * injectable, unit-tested without git or an agent. Split from `cli.ts`
 * purely for module size (the plan-cli precedent); `cli.ts` re-exports the
 * loop, so consumers keep one import surface.
 */
import { execFileSync } from 'child_process';
import type { TaskRun } from './cli';

/** The seams the configured loop drives — injectable so the sequencing
 *  POLICY is unit-testable without git or an agent. */
export interface ConfiguredLoopOps {
  execute(taskId: string): Promise<TaskRun>;
  /** Current commit, or null when unreadable. */
  head(): string | null;
  /** Hard-reset the tree to a commit; false on failure. */
  resetTo(head: string): boolean;
  report(taskId: string, run: TaskRun): void;
}

export interface ConfiguredLoopResult {
  readonly runs: ReadonlyArray<{ readonly taskId: string; readonly run: TaskRun }>;
  /** Tasks NOT run because an earlier task left unlanded work in the tree
   *  (or a reset failed) — disclosed, never silent. */
  readonly skipped: readonly string[];
  readonly failed: boolean;
}

/**
 * The sequencing policy of `remediate configured` (X-1): tasks share one
 * tree, so isolation between them is explicit —
 *
 *   - after a LANDED task, the tree resets to the initial head (the work
 *     lives on the pushed standing branch), so the next task's PR carries
 *     ONLY its own diff;
 *   - a task that left UNLANDED work in the tree (floor-red, guardrail-red,
 *     a discarded partial, a refused landing) STOPS the loop: resetting
 *     would destroy the work the ledger promises stays for inspection, and
 *     running the next task on a polluted tree would stack diffs into its
 *     PR. The remaining tasks are named as skipped; the next scheduled run
 *     picks them up on a fresh checkout.
 */
export async function runConfiguredLoop(
  tasks: readonly string[],
  ops: ConfiguredLoopOps,
): Promise<ConfiguredLoopResult> {
  const initialHead = ops.head();
  const runs: Array<{ taskId: string; run: TaskRun }> = [];
  let skipped: string[] = [];
  let failed = false;

  for (let i = 0; i < tasks.length; i++) {
    const taskId = tasks[i];
    const run = await ops.execute(taskId);
    ops.report(taskId, run);
    runs.push({ taskId, run });
    if (!run.clean) failed = true;

    const moved = initialHead !== null && ops.head() !== initialHead;
    if (!moved) continue;

    const remaining = tasks.slice(i + 1);
    if (run.landed) {
      if (ops.resetTo(initialHead!)) continue;
      skipped = remaining; // a failed reset means a polluted tree — stop
      failed = true;
      break;
    }
    skipped = remaining;
    break;
  }
  return { runs, skipped, failed };
}

/** Current commit sha, or null when unreadable. */
export function headCommit(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/** Hard-reset to a commit (used only after a LANDED task — the work is on
 *  the pushed standing branch). False on failure. */
export function resetHardTo(cwd: string, head: string): boolean {
  try {
    execFileSync('git', ['reset', '--hard', head], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}
