/**
 * Per-pair context helpers for the gate engine: identity/severity
 * indices over the current scan, envelope drift, locator derivation,
 * and the pair-level verdict predicates. Pure module — extracted from
 * `src/baseline/check.ts` in the 4.4.0 WP1 engine split; the public
 * names are re-exported from there unchanged.
 */

import { isMaliciousAdvisory } from '../analyzers/security/malicious';
import type { SecurityAggregate } from '../analyzers/security/aggregator';
import type { CurrentScan } from '../baseline/create';
import type { BaselineFile } from '../baseline/baseline-file';
import { diffCoverage } from '../baseline/coverage';
import { priorClassOf } from '../baseline/modes';
import type { ResolvedMode } from '../baseline/modes';
import { diffRecall } from '../baseline/recall';
import { isSanitized } from '../baseline/sanitize';
import type { ClassifyResult } from '../baseline/classify';
import type { BaselineEntry, FindingId, FindingSeverity } from '../baseline/types';
import type { ClassifiedPair, EnvelopeDrift } from './result';

export function indexById(entries: ReadonlyArray<BaselineEntry>): Map<FindingId, BaselineEntry> {
  const out = new Map<FindingId, BaselineEntry>();
  for (const e of entries) out.set(e.id, e);
  return out;
}

/**
 * Severity-by-fingerprint index built from the current run's
 * security aggregate. CodeFindings carry `fingerprint` (computed via
 * `computeCodeFingerprint` — the same hash `identityFor` produces
 * for secret/code/config kinds), and DepVulnFindings carry
 * `fingerprint` (computed via `computeFingerprint` — same as
 * identityFor for dep-vulns). For other kinds the lookup misses and
 * the caller falls back to `KIND_DEFAULT_SEVERITY`.
 */
export function buildSeverityIndex(aggregate: SecurityAggregate): Map<FindingId, FindingSeverity> {
  const out = new Map<FindingId, FindingSeverity>();
  for (const f of aggregate.findingsByCategory.secret) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  for (const f of aggregate.findingsByCategory.code) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  for (const f of aggregate.findingsByCategory.config) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  for (const f of aggregate.findingsByCategory.dependency) {
    if (f.fingerprint) out.set(f.fingerprint, f.severity);
  }
  return out;
}

/**
 * Fingerprints of current-scan dependency findings whose advisory reports
 * the package itself as malicious code — the `newMaliciousDependency`
 * block rule's signal. Computed from the CURRENT side only: block rules
 * fire on `added` pairs, which always carry a currentId, so the committed
 * baseline needs no schema change. Classification comes from the one
 * canonical predicate (`src/analyzers/security/malicious.ts`).
 */
export function buildMaliciousIndex(aggregate: SecurityAggregate): Set<FindingId> {
  const out = new Set<FindingId>();
  for (const f of aggregate.findingsByCategory.dependency) {
    if (f.fingerprint && isMaliciousAdvisory(f)) out.add(f.fingerprint);
  }
  return out;
}

/**
 * Fingerprints of current-scan dependency findings the import graph marks
 * REACHABLE — the `newHighReachableDependencyVulnerability` block rule's
 * evidence. Mirror of `buildMaliciousIndex` (current side only, same
 * rationale). `f.reachable` is annotated by the ONE entry point
 * (`annotateReachability`) on both the standalone and the guardrail
 * gather paths; when reachability was not computed (no imports gathered)
 * the field is unset and the index stays empty — the rule then simply
 * has no evidence, it never fabricates `false` or `true` (T1.2).
 * Exported for the rule-liveness test.
 */
export function buildReachableIndex(aggregate: SecurityAggregate): Set<FindingId> {
  const out = new Set<FindingId>();
  for (const f of aggregate.findingsByCategory.dependency) {
    if (f.fingerprint && f.reachable === true) out.add(f.fingerprint);
  }
  return out;
}

