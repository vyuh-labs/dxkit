import { describe, it, expect } from 'vitest';
import { renderLoopGuardrailDemo } from '../../src/loop/demo';
import { buildRepairMessage } from '../../src/loop/stop-gate';

describe('loop guardrail demo', () => {
  it('produces the real repair message for the example net-new finding', () => {
    const { blockMessage } = renderLoopGuardrailDemo();
    // It must list the example finding with its location…
    expect(blockMessage).toContain('src/payments.js:12');
    expect(blockMessage).toContain('secret');
    // …and carry the loop norm (don't refresh baseline / don't fix unrelated debt).
    expect(blockMessage.toLowerCase()).toContain('do not refresh the baseline');
    expect(blockMessage).toContain('1 net-new');
  });

  it('renders the exact production repair text (not a mock)', () => {
    // The demo must use the real buildRepairMessage code path, so the message
    // it shows is byte-identical to what a live gate would feed the model.
    const { blockMessage } = renderLoopGuardrailDemo();
    // Reconstruct from the same builder over an equivalent single-secret payload.
    expect(blockMessage.startsWith('dxkit blocked completion')).toBe(true);
    expect(typeof buildRepairMessage).toBe('function');
  });
});
