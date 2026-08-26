/**
 * Suite-shared remediate test helpers: the green floor constant and the
 * recording driver stub. Extracted for the e2e proof suite (PR #343
 * review). The older suites (run, orders-phase, dispatch, resume,
 * executor-landing) still carry local variants shaped to their own
 * assertions; consolidating them onto this module is a deliberate
 * follow-up, not done here to keep the release-prep diff reviewable.
 */
import type { CorrectnessFloorResult } from '../../src/analyzers/correctness/run';
import type { AgentDriver, AgentRunResult } from '../../src/remediate/driver';

export const GREEN_FLOOR: CorrectnessFloorResult = { ran: true, blocks: false, checks: [] };

/**
 * A driver that records every run. Without `work` it THROWS on contact,
 * the $0 proof for recipe-only and paused plans; with `work`, it plays the
 * scripted result (and `work` may edit the checkout to simulate the
 * agent's writes).
 */
export function stubDriver(
  work?: (opts: Parameters<AgentDriver['run']>[0]) => Partial<AgentRunResult>,
): { driver: AgentDriver; runs: Parameters<AgentDriver['run']>[0][] } {
  const runs: Parameters<AgentDriver['run']>[0][] = [];
  const driver: AgentDriver = {
    id: 'fake-agent',
    budgetSupport: { turns: 'enforced', cost: 'reported' },
    credentialEnv: [],
    cli: null,
    resolveModel: (tier) => `fake-${tier}`,
    available: () => ({ ok: true }),
    run: async (opts) => {
      runs.push(opts);
      if (!work) throw new Error('the driver must never be invoked on this run ($0 contract)');
      return { completed: true, timedOut: false, transcriptTail: '', ...work(opts) };
    },
  };
  return { driver, runs };
}
