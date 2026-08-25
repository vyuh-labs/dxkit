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
 *   3. Returns `BaselineEntry[]` — a pure map. Content-hash stamping is the
 *      ORCHESTRATOR's job (`stampEntries`), never a producer's.
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
import type { CustomCheckFinding } from '../../analyzers/custom-checks/types';
import type { BaselineEntry, RichBaselineEntry } from '../types';
import { RECALL_EPOCHS, type RecallContext, type RecallMap } from '../recall';
import { resolveToolInputs, splitTools, toolRecall } from './recall-inputs';
import { stampEntries } from '../content-stamp';
import { customCheckFindingsToBaselineEntries } from './custom-checks';
import { LICENSES_PRODUCER } from './licenses';
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
  /** Commit SHA the baseline anchors to; display/provenance only. Empty
   *  string when not in a git repo. Content-hash stamping does NOT depend
   *  on it — the orchestrator stamps from the working tree (`cwd`). */
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
  /** Failures captured by the custom-check runner (user-declared checks +
   *  built-in lint), gathered once by the orchestrator via
   *  `gatherCustomCheckFindings`. Empty when no checks are configured (the
   *  common case) — the producer then emits nothing. */
  readonly customCheckFindings: ReadonlyArray<CustomCheckFinding>;
  /** What determines what the custom-check kind can SEE (Rule 19), resolved by
   *  the ONE Rule 17 seam entry point (`customCheckRecallInputs`) across all
   *  three of its consumers: user checks, pack lint, extension findings.
   *
   *  Separate from `customCheckFindings` because recall is not a function of
   *  the findings: a CLEAN lint run emits zero findings and still has a full
   *  recall context, and a clean run is exactly when you need to know whether
   *  "clean" was comparable to the baseline's "clean". */
  readonly customCheckRecall: Readonly<Record<string, string>>;
  /** The repo's normalized `licenses.prohibited` list (the ONE normalizer,
   *  `prohibitedLicensePatterns`). Empty (the default) ⟹ the license producer
   *  emits nothing. Part of the context — not re-read from disk — so the
   *  producer stays pure and the playbook can inject it. */
  readonly prohibitedLicenses: ReadonlyArray<string>;
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
  /**
   * What determines what each contributed kind can SEE this run (CLAUDE.md
   * Rule 19). ONE context per kind in `contributes` — no missing, no extra;
   * the contract test asserts exact coverage.
   *
   * REQUIRED. A new producer cannot ship without declaring what makes its
   * kinds see differently — the omission is what made `custom-check`
   * second-class for its entire life (there was no registry to be absent
   * from, so lint could never be attributed to a tool change).
   *
   * Per KIND, not per producer: `security` contributes four kinds driven by
   * three different tools, so a per-producer context would drift secrets
   * every time semgrep bumps.
   *
   * Unlike `produce`, this MUST return a context for every contributed kind
   * even when the upstream analyzer didn't run — a kind with no findings
   * still has a recall context, and a clean run is exactly when you need to
   * know whether "clean" was comparable to the baseline's "clean".
   *
   * Empty `inputs` is a legitimate, meaningful answer: it says "nothing
   * environmental determines this kind's recall — only dxkit's own code,
   * which `epoch` covers." (`large-file`, `test-gap`, `stale-file` are all
   * in-process with no external tool.) Config knobs are NOT recall inputs:
   * `.dxkit/policy.json` + `.vyuh-dxkit.json` already drive the separate,
   * existing `config_drift` signal via `policyHash` / `configHash`, and
   * duplicating them here would double-report one cause.
   */
  readonly recallContexts: (ctx: ProducerContext) => ReadonlyMap<IdentityKind, RecallContext>;
}

// `DEFERRED_KINDS` lives in `deferred-kinds.ts` (split at the large-file
// bar); re-exported so the registry stays the one import surface.
export { DEFERRED_KINDS } from './deferred-kinds';

// ─── Producer module wrappers ─────────────────────────────────────────────
// Each wraps a producer module's pure function with the registry's
// `BaselineProducer` shape. Kept in this file (rather than alongside
// each producer module) so the registry stays the single discovery
// surface — readers see every wired producer + every deferral in
// one place.

/** The tools that determine what the SECRETS pass can see. Shared by the
 *  `secret` / `config` / `secret-hmac` kinds — all three come out of the same
 *  scanner pass (`config` is the .env-in-git + private-key file sweep), so a
 *  gitleaks bump moves all three together. */
