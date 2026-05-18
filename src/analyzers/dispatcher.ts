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
import { DEFAULT_PROVIDER_DEADLINE_MS, withDeadline } from './tools/deadline';

export interface DispatcherOptions {
  /** Called once per provider that throws or rejects. Default: silent. */
  onProviderError?(capId: string, source: string, err: unknown): void;
  /**
   * Called once per provider whose Promise never settles within the
   * deadline. Default: warns on stderr. Tests pass a stub to capture
   * stalls without polluting test output.
   */
  onProviderStall?(capId: string, source: string, stalledMs: number): void;
  /**
   * Per-provider deadline. Stalled providers are treated as if they
   * had returned `null` with a "stalled at >Ns (deadline)" reason —
   * the rest of the dispatch still completes via `Promise.allSettled`,
   * and the stall surfaces in `toolsUnavailable` via the existing
   * `availabilityFromOutcome` machinery. Default:
   * `DEFAULT_PROVIDER_DEADLINE_MS` (12 minutes).
   */
  providerDeadlineMs?: number;
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
  /**
   * Per-source reasons for skipping, when the provider exposes a
   * `gatherOutcome` method (the same channel `DepVulnsProvider`,
   * `LicensesProvider`, and `LintProvider` use to surface
   * unavailability reasons). Empty record when no provider supplied
   * a reason — legacy `gather()`-only providers don't propagate
   * "why" through this boundary, so their skip entries land in
   * `skipped` without an entry here. Consumers should treat absent
   * keys as "reason unknown" and render accordingly.
   */
  skipReasons: Record<string, string>;
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
      return {
        envelope: null,
        attempted: [],
        succeeded: [],
        skipped: [],
        skipReasons: {},
      };
    }

    const attempted = providers.map((p) => p.source);
    // Each provider's gather pathway: prefer the discriminant-returning
    // `gatherOutcome` (Lint / DepVulns / Licenses providers) when it
    // exists, since it carries the "unavailable reason" the user-
    // facing report wants. Fall back to plain `gather()` for legacy
    // providers — the only loss is per-pack reason text; success/skip
    // attribution still works.
    //
    // Every provider's promise is wrapped in a deadline so a single
    // never-settling Promise can't keep `Promise.allSettled` pending
    // forever (the silent-failure shape observed when the capabilities
    // gather hung and the parent exited rc=0 with no work done). A
    // stall is materialised as `{ value: null, reason: "stalled at
    // >Ns (deadline)" }` so the existing skip/skipReason channels
    // carry it through to `toolsUnavailable` without any consumer
    // change.
    const deadlineMs = this.opts.providerDeadlineMs ?? DEFAULT_PROVIDER_DEADLINE_MS;
    const settled = await Promise.allSettled(
      providers.map((p) => {
        const candidate = p as CapabilityProvider<T> & {
          gatherOutcome?(
            cwd: string,
          ): Promise<{ kind: 'success'; envelope: T } | { kind: string; reason?: string }>;
        };
        const inner: Promise<{ value: T | null; reason: string | null }> =
          typeof candidate.gatherOutcome === 'function'
            ? candidate.gatherOutcome(cwd).then((o) => {
                if (o.kind === 'success') {
                  return { value: (o as { envelope: T }).envelope, reason: null };
                }
                return {
                  value: null as T | null,
                  reason: (o as { reason?: string }).reason ?? null,
                };
              })
            : p.gather(cwd).then((v) => ({ value: v, reason: null }));
        return withDeadline(inner, deadlineMs).then((outcome) => {
          if (outcome.stalled) {
            const stalledSeconds = Math.round(outcome.stalledMs / 1000);
            const onStall = this.opts.onProviderStall ?? defaultOnProviderStall;
            onStall(cap.id, p.source, outcome.stalledMs);
            return {
              value: null as T | null,
              reason: `stalled at >${stalledSeconds}s (deadline)`,
            };
          }
          return outcome.value;
        });
      }),
    );
    const succeeded: string[] = [];
    const skipped: string[] = [];
    const skipReasons: Record<string, string> = {};
    const successful: T[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const source = providers[i].source;
      if (r.status === 'rejected') {
        this.opts.onProviderError?.(cap.id, source, r.reason);
        skipped.push(source);
        continue;
      }
      const { value, reason } = r.value;
      if (value !== null) {
        successful.push(value);
        succeeded.push(source);
      } else {
        skipped.push(source);
        if (reason !== null) skipReasons[source] = reason;
      }
    }
    const envelope = successful.length === 0 ? null : cap.aggregate(successful);
    return { envelope, attempted, succeeded, skipped, skipReasons };
  }
}

/**
 * Default stall notifier — emits a single stderr line so a stalled
 * provider is visible in `vyuh-dxkit report --verbose` and CI logs.
 * Tests pass `onProviderStall` to suppress the write.
 */
function defaultOnProviderStall(capId: string, source: string, stalledMs: number): void {
  const seconds = Math.round(stalledMs / 1000);
  // Stderr keeps the stall visible in --verbose + CI logs without
  // polluting subprocess stdout (the orchestrator parses stdout).
  process.stderr.write(
    `[dxkit] capability "${capId}" provider "${source}" stalled after >${seconds}s (deadline) — treating as skipped\n`,
  );
}

/** Process-wide singleton. Tests should construct their own instance. */
export const defaultDispatcher = new CapabilityDispatcher();
