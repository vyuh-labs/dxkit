import { describe, expect, it, vi } from 'vitest';
import { CapabilityDispatcher } from '../src/analyzers/dispatcher';
import { withDeadline } from '../src/analyzers/tools/deadline';
import { DEP_VULNS } from '../src/languages/capabilities/descriptors';
import type { CapabilityProvider } from '../src/languages/capabilities/provider';
import type { DepVulnResult } from '../src/languages/capabilities/types';

/**
 * Belt-and-suspenders regression test for the per-provider deadline.
 * Mirrors the production scenario that caused a silent rc=0 with no
 * report written: a capability provider's gather Promise never
 * settles, the dispatcher's `Promise.allSettled` would otherwise stay
 * pending forever, Node's event loop empties, the subprocess exits
 * cleanly. With the deadline in place, the stalled provider is
 * materialised as a skip with a deadline reason and the dispatch
 * completes normally.
 */

const okSample = (tool: string): DepVulnResult => ({
  schemaVersion: 1,
  tool,
  enrichment: null,
  counts: { critical: 0, high: 0, medium: 1, low: 0 },
});

function hangingProvider(source: string): CapabilityProvider<DepVulnResult> {
  return {
    source,
    gather: () => new Promise<DepVulnResult | null>(() => {}),
  };
}

function settlingProvider(
  source: string,
  result: DepVulnResult | null,
): CapabilityProvider<DepVulnResult> {
  return { source, gather: async () => result };
}

describe('withDeadline', () => {
  it('resolves with the inner value when the Promise settles in time', async () => {
    const out = await withDeadline(Promise.resolve(42), 50);
    expect(out).toEqual({ stalled: false, value: 42 });
  });

  it('reports stalled when the Promise never settles within the deadline', async () => {
    const never = new Promise<number>(() => {});
    const out = await withDeadline(never, 20);
    expect(out.stalled).toBe(true);
    if (out.stalled) {
      expect(out.stalledMs).toBe(20);
    }
  });

  it('propagates inner rejections untouched', async () => {
    const rejecting = Promise.reject(new Error('boom'));
    await expect(withDeadline(rejecting, 50)).rejects.toThrow('boom');
  });
});

describe('CapabilityDispatcher per-provider deadline', () => {
  it('returns a non-null aggregate when one provider hangs and another succeeds', async () => {
    const onStall = vi.fn();
    const d = new CapabilityDispatcher({ providerDeadlineMs: 30, onProviderStall: onStall });
    const outcome = await d.gatherWithProvenance('/cwd', DEP_VULNS, [
      hangingProvider('hung-pack'),
      settlingProvider('good-pack', okSample('npm-audit')),
    ]);
    expect(outcome.envelope?.counts.medium).toBe(1);
    expect(outcome.succeeded).toEqual(['good-pack']);
    expect(outcome.skipped).toEqual(['hung-pack']);
    expect(outcome.skipReasons['hung-pack']).toMatch(/^stalled at >\d+s \(deadline\)$/);
    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall).toHaveBeenCalledWith('depVulns', 'hung-pack', 30);
  });

  it('returns a null envelope with a deadline reason when every provider hangs', async () => {
    const onStall = vi.fn();
    const d = new CapabilityDispatcher({ providerDeadlineMs: 25, onProviderStall: onStall });
    const outcome = await d.gatherWithProvenance('/cwd', DEP_VULNS, [
      hangingProvider('a'),
      hangingProvider('b'),
    ]);
    expect(outcome.envelope).toBeNull();
    expect(outcome.succeeded).toEqual([]);
    expect(outcome.skipped.sort()).toEqual(['a', 'b']);
    expect(outcome.skipReasons['a']).toMatch(/^stalled at >\d+s \(deadline\)$/);
    expect(outcome.skipReasons['b']).toMatch(/^stalled at >\d+s \(deadline\)$/);
    expect(onStall).toHaveBeenCalledTimes(2);
  });

  it('completes within the deadline window when every provider hangs', async () => {
    const d = new CapabilityDispatcher({
      providerDeadlineMs: 40,
      onProviderStall: () => {},
    });
    const t0 = Date.now();
    await d.gather('/cwd', DEP_VULNS, [
      hangingProvider('a'),
      hangingProvider('b'),
      hangingProvider('c'),
    ]);
    const elapsed = Date.now() - t0;
    // Generous bounds on both sides — node's setTimeout granularity
    // (~1-2ms) + WSL2 / CI runner scheduling jitter make tight bounds
    // flaky. The point is the dispatch DOES wait for the deadline
    // rather than returning immediately (would be <5ms) AND it returns
    // rather than hanging forever (would be minutes). The deadline is
    // 40ms; fast runners can fire setTimeout at 38-39ms, so the lower
    // bound is 25ms — well clear of "no waiting" while tolerating
    // timer-granularity variance.
    expect(elapsed).toBeGreaterThanOrEqual(25);
    expect(elapsed).toBeLessThan(2000);
  });

  it('does not stall providers that throw — rejections still propagate to the error hook', async () => {
    const onError = vi.fn();
    const onStall = vi.fn();
    const d = new CapabilityDispatcher({
      providerDeadlineMs: 200,
      onProviderError: onError,
      onProviderStall: onStall,
    });
    const throwing: CapabilityProvider<DepVulnResult> = {
      source: 'throws',
      gather: async () => {
        throw new Error('nope');
      },
    };
    const outcome = await d.gatherWithProvenance('/cwd', DEP_VULNS, [
      throwing,
      settlingProvider('good-pack', okSample('npm-audit')),
    ]);
    expect(outcome.envelope?.counts.medium).toBe(1);
    expect(outcome.skipped).toEqual(['throws']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onStall).not.toHaveBeenCalled();
  });
});
