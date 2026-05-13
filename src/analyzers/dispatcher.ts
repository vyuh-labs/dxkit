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

/**
 * D080 (2.4.7): when a multi-pack capability has providers that
 * return null silently (tool unavailable on the customer's machine),
 * the rendered tool label hides which packs were attempted.
 * gatherWithProvenance exposes both the aggregated envelope AND the
 * per-provider {ran, skipped} split so consumers can surface
 * "lint ran: ruff; not run: eslint (not installed)" instead of just
 * "lint ran: ruff."
 */
export interface DispatchOutcome<T extends CapabilityEnvelope> {
  envelope: T | null;
  /** All provider sources we ATTEMPTED to run (one per provider passed in). */
  attempted: string[];
  /** Sources that returned a non-null envelope. Subset of `attempted`. */
  succeeded: string[];
  /** Sources that returned null (tool absent, no config, etc.). */
  skipped: string[];
}

export class CapabilityDispatcher {
  private readonly cache = new Map<string, Promise<DispatchOutcome<CapabilityEnvelope>>>();
  private readonly opts: DispatcherOptions;

  constructor(opts: DispatcherOptions = {}) {
    this.opts = opts;
  }

  async gather<T extends CapabilityEnvelope>(
    cwd: string,
    cap: CapabilityDescriptor<T>,
    providers: ReadonlyArray<CapabilityProvider<T>>,
  ): Promise<T | null> {
    return (await this.gatherWithProvenance(cwd, cap, providers)).envelope;
  }

  /**
   * Same gather + cache semantics as `gather()`, plus per-provider
   * provenance (which sources we attempted, which returned null).
   * D080 (2.4.7): consumed by quality/health report renderers so the
   * "Tool" label honestly reflects which providers were attempted even
   * when one returned null silently.
   */
  async gatherWithProvenance<T extends CapabilityEnvelope>(
    cwd: string,
    cap: CapabilityDescriptor<T>,
    providers: ReadonlyArray<CapabilityProvider<T>>,
  ): Promise<DispatchOutcome<T>> {
    const cacheKey = `${cwd}::${cap.id}`;
    const cached = this.cache.get(cacheKey) as
      | Promise<DispatchOutcome<CapabilityEnvelope>>
      | undefined;
    if (cached) return cached as Promise<DispatchOutcome<T>>;

    const promise = this.run(cwd, cap, providers);
    this.cache.set(cacheKey, promise as Promise<DispatchOutcome<CapabilityEnvelope>>);
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
  ): Promise<DispatchOutcome<T>> {
    if (providers.length === 0) {
      return { envelope: null, attempted: [], succeeded: [], skipped: [] };
    }

    const attempted = providers.map((p) => p.source);
    const settled = await Promise.allSettled(providers.map((p) => p.gather(cwd)));
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const successful: T[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const source = providers[i].source;
      if (r.status === 'rejected') {
        this.opts.onProviderError?.(cap.id, source, r.reason);
        skipped.push(source);
        continue;
      }
      if (r.value !== null) {
        successful.push(r.value);
        succeeded.push(source);
      } else {
        skipped.push(source);
      }
    }
    const envelope = successful.length === 0 ? null : cap.aggregate(successful);
    return { envelope, attempted, succeeded, skipped };
  }
}

/** Process-wide singleton. Tests should construct their own instance. */
export const defaultDispatcher = new CapabilityDispatcher();
