/**
 * Capability dispatcher — the typed channel analyzers use to request a
 * capability (lint, depVulns, coverage, …) by descriptor. The dispatcher
 * runs every registered provider concurrently, filters nulls and
 * rejections, and aggregates the survivors using the descriptor's
 * bespoke aggregator.
 *
 * Caching is in-memory and per-dispatcher-instance: the same `(cwd, capId)`
 * request inside one analyzer run reuses the same Promise, so two reports
 * (e.g. `health` + `vulnerabilities`) sharing a process don't double-shell
 * out to `pip-audit`. Process exit clears the cache; persistent caching
 * is out of scope.
 *
 * Provider failures are isolated: one provider throwing does not abort the
 * dispatch. The thrown error is logged via the optional `onProviderError`
 * hook and that provider's contribution is dropped from the aggregate.
 */

import type { CapabilityProvider } from '../languages/capabilities/provider';
import type { CapabilityDescriptor } from '../languages/capabilities/descriptors';
import type { CapabilityEnvelope } from '../languages/capabilities/types';

export interface DispatcherOptions {
  /** Called once per provider that throws or rejects. Default: silent. */
  onProviderError?(capId: string, source: string, err: unknown): void;
}

export class CapabilityDispatcher {
  private readonly cache = new Map<string, Promise<CapabilityEnvelope | null>>();
  private readonly opts: DispatcherOptions;

  constructor(opts: DispatcherOptions = {}) {
    this.opts = opts;
  }

  async gather<T extends CapabilityEnvelope>(
    cwd: string,
    cap: CapabilityDescriptor<T>,
    providers: ReadonlyArray<CapabilityProvider<T>>,
  ): Promise<T | null> {
    const cacheKey = `${cwd}::${cap.id}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached as Promise<T | null>;

    const promise = this.run(cwd, cap, providers);
    this.cache.set(cacheKey, promise as Promise<CapabilityEnvelope | null>);
    return promise;
  }

  /** Test seam — drop the in-memory cache between runs. */
  clearCache(): void {
    this.cache.clear();
  }

  private async run<T extends CapabilityEnvelope>(
    cwd: string,
    cap: CapabilityDescriptor<T>,
    providers: ReadonlyArray<CapabilityProvider<T>>,
  ): Promise<T | null> {
    if (providers.length === 0) return null;

    const settled = await Promise.allSettled(providers.map((p) => p.gather(cwd)));
    const successful: T[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'rejected') {
        this.opts.onProviderError?.(cap.id, providers[i].source, r.reason);
        continue;
      }
      if (r.value !== null) successful.push(r.value);
    }
    if (successful.length === 0) return null;
    return cap.aggregate(successful);
  }
}

/** Process-wide singleton. Tests should construct their own instance. */
export const defaultDispatcher = new CapabilityDispatcher();
