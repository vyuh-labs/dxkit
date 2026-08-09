/**
 * Observation semantics of the gate diff: which kinds a mode can gate at
 * all (`partitionForRefBasedDiff`), whether a kind was actually observed
 * this run (`kindNotObservedReason`, Rule 19's removed direction), and
 * the per-kind default severity table. Pure module — extracted from
 * `src/baseline/check.ts` in the 4.4.0 WP1 engine split; the public
 * names are re-exported from there unchanged.
 */

import type { BaselineEntry, FindingId, FindingSeverity } from '../baseline/types';
import { priorClassOf } from '../baseline/modes';
import type { ResolvedMode } from '../baseline/modes';
import type { GatherScope } from '../baseline/gather-scope';
import { KIND_OBSERVATION_SCOPE } from '../baseline/gather-scope';
import type { SecurityAggregate } from '../analyzers/security/aggregator';
import type { ClassifiedPair, GuardrailCheckResult, NotObservedDisclosure } from './result';

/**
 * Was a NON-custom-check kind observed by this run? Pure — the ONE answer the
 * removed-direction attribution reads for scope- and scanner-level causes
 * (`custom-check` has its own richer record at the seam, `CustomChecksUnobserved`).
 *
 * Committed prior class only: a re-gathered prior (a materialized ref, a
 * supplied tree) diffs BOTH sides in this same environment, so an un-run
 * scanner produces zero findings on each and no removed pair exists to
 * mislabel (and the structurally-excluded kinds carry their own
 * `refExcludedKinds` disclosure); an empty prior has no removed direction
 * at all.
 *
 * Two causes, in order:
 *   1. the kind's gather was scoped out (`KIND_OBSERVATION_SCOPE`);
 *   2. the gather was requested but its scanner did not run — read from the
 *      aggregate's per-source provenance, the same signal `depVulnsUnmeasured`
 *      trusts (never a kind↔tool table; provenance says what actually ran).
 */
export function kindNotObservedReason(
  kind: BaselineEntry['kind'],
  ctx: {
    readonly mode: ResolvedMode['mode'];
    readonly scope: GatherScope;
    readonly provenance: SecurityAggregate['provenance'];
  },
): string | undefined {
  if (priorClassOf(ctx.mode) !== 'committed') return undefined;
  const offFlag = KIND_OBSERVATION_SCOPE[kind].find((flag) => !ctx.scope[flag]);
  if (offFlag !== undefined) {
    return `not gathered this run (the ${offFlag} gather is outside this run's scope)`;
  }
  if ((kind === 'secret' || kind === 'secret-hmac') && !ctx.provenance.secrets.ran) {
    return 'not observed this run (no secret scanner ran)';
  }
  if (kind === 'code' && !ctx.provenance.codePatterns.ran) {
    return 'not observed this run (the code-pattern scanner did not run)';
  }
  if (kind === 'dep-vuln' && !ctx.provenance.depVulns.available) {
    return 'not observed this run (the dependency scanner could not run)';
  }
  return undefined;
}

/**
 * Group `not_observed` pairs by their reason. Pure; reads the prior-side entry
 * through the SAME reason function the classifier consumed, so a disclosure
 * can never disagree with the pair statuses it summarizes. Sorted by count
 * (largest first) for stable rendering.
 */