function secretsTools(ctx: ProducerContext): string[] {
  const p = ctx.analysisResult.capabilities.securityAggregate?.provenance;
  return splitTools(p?.secrets.tool);
}

const SECURITY_PRODUCER: BaselineProducer = {
  name: 'security',
  contributes: ['secret', 'code', 'config', 'dep-vuln'],
  produce(ctx) {
    const aggregate = ctx.analysisResult.capabilities.securityAggregate;
    if (!aggregate) return [];
    return securityAggregateToBaselineEntries(aggregate);
  },
  recallContexts(ctx) {
    const p = ctx.analysisResult.capabilities.securityAggregate?.provenance;
    const secrets = secretsTools(ctx);
    // Code findings come from semgrep, PLUS the in-process TLS-bypass registry,
    // PLUS any ingested external engine (Rule 13). An engine's snapshot being
    // refreshed changes what `code` can see exactly like a semgrep bump does,
    // so it is an input, not a footnote.
    const code = [
      ...splitTools(p?.codePatterns.tool),
      ...(p?.tlsBypass.ran ? ['tls-bypass-registry'] : []),
      ...(p?.external?.ran ? p.external.tools : []),
    ];
    // Offline snapshot mode (4.4.0 P1-4): the advisory feed STATE is a
    // dep-vuln recall input — a newer snapshot sees more advisories, and
    // that delta is feed movement (Rule 19 cause #5), never the
    // developer's regression. Live mode contributes nothing here (the
    // rolling OSV.dev feed is the `newly_published_advisory` machinery's
    // concern, not a comparable input).
    const depVulnRecall = toolRecall('dep-vuln', splitTools(p?.depVulns.tool), ctx.cwd);
    const depVuln: RecallContext =
      p?.depVulns.advisoryDbVersion !== undefined
        ? {
            ...depVulnRecall,
            inputs: { ...depVulnRecall.inputs, 'osv-advisory-db': p.depVulns.advisoryDbVersion },
          }
        : depVulnRecall;
    return new Map<IdentityKind, RecallContext>([
      ['secret', toolRecall('secret', secrets, ctx.cwd)],
      ['code', toolRecall('code', code, ctx.cwd)],
      ['config', toolRecall('config', secrets, ctx.cwd)],
      ['dep-vuln', depVuln],
    ]);
  },
};

const SECRET_HMAC_PRODUCER: BaselineProducer = {
  name: 'secret-hmac',
  contributes: ['secret-hmac'],
  produce(ctx) {
    // Salt mode `unavailable` (a bare tree — 4.4.0 WP2): no HMAC can be
    // computed, so the companion kind is skipped, DECLARED on the
    // envelope (`saltMode: 'unavailable'`). The located `secret` twin
    // still gates in full — the companion is cross-file relocation
    // assist, never the gate itself.
    if (ctx.salt === '') return [];
    return rawSecretsToBaselineEntries({ rawSecrets: ctx.rawSecrets, salt: ctx.salt });
  },
  recallContexts(ctx) {
    return new Map([['secret-hmac', toolRecall('secret-hmac', secretsTools(ctx), ctx.cwd)]]);
  },
};

const QUALITY_PRODUCER: BaselineProducer = {
  name: 'quality',
  contributes: ['duplication', 'stale-file'],
  produce(ctx) {
    return [
      ...duplicationToBaselineEntries(ctx.analysisResult.capabilities.duplication),
      ...staleFilesToBaselineEntries(ctx.hygiene.staleFiles),
    ];
  },
  recallContexts(ctx) {
    const dupTool = ctx.analysisResult.capabilities.duplication?.tool;
    return new Map<IdentityKind, RecallContext>([
      ['duplication', toolRecall('duplication', dupTool ? [dupTool] : [], ctx.cwd)],
      // Stale files are a git ls-files sweep over a fixed suffix set — no
      // external tool, so nothing environmental determines recall. The epoch
      // covers a change to the suffix set itself.
      ['stale-file', { epoch: RECALL_EPOCHS['stale-file'], inputs: {} }],
    ]);
  },
};

