import { describe, it, expect } from 'vitest';
import { runConfiguredLoop, type ConfiguredLoopOps, type TaskRun } from '../../src/remediate/cli';
import type { RemediateResult } from '../../src/remediate/run';

/**
 * The configured-lane sequencing policy (pass-2 X-1): tasks share one tree,
 * so isolation is explicit and truthful. These tests pin the three laws —
 * a landed task's tree resets so the NEXT task's PR carries only its own
 * diff; unlanded work STOPS the loop with the remaining tasks disclosed
 * (never destroyed, never stacked into the next PR); and a failed reset is
 * a stop, not a shrug.
 */

function taskRun(partial: Partial<TaskRun> & { outcome: RemediateResult['outcome'] }): TaskRun {
  return {
    result: { outcome: partial.outcome, ledger: '' } as RemediateResult,
    landed: partial.landed ?? false,
    clean: partial.clean ?? false,
    ...(partial.landRefused ? { landRefused: partial.landRefused } : {}),
  };
}

interface Script {
  readonly run: TaskRun;
  /** Head AFTER this task executes (simulates commits landing in the tree). */
  readonly headAfter: string;
}

function ops(
  scripts: Record<string, Script>,
  opts: { resetFails?: boolean } = {},
): ConfiguredLoopOps & { resets: string[]; executed: string[] } {
  let head = 'initial';
  const state = {
    resets: [] as string[],
    executed: [] as string[],
    execute: async (taskId: string) => {
      state.executed.push(taskId);
      head = scripts[taskId].headAfter;
      return scripts[taskId].run;
    },
    head: () => head,
    resetTo: (h: string) => {
      if (opts.resetFails) return false;
      state.resets.push(h);
      head = h;
      return true;
    },
    report: () => {},
  };
  return state;
}

describe('runConfiguredLoop', () => {
  it('resets after a LANDED task so the next task starts from the initial head', async () => {
    const o = ops({
      'fix-vulns': {
        run: taskRun({ outcome: 'verified', landed: true, clean: true }),
        headAfter: 'a1',
      },
      'fix-lint': {
        run: taskRun({ outcome: 'verified', landed: true, clean: true }),
        headAfter: 'b2',
      },
    });
    const r = await runConfiguredLoop(['fix-vulns', 'fix-lint'], o);
    expect(o.executed).toEqual(['fix-vulns', 'fix-lint']);
    expect(o.resets).toEqual(['initial', 'initial']);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toBe(false);
  });

  it('stops on unlanded work in the tree and DISCLOSES the remaining tasks', async () => {
    const o = ops({
      'fix-build': { run: taskRun({ outcome: 'floor-red' }), headAfter: 'polluted' },
      'fix-vulns': {
        run: taskRun({ outcome: 'verified', landed: true, clean: true }),
        headAfter: 'x',
      },
      'fix-lint': {
        run: taskRun({ outcome: 'verified', landed: true, clean: true }),
        headAfter: 'y',
      },
    });
    const r = await runConfiguredLoop(['fix-build', 'fix-vulns', 'fix-lint'], o);
    expect(o.executed).toEqual(['fix-build']); // nothing runs on a polluted tree
    expect(o.resets).toEqual([]); // inspection work is never destroyed
    expect(r.skipped).toEqual(['fix-vulns', 'fix-lint']);
    expect(r.failed).toBe(true);
  });

  it('a refused landing (verified work, wrong branch) also stops the loop', async () => {
    const o = ops({
      'fix-vulns': {
        run: taskRun({ outcome: 'verified', landRefused: 'wrong branch' }),
        headAfter: 'work-in-tree',
      },
      'fix-lint': {
        run: taskRun({ outcome: 'verified', landed: true, clean: true }),
        headAfter: 'z',
      },
    });
    const r = await runConfiguredLoop(['fix-vulns', 'fix-lint'], o);
    expect(r.skipped).toEqual(['fix-lint']);
  });

  it('a task that moved nothing (no-op, refused, never-ran) continues the loop', async () => {
    const o = ops({
      'fix-build': { run: taskRun({ outcome: 'no-op', clean: true }), headAfter: 'initial' },
      'fix-lint': { run: taskRun({ outcome: 'agent-never-ran' }), headAfter: 'initial' },
      'fix-vulns': {
        run: taskRun({ outcome: 'verified', landed: true, clean: true }),
        headAfter: 'w',
      },
    });
    const r = await runConfiguredLoop(['fix-build', 'fix-lint', 'fix-vulns'], o);
    expect(o.executed).toEqual(['fix-build', 'fix-lint', 'fix-vulns']);
    expect(r.skipped).toEqual([]);
    expect(r.failed).toBe(true); // never-ran keeps the truthful failure
  });

  it('a FAILED reset stops the loop rather than running on a polluted tree', async () => {
    const o = ops(
      {
        'fix-vulns': {
          run: taskRun({ outcome: 'verified', landed: true, clean: true }),
          headAfter: 'a1',
        },
        'fix-lint': {
          run: taskRun({ outcome: 'verified', landed: true, clean: true }),
          headAfter: 'b2',
        },
      },
      { resetFails: true },
    );
    const r = await runConfiguredLoop(['fix-vulns', 'fix-lint'], o);
    expect(o.executed).toEqual(['fix-vulns']);
    expect(r.skipped).toEqual(['fix-lint']);
    expect(r.failed).toBe(true);
  });
});