export function collectNotObservedDisclosures(
  pairs: ReadonlyArray<ClassifiedPair>,
  priorById: ReadonlyMap<FindingId, BaselineEntry>,
  reasonFor: (entry: BaselineEntry) => string | undefined,
): NotObservedDisclosure[] {
  const byReason = new Map<string, { kind: BaselineEntry['kind']; count: number }>();
  for (const p of pairs) {
    if (p.classification.status !== 'not_observed' || p.pair.priorId === undefined) continue;
    const entry = priorById.get(p.pair.priorId);
    if (!entry) continue;
    const reason = reasonFor(entry);
    if (reason === undefined) continue;
    const agg = byReason.get(reason) ?? { kind: entry.kind, count: 0 };
    agg.count += 1;
    byReason.set(reason, agg);
  }
  return [...byReason.entries()]
    .map(([reason, { kind, count }]) => ({ kind, reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}

/**
 * Finding kinds that cannot be gathered comparably from a detached git
 * worktree, so ref-based mode must not diff them. `duplication` runs
 * jscpd, which needs the project's `node_modules`; `test-gap` reads the
 * coverage report — neither exists in a bare `git worktree add` checkout.
 * The prior (worktree) side therefore under-produces these systematically
 * while the current (working-tree) side produces them in full, so a
 * straight diff reports the entire current set as net-new regressions.
 * Confirmed empirically: gathering the SAME commit via cwd vs a worktree
 * differed only here (duplication 15→0, test-gap 44→12). Excluded from
 * both sides in ref-based mode; committed-full (which captures them once
 * from a fully-provisioned tree) is the mode that gates them. (D-G4.)
 *
 * `secret-hmac` joins them for a different reason: it is an internal,
 * locator-less companion to each located `secret`, identified by a
 * salt-based HMAC of the secret value. The salt resolves from
 * `.dxkit/salt` / `DXKIT_BASELINE_SALT` / root-SHA, and on a fresh or
 * shallow checkout the two sides can derive different salts (the ref
 * worktree and the working tree need not share the salt source), so the
 * HMACs don't match across the diff and every companion reads as net-new —
 * a FALSE block, even though the located `secret` twins match fine. The
 * located `secret` kind still gates net-new credentials; the companion
 * exists only for cross-file relocation matching, which a committed salt
 * provides and ref-based does not. So it is matcher-assist only here and is
 * excluded from the ref-based diff.
 *
 * `custom-check` joins them for the same reason as `duplication`: the checks it
 * runs (linters, build-based analyzers, user commands) need the project's
 * toolchain — `node_modules`, a restored `dotnet`/gradle build — which a bare
 * `git worktree add` checkout does not have. The ref side would systematically
 * under-produce (every linter fail-open-skips for a missing binary) while the
 * working-tree side produces in full, so a straight diff would flag the whole
 * current set as net-new. Committed-full mode (which captures custom-check once
 * from a fully-provisioned tree) is the mode that gates it; ref-based excludes
 * it. (The loop Stop-gate + pre-push run in the working tree, so they gate it
 * fine via the committed baseline.)
 *
 * `license` joins them for the same reason: the license gather reads the
 * INSTALLED dependency tree (license-checker walks `node_modules`,
 * pip-licenses the venv), which a bare worktree lacks — the ref side would
 * report zero licenses and every standing violation would read net-new.
 */
const REF_UNRELIABLE_KINDS: ReadonlySet<BaselineEntry['kind']> = new Set([
  'duplication',
  'test-gap',
  'secret-hmac',
  'custom-check',
  'license',
]);

/**
 * Apply the ref-based-mode kind exclusion to both sides of the diff.
 *
 * In ref-based mode the prior side is gathered from a detached worktree
 * that can't produce the build-artifact-dependent kinds (REF_UNRELIABLE_KINDS),
 * so they're dropped from BOTH sides to keep the comparison symmetric —
 * otherwise the current side's full set has nothing to match against and
 * every one reads as a net-new regression. The dropped current-side counts
 * are returned for disclosure. In committed modes nothing is excluded.
 *
 * Pure + exported so the exclusion behavior is unit-testable without
 * driving the (slow, environment-dependent) gather pipeline.
 */
export function partitionForRefBasedDiff<T extends { readonly kind: BaselineEntry['kind'] }>(
  priorFindings: ReadonlyArray<T>,
  currentFindings: ReadonlyArray<T>,
  isRefBased: boolean,
): {
  diffablePrior: ReadonlyArray<T>;
  diffableCurrent: ReadonlyArray<T>;
  refExcludedKinds: GuardrailCheckResult['refExcludedKinds'];
} {
  if (!isRefBased) {
    return {
      diffablePrior: priorFindings,
      diffableCurrent: currentFindings,
      refExcludedKinds: [],
    };
  }
  const keep = (f: T): boolean => !REF_UNRELIABLE_KINDS.has(f.kind);
  const refExcludedKinds = [...REF_UNRELIABLE_KINDS]
    .map((kind) => ({
      kind,
      currentCount: currentFindings.filter((f) => f.kind === kind).length,
    }))
    .filter((e) => e.currentCount > 0);
  return {
    diffablePrior: priorFindings.filter(keep),
    diffableCurrent: currentFindings.filter(keep),
    refExcludedKinds,
  };
}

/** Canonical per-kind default severity (exported for the debt inventory —
 *  the one severity table, never a second copy). */
export const KIND_DEFAULT_SEVERITY: Readonly<Record<BaselineEntry['kind'], FindingSeverity>> =
  Object.freeze({
    secret: 'high',
    code: 'medium',
    config: 'medium',
    'dep-vuln': 'medium',
    duplication: 'medium',
    'coverage-gap': 'medium',
    'test-gap': 'medium',
    hygiene: 'low',
    'test-file-degradation': 'medium',
    'god-file': 'medium',
    'stale-file': 'low',
    'large-file': 'medium',
    'secret-hmac': 'high',
    // Stale-allow is a self-detected dxkit hygiene finding (orphaned
    // allowlist annotation). Low severity — it's a maintenance signal,
    // not an active risk; the underlying suppressed finding is already
    // gone.
    'stale-allow': 'low',
    // A net-new broken integration (a UI call that no longer resolves to a
    // served route, or a served route a consumer still binds to that a PR
    // removed). High severity — it is a runtime breakage the gate proves
    // statically, on par with a security regression.
    'flow-binding': 'high',
    // Net-new breaking schema drift (a field removed / type changed /
    // requiredness tightened on a declared data model). High severity — a
    // statically proven contract break, the same tier as flow-binding. The
    // additive/info classes never reach the guardrail as findings, so this
    // default speaks only for the breaking ones.
    'model-schema-drift': 'high',
    // A structural code-reimplementation (two functions the graph shows to be
    // the same routine written twice). Low severity — it is a maintainability /
    // slop signal surfaced warn-tier, not a correctness or security defect; its
    // block confidence comes only from seam CONVERGENCE (dup ∩ reliably-dead),
    // never from this default alone.
    'code-reimplementation': 'low',
    // A custom-check / lint failure. Severity is a neutral default — a custom
    // check's block intent is user/pack-declared (`entry.blocking`), NOT
    // severity-derived, so severity only feeds the confidence-threshold logic
    // for persisted pairs here, never the block decision.
    'custom-check': 'medium',
    // A paired-change violation. Same doctrine as custom-check: block intent
    // is rule-declared (`blocking`), never severity-derived.
    'paired-change': 'medium',
    // A broken declared flow (4.4.0 WP7): a statically proven estate
    // contract break — the flow-binding / model-schema-drift tier.
    'broken-flow': 'high',
    // A prohibited-license dependency. High — a statically proven policy
    // violation (the flow-binding / model-schema-drift tier); the block
    // decision itself comes from the `newProhibitedLicense` rule, not from
    // this default.
    license: 'high',
  });