const HEALTH_PRODUCER: BaselineProducer = {
  name: 'health',
  contributes: ['large-file'],
  produce(ctx) {
    return largeFilesToBaselineEntries(ctx.analysisResult.metrics);
  },
  recallContexts() {
    // In-process line count over the metrics envelope. The large-file threshold
    // is a policy knob, and policy already drives the SEPARATE `config_drift`
    // signal via `policyHash` — recording it here too would double-report one
    // cause under two names.
    return new Map([['large-file', { epoch: RECALL_EPOCHS['large-file'], inputs: {} }]]);
  },
};

const TESTS_PRODUCER: BaselineProducer = {
  name: 'tests',
  contributes: ['test-gap', 'test-file-degradation'],
  produce(ctx) {
    return testGapsToBaselineEntries(ctx.testGapsReport);
  },
  recallContexts(ctx) {
    // Coverage tooling decides which files read as tested: a repo that gains a
    // real coverage report stops guessing from filenames, so gaps appear and
    // vanish without anyone touching the code. `coverageSource` is the honest
    // input, and the tools that produced it are named alongside.
    const inputs: Record<string, string> = {
      'coverage-source': ctx.testGapsReport.summary.coverageSource,
      ...resolveToolInputs(ctx.testGapsReport.toolsUsed, ctx.cwd),
    };
    return new Map<IdentityKind, RecallContext>([
      ['test-gap', { epoch: RECALL_EPOCHS['test-gap'], inputs }],
      ['test-file-degradation', { epoch: RECALL_EPOCHS['test-file-degradation'], inputs }],
    ]);
  },
};

const STALE_ALLOW_PRODUCER: BaselineProducer = {
  name: 'stale-allow',
  contributes: ['stale-allow'],
  produce(ctx) {
    return staleAllowToBaselineEntries({
      annotations: ctx.inlineAllowlistAnnotations,
      aggregate: ctx.analysisResult.capabilities.securityAggregate ?? null,
    });
  },
  recallContexts(ctx) {
    // A stale-allow finding means "this annotation's underlying finding is
    // gone." Whether the finding is gone is exactly what the secret scanners
    // decide — so a gitleaks bump that stops matching a value mints a NET-NEW
    // stale-allow that no developer caused. Same inputs as `secret`.
    return new Map([['stale-allow', toolRecall('stale-allow', secretsTools(ctx), ctx.cwd)]]);
  },
};

const CUSTOM_CHECK_PRODUCER: BaselineProducer = {
  name: 'custom-check',
  contributes: ['custom-check'],
  produce(ctx) {
    // Stamped through the shared content-hash entry point (content-stamp.ts) so a
    // located lint finding survives a whole-file reformat like every other located kind.
    return customCheckFindingsToBaselineEntries(ctx.customCheckFindings);
  },
  recallContexts(ctx) {
    // Resolved by the seam (Rule 17's one entry point) across all three of its
    // consumers, so the producer never re-derives what a check IS. The epoch is
    // the producer's own: it records that DXKIT changed what this kind can see,
    // which no seam input can express.
    return new Map([
      ['custom-check', { epoch: RECALL_EPOCHS['custom-check'], inputs: ctx.customCheckRecall }],
    ]);
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
  CUSTOM_CHECK_PRODUCER,
  LICENSES_PRODUCER,
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
  // Stamp ONCE, through the same located projection the matcher pairs on
  // (content-stamp.ts): a producer cannot forget to stamp, and a new located
  // kind is stamped the day it lands.
  return stampEntries(out, ctx.cwd);
}

/**
 * Union every producer's per-kind recall contexts into the ONE map the
 * baseline records and the guardrail compares (CLAUDE.md Rule 19).
 *
 * The orchestrator calls this with `PRODUCERS`; the playbook test calls it
 * with an extended list to verify a synthetic producer's inputs actually reach
 * the baseline. Registry-driven by construction — there is no per-kind list
 * here to fall out of date, which is precisely the bug this replaces
 * (`create.ts` hardcoded three tools; `check.ts` hardcoded five kinds; neither
 * derived from the other, so lint could never be attributed).
 *
 * A producer that declares a context for a kind it does not contribute is a
 * programming error the contract test catches; here we take what is given so a
 * synthetic producer in a test needs no special-casing.
 */
export function runRecallContexts(
  ctx: ProducerContext,
  producers: ReadonlyArray<BaselineProducer> = PRODUCERS,
): RecallMap {
  const out: Partial<Record<IdentityKind, RecallContext>> = {};
  for (const producer of producers) {
    for (const [kind, recall] of producer.recallContexts(ctx)) {
      out[kind] = recall;
    }
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
