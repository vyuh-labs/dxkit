/**
 * Producer registry — the single canonical home for everything that
 * turns analyzer output into `BaselineEntry`s.
 *
 * # Why this exists (CLAUDE.md Rule 10)
 *
 * The baseline file is the durable contract the guardrail check
 * reads. Every analyzer that surfaces per-finding output MUST flow
 * through a registered producer so guardrails don't silently miss
 * its findings. Without the registry, adding a new analyzer means
 * remembering to also edit `create.ts` orchestration — easy to
 * forget, and the bug is invisible (the guardrail check passes even
 * when a new finding kind is silently bypassed).
 *
 * With the registry:
 *   - Adding a new analyzer is a one-line `PRODUCERS.push(...)`.
 *   - The orchestrator iterates the registry — no per-producer
 *     `findings.push(...)` calls to forget.
 *   - A contract test asserts every `IdentityInput` discriminant
 *     kind is either contributed by a registered producer OR
 *     listed in `DEFERRED_KINDS` with explicit rationale.
 *   - A synthetic-producer playbook test asserts the orchestrator
 *     stays registry-driven (adding a fake producer to the
 *     registry makes its entries appear in the baseline file
 *     without any edits to the orchestrator).
 *
 * # Producer contract
 *
 * Each producer:
 *   1. Declares the identity kinds it contributes via `contributes`.
 *   2. Reads from the shared `ProducerContext` (gathered once by
 *      the orchestrator so multiple producers don't re-shell the
 *      same analyzer).
 *   3. Returns `BaselineEntry[]` — pure or near-pure, depending on
 *      whether content-hash stamping is needed.
 *
 * # Adding a new identity kind
 *
 *   1. Add the discriminant to `IdentityInput` in `types.ts`.
 *   2. Add the case branch in `identityFor`.
 *   3. EITHER add a new producer here (or extend an existing one)
 *      so `contributes` covers the new kind, OR add the kind to
 *      `DEFERRED_KINDS` with rationale + landing phase.
 *   4. Add a fixture row in `test/baseline/finding-identity.test.ts`
 *      (Rule 9 / per-kind fixture contract).
 *
 * The contract test enforces steps 3 + 4 at runtime; the
 * exhaustive switch in `identityFor` enforces step 2 at compile
 * time. The result: no new identity kind can land in a way that
 * silently bypasses guardrails.
 */

import type { GitleaksRawSecret } from '../../analyzers/tools/gitleaks';
import type { AnalysisResult } from '../../analysis-result';
import type { TestGapsReport } from '../../analyzers/tests/types';
import type { InlineAllowlistOccurrence } from '../../allowlist/gather';
import type { BaselineEntry, RichBaselineEntry } from '../types';
import { largeFilesToBaselineEntries } from './health';
import { duplicationToBaselineEntries, staleFilesToBaselineEntries } from './quality';
import { rawSecretsToBaselineEntries } from './secret-hmac';
import { securityAggregateToBaselineEntries } from './security';
import { staleAllowToBaselineEntries } from './stale-allow';
import { testGapsToBaselineEntries } from './tests';

/** Every discriminant value the `BaselineEntry` union takes. Mirror
 *  of `IdentityInput['kind']` — kept as a separate alias because the
 *  registry contract speaks in terms of stored entries, not the
 *  identity-compute input. */
export type IdentityKind = BaselineEntry['kind'];

/**
 * Hygiene-marker counts + stale-file list returned by
 * `gatherHygieneMarkers`. Replicated here as the producer-context
 * field type so producers don't need to depend on the analyzer
 * module's gather signature.
 */
export interface HygieneSnapshot {
  readonly staleFiles: ReadonlyArray<string>;
  readonly todoCount: number;
  readonly fixmeCount: number;
  readonly hackCount: number;
  readonly consoleLogCount: number;
  readonly mixedLanguages: boolean;
}

/**
 * Per-run inputs every producer reads from. Gathered ONCE by the
 * orchestrator; producers are pure (or content-hash-impure for
 * stamping) over this context. Adding a new producer that needs a
 * new analyzer means extending this context — a single, visible
 * extension point.
 */