export function diffEnvelopes(
  baseline: BaselineFile,
  current: CurrentScan,
  mode: ResolvedMode['mode'],
  refreshLaneInstalled?: boolean,
): EnvelopeDrift {
  const toolVersionDiffs: Array<{
    tool: string;
    baselineVersion: string | undefined;
    currentVersion: string | undefined;
  }> = [];
  const names = new Set<string>([...Object.keys(baseline.tools), ...Object.keys(current.tools)]);
  for (const tool of [...names].sort()) {
    const baselineVersion = baseline.tools[tool];
    const currentVersion = current.tools[tool];
    if (baselineVersion !== currentVersion) {
      toolVersionDiffs.push({ tool, baselineVersion, currentVersion });
    }
  }
  // Per-kind recall attribution (CLAUDE.md Rule 19) — the ONE comparison that
  // decides whether a kind's delta may be blamed on the developer. Filtered to
  // the kinds this run actually has findings for: a kind with nothing on either
  // side has nothing to misattribute, so reporting its drift would be noise
  // that trains readers to ignore the signal.
  const kindsInPlay = new Set<BaselineEntry['kind']>([
    ...baseline.findings.map((e) => e.kind),
    ...current.findings.map((e) => e.kind),
  ]);
  const recallDrift = diffRecall(baseline.recall, current.recall).filter((d) =>
    kindsInPlay.has(d.kind),
  );

  return {
    toolchainHashChanged: baseline.analysis.toolchainHash !== current.analysisMeta.toolchainHash,
    policyHashChanged: baseline.analysis.policyHash !== current.analysisMeta.policyHash,
    ignoreHashChanged: baseline.analysis.ignoreHash !== current.analysisMeta.ignoreHash,
    configHashChanged: baseline.analysis.configHash !== current.analysisMeta.configHash,
    dxkitVersionChanged: baseline.analysis.dxkitVersion !== current.analysisMeta.dxkitVersion,
    toolVersionDiffs,
    recallDrift,
    ...(baseline.capturedIn ? { baselineCapturedIn: baseline.capturedIn } : {}),
    ...(refreshLaneInstalled !== undefined ? { refreshLaneInstalled } : {}),
    // Non-committed prior classes: the prior side is a fresh gather (a bare
    // worktree, a supplied tree) or empty, so its "coverage" records
    // artifact-dependent tools (a node_modules linter, the coverage report)
    // as missing BY CONSTRUCTION — not as a fact about any capture. Diffing
    // that against the real tree produced a guaranteed-noise warning
    // ("eslint was NOT available at baseline … findings may surface as new")
    // for categories the dir-gathered diff ALREADY excludes and discloses
    // (REF_UNRELIABLE_KINDS). Committed priors keep the diff — there it is
    // load-bearing (a baseline captured without gitleaks genuinely never
    // baselined secrets).
    coverageDrift:
      priorClassOf(mode) !== 'committed' ? [] : diffCoverage(baseline.coverage, current.coverage),
  };
}

/**
 * Human location descriptor for a finding table — kind-aware, computed once.
 * Located kinds render `file:line` (or `file`); a dep-vuln has no file:line, so
 * it renders its own identity `package@version · advisory-id` (the fix for the
 * `Location: —` rows). Returns `''` for a genuinely location-less kind with no
 * meaningful descriptor (e.g. a sanitized entry). Extend the dep-vuln branch's
 * shape here — never re-derive location text in a renderer — so a future
 * locator-less kind supplies a descriptor instead of regressing to `—`.
 */
export function describeEntryLocation(entry: BaselineEntry): string {
  if (!isSanitized(entry) && entry.kind === 'dep-vuln') {
    const ver = entry.installedVersion ? `@${entry.installedVersion}` : '';
    // The ADVISORY id, not `entry.id` (the fingerprint — a naming collision:
    // `DepVulnIdentityInput.id` means advisory id, `BaselineEntry.id` means
    // finding id). Reading the fingerprint made ten same-package rows repeat
    // the Fingerprint column and read as duplicates with contradictory
    // severities (severity is per-advisory). Fallback covers pre-advisoryId
    // baselines.
    const advisoryId = entry.advisoryId ?? entry.id;
    const adv = advisoryId ? ` · ${advisoryId}` : '';
    return `${entry.package}${ver}${adv}`;
  }
  if (!isSanitized(entry) && entry.kind === 'custom-check') {
    // Lead with the check name — a binary (whole-command) check has no file, so
    // without this the row would read a bare `custom-check` with no clue which
    // one failed. Located findings append `check/rule · file:line`.
    const rule = entry.rule ? `/${entry.rule}` : '';
    const loc =
      entry.file !== undefined
        ? ` · ${entry.file}${entry.line !== undefined && entry.line > 0 ? `:${entry.line}` : ''}`
        : '';
    return `${entry.check}${rule}${loc}`;
  }
  if (!isSanitized(entry) && entry.kind === 'paired-change') {
    // Locator-less by design (a violation is a property of the diff, not a
    // file) — lead with the declared rule name so the row is identifiable.
    return entry.check;
  }
  if (!isSanitized(entry) && entry.kind === 'license') {
    const ver = entry.version ? `@${entry.version}` : '';
    return `${entry.package}${ver} · ${entry.licenseType}`;
  }
  const file = locatorFile(entry);
  if (file === undefined) return '';
  const line = locatorLine(entry);
  return line !== undefined && line > 0 ? `${file}:${line}` : file;
}

