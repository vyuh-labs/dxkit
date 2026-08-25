/**
 * The task catalog as selectors: `selects` is a READ of the class table, so
 * every bounded task selects at least one class, the bounded tasks cover
 * every class with no overlap, and open-ended tasks select nothing.
 */
import { describe, it, expect } from 'vitest';
import { REMEDIATE_TASKS, customDispatchTask } from '../../../src/remediate/tasks';
import { WORK_ORDER_CLASSES, classesSelectedBy } from '../../../src/remediate/work-orders/types';

describe('remediate tasks select work-order classes', () => {
  for (const task of REMEDIATE_TASKS) {
    it(`'${task.id}' is a selector (bounded) or declared open-ended`, () => {
      if (task.openEnded) {
        expect(task.selects).toEqual([]);
        expect(task.completion).toBe('open-ended');
      } else {
        expect(task.selects.length).toBeGreaterThan(0);
        expect([...task.selects]).toEqual(classesSelectedBy(task.id));
      }
    });
  }

  it('every class names a real bounded task, and the bounded tasks cover every class with no overlap', () => {
    const bounded = REMEDIATE_TASKS.filter((t) => !t.openEnded).map((t) => t.id);
    for (const [, d] of Object.entries(WORK_ORDER_CLASSES)) expect(bounded).toContain(d.task);
    const all = REMEDIATE_TASKS.flatMap((t) => [...t.selects]);
    expect(new Set(all).size).toBe(all.length);
    expect([...new Set(all)].sort()).toEqual(Object.keys(WORK_ORDER_CLASSES).sort());
  });

  it('the custom dispatch task is open-ended and selects nothing', () => {
    const custom = customDispatchTask('do a thing');
    expect(custom.openEnded).toBe(true);
    expect(custom.selects).toEqual([]);
  });
});