export interface ProducerContext {
  /** Absolute repo path. */
  readonly cwd: string;
  /** Commit SHA the baseline anchors to. Empty string when not in
   *  a git repo — content-hash stamping is then disabled but other
   *  producers still emit normally. */
  readonly commitSha: string;
  /** Resolved repo salt (from `resolveSalt`). Threaded into
   *  producers that compute HMACs. */
  readonly salt: string;
  /** Canonical cached analysis envelope — capabilities + metrics
   *  + provenance for every gather pipeline. */
  readonly analysisResult: AnalysisResult;
  /** Test-gaps report (separate analyzer because the gap detection
   *  + import-graph reachability isn't part of the cached
   *  envelope). */
  readonly testGapsReport: TestGapsReport;
  /** Hygiene-marker snapshot — stale file list + aggregate counts. */
  readonly hygiene: HygieneSnapshot;
  /** Raw secrets gitleaks captured (process-only; never written to
   *  disk; consumed by the secret-HMAC producer). */
  readonly rawSecrets: ReadonlyArray<GitleaksRawSecret>;
  /** Inline `dxkit-allow:` annotations gathered from source files.
   *  Consumed by the stale-allow producer to detect orphaned
   *  annotations whose underlying finding is gone. */
  readonly inlineAllowlistAnnotations: ReadonlyArray<InlineAllowlistOccurrence>;
}

/**
 * The registry entry shape. A producer self-describes the kinds it
 * contributes and supplies the function to produce them.
 */
export interface BaselineProducer {
  /** Human-readable name; surfaces in logs + contract-test
   *  diagnostics ("producer X contributed N entries"). */
  readonly name: string;
  /** Identity kinds this producer wires. The contract test reads
   *  the union across every producer and asserts it covers every
   *  `IdentityKind` value not in `DEFERRED_KINDS`. */
  readonly contributes: ReadonlyArray<IdentityKind>;
  /** Build `RichBaselineEntry`s from the shared context. Producers
   *  emit ZERO entries when their upstream data is missing
   *  (analyzer didn't run, envelope absent, etc.) — never throw
   *  for missing inputs. Producers always emit the rich shape;
   *  sanitization is applied at the write boundary, not here. */
  readonly produce: (ctx: ProducerContext) => RichBaselineEntry[];
}

/**
 * Identity kinds declared in `IdentityInput` but not yet wired by
 * any producer. Each entry MUST carry a `reason` (what blocks the
 * producer today) and `landingPhase` (when we intend to wire it).
 * The contract test asserts:
 *
 *   - Every kind appearing here is NOT contributed by any
 *     registered producer (no double-counting).
 *   - Every `IdentityKind` is either contributed OR in this map.
 *
 * Adding a new identity kind without wiring a producer requires
 * adding an entry here — the deferral becomes architecturally
 * explicit rather than silently invisible.
 */
export const DEFERRED_KINDS: Readonly<
  Record<string, { readonly reason: string; readonly landingPhase: string }>
> = Object.freeze({
  'god-file': {
    reason:
      'graphify Python script does not yet surface per-file complexity offenders; ' +
      'QualityMetrics.topGodFiles is forward-declared but unpopulated. ' +
      'Substitute: large-file (>500 lines) overlaps the same files ~80%+ of the time.',
    landingPhase: '2.6 / Phase 10s.2 (graphify-symbols expansion)',
  },
  hygiene: {
    reason:
      'gatherHygieneMarkers emits aggregate counts, not per-occurrence positions; ' +
      'extending to surface Array<{file, line, marker}> is a small gather refactor. ' +
      'Substitute: aggregate counts feed the Quality dimension score; ' +
      'newSevereQualityIssueInChangedFiles block rule catches high-severity overlap.',
    landingPhase: 'Phase 5 (pre-launch polish)',
  },
  'coverage-gap': {
    reason:
      'per-pack coverage adapters do not yet surface uncovered symbol ranges. ' +
      'Five of eight packs (typescript / java / kotlin / ruby / go) land in ' +
      'Phase 3.5 inside 2.5; remaining three (python / csharp / rust) decided ' +
      'mid-Phase-3.5 based on adapter complexity. ' +
      'Substitute: test-gap covers file-level untested; new uncovered functions ' +
      'inside an already-tested file remain invisible until Phase 3.5 lands.',
    landingPhase: 'Phase 3.5 (5 packs) / 2.6 (remaining)',
  },
  'flow-binding': {
    reason:
      'the identity + baseline-entry shape ship ahead of the producer so the ' +
      'integration gate can grandfather bindings the moment it lands. The gate ' +
      'evaluates the affected scope of a diff against committed contract ' +
      'snapshots (served.json / consumed.json) rather than a full-scan producer, ' +
      'so the flow-binding entries are minted by the gate path, not baseline-create. ' +
      'Substitute: none — net-new broken-integration detection is inert until the gate wires in.',
    landingPhase: 'Flow M3 (the integration gate)',
  },
  'custom-check': {
    reason:
      'the identity + baseline-entry shape land first (this commit); the producer ' +
      'that runs the checks and folds their failures into the baseline lands in the ' +
      'next commit of the same flagship, once the canonical runner + policy schema ' +
      'exist for it to consume. Substitute: none — custom-check grandfathering is ' +
      'inert until the producer wires in.',
    landingPhase: 'custom-check flagship (producer commit)',
  },
});