/**
 * Whether a net-new custom-check finding blocks. Reads the user/pack-declared
 * `blocking` flag off the entry. A sanitized entry (compliance mode) stripped
 * the flag, so it defaults to blocking=true — the conservative choice. Non-
 * custom-check kinds never call this.
 */
function customCheckIsBlocking(entry: BaselineEntry): boolean {
  if (isSanitized(entry)) return true;
  return entry.kind === 'custom-check' ? entry.blocking : true;
}

/**
 * Fold the custom-check block INTENT into a classification. Custom-check block
 * intent is user/pack-declared per check (`entry.blocking`), NOT derived from
 * severity or matcher status — so a net-new finding from a `blocking: false`
 * check (a warn-only user check, or lint left at its default) is demoted
 * block→warn here even though its `added` status is in the policy's block list.
 * Pure + exported so the demotion is unit-tested directly (not only via a full
 * guardrail run). A no-op for every non-custom-check kind and for a custom-check
 * that already doesn't block.
 */
export function applyCustomCheckIntent(entry: BaselineEntry, c: ClassifyResult): ClassifyResult {
  if (isSanitized(entry) || entry.kind !== 'custom-check' || !c.blocks) return c;
  if (customCheckIsBlocking(entry)) return c;
  return {
    ...c,
    blocks: false,
    warns: true,
    reasons: [
      ...c.reasons,
      {
        code: 'non-blocking-check',
        detail: 'custom check declared blocking:false — reported as a warning, not a block',
      },
    ],
  };
}

export function locatorFile(entry: BaselineEntry): string | undefined {
  if (isSanitized(entry)) return undefined;
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
    case 'hygiene':
    case 'test-gap':
    case 'test-file-degradation':
    case 'god-file':
    case 'stale-file':
    case 'large-file':
      return entry.file;
    case 'coverage-gap':
      return entry.file;
    case 'duplication':
      return entry.fileA;
    case 'custom-check':
      // Located variant carries a file; binary variant does not.
      return entry.file;
    case 'dep-vuln':
    case 'secret-hmac':
      return undefined;
  }
}

export function locatorLine(entry: BaselineEntry): number | undefined {
  if (isSanitized(entry)) return undefined;
  switch (entry.kind) {
    case 'secret':
    case 'code':
    case 'config':
    case 'hygiene':
      return entry.line;
    case 'duplication':
      return entry.startLineA;
    case 'coverage-gap':
      return entry.lineRange?.[0];
    case 'custom-check':
      return entry.line;
    default:
      return undefined;
  }
}

/**
 * Whether a classified pair contributes a BLOCK to the verdict. Folds
 * the classifier's verdict together with allowlist suppression: a pair
 * the classifier would block but an active allowlist entry accepted
 * does not block. Single chokepoint so the main verdict, the
 * post-`--changed-only` re-derivation, and the verdict cache's
 * blocking-finding projection can't drift. Exported for the cache.
 */
export function pairBlocks(p: ClassifiedPair): boolean {
  return p.classification.blocks && p.suppressedByAllowlist === undefined;
}

/**
 * `--changed-only` filter predicate. Keeps:
 *   - pairs without a line locator (dep-vuln, duplication, etc.) —
 *     their identity isn't line-bound, so changed-line overlap
 *     doesn't apply
 *   - prior-side pairs (persisted / relocated / removed) — they
 *     represent existing state, not newly-introduced findings, so
 *     they pass regardless of where they live in the diff
 *   - new-side pairs whose anchor line is inside the diff
 *
 * Drops new-side pairs (added / tooling_drift / config_drift /
 * newly_detected) whose locator IS known but doesn't overlap any
 * changed line. That's the exact scope a pre-commit / pre-push hook
 * wants — "only flag what this developer just touched."
 */
export function keepUnderChangedOnly(p: ClassifiedPair): boolean {
  if (p.file === undefined || p.line === undefined) return true;
  const isNewSide =
    p.classification.status === 'added' ||
    p.classification.status === 'tooling_drift' ||
    p.classification.status === 'config_drift' ||
    p.classification.status === 'newly_detected';
  if (!isNewSide) return true;
  return p.overlapsChangedLines === true;
}
