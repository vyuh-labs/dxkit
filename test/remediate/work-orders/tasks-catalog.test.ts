/**
 * The task catalog as selectors: selection is DERIVED from the class table
 * (`classesSelectedBy`), never stored on the task, so every bounded task
 * selects at least one class, the bounded tasks cover every class with no
 * overlap, and open-ended tasks (completion shape) select nothing.
 */
import { describe, it, expect } from 'vitest';
import { REMEDIATE_TASKS, customDispatchTask } from '../../../src/remediate/tasks';
import { WORK_ORDER_CLASSES, classesSelectedBy } from '../../../src/remediate/work-orders/types';

describe('remediate tasks select work-order classes', () => {
  for (const task of REMEDIATE_TASKS) {
    it(`'${task.id}' is a selector (bounded) or open-ended by completion shape`, () => {
      if (task.completion === 'open-ended') {
        expect(classesSelectedBy(task.id)).toEqual([]);
      } else {
        expect(classesSelectedBy(task.id).length).toBeGreaterThan(0);
      }
    });
  }

  it('every class names a real bounded task, and the bounded tasks cover every class with no overlap', () => {
    const bounded = REMEDIATE_TASKS.filter((t) => t.completion === 'bounded').map((t) => t.id);
    for (const [, d] of Object.entries(WORK_ORDER_CLASSES)) expect(bounded).toContain(d.task);
    const all = REMEDIATE_TASKS.flatMap((t) => classesSelectedBy(t.id));
    expect(new Set(all).size).toBe(all.length);
    expect([...new Set(all)].sort()).toEqual(Object.keys(WORK_ORDER_CLASSES).sort());
  });

  it('the custom dispatch task is open-ended and selects nothing', () => {
    const custom = customDispatchTask('do a thing');
    expect(custom.completion).toBe('open-ended');
    expect(classesSelectedBy(custom.id)).toEqual([]);
  });
});