// ─── Producer module wrappers ─────────────────────────────────────────────
// Each wraps a producer module's pure function with the registry's
// `BaselineProducer` shape. Kept in this file (rather than alongside
// each producer module) so the registry stays the single discovery
// surface — readers see every wired producer + every deferral in
// one place.

const SECURITY_PRODUCER: BaselineProducer = {
  name: 'security',
  contributes: ['secret', 'code', 'config', 'dep-vuln'],
  produce(ctx) {
    const aggregate = ctx.analysisResult.capabilities.securityAggregate;
    if (!aggregate) return [];
    return securityAggregateToBaselineEntries(aggregate, {
      cwd: ctx.cwd,
      commitSha: ctx.commitSha || undefined,
    });
  },
};

const SECRET_HMAC_PRODUCER: BaselineProducer = {
  name: 'secret-hmac',
  contributes: ['secret-hmac'],
  produce(ctx) {
    return rawSecretsToBaselineEntries({ rawSecrets: ctx.rawSecrets, salt: ctx.salt });
  },
};

const QUALITY_PRODUCER: BaselineProducer = {
  name: 'quality',
  contributes: ['duplication', 'stale-file'],
  produce(ctx) {
    return [
      ...duplicationToBaselineEntries(ctx.analysisResult.capabilities.duplication, {
        cwd: ctx.cwd,
        commitSha: ctx.commitSha,
      }),
      ...staleFilesToBaselineEntries(ctx.hygiene.staleFiles),
    ];
  },
};

const HEALTH_PRODUCER: BaselineProducer = {
  name: 'health',
  contributes: ['large-file'],
  produce(ctx) {
    return largeFilesToBaselineEntries(ctx.analysisResult.metrics);
  },
};

const TESTS_PRODUCER: BaselineProducer = {
  name: 'tests',
  contributes: ['test-gap', 'test-file-degradation'],
  produce(ctx) {
    return testGapsToBaselineEntries(ctx.testGapsReport);
  },
};

const STALE_ALLOW_PRODUCER: BaselineProducer = {
  name: 'stale-allow',
  contributes: ['stale-allow'],
  produce(ctx) {
    return staleAllowToBaselineEntries({
      annotations: ctx.inlineAllowlistAnnotations,
      aggregate: ctx.analysisResult.capabilities.securityAggregate ?? null,
      commit: { cwd: ctx.cwd, commitSha: ctx.commitSha },
    });
  },
};

/**
 * The canonical producer list. Order is preserved in baseline-file
 * output for deterministic diffs; adding a new producer appends
 * here and updates the contract-test expectations.
 *
 * Mutable for the synthetic-producer playbook test: the test
 * substitutes a wrapped registry rather than mutating PRODUCERS
 * directly. Callers MUST treat this as immutable.
 */
export const PRODUCERS: ReadonlyArray<BaselineProducer> = Object.freeze([
  SECURITY_PRODUCER,
  SECRET_HMAC_PRODUCER,
  QUALITY_PRODUCER,
  HEALTH_PRODUCER,
  TESTS_PRODUCER,
  STALE_ALLOW_PRODUCER,
]);

/**
 * Run every producer in `producers` against the shared context and
 * flatten the result. The orchestrator calls this with `PRODUCERS`
 * for production use; the playbook test calls it with an extended
 * list to verify synthetic producers flow through.
 */
export function runProducers(
  ctx: ProducerContext,
  producers: ReadonlyArray<BaselineProducer> = PRODUCERS,
): RichBaselineEntry[] {
  const out: RichBaselineEntry[] = [];
  for (const producer of producers) {
    out.push(...producer.produce(ctx));
  }
  return out;
}

/**
 * Every kind currently contributed by some producer in `producers`.
 * Convenience used by the contract test + by the orchestrator for
 * logging "this run produced entries across N kinds."
 */
export function wiredKinds(
  producers: ReadonlyArray<BaselineProducer> = PRODUCERS,
): ReadonlySet<IdentityKind> {
  const out = new Set<IdentityKind>();
  for (const p of producers) for (const k of p.contributes) out.add(k);
  return out;
}
