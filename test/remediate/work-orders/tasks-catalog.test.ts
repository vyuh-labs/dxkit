/**
 * The task catalog as selectors: every bounded task selects at least one
 * registered work-order class; open-ended tasks select nothing and say so.
 */
import { describe, it, expect } from 'vitest';
import { REMEDIATE_TASKS, customDispatchTask } from '../../../src/remediate/tasks';
import { WORK_ORDER_CLASSES } from '../../../src/remediate/work-orders/types';

describe('remediate tasks select work-order classes', () => {
  for (const task of REMEDIATE_TASKS) {
    it(`'${task.id}' is a selector (bounded) or declared open-ended`, () => {
      if (task.openEnded) {
        expect(task.selects).toEqual([]);
        expect(task.completion).toBe('open-ended');
      } else {
        expect(task.selects.length).toBeGreaterThan(0);
        for (const c of task.selects) expect(Object.keys(WORK_ORDER_CLASSES)).toContain(c);
      }
    });
  }

  it('the three bounded tasks cover every built-in class between them, with no overlap', () => {
    const bounded = REMEDIATE_TASKS.filter((t) => !t.openEnded);
    const all = bounded.flatMap((t) => [...t.selects]);
    expect(new Set(all).size).toBe(all.length);
    expect([...new Set(all)].sort()).toEqual(Object.keys(WORK_ORDER_CLASSES).sort());
  });

  it('the custom dispatch task is open-ended and selects nothing', () => {
    const custom = customDispatchTask('do a thing');
    expect(custom.openEnded).toBe(true);
    expect(custom.selects).toEqual([]);
  });
});
