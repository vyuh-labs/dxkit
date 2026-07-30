/**
 * Output renderers for `vyuh-dxkit guardrail check`.
 *
 * Three target surfaces, one shared `GuardrailCheckResult`:
 *
 *   - **Console** (`renderConsole`) — human-readable text for
 *     terminal output. Grouped by verdict (blocking / warning /
 *     informational), each pair showing status + kind + locator +
 *     severity + reason chain. Color codes via the shared logger
 *     palette so output blends with the rest of dxkit's CLI.
 *
 *   - **JSON** (`renderJson`) — schema-stable machine-readable
 *     payload (top-level `schema: 'dxkit.guardrail-check.v1'`).
 *     Designed for AI agents and CI runners that need to programmatically
 *     decide what to do. Includes the matcher's per-pair detail,
 *     classifier verdicts, envelope drift, and the resolved policy.
 *
 *   - **Markdown** (`renderMarkdown`) — Phase 4 PR-comment template.
 *     Compact, table-heavy, status-banner-first. Renders into the
 *     `dxkit-guardrails.yml` workflow's PR comment unchanged. No
 *     emojis (bot-friendly; Phase 4 templates can layer presentation
 *     on top).
 *
 * Pure modules. No I/O — callers handle stdout writing, file
 * writing, or PR-comment posting.
 */

import * as logger from '../logger';
import type {
  AnchorSourceDisclosure,
  ClassifiedPair,
  EnvelopeDrift,
  GuardrailCheckResult,
  NotObservedDisclosure,
} from './check';
import { ATTRIBUTION_GAP_REMEDY, describeAttributionGap } from './attribution-gap';
import type { AttributionGap } from './attribution-gap';
import {
  EXPIRY_PROJECTION_REMEDY,
  describeExpiryProjection,
  describeLapsingSuppression,
} from './expiry-projection';
import type { ExpiryProjection } from './expiry-projection';
import { recallDriftRemedy, describeRecallDrift } from './recall';
import type { BrownfieldPolicy } from './policy';
import type { FindingStatus, MatchReason } from './types';
import { DEFER_ADVISORY_EXPIRY_DAYS } from '../allowlist/categories';
import { failingFloorDebt } from './floor-debt';
import { describeBrokenIntegration } from '../analyzers/flow/gate';
import type { FlowGateOutcome } from './flow-gate-check';
import { describeSchemaDrift } from '../analyzers/model-schema/gate';
import type { SchemaDriftGateOutcome } from './schema-drift-gate-check';
import type { DupGateOutcome } from './dup-gate-check';
import type { PairedChangeFinding, PairedGateOutcome } from './paired-gate-check';
import type { GateFailure } from './gate-failopen';
import {
  groupDuplicatesByAdded,
  type DuplicateFinding,
  type DuplicateGroup,
} from '../analyzers/duplication/findings';

// ─── Shared verdict predicates ────────────────────────────────────────────

/**
 * Whether a pair was accepted by an active allowlist entry. Such a
 * pair would otherwise block, so it carries `classification.blocks ===
 * true`; the verdict already excludes it (see `pairBlocks` in
 * `check.ts`). The renderers mirror that here so a suppressed finding
 * is surfaced in its own bucket — never silently dropped, never
 * miscounted as a live regression.
 */
function isAllowlistSuppressed(p: ClassifiedPair): boolean {
  return p.suppressedByAllowlist !== undefined;
}

/** Whether a pair contributes a live BLOCK to the verdict — blocking
 *  per the classifier AND not waived by an active allowlist entry. */
function isBlocking(p: ClassifiedPair): boolean {
  return p.classification.blocks && p.suppressedByAllowlist === undefined;
}

/** Whether a pair is UNATTRIBUTABLE on a block-rule kind — demoted by recall
 *  drift out of reach of an armed block rule, and not waived by an allowlist
 *  entry. Such a pair forces the verdict to `CANNOT GATE` (never PASSED): the
 *  run can neither blame the developer nor certify "no net-new". */
function isUnattributable(p: ClassifiedPair): boolean {
  return (
    p.classification.unattributableBlockRule !== undefined && p.suppressedByAllowlist === undefined
  );
}

/** Whether a pair contributes a live WARNING — warns per the classifier, not a
 *  block, not waived by an active allowlist entry (a suppressed pair is
 *  neither blocking nor warning; it lands in the suppressed bucket), and not
 *  an unattributable block-rule finding (which gets its own bucket + verdict
 *  tier — rendering it as a mere warning is the bypass this closes). */
function isWarning(p: ClassifiedPair): boolean {
  return (
    !p.classification.blocks &&
    p.classification.warns &&
    p.suppressedByAllowlist === undefined &&
    p.classification.unattributableBlockRule === undefined
  );
}

/** The four-tier verdict word. `CANNOT GATE` is the refusal tier: an
 *  attribution gap on a block-rule kind means the run can neither certify
 *  "no net-new" nor blame the developer, so it refuses to pass (exit 1) and
 *  names the remedy — the identity-scheme-mismatch treatment, structural. */
export type VerdictWord = 'BLOCKED' | 'CANNOT GATE' | 'PASSED (with warnings)' | 'PASSED';

/** The headline verdict word + the counts behind it — the same numbers
 *  `renderMarkdown` shows, including folded-in flow-gate findings. One counting
 *  path so the cached verdict summary and the rendered block never disagree. */
export interface VerdictCounts {
  readonly verdict: VerdictWord;
  /** The exit code the verdict maps to. Derived HERE and nowhere else, so a
   *  consumer cannot exit 0 over an attribution gap. */
  readonly exitCode: 0 | 1;
  readonly blocking: number;
  /** Unattributable block-rule-class findings (the `CANNOT GATE` tier). */
  readonly unattributable: number;
  readonly warning: number;
  readonly resolved: number;
}

/**
 * The ONE verdict-word + exit-code derivation. Every surface that names the
 * verdict — the console banner, the summary footer, the JSON payload, the
 * markdown heading, the verdict cache, `receipt` — routes through this (or
 * through `verdictCounts`, which calls it), so PASSED is unconstructible while
 * an unattributable block-rule finding exists. Precedence: a definite
 * regression outranks a refusal (both exit 1); a refusal outranks any pass.
 */
export function verdictWordFrom(v: {
  readonly blocks: boolean;
  readonly warns: boolean;
  readonly unattributable: number;
}): { verdict: VerdictWord; exitCode: 0 | 1 } {
  if (v.blocks) return { verdict: 'BLOCKED', exitCode: 1 };
  if (v.unattributable > 0) return { verdict: 'CANNOT GATE', exitCode: 1 };
  return v.warns
    ? { verdict: 'PASSED (with warnings)', exitCode: 0 }
    : { verdict: 'PASSED', exitCode: 0 };
}
/** Active findings of the ADDITIVE gates (flow + schema drift) tallied by
 *  verdict — the one counting path every surface (verdict banner, summary
 *  sentence, cached verdict counts) folds gate findings through, so a second
 *  gate cannot re-introduce the "one report, two stories" divergence flow
 *  once threaded by hand. Schema `info` findings are disclosure-only and
 *  never counted. */
function extraGateTallies(result: GuardrailCheckResult): { block: number; warn: number } {
  const findings = [
    ...(result.flowGate?.findings ?? []),
    ...(result.schemaDriftGate?.findings ?? []),
  ];
  // Seam-gate duplicates are always warn-tier (no per-finding verdict field);
  // fold their count into the warn tally so the banner reconciles with the
  // summary. Count GROUPS (one added function = one warning), not raw pairs, so
  // an added function that copies N existing reads as one warning everywhere.
  const dupFindings = result.dupGate?.findings ?? [];
  const dupWarns = dupFindings.length > 0 ? groupDuplicatesByAdded(dupFindings).length : 0;
  // Paired-change findings carry their own rule-declared verdict.
  const paired = result.pairedGate?.findings ?? [];
  return {
    block:
      findings.filter((f) => f.verdict === 'block').length +
      paired.filter((f) => f.blocking).length,
    warn:
      findings.filter((f) => f.verdict === 'warn').length +
      dupWarns +
      paired.filter((f) => !f.blocking).length,
  };
}

export function verdictCounts(result: GuardrailCheckResult): VerdictCounts {
  const extra = extraGateTallies(result);
  // Consumed from the REQUIRED `attributionGaps` field (not re-derived from the
  // pairs) so the verdict's dependency on the gap value is explicit — the field
  // and the per-pair markers come from the same classifier output, so the
  // counts agree by construction.
  const unattributable = result.attributionGaps.reduce((n, g) => n + g.findingCount, 0);
  const word = verdictWordFrom({
    blocks: result.blocks,
    warns: result.warns,
    unattributable,
  });
  return {
    verdict: word.verdict,
    exitCode: word.exitCode,
    blocking: result.pairs.filter(isBlocking).length + extra.block,
    unattributable,
    warning: result.pairs.filter(isWarning).length + extra.warn,
    resolved: result.pairs.filter((p) => p.classification.status === 'removed').length,
  };
}

// ─── Console renderer ─────────────────────────────────────────────────────

/**
 * Render the check result as a human-readable text block. Returns a
 * single multi-line string; callers route it to stdout.
 */
/**
 * The remediation clause for an UNMEASURED dependency dimension — honest about
 * WHY the scan didn't run. "run tools install" is correct only when the scanner
 * is genuinely absent; on a scanner that IS present but couldn't run (a missing
 * lockfile, a runtime failure) it sends the user down the wrong path (the bug:
 * a present osv-scanner told to "install the scanner"). Branch on the reason.
 */
export function depVulnsUnmeasuredRemediation(reason: string): string {
  const r = reason.toLowerCase();
  if (/not installed|not present|not found|no scanner/.test(r)) {
    return 'Run `vyuh-dxkit tools install` so the scanner is present.';
  }
  if (/no lockfile|no manifest|generate one/.test(r)) {
    return 'Generate a lockfile (run your package manager install) so the scanner can resolve dependency versions.';
  }
  return 'The scanner is present but did not produce a result — investigate the reason above rather than reinstalling.';
}

/**
 * The arming banner for a committed baseline captured with classes DEFERRED
 * (CLAUDE.md Rule 20 — a stale mirror couldn't install a scanner, or a
 * wrong-host build gate). One phrasing, shared by every renderer, so the
 * boundary is stated once. The point: never certify a class that was never
 * observed. Returns the note lines (no leading blank) or `[]` when nothing was
 * deferred. `armed` is the count of classes NOT yet gating.
 */
export function deferredCaptureBannerLines(result: GuardrailCheckResult): string[] {
  const deferred = result.deferredCapture ?? [];
  if (deferred.length === 0) return [];
  const labels = deferred.map((d) => d.label).join(', ');
  return [
    `Baseline COMPLETING ON CI — ${deferred.length} class${deferred.length === 1 ? '' : 'es'} ` +
      `not yet gating (${labels}).`,
    `These could not be captured in the environment that ran this baseline ` +
      `(a scanner your package index couldn't reach, or a host/toolchain not present here). ` +
      `CI captures them with the guaranteed pinned toolchain and refreshes the baseline anchor; ` +
      `the gate is fully armed once that lands. A pass here does NOT yet verify these classes. ` +
      `If this repo has no CI to complete on, capture them in the generated devcontainer ` +
      `(a guaranteed-complete environment).`,
  ];
}

export function renderConsole(result: GuardrailCheckResult): string {
  const lines: string[] = [];

  // Verdict banner. Single line at the top so a developer skimming
  // terminal output sees pass/fail without scrolling.
  lines.push(verdictBanner(result));
  lines.push('');

  // Provenance: what was compared against what. Inline so the user
  // can verify they're checking against the intended baseline.
  lines.push(logger.bold('Baseline'));
  // Ref-based mode has no on-disk baseline; say so rather than stringifying the
  // absent field into the literal word "undefined".
  lines.push(
    `  Path:        ${result.baselinePath ?? `(none — gathered from ${result.mode.ref ?? 'a git ref'})`}`,
  );
  lines.push(`  Name:        ${result.baseline.name}`);
  lines.push(`  Captured:    ${result.baseline.createdAt}`);
  lines.push(
    `  Commit:      ${shortSha(result.baseline.repo.commitSha)} (${result.baseline.repo.branch || 'detached'})`,
  );
  lines.push(`  Findings:    ${result.baseline.findings.length}`);
  // D4d: under the `branch` anchor transport, say WHICH file actually loaded —
  // an unreachable side branch silently gating against a stale tree copy was
  // invisible in the incident output.
  if (result.anchorSource) {
    lines.push(
      result.anchorSource.used === 'anchor'
        ? `  Anchor:      side branch '${result.anchorSource.anchorRef}'`
        : `  ⚠ Anchor:    TREE FALLBACK — ${result.anchorSource.note}`,
    );
  }
  const debtNote = floorDebtNotice(result.baseline);
  if (debtNote) lines.push(`  ${debtNote}`);
  lines.push('');

  lines.push(logger.bold('Current'));
  lines.push(`  Commit:      ${shortSha(result.current.repoState.commitSha)}`);
  lines.push(`  Findings:    ${result.current.findings.length}`);
  lines.push(
    `  Matcher:     ${result.matchResult.gitAware ? 'git-aware' : `degraded (${result.matchResult.degradedReason ?? 'unknown reason'})`}`,
  );
  lines.push('');

  const driftLines = formatDrift(result.envelopeDrift);
  if (driftLines.length > 0) {
    lines.push(logger.bold('Envelope drift'));
    for (const l of driftLines) lines.push(`  ${l}`);
    lines.push('');
  }

  // Group + render pairs by verdict bucket. Buckets ordered so the
  // most actionable surfaces first.
  const blocking = result.pairs.filter(isBlocking);
  const unattributable = result.pairs.filter(isUnattributable);
  const suppressed = result.pairs.filter(isAllowlistSuppressed);
  const warning = result.pairs.filter(isWarning);
  const persisted = result.pairs.filter(
    (p) =>
      !p.classification.blocks &&
      !p.classification.warns &&
      (p.classification.status === 'persisted' || p.classification.status === 'relocated'),
  );
  const removed = result.pairs.filter((p) => p.classification.status === 'removed');

  if (blocking.length > 0) {
    lines.push(logger.bold(`Blocking (${blocking.length})`));
    for (const p of blocking) lines.push(...formatPairLines(p, '  '));
    lines.push(...newlyPublishedAdvisoryNote(blocking, '  '));
    lines.push('');
  }
  if (unattributable.length > 0) {
    lines.push(logger.bold(`Cannot attribute — refusing to pass (${unattributable.length})`));
    for (const p of unattributable) lines.push(...formatPairLines(p, '  '));
    for (const gap of result.attributionGaps) {
      lines.push(`  · ${describeAttributionGap(gap)}`);
    }
    lines.push(`  · ${ATTRIBUTION_GAP_REMEDY}`);
    lines.push('');
  }
  if (suppressed.length > 0) {
    lines.push(logger.bold(`Suppressed by allowlist (${suppressed.length})`));
    for (const p of suppressed) lines.push(...formatPairLines(p, '  '));
    lines.push('');
  }
  // The lapse projection, immediately after the list it is the consequence of.
  // Silent when nothing expires inside the horizon, which is almost every run.
  lines.push(...formatExpiryProjection(result.suppressionExpiry));
  if (warning.length > 0) {
    lines.push(logger.bold(`Warnings (${warning.length})`));
    // Collapse the envelope-drift wall (gh #157): after a dxkit upgrade or a
    // policy.json edit, dozens of unrelated findings all fall out as
    // `config_drift` warnings. Rendering each as its own line buries the
    // specific, actionable warnings under the wall — so print the drift group as
    // ONE summary line and enumerate only the specific warnings.
    const drift = warning.filter((p) => p.classification.status === 'config_drift');
    // The tooling-drift wall (VERIFY-39 F-6) is the same disease one status
    // over: on a pre-Rule-19 baseline the whole backlog demotes at once
    // (18,396 blocks on a real repo). One summary block per kind instead.
    const toolingDrift = warning.filter((p) => p.classification.status === 'tooling_drift');
    const specific = warning.filter(
      (p) =>
        p.classification.status !== 'config_drift' && p.classification.status !== 'tooling_drift',
    );
    for (const p of specific) lines.push(...formatPairLines(p, '  '));
    if (toolingDrift.length > 0) lines.push(...formatToolingDriftSummary(toolingDrift, '  '));
    if (drift.length > 0) lines.push(...formatDriftWarningSummary(drift, '  '));
    lines.push('');
  }
  if (removed.length > 0) {
    lines.push(logger.bold(`Resolved (${removed.length})`));
    for (const p of removed) lines.push(...formatPairLines(p, '  '));
    lines.push('');
  }
  // Not-observed disclosure (Rule 19's REMOVED direction): baseline findings
  // the current side never re-verified. One aggregate line per unobserved
  // check — never a per-finding table (the whole point is that a repo-scale
  // backlog must not render as 18k "resolved" rows or 18k anything-rows).
  lines.push(...formatNotObserved(result.notObserved));

  lines.push(...formatFlowGate(result.flowGate));
  lines.push(...formatSchemaDriftGate(result.schemaDriftGate));
  lines.push(...formatDupGate(result.dupGate));
  lines.push(...formatPairedGate(result.pairedGate));

  // Always show a summary footer — sets expectations for what
  // happens next (exit code, what to read on a fail).
  lines.push(logger.bold('Summary'));
  lines.push(
    `  Pairs:       ${result.pairs.length} (blocking: ${blocking.length}, ` +
      `suppressed: ${suppressed.length}, ` +
      (unattributable.length > 0 ? `unattributable: ${unattributable.length}, ` : '') +
      `warning: ${warning.length}, persisted: ${persisted.length}, ` +
      `resolved: ${removed.length}` +
      (notObservedPairCount(result) > 0 ? `, not observed: ${notObservedPairCount(result)}` : '') +
      `)`,
  );
  // The lapse line belongs in the footer too: a reader who skims to the summary
  // and stops must still see that today's PASS has an expiry date on it.
  if (result.suppressionExpiry.lapsing.length > 0) {
    const p = result.suppressionExpiry;
    lines.push(
      `  Expiring:    ${p.lapsing.length} suppression(s) within ${p.horizonDays}d ` +
        `(next in ${p.nextLapseDays}d; ${p.willBlock} would block, ${p.willWarn} would warn)`,
    );
  }
  // A flow-gate line so the verdict banner's total (which counts flow findings)
  // reconciles with the summary. Without it, a repo whose only regressions are
  // flow breakages read "BLOCKED — 3 new regressions" over "Pairs: blocking: 0"
  // — one report, two stories.
  const flowFindings = result.flowGate?.findings ?? [];
  const flowSuppressed = result.flowGate?.suppressed ?? [];
  if (flowFindings.length > 0 || flowSuppressed.length > 0) {
    const fBlock = flowFindings.filter((f) => f.verdict === 'block').length;
    const fWarn = flowFindings.filter((f) => f.verdict === 'warn').length;
    lines.push(
      `  Flow:        ${flowFindings.length + flowSuppressed.length} ` +
        `(blocking: ${fBlock}, warning: ${fWarn}, suppressed: ${flowSuppressed.length})`,
    );
  }
  // Same reconciliation line for the schema drift gate.
  const schemaFindings = result.schemaDriftGate?.findings ?? [];
  const schemaSuppressed = result.schemaDriftGate?.suppressed ?? [];
  if (schemaFindings.length > 0 || schemaSuppressed.length > 0) {
    const sBlock = schemaFindings.filter((f) => f.verdict === 'block').length;
    const sWarn = schemaFindings.filter((f) => f.verdict === 'warn').length;
    const sInfo = schemaFindings.filter((f) => f.verdict === 'info').length;
    lines.push(
      `  Schema:      ${schemaFindings.length + schemaSuppressed.length} ` +
        `(blocking: ${sBlock}, warning: ${sWarn}, info: ${sInfo}, suppressed: ${schemaSuppressed.length})`,
    );
  }
  // Same reconciliation line for the structural-duplicate (seam) gate. All
  // warn-tier (a lone duplicate never blocks), so the count folds into warnings.
  const dupFindings = result.dupGate?.findings ?? [];
  const dupSuppressed = result.dupGate?.suppressed ?? [];
  if (dupFindings.length > 0 || dupSuppressed.length > 0) {
    // Warning count is GROUPED (one added function = one warning), matching the
    // seam section; suppressed stay per-pair (each is individually waived).
    const dupGroups = dupFindings.length > 0 ? groupDuplicatesByAdded(dupFindings).length : 0;
    lines.push(
      `  Seam:        ${dupGroups + dupSuppressed.length} ` +
        `(warning: ${dupGroups}, suppressed: ${dupSuppressed.length})`,
    );
  }
  // Verdict + exit code from the ONE derivation (consumes attribution gaps) —
  // a summary footer must never disagree with the process exit.
  const counts = verdictCounts(result);
  lines.push(`  Verdict:     ${counts.verdict}`);
  lines.push(`  Exit code:   ${counts.exitCode}`);
  if (result.depVulnsUnmeasured) {
    lines.push('');
    lines.push(
      `  ⚠ Dependency audit UNMEASURED — ${result.depVulnsUnmeasured.reason}. A pass here ` +
        `does not verify "no net-new dependency vulnerabilities". ` +
        depVulnsUnmeasuredRemediation(result.depVulnsUnmeasured.reason),
    );
  }
  if (result.refExcludedKinds.length > 0) {
    const detail = result.refExcludedKinds.map((e) => `${e.currentCount} ${e.kind}`).join(', ');
    lines.push('');
    lines.push(
      `  Note: ref-based mode does not gate ${detail} — these depend on build ` +
        `artifacts (node_modules / coverage) absent at a bare git ref. Use ` +
        `committed-full mode to gate them.`,
    );
  }
  for (const line of deferredCaptureBannerLines(result)) {
    lines.push('');
    lines.push(`  ⚠ ${line}`);
  }
  if (result.blocks) {
    lines.push('');
    lines.push(
      `  Re-run with --json for a machine-readable payload, or --markdown to capture a PR-comment-friendly report.`,
    );
  }
  return lines.join('\n');
}

/**
 * Console lines for the flow integration gate. Silent unless the gate produced
 * findings — a skipped or clean gate adds no noise. Blocking breakages are
 * grouped separately from warnings so the actionable set surfaces first.
 */
/**
 * A visible line for a fail-open gate that ERRORED — never silent. The gate
 * degraded to "did not gate" (correct: a broken toolchain is not broken code),
 * but it says WHERE (`error.step`) and WHY (`error.message`) instead of
 * swallowing the throw. Closes the class where a gate erroring inside
 * `guardrail check` produced a bare `skipped:"error"` with nothing in the human
 * output, the JSON, or stderr. Accepts the minimal shared shape so all three
 * gates render a failure identically (Rule 2). Empty for any non-error state.
 */
function formatGateFailure(
  label: string,
  gate: { skipped?: string; error?: GateFailure } | undefined,
): string[] {
  if (!gate || gate.skipped !== 'error') return [];
  const at = gate.error?.step ? ` at ${gate.error.step}` : '';
  const why = gate.error?.message ? `: ${gate.error.message}` : '';
  return [
    logger.bold(`⚠ ${label} gate did not run — error${at}${why}`),
    '  (fail-open: this did not block the check; set DXKIT_DEBUG=1 for the stack)',
    '',
  ];
}

/**
 * The lapse projection section. Prints nothing when no active suppression
 * expires inside the horizon — the state of almost every run, and an empty
 * "nothing expiring" section would be noise that trains readers to skip the
 * area where the real warning eventually appears.
 *
 * Where the delivery gap was: the horizon computation has existed since the
 * allowlist shipped, reachable only from `doctor` and `allowlist audit`. Every
 * author and reviewer reads THIS output instead, which is why the warning goes
 * here (see `src/baseline/expiry-projection.ts`).
 */
/** Total pairs classified `not_observed` — the summary-footer count. Derived
 *  from the disclosures (which the check computed from the same pair set), so
 *  the footer and the section agree by construction. */
function notObservedPairCount(result: GuardrailCheckResult): number {
  return result.notObserved.reduce((n, d) => n + d.count, 0);
}

/**
 * The not-observed disclosure block, shared in structure by the console and
 * markdown renderers: one line per unobserved check, aggregate counts only.
 * A silent skip is the class this section exists to kill — but so is a 18k-row
 * table, so it deliberately never enumerates findings.
 */
function formatNotObserved(disclosures: ReadonlyArray<NotObservedDisclosure>): string[] {
  if (disclosures.length === 0) return [];
  const total = disclosures.reduce((n, d) => n + d.count, 0);
  const out = [logger.bold(`⚠ Not re-verified this run (${total})`)];
  for (const d of disclosures) {
    out.push(
      `  ${d.kind} ${d.reason} — ${d.count} baseline finding${d.count === 1 ? '' : 's'} ` +
        `not re-verified this run (reported as not observed, never as resolved)`,
    );
  }
  out.push('');
  return out;
}

function formatExpiryProjection(projection: ExpiryProjection): string[] {
  const headline = describeExpiryProjection(projection);
  if (!headline) return [];
  const out = [
    logger.bold(
      `${projection.willBlock > 0 ? '⚠ ' : ''}Suppressions expiring (${projection.lapsing.length})`,
    ),
    `  ${headline}`,
  ];
  for (const l of projection.lapsing) out.push(`  · ${describeLapsingSuppression(l)}`);
  out.push(`  → ${EXPIRY_PROJECTION_REMEDY}`);
  out.push('');
  return out;
}

/**
 * Structural skips a CONFIGURED-ON gate must disclose — the gate can never run
 * as configured, so silence here reads as "the gate is protecting this repo"
 * when it is inert. 3.7.1 closed silent-*errors* (`formatGateFailure`); this
 * closes silent-*skips*: a repo shipped with `flow.mode: block` and no served
 * truth, so the gate skipped every run for months and nothing said so.
 * Routine per-diff skips (`no-flow-surface-change`, `no-source-change`,
 * `no-candidates`) stay quiet — they mean "nothing to gate in THIS diff", not
 * "the gate cannot work"; `off` / `no-base-ref` stay quiet because the gate
 * isn't configured on / the run has no base at all.
 */
const STRUCTURAL_GATE_SKIPS: Readonly<Record<string, string>> = {
  'no-served-truth':
    'no served-side truth is available (no committed served.json and no monorepo route set) — ' +
    'publish one via `flow publish` (or set `flow.mode: off`) or this gate will never evaluate',
  'no-models':
    'neither side declares any data model — if models exist, check `schema.specs`; ' +
    'otherwise set `schema.mode: off`',
};

/** A visible line for a configured-on gate that skipped STRUCTURALLY (it can
 *  never run as configured) — never silent, mirror of `formatGateFailure`.
 *  Empty for routine, error, off, and no-base-ref skips. */
function formatGateSkip(label: string, gate: { skipped?: string } | undefined): string[] {
  if (!gate?.skipped) return [];
  const why = STRUCTURAL_GATE_SKIPS[gate.skipped];
  if (!why) return [];
  return [
    logger.bold(`⚠ ${label} gate is configured but did not run — ${gate.skipped}`),
    `  ${why}`,
    '',
  ];
}

function formatFlowGate(flow: FlowGateOutcome | undefined): string[] {
  if (!flow) return [];
  const failure = formatGateFailure('Flow', flow);
  if (failure.length > 0) return failure;
  const structuralSkip = formatGateSkip('Flow', flow);
  if (structuralSkip.length > 0) return structuralSkip;
  const suppressed = flow.suppressed ?? [];
  if (flow.findings.length === 0 && suppressed.length === 0) return [];
  const out: string[] = [];
  // Snapshot-age disclosure: the findings were resolved against a committed
  // contract of a specific vintage — a stale one can read as a false no-route,
  // and the reader deserves to know which vintage judged them.
  if (flow.contractGeneratedAt && flow.findings.length > 0) {
    out.push(
      `  (resolved against committed served.json published ${flow.contractGeneratedAt.slice(0, 10)} — ` +
        `if the provider has since changed, refresh via \`flow publish\` and commit)`,
    );
    out.push('');
  }
  const blocking = flow.findings.filter((f) => f.verdict === 'block');
  const warning = flow.findings.filter((f) => f.verdict === 'warn');
  if (blocking.length > 0) {
    out.push(logger.bold(`Flow breakage — blocking (${blocking.length})`));
    for (const f of blocking) {
      out.push(`  ${describeBrokenIntegration(f)}`);
      out.push(flowFingerprintLine(f.id));
    }
    out.push('');
  }
  if (warning.length > 0) {
    out.push(logger.bold(`Flow breakage — warning (${warning.length})`));
    for (const f of warning) {
      out.push(`  ${describeBrokenIntegration(f)}`);
      out.push(flowFingerprintLine(f.id));
    }
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push(logger.bold(`Flow breakage — suppressed by allowlist (${suppressed.length})`));
    for (const s of suppressed) {
      const exp = s.expiresAt ? `, expires ${s.expiresAt}` : '';
      out.push(`  ${describeBrokenIntegration(s.finding)}`);
      out.push(`    · allowlisted: ${s.category}${exp} (waived from the verdict)`);
    }
    out.push('');
  }
  return out;
}

/** The flow-binding fingerprint line + the concrete accept command. A flow
 *  finding's kind is always `flow-binding` (unlike a generic pair, whose kind
 *  varies), so the hint can spell out the FULL `allowlist add` invocation — the
 *  documented escape hatch for an intentional break, reviewed like any
 *  suppression. Identity is on `id` (Rule 9). */
function flowFingerprintLine(id: string): string {
  return (
    `    · fingerprint: ${id}  (accept if intentional: allowlist add ` +
    `--fingerprint=${id} --kind=flow-binding --category=false-positive --reason="<why>")`
  );
}

/**
 * Console lines for the model-schema drift gate. Silent unless the gate
 * produced findings. Blocking drift first, then warnings, then the
 * disclosure-only info class (additions/relaxations), then suppressions.
 */
function formatSchemaDriftGate(gate: SchemaDriftGateOutcome | undefined): string[] {
  if (!gate) return [];
  const failure = formatGateFailure('Schema drift', gate);
  if (failure.length > 0) return failure;
  const structuralSkip = formatGateSkip('Schema drift', gate);
  if (structuralSkip.length > 0) return structuralSkip;
  const suppressed = gate.suppressed ?? [];
  if (gate.findings.length === 0 && suppressed.length === 0) return [];
  const out: string[] = [];
  const blocking = gate.findings.filter((f) => f.verdict === 'block');
  const warning = gate.findings.filter((f) => f.verdict === 'warn');
  const info = gate.findings.filter((f) => f.verdict === 'info');
  if (blocking.length > 0) {
    out.push(logger.bold(`Schema drift — blocking (${blocking.length})`));
    for (const f of blocking) {
      out.push(`  ${describeSchemaDrift(f)}`);
      out.push(schemaFingerprintLine(f.id));
    }
    out.push('');
  }
  if (warning.length > 0) {
    out.push(logger.bold(`Schema drift — warning (${warning.length})`));
    for (const f of warning) {
      out.push(`  ${describeSchemaDrift(f)}`);
      out.push(schemaFingerprintLine(f.id));
    }
    out.push('');
  }
  if (info.length > 0) {
    out.push(logger.bold(`Schema drift — informational (${info.length})`));
    for (const f of info) out.push(`  ${describeSchemaDrift(f)}`);
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push(logger.bold(`Schema drift — suppressed by allowlist (${suppressed.length})`));
    for (const s of suppressed) {
      const exp = s.expiresAt ? `, expires ${s.expiresAt}` : '';
      out.push(`  ${describeSchemaDrift(s.finding)}`);
      out.push(`    · allowlisted: ${s.category}${exp} (waived from the verdict)`);
    }
    out.push('');
  }
  return out;
}

/** The drift fingerprint line + the concrete accept command. The documented
 *  escape hatch for a DELIBERATE breaking change is accepted-risk (ideally
 *  with an expiry), so the hint spells that category — contrast flow's
 *  false-positive default. */
function schemaFingerprintLine(id: string): string {
  return (
    `    · fingerprint: ${id}  (accept if intentional: allowlist add ` +
    `--fingerprint=${id} --kind=model-schema-drift --category=accepted-risk --reason="<why>")`
  );
}

/**
 * Console lines for the structural-duplicate (seam) gate. Silent unless the
 * gate produced findings. All warn-tier (a lone duplicate never blocks), so the
 * one section names the twin, the similarity score, and the accept command.
 */
function formatDupGate(gate: DupGateOutcome | undefined): string[] {
  if (!gate) return [];
  const failure = formatGateFailure('Structural duplicate', gate);
  if (failure.length > 0) return failure;
  const structuralSkip = formatGateSkip('Structural duplicate', gate);
  if (structuralSkip.length > 0) return structuralSkip;
  const suppressed = gate.suppressed ?? [];
  if (gate.findings.length === 0 && suppressed.length === 0) return [];
  const out: string[] = [];
  if (gate.findings.length > 0) {
    // Group net-new pairs by the function the change INTRODUCED, so an added
    // function that duplicates N existing reads as one finding, not N warns.
    const groups = groupDuplicatesByAdded(gate.findings);
    out.push(logger.bold(`Structural duplicate — warning (${groups.length})`));
    for (const g of groups) out.push(...describeGroup(g));
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push(logger.bold(`Structural duplicate — suppressed by allowlist (${suppressed.length})`));
    for (const s of suppressed) {
      const exp = s.expiresAt ? `, expires ${s.expiresAt}` : '';
      out.push(`  ${describeDuplicate(s.finding)}`);
      out.push(`    · allowlisted: ${s.category}${exp} (waived from the verdict)`);
    }
    out.push('');
  }
  return out;
}

function formatPairedGate(gate: PairedGateOutcome | undefined): string[] {
  if (!gate) return [];
  const failure = formatGateFailure('Paired-change', gate);
  if (failure.length > 0) return failure;
  const structuralSkip = formatGateSkip('Paired-change', gate);
  if (structuralSkip.length > 0) return structuralSkip;
  const out: string[] = [];
  for (const w of gate.warnings) out.push(`  paired-change config: ${w}`);
  const suppressed = gate.suppressed ?? [];
  if (gate.findings.length === 0 && suppressed.length === 0) {
    if (out.length > 0) out.push('');
    return out;
  }
  if (gate.findings.length > 0) {
    const blocking = gate.findings.filter((f) => f.blocking).length;
    const label =
      blocking > 0
        ? `Paired-change — BLOCKING (${blocking}${gate.findings.length > blocking ? ` + ${gate.findings.length - blocking} warn` : ''})`
        : `Paired-change — warning (${gate.findings.length})`;
    out.push(logger.bold(label));
    for (const f of gate.findings) out.push(...describePairedFinding(f));
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push(logger.bold(`Paired-change — suppressed by allowlist (${suppressed.length})`));
    for (const s of suppressed) {
      const exp = s.expiresAt ? `, expires ${s.expiresAt}` : '';
      out.push(`  ${s.finding.check}`);
      out.push(`    · allowlisted: ${s.category}${exp} (waived from the verdict)`);
    }
    out.push('');
  }
  return out;
}

/** Render one paired-change violation: the rule, its evidence (which changed
 *  paths triggered it), the required companion surface, and the two remedies
 *  (make the companion change, or defer time-boxed). */
function describePairedFinding(f: PairedChangeFinding): string[] {
  const out = [
    `  ${f.check}${f.blocking ? '' : ' (warn-only)'}${f.message ? ` — ${f.message}` : ''}`,
  ];
  out.push(`    changed: ${f.ifMatched.join(', ')}`);
  out.push(`    but nothing changed under: ${f.thenGlobs.join(', ')}`);
  out.push(
    `    · add the companion change, or defer time-boxed: allowlist add ` +
      `--fingerprint=${f.id} --kind=paired-change --category=deferred ` +
      `--expires=+7d --reason="<why this change needs none>"`,
  );
  return out;
}

/** Anchor coordinates as `symbol @ file:line`. */
function anchorLoc(x: { symbol: string; file: string; line: number }): string {
  return `${x.symbol} @ ${x.file}:${x.line}`;
}

/**
 * Render one grouped duplicate — the function a change introduced plus every
 * existing function it duplicates. A single twin reads as the familiar directional
 * one-liner; many twins read as "added X duplicates N existing" with the twins
 * listed, so one added function is one finding, not N warns. Per-twin fingerprints
 * are kept (granular allowlisting is unchanged).
 */
function describeGroup(g: DuplicateGroup): string[] {
  if (g.twins.length === 1) {
    const t = g.twins[0];
    const sim = `(similarity ${t.score.toFixed(2)})`;
    const head = t.bothAdded
      ? `  both added: ${anchorLoc(g.added)}  ≈  ${anchorLoc(t.anchor)}  ${sim}`
      : `  added: ${anchorLoc(g.added)}  ≈  existing: ${anchorLoc(t.anchor)}  ${sim}`;
    return [head, dupFingerprintLine(t.id)];
  }
  const out = [
    `  added: ${anchorLoc(g.added)}  duplicates ${g.twins.length} existing function(s):`,
  ];
  for (const t of g.twins) {
    out.push(`    ≈ ${anchorLoc(t.anchor)}  (similarity ${t.score.toFixed(2)})`);
  }
  out.push(
    `    · accept any by-design twin: allowlist add --fingerprint=<id> ` +
      `--kind=code-reimplementation --category=false-positive --reason="<why>" ` +
      `(fingerprints: ${g.twins.map((t) => t.id).join(', ')})`,
  );
  return out;
}

/** One-line description of a structural-duplicate pair. When the gate marked
 *  which side the change introduced, the new side is named FIRST and labelled —
 *  so the fix is directional ("you added A, consolidate with existing B"). */
function describeDuplicate(f: DuplicateFinding): string {
  const [a, b] = f.anchors;
  const loc = (x: DuplicateFinding['anchors'][number]) => `${x.symbol} @ ${x.file}:${x.line}`;
  const sim = `(similarity ${f.score.toFixed(2)})`;
  if (f.changed) {
    const [aNew, bNew] = f.changed;
    // One side new, one pre-existing → name the new (added) side first.
    if (aNew && !bNew) return `added: ${loc(a)}  ≈  existing: ${loc(b)}  ${sim}`;
    if (bNew && !aNew) return `added: ${loc(b)}  ≈  existing: ${loc(a)}  ${sim}`;
    // Both sides in the change → the whole duplicate was introduced here.
    if (aNew && bNew) return `both added: ${loc(a)}  ≈  ${loc(b)}  ${sim}`;
  }
  return `${loc(a)}  ≈  ${loc(b)}  ${sim}`;
}

/** The duplicate fingerprint line + the concrete accept command. A sanctioned
 *  by-design parallel is accepted as false-positive (the same category flow
 *  uses for a cross-repo consumer the scan can't see). */
function dupFingerprintLine(id: string): string {
  return (
    `    · fingerprint: ${id}  (accept if by-design: allowlist add ` +
    `--fingerprint=${id} --kind=code-reimplementation --category=false-positive --reason="<why>")`
  );
}

/**
 * One informational line when the baseline carries recorded floor debt
 * (a grandfathered broken build / failing tests). A PASSED gate on such a
 * repo is technically correct and experientially misleading — the gate
 * proves no NEW debt, and this line keeps the OLD debt from being
 * invisible at the one place people actually look. Exported for tests;
 * null when there is no envelope or it is all green.
 */
export function floorDebtNotice(baseline: {
  readonly floorDebt?: { readonly checks: ReadonlyArray<{ readonly status: string }> };
}): string | null {
  // The one canonical failing filter (Rule 2) — shared with `debt` and the
  // remediate recommend probe.
  const failing = baseline.floorDebt ? failingFloorDebt(baseline.floorDebt).length : 0;
  if (failing === 0) return null;
  return `Floor debt:  ${failing} failing correctness check(s) grandfathered (build/tests) — \`vyuh-dxkit debt\` for the repair inventory`;
}

function verdictBanner(result: GuardrailCheckResult): string {
  const extra = extraGateTallies(result);
  if (result.blocks) {
    const count = result.pairs.filter(isBlocking).length + extra.block;
    return logger.bold(`Guardrail BLOCKED — ${count} new regression${count === 1 ? '' : 's'}`);
  }
  const unattributable = result.attributionGaps.reduce((n, g) => n + g.findingCount, 0);
  if (unattributable > 0) {
    // The refusal tier: neither "BLOCKED" (would misattribute) nor "PASSED"
    // (would certify what dxkit cannot verify). Same treatment as the
    // identity-scheme mismatch — refuse, name the gap, exit 1.
    const kinds = result.attributionGaps.map((g) => g.kind).join(', ');
    return logger.bold(
      `Guardrail CANNOT GATE — ${unattributable} finding${unattributable === 1 ? '' : 's'} on ` +
        `block-rule kind${result.attributionGaps.length === 1 ? '' : 's'} (${kinds}) cannot be attributed`,
    );
  }
  if (result.warns) {
    const count = result.pairs.filter(isWarning).length + extra.warn;
    return logger.bold(`Guardrail PASSED — ${count} warning${count === 1 ? '' : 's'}`);
  }
  return logger.bold('Guardrail PASSED');
}

/** The finding's durable fingerprint (current side for added/persisted; prior
 *  side for removed) — the `--fingerprint` value `allowlist add` expects. */
function pairFingerprint(p: ClassifiedPair): string | undefined {
  return p.pair.currentId ?? p.pair.priorId;
}

function formatPairLines(p: ClassifiedPair, indent: string): string[] {
  const out: string[] = [];
  const loc = locatorProse(p);
  const sev = p.severity ? `[${p.severity}]` : '';
  const conf = p.pair.confidence < 1 ? ` (${p.pair.confidence.toFixed(2)})` : '';
  out.push(
    `${indent}${statusLabel(p.classification.status)} ${sev} ${p.kind} ${loc}${conf}`
      .replace(/\s+/g, ' ')
      .trim(),
  );
  for (const r of p.classification.reasons) {
    out.push(`${indent}  · ${r.code}: ${r.detail}`);
  }
  // The fingerprint, so a reviewer can copy-paste it straight into
  // `allowlist add --fingerprint=<id>` without digging through the JSON report.
  const fp = pairFingerprint(p);
  if (fp) out.push(`${indent}  · fingerprint: ${fp}  (allowlist add --fingerprint=${fp})`);
  if (p.suppressedByAllowlist) {
    const exp = p.suppressedByAllowlist.expiresAt
      ? `, expires ${p.suppressedByAllowlist.expiresAt}`
      : '';
    out.push(
      `${indent}  · allowlisted: ${p.suppressedByAllowlist.category}${exp} (waived from the verdict)`,
    );
  }
  return out;
}

/**
 * Collapse a group of `config_drift` warning pairs into ONE summary line (gh
 * #157). The count is the headline; when some are the dimension-newly-measured
 * case (a gate was just enabled), that truer cause is named so a reviewer looks
 * in the right place instead of chasing "policy changed". Points at `--json` for
 * the un-collapsed per-finding payload.
 */
/**
 * Collapse `tooling_drift` warning pairs into ONE summary block per KIND
 * (VERIFY-39 F-6). On a brownfield repo whose baseline predates the current
 * recall context — a dxkit upgrade, a plugin bump, lint newly enabled — the
 * ENTIRE backlog demotes to tooling-drift at once: a real repo produced
 * 18,396 four-line drift blocks (73,665 lines of console output) that buried
 * the one unattributable block-rule finding driving the verdict. Every block
 * said the same cause and the same remedy, so itemizing them adds nothing a
 * reader can act on. One block per kind carries everything actionable: the
 * count, the shared cause, one exemplar, and the pointer at `--json` for the
 * full per-finding payload (which is NOT collapsed). Sibling of the
 * `config_drift` collapse above (gh #157) — same disease, one status over.
 */
export function formatToolingDriftSummary(
  drift: ReadonlyArray<ClassifiedPair>,
  indent: string,
): string[] {
  const byKind = new Map<string, ClassifiedPair[]>();
  for (const p of drift) {
    const list = byKind.get(p.kind) ?? [];
    list.push(p);
    byKind.set(p.kind, list);
  }
  const out: string[] = [];
  for (const [kind, pairs] of byKind) {
    const n = pairs.length;
    const cause =
      pairs[0].classification.reasons.find((r) => r.code === 'tooling-drift')?.detail ??
      'what dxkit can see for this kind changed between runs';
    out.push(
      `${indent}${n} ${kind} finding${n === 1 ? '' : 's'} demoted to TOOLING-DRIFT — ${cause}`,
    );
    const exemplar = pairs[0];
    const where = locatorProse(exemplar);
    if (where) out.push(`${indent}  · e.g. ${where}`);
  }
  out.push(
    `${indent}  · Not attributable to this diff, so these warn and never block. ` +
      `Re-run with --json for the full per-finding list; re-baseline (from CI) to restore attribution.`,
  );
  return out;
}

export function formatDriftWarningSummary(
  drift: ReadonlyArray<ClassifiedPair>,
  indent: string,
): string[] {
  const gateEnabled = drift.filter((p) =>
    p.classification.reasons.some((r) => r.code === 'dimension-newly-measured'),
  ).length;
  const n = drift.length;
  const breakdown =
    gateEnabled > 0
      ? gateEnabled === n
        ? ` (a gate/dimension was newly enabled — its pre-existing findings read as net-new)`
        : ` (${gateEnabled} from a newly-enabled gate/dimension)`
      : ` (a dxkit upgrade or policy/config change shifted the envelope)`;
  return [
    `${indent}${n} finding${n === 1 ? '' : 's'} unmatched after an envelope change${breakdown}.`,
    `${indent}  · Not necessarily net-new — re-run with --json to inspect each, or re-capture the baseline if it is stale.`,
  ];
}

/**
 * The honest-attribution note under a blocking list that contains newly
 * published advisories (D4): states the PR did not cause them and names both
 * lanes as one-command remedies. Empty when none are present. Exported for
 * unit testing (the `formatDriftWarningSummary` pattern).
 */
export function newlyPublishedAdvisoryNote(
  blocking: ReadonlyArray<ClassifiedPair>,
  indent: string,
): string[] {
  const advisories = blocking.filter((p) => p.classification.status === 'newly_published_advisory');
  if (advisories.length === 0) return [];
  return [
    `${indent}${advisories.length} of the blocking finding${blocking.length === 1 ? '' : 's'} ` +
      `${advisories.length === 1 ? 'is a newly published advisory' : 'are newly published advisories'} — ` +
      `not introduced by this PR (no dependency manifest changed; published after baseline capture).`,
    `${indent}  · fix lane: upgrade/patch the dependency — that is what unblocks`,
    `${indent}  · defer lane (time-sensitive change): vyuh-dxkit allowlist defer --from-last-check --reason="…" ` +
      `(time-boxed; expires in ${DEFER_ADVISORY_EXPIRY_DAYS} days by default)`,
  ];
}

/** Markdown sibling of `newlyPublishedAdvisoryNote` — the blockquote above the
 *  blocking table. Exported for unit testing. */
export function markdownNewlyPublishedAdvisoryNote(
  blocking: ReadonlyArray<ClassifiedPair>,
): string[] {
  const advisories = blocking.filter((p) => p.classification.status === 'newly_published_advisory');
  if (advisories.length === 0) return [];
  const head =
    advisories.length === blocking.length
      ? advisories.length === 1
        ? 'This blocking finding is a newly published advisory'
        : `All ${advisories.length} blocking findings are newly published advisories`
      : `${advisories.length} of these ${blocking.length} blocking findings ` +
        `${advisories.length === 1 ? 'is a newly published advisory' : 'are newly published advisories'}`;
  return [
    `> **${head}** — ` +
      `not introduced by this PR: the diff touches no dependency manifest, so they were ` +
      `published to the advisory feed after the baseline was captured. Two lanes: **fix** the ` +
      `vulnerabilities (that is what unblocks), or **defer time-boxed** when the change is ` +
      'time-sensitive: `vyuh-dxkit allowlist defer --from-last-check --reason="…"` (expires in ' +
      `${DEFER_ADVISORY_EXPIRY_DAYS} days by default — the expiry forces the fix lane).`,
    '',
  ];
}

/** How many fingerprints the comment-defer reply hint spells out before
 *  pointing at the bulk form — a hint is a doorway, not an inventory. */
const COMMENT_DEFER_HINT_MAX_FPS = 8;

/**
 * The PR-comment reply hint under the blocking table: when this repo has the
 * `/dxkit defer` comment workflow installed, print the exact reply a
 * maintainer can post to time-box the blocking findings — real fingerprints
 * filled in, copy-paste ready. The lane exists precisely for this moment; a
 * reviewer staring at a blocked PR should not need to know the grammar by
 * heart or leave the conversation.
 *
 * Any blocking finding is deferrable (the repo's owners hold the policy — a
 * write-access reviewer could land the same allowlist entry by hand); what
 * the platform keeps is the honesty mechanics: time-boxed always, commenter
 * attributed, visible in the allowlist delta. The hint never appears on a
 * repo without the workflow (a dead hint teaches commands that do nothing).
 * Exported for unit testing.
 */
export function markdownCommentDeferHint(
  result: Pick<GuardrailCheckResult, 'commentDeferInstalled'>,
  blocking: ReadonlyArray<ClassifiedPair>,
): string[] {
  if (!result.commentDeferInstalled) return [];
  const fps = blocking.map(pairFingerprint).filter((fp): fp is string => fp !== undefined);
  if (fps.length === 0) return [];
  const shown = fps.slice(0, COMMENT_DEFER_HINT_MAX_FPS);
  const findings = `finding${fps.length === 1 ? '' : 's'}`;
  const overflow =
    fps.length > shown.length
      ? ` (first ${shown.length} of ${fps.length} — every fingerprint is in the table above)`
      : '';
  return [
    `> 💬 **Defer from this conversation** — a maintainer can reply` +
      ` \`/dxkit defer ${shown.join(' ')} --reason="…"\`` +
      ` to time-box the ${fps.length === 1 ? '' : `${fps.length} `}blocking ${findings}${overflow}, ` +
      `or \`/dxkit defer --new-advisories\` for every dependency advisory published since ` +
      `the baseline. Expires in ${DEFER_ADVISORY_EXPIRY_DAYS} days by default — the expiry is ` +
      `the forcing function; fixing the findings is what actually unblocks.`,
    '',
  ];
}

function statusLabel(status: FindingStatus): string {
  switch (status) {
    case 'added':
      return 'ADDED';
    case 'removed':
      return 'RESOLVED';
    case 'persisted':
      return 'PERSISTED';
    case 'relocated':
      return 'RELOCATED';
    case 'tooling_drift':
      return 'TOOLING-DRIFT';
    case 'config_drift':
      return 'CONFIG-DRIFT';
    case 'newly_published_advisory':
      return 'NEWLY-PUBLISHED-ADVISORY';
    case 'newly_detected':
      return 'NEWLY-DETECTED';
    case 'probable_existing':
      return 'PROBABLE-EXISTING';
    case 'uncertain':
      return 'UNCERTAIN';
    case 'fixed':
      return 'FIXED';
    case 'not_observed':
      return 'NOT-OBSERVED';
  }
}

function locatorProse(p: ClassifiedPair): string {
  // Kind-aware location descriptor, computed once at classification time
  // (`describeEntryLocation`): `file:line` for located kinds, `package@version ·
  // advisory-id` for dep-vulns (which have no file:line — the `Location: —`
  // rows). Falls back to the file:line locator for any pair without a precomputed
  // descriptor (defensive).
  if (p.locator) return p.locator;
  if (p.file === undefined) return '';
  return p.line !== undefined && p.line > 0 ? `${p.file}:${p.line}` : p.file;
}

function shortSha(sha: string): string {
  if (!sha) return '(no-commit)';
  return sha.slice(0, 8);
}

function formatDrift(drift: EnvelopeDrift): string[] {
  const out: string[] = [];
  if (drift.dxkitVersionChanged) out.push('dxkit version changed since baseline capture');
  if (drift.toolchainHashChanged) out.push('toolchainHash changed');
  if (drift.policyHashChanged) out.push('policy hash changed');
  if (drift.ignoreHashChanged) out.push('.dxkit-ignore changed');
  if (drift.configHashChanged) out.push('.vyuh-dxkit.json changed');
  for (const d of drift.toolVersionDiffs) {
    // An EMPTY-string value is a real recorded value (e.g. `licenses.prohibited`
    // with an empty list), distinct from `(absent)` — but rendered bare it
    // reads as a truncated line ("… → "). Name it.
    const show = (v: string | undefined): string =>
      v === undefined ? '(absent)' : v === '' ? '(empty)' : v;
    out.push(`tool drift: ${d.tool} ${show(d.baselineVersion)} → ${show(d.currentVersion)}`);
  }
  // Recall drift (CLAUDE.md Rule 19) — the load-bearing disclosure. A drifted
  // kind's net-new findings are NOT attributable to the diff, so they warn
  // instead of blocking. That is a real reduction in what the gate enforces, so
  // it must never be silent: name the kind, the evidence, and the remedy. Same
  // discipline as `GateFailure` (3.7.1) — a fail-open gate always says why.
  for (const d of drift.recallDrift) {
    out.push(`cannot attribute ${describeRecallDrift(d)}`);
  }
  if (drift.recallDrift.length > 0) {
    out.push(
      `${drift.recallDrift.length} kind(s) not attributable — ${recallDriftRemedy(drift.baselineCapturedIn)}`,
    );
  }
  for (const d of drift.coverageDrift) {
    if (!d.baselineAvailable && d.currentAvailable) {
      out.push(
        `coverage drift: ${d.tool} was NOT available when the baseline was captured ` +
          `but is now — that category was never baselined, so its findings may surface as new`,
      );
    } else if (d.baselineAvailable && !d.currentAvailable) {
      out.push(
        `coverage drift: ${d.tool} was available at baseline but is missing now — ` +
          `this check can't re-verify that category`,
      );
    }
  }
  return out;
}

/** Markdown Resolved-table row cap. The count in the summary line is exact;
 *  the table shows a sample so a batch cleanup cannot push the comment past
 *  GitHub's 65,536-byte limit (a real PR comment hit 60,143 bytes of mostly
 *  this table). */
const MAX_RESOLVED_ROWS = 100;

// ─── JSON renderer ────────────────────────────────────────────────────────

export const GUARDRAIL_JSON_SCHEMA = 'dxkit.guardrail-check.v1' as const;

/**
 * Schema-stable machine-readable payload. `schema` at the top level
 * lets downstream tooling version-gate before reading further fields;
 * bump it when the shape changes incompatibly.
 */
export interface GuardrailJsonPayload {
  readonly schema: typeof GUARDRAIL_JSON_SCHEMA;
  readonly verdict: {
    readonly blocks: boolean;
    readonly warns: boolean;
    /** True when the run REFUSED to gate: block-rule-class findings exist
     *  that recall drift made unattributable, so neither "no net-new" nor
     *  "developer-introduced" can honestly be claimed. Maps to `CANNOT GATE`
     *  and exit 1. Consumers deciding pass/fail must treat this as a fail
     *  that is NOT the diff's fault — the remedy is re-baselining, not a
     *  code fix (see `attributionGaps`). */
    readonly refused: boolean;
    readonly exitCode: 0 | 1;
  };
  /** Per-kind evidence behind `verdict.refused` — which block rules were
   *  disarmed, how many findings, and which recall input moved. Empty on a
   *  healthy run. */
  readonly attributionGaps: ReadonlyArray<AttributionGap>;
  /** What this run's ACTIVE allowlist suppressions will do when their windows
   *  close: how many would block, how many would warn, and how soon. ALWAYS
   *  present (`lapsing: []` when nothing expires inside the horizon), so an
   *  agent can read it without probing for the field. Never affects
   *  `verdict` — a lapse that has not happened yet is not a regression, and
   *  the finding is re-classified on the run after it lapses. */
  readonly suppressionExpiry: ExpiryProjection;
  /** Baseline findings the current side never re-verified, per unobserved
   *  check (aggregate counts, never per-finding rows). ALWAYS present
   *  (`[]` when everything was observed) so an agent can tell "nothing
   *  unobserved" from "nobody said". Their pairs carry status
   *  `not_observed` — excluded from `summary.resolved`. */
  readonly notObserved: ReadonlyArray<NotObservedDisclosure>;
  /** Present when the dependency-vuln scan was requested but could not run —
   *  a pass is then NOT a clean bill of dependency health. */
  readonly depVulnsUnmeasured?: { readonly reason: string };
  /** Present when the committed baseline was captured with classes deferred to
   *  CI (CLAUDE.md Rule 20). A pass does NOT yet verify these classes — they are
   *  completing on CI. Absent on a complete capture and in ref-based mode. */
  readonly deferredCapture?: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly reason: string;
    readonly cause: 'scanner-missing' | 'unmet-requirement';
  }>;
  readonly baseline: {
    /** Absent when the run used `ref-based` mode (no on-disk
     *  baseline file). */
    readonly path?: string;
    readonly name: string;
    readonly createdAt: string;
    readonly commitSha: string;
    readonly branch: string;
    readonly findingsCount: number;
    /** D4d: under the `branch` anchor transport, which file actually loaded —
     *  the side-branch anchor, or the tree copy as a disclosed fallback. */
    readonly anchorSource?: AnchorSourceDisclosure;
    /** Resolved baseline mode (`committed-full` / `committed-
     *  sanitized` / `ref-based`) + its audit trail. Surfaced so
     *  agents + dashboards can see WHY the run picked a given
     *  posture without re-deriving from policy + visibility. */
    readonly mode: {
      readonly value: 'committed-full' | 'committed-sanitized' | 'ref-based';
      readonly source: string;
      readonly explanation: string;
      readonly ref?: string;
    };
  };
  readonly current: {
    readonly commitSha: string;
    readonly branch: string;
    readonly findingsCount: number;
  };
  readonly matcher: {
    readonly gitAware: boolean;
    readonly degradedReason?: string;
  };
  readonly envelopeDrift: EnvelopeDrift;
  readonly policy: {
    readonly mode: BrownfieldPolicy['mode'];
    readonly block: ReadonlyArray<FindingStatus>;
    readonly warn: ReadonlyArray<FindingStatus>;
    readonly confidence: BrownfieldPolicy['confidence'];
    readonly blockRules: BrownfieldPolicy['blockRules'];
  };
  readonly summary: {
    readonly pairs: number;
    readonly blocking: number;
    /** Pairs the classifier would block but an active allowlist entry
     *  waived. Excluded from `blocking`; surfaced for review. */
    readonly suppressed: number;
    readonly warning: number;
    readonly persisted: number;
    readonly resolved: number;
    /** Pairs classified `not_observed` — see the top-level `notObserved`. */
    readonly notObserved: number;
  };
  readonly pairs: ReadonlyArray<{
    readonly status: FindingStatus;
    readonly blocks: boolean;
    readonly warns: boolean;
    /** Present when this finding forces the refusal tier — the armed block
     *  rule that would have tested it, had recall drift not made it
     *  unattributable. */
    readonly unattributableBlockRule?: string;
    readonly priorId?: string;
    readonly currentId?: string;
    readonly confidence: number;
    readonly kind: string;
    readonly severity?: string;
    readonly file?: string;
    readonly line?: number;
    readonly overlapsChangedLines?: boolean;
    /** Present when an active allowlist entry waived this pair from the
     *  verdict. `blocks` stays true (the classifier's view); consumers
     *  deciding pass/fail must treat a pair with this field as
     *  non-blocking — mirror of the top-level `verdict`. */
    readonly suppressedByAllowlist?: {
      readonly fingerprint: string;
      readonly category: string;
      readonly expiresAt?: string;
    };
    readonly reasons: ReadonlyArray<MatchReason>;
  }>;
  /** The flow integration gate — net-new UI→API breakages from the base↔HEAD
   *  contract diff. Absent in committed modes (the gate runs only ref-based).
   *  When present but `ran` is false, `skipped` says why (e.g. no flow-surface
   *  change, no served-side truth). */
  readonly flowGate?: {
    readonly ran: boolean;
    readonly skipped?: string;
    /** Present when `skipped === 'error'` — the step that threw + a clean
     *  message. A fail-open error is disclosed, never a silent `skipped:"error"`. */
    readonly error?: { readonly step: string; readonly message: string };
    readonly mode: string;
    readonly blocks: boolean;
    readonly warns: boolean;
    readonly findings: ReadonlyArray<{
      readonly id: string;
      readonly method: string;
      readonly path: string;
      readonly file: string;
      readonly line: number;
      readonly confidence: number;
      readonly reason: string;
      readonly verdict: 'block' | 'warn';
    }>;
    /** Broken integrations an active allowlist entry waived — excluded from
     *  `blocks` / `warns`, surfaced for audit. */
    readonly suppressed: ReadonlyArray<{
      readonly id: string;
      readonly method: string;
      readonly path: string;
      readonly file: string;
      readonly line: number;
      readonly reason: string;
      readonly category: string;
      readonly expiresAt?: string;
    }>;
  };
  /** The model-schema drift gate — net-new breaking model changes from the
   *  base↔HEAD diff. Absent when the gate is off (the default) or no base
   *  commit was resolvable. `info` findings are disclosure-only. */
  readonly schemaDriftGate?: {
    readonly ran: boolean;
    readonly skipped?: string;
    readonly error?: { readonly step: string; readonly message: string };
    readonly mode: string;
    readonly blocks: boolean;
    readonly warns: boolean;
    readonly findings: ReadonlyArray<{
      readonly id: string;
      readonly changeClass: string;
      readonly model: string;
      readonly field: string | null;
      readonly from: string | null;
      readonly to: string | null;
      readonly file: string;
      readonly line: number;
      readonly confidence: number;
      readonly verdict: 'block' | 'warn' | 'info';
    }>;
    readonly suppressed: ReadonlyArray<{
      readonly id: string;
      readonly changeClass: string;
      readonly model: string;
      readonly field: string | null;
      readonly file: string;
      readonly line: number;
      readonly category: string;
      readonly expiresAt?: string;
    }>;
  };
  /** The structural-duplicate (seam) gate — net-new code-reimplementation pairs
   *  from the base↔HEAD diff. Absent when the gate is off (the default — it
   *  builds the code graph) or no base commit was resolvable. All warn-tier. */
  readonly dupGate?: {
    readonly ran: boolean;
    readonly skipped?: string;
    readonly error?: { readonly step: string; readonly message: string };
    readonly mode: string;
    readonly blocks: boolean;
    readonly warns: boolean;
    readonly findings: ReadonlyArray<{
      readonly id: string;
      readonly score: number;
      readonly anchors: ReadonlyArray<{
        readonly file: string;
        readonly symbol: string;
        readonly line: number;
        /** True when this anchor's file was touched by the change — the side the
         *  diff introduced (the one to consolidate). Absent on an unscoped run. */
        readonly changed?: boolean;
      }>;
    }>;
    readonly suppressed: ReadonlyArray<{
      readonly id: string;
      readonly category: string;
      readonly expiresAt?: string;
    }>;
  };
  /** The paired-change gate — declared "changing X requires also changing Y"
   *  rules the diff violated. Absent when the gate is off (no rules) or no
   *  base commit was resolvable. */
  readonly pairedGate?: {
    readonly ran: boolean;
    readonly skipped?: string;
    readonly error?: { readonly step: string; readonly message: string };
    readonly blocks: boolean;
    readonly warns: boolean;
    readonly warnings: ReadonlyArray<string>;
    readonly findings: ReadonlyArray<{
      readonly id: string;
      readonly check: string;
      readonly blocking: boolean;
      readonly message?: string;
      readonly ifMatched: ReadonlyArray<string>;
      readonly thenGlobs: ReadonlyArray<string>;
    }>;
    readonly suppressed: ReadonlyArray<{
      readonly id: string;
      readonly check: string;
      readonly category: string;
      readonly expiresAt?: string;
    }>;
  };
}

export function renderJson(result: GuardrailCheckResult): GuardrailJsonPayload {
  const blocking = result.pairs.filter(isBlocking).length;
  const suppressed = result.pairs.filter(isAllowlistSuppressed).length;
  const warning = result.pairs.filter(isWarning).length;
  const persisted = result.pairs.filter(
    (p) =>
      !p.classification.blocks &&
      !p.classification.warns &&
      (p.classification.status === 'persisted' || p.classification.status === 'relocated'),
  ).length;
  const resolved = result.pairs.filter((p) => p.classification.status === 'removed').length;
  const counts = verdictCounts(result);

  return {
    schema: GUARDRAIL_JSON_SCHEMA,
    verdict: {
      blocks: result.blocks,
      warns: result.warns,
      refused: counts.verdict === 'CANNOT GATE',
      exitCode: counts.exitCode,
    },
    attributionGaps: result.attributionGaps,
    suppressionExpiry: result.suppressionExpiry,
    // Baseline findings the current side never re-verified (per unobserved
    // check, aggregate counts). Always present — an agent reading the JSON
    // must be able to tell "nothing unobserved" from "nobody said".
    notObserved: result.notObserved,
    ...(result.depVulnsUnmeasured ? { depVulnsUnmeasured: result.depVulnsUnmeasured } : {}),
    ...(result.deferredCapture && result.deferredCapture.length > 0
      ? { deferredCapture: result.deferredCapture }
      : {}),
    baseline: {
      ...(result.baselinePath !== undefined ? { path: result.baselinePath } : {}),
      name: result.baseline.name,
      createdAt: result.baseline.createdAt,
      commitSha: result.baseline.repo.commitSha,
      branch: result.baseline.repo.branch,
      findingsCount: result.baseline.findings.length,
      ...(result.anchorSource ? { anchorSource: result.anchorSource } : {}),
      mode: {
        value: result.mode.mode,
        source: result.mode.source,
        explanation: result.mode.explanation,
        ...(result.mode.ref !== undefined ? { ref: result.mode.ref } : {}),
      },
    },
    current: {
      commitSha: result.current.repoState.commitSha,
      branch: result.current.repoState.branch,
      findingsCount: result.current.findings.length,
    },
    matcher: {
      gitAware: result.matchResult.gitAware,
      ...(result.matchResult.degradedReason
        ? { degradedReason: result.matchResult.degradedReason }
        : {}),
    },
    envelopeDrift: result.envelopeDrift,
    policy: {
      mode: result.policy.mode,
      block: result.policy.block,
      warn: result.policy.warn,
      confidence: result.policy.confidence,
      blockRules: result.policy.blockRules,
    },
    summary: {
      pairs: result.pairs.length,
      blocking,
      suppressed,
      warning,
      persisted,
      resolved,
      notObserved: notObservedPairCount(result),
    },
    pairs: result.pairs.map((p) => ({
      status: p.classification.status,
      blocks: p.classification.blocks,
      warns: p.classification.warns,
      ...(p.classification.unattributableBlockRule !== undefined
        ? { unattributableBlockRule: p.classification.unattributableBlockRule }
        : {}),
      ...(p.pair.priorId !== undefined ? { priorId: p.pair.priorId } : {}),
      ...(p.pair.currentId !== undefined ? { currentId: p.pair.currentId } : {}),
      confidence: p.pair.confidence,
      kind: p.kind,
      ...(p.severity !== undefined ? { severity: p.severity } : {}),
      ...(p.file !== undefined ? { file: p.file } : {}),
      ...(p.line !== undefined ? { line: p.line } : {}),
      // Kind-aware location descriptor (`package@version · advisory-id` for
      // dep-vulns, `file:line` otherwise) so JSON consumers get a finding's
      // identity without re-deriving it.
      ...(p.locator !== undefined ? { locator: p.locator } : {}),
      ...(p.overlapsChangedLines !== undefined
        ? { overlapsChangedLines: p.overlapsChangedLines }
        : {}),
      ...(p.suppressedByAllowlist !== undefined
        ? { suppressedByAllowlist: p.suppressedByAllowlist }
        : {}),
      reasons: p.classification.reasons,
    })),
    ...(result.flowGate !== undefined
      ? {
          flowGate: {
            ran: result.flowGate.ran,
            ...(result.flowGate.skipped !== undefined ? { skipped: result.flowGate.skipped } : {}),
            ...(result.flowGate.error !== undefined ? { error: result.flowGate.error } : {}),
            mode: result.flowGate.mode,
            blocks: result.flowGate.blocks,
            warns: result.flowGate.warns,
            findings: result.flowGate.findings.map((f) => ({
              id: f.id,
              method: f.method,
              path: f.path,
              file: f.file,
              line: f.line,
              confidence: f.confidence,
              reason: f.reason,
              verdict: f.verdict,
            })),
            suppressed: (result.flowGate.suppressed ?? []).map((s) => ({
              id: s.finding.id,
              method: s.finding.method,
              path: s.finding.path,
              file: s.finding.file,
              line: s.finding.line,
              reason: s.finding.reason,
              category: s.category,
              ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
            })),
          },
        }
      : {}),
    ...(result.schemaDriftGate !== undefined
      ? {
          schemaDriftGate: {
            ran: result.schemaDriftGate.ran,
            ...(result.schemaDriftGate.skipped !== undefined
              ? { skipped: result.schemaDriftGate.skipped }
              : {}),
            ...(result.schemaDriftGate.error !== undefined
              ? { error: result.schemaDriftGate.error }
              : {}),
            mode: result.schemaDriftGate.mode,
            blocks: result.schemaDriftGate.blocks,
            warns: result.schemaDriftGate.warns,
            findings: result.schemaDriftGate.findings.map((f) => ({
              id: f.id,
              changeClass: f.changeClass,
              model: f.model,
              field: f.field,
              from: f.from,
              to: f.to,
              file: f.file,
              line: f.line,
              confidence: f.confidence,
              verdict: f.verdict,
            })),
            suppressed: (result.schemaDriftGate.suppressed ?? []).map((s) => ({
              id: s.finding.id,
              changeClass: s.finding.changeClass,
              model: s.finding.model,
              field: s.finding.field,
              file: s.finding.file,
              line: s.finding.line,
              category: s.category,
              ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
            })),
          },
        }
      : {}),
    ...(result.dupGate !== undefined
      ? {
          dupGate: {
            ran: result.dupGate.ran,
            ...(result.dupGate.skipped !== undefined ? { skipped: result.dupGate.skipped } : {}),
            ...(result.dupGate.error !== undefined ? { error: result.dupGate.error } : {}),
            mode: result.dupGate.mode,
            blocks: result.dupGate.blocks,
            warns: result.dupGate.warns,
            findings: result.dupGate.findings.map((f) => ({
              id: f.id,
              score: f.score,
              anchors: f.anchors.map((a, idx) => ({
                file: a.file,
                symbol: a.symbol,
                line: a.line,
                ...(f.changed ? { changed: f.changed[idx] } : {}),
              })),
            })),
            suppressed: (result.dupGate.suppressed ?? []).map((s) => ({
              id: s.finding.id,
              category: s.category,
              ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
            })),
          },
        }
      : {}),
    ...(result.pairedGate !== undefined
      ? {
          pairedGate: {
            ran: result.pairedGate.ran,
            ...(result.pairedGate.skipped !== undefined
              ? { skipped: result.pairedGate.skipped }
              : {}),
            ...(result.pairedGate.error !== undefined ? { error: result.pairedGate.error } : {}),
            blocks: result.pairedGate.blocks,
            warns: result.pairedGate.warns,
            warnings: [...result.pairedGate.warnings],
            findings: result.pairedGate.findings.map((f) => ({
              id: f.id,
              check: f.check,
              blocking: f.blocking,
              ...(f.message !== undefined ? { message: f.message } : {}),
              ifMatched: [...f.ifMatched],
              thenGlobs: [...f.thenGlobs],
            })),
            suppressed: (result.pairedGate.suppressed ?? []).map((s) => ({
              id: s.finding.id,
              check: s.finding.check,
              category: s.category,
              ...(s.expiresAt !== undefined ? { expiresAt: s.expiresAt } : {}),
            })),
          },
        }
      : {}),
  };
}

// ─── Markdown renderer ────────────────────────────────────────────────────

/**
 * PR-comment-friendly markdown. Phase 4's GitHub Actions workflow
 * pastes the output verbatim into a PR comment. Format:
 *
 *   ## Guardrail: PASSED / BLOCKED
 *   one-line summary
 *   <blocking findings table, when any>
 *   <warnings collapsible section, when any>
 *   <drift signal callout, when envelope drifted>
 *   <provenance footnote>
 */
export function renderMarkdown(result: GuardrailCheckResult): string {
  const lines: string[] = [];
  const blocking = result.pairs.filter(isBlocking);
  const suppressed = result.pairs.filter(isAllowlistSuppressed);
  const warning = result.pairs.filter(isWarning);
  const resolved = result.pairs.filter((p) => p.classification.status === 'removed');
  const unattributable = result.pairs.filter(isUnattributable);

  // Verdict from the ONE derivation — the PR-comment heading must never say
  // PASSED over an attribution gap.
  const counts = verdictCounts(result);
  lines.push(`## Guardrail: ${counts.verdict}`);
  lines.push('');
  const extra = extraGateTallies(result);
  lines.push(
    summarySentence(
      result,
      blocking.length + extra.block,
      warning.length + extra.warn,
      resolved.length,
    ),
  );
  lines.push('');

  if (result.attributionGaps.length > 0) {
    lines.push(
      `> ⚠️ **Cannot attribute ${counts.unattributable} finding${counts.unattributable === 1 ? '' : 's'} ` +
        `covered by block rules** — the guardrail refuses to pass rather than certify what it ` +
        `cannot verify.`,
    );
    for (const gap of result.attributionGaps) {
      lines.push(`> - ${escapeMd(describeAttributionGap(gap))}`);
    }
    lines.push(`> - Remedy: ${escapeMd(ATTRIBUTION_GAP_REMEDY)}`);
    lines.push('');
    if (unattributable.length > 0) {
      lines.push('### Unattributable findings');
      lines.push('');
      lines.push('| Status | Kind | Severity | Location | Fingerprint | Reason |');
      lines.push('|---|---|---|---|---|---|');
      for (const p of unattributable) lines.push(markdownPairRow(p));
      lines.push('');
    }
  }

  if (result.depVulnsUnmeasured) {
    lines.push(
      `> ⚠️ **Dependency audit UNMEASURED** — ${result.depVulnsUnmeasured.reason}. ` +
        `A pass here does **not** mean "no net-new dependency vulnerabilities": the scan ` +
        `could not run, so zero dep findings are unverified. ` +
        depVulnsUnmeasuredRemediation(result.depVulnsUnmeasured.reason),
    );
    lines.push('');
  }

  // Rule 19's REMOVED direction: what this run never looked at, said loudly in
  // the PR comment — one aggregate line per unobserved check. The class this
  // kills: an untrusted run skipped lint and the comment reported the repo's
  // entire 18,406-finding backlog as "Resolved".
  if (result.notObserved.length > 0) {
    const total = result.notObserved.reduce((n, d) => n + d.count, 0);
    lines.push(
      `> ⚠️ **${total} baseline finding${total === 1 ? '' : 's'} not re-verified this run** — ` +
        `their check did not execute here, so they are reported as *not observed*, ` +
        `never as resolved. A pass does **not** re-verify them; trusted surfaces ` +
        `(the default-branch refresh, pre-push, a local run) remain the backstop.`,
    );
    for (const d of result.notObserved) {
      lines.push(
        `> - ${escapeMd(d.kind)} ${escapeMd(d.reason)} — ${d.count} ` +
          `finding${d.count === 1 ? '' : 's'}`,
      );
    }
    lines.push('');
  }

  if (result.refExcludedKinds.length > 0) {
    const detail = result.refExcludedKinds.map((e) => `${e.currentCount} ${e.kind}`).join(', ');
    lines.push(
      `> ℹ️ ref-based mode does not gate **${detail}** — these depend on build ` +
        `artifacts (\`node_modules\` / coverage) not present at a bare git ref. ` +
        `Switch \`.dxkit/policy.json\` to \`committed-full\` to gate them.`,
    );
    lines.push('');
  }

  {
    const banner = deferredCaptureBannerLines(result);
    if (banner.length > 0) {
      lines.push(`> ⚠️ **${banner[0]}** ${banner.slice(1).join(' ')}`);
      lines.push('');
    }
  }

  if (blocking.length > 0) {
    lines.push('### Blocking findings');
    lines.push('');
    lines.push(...markdownNewlyPublishedAdvisoryNote(blocking));
    lines.push('| Status | Kind | Severity | Location | Fingerprint | Reason |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of blocking) lines.push(markdownPairRow(p));
    lines.push('');
    lines.push(...markdownCommentDeferHint(result, blocking));
  }

  lines.push(...markdownFlowGate(result.flowGate));
  lines.push(...markdownSchemaDriftGate(result.schemaDriftGate));
  lines.push(...markdownDupGate(result.dupGate));
  lines.push(...markdownPairedGate(result.pairedGate));

  if (suppressed.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>Suppressed by allowlist (${suppressed.length})</summary>`);
    lines.push('');
    lines.push(
      'These findings would block, but an active allowlist entry accepted them. ' +
        'Review the category + expiry before approving.',
    );
    lines.push('');
    lines.push('| Status | Kind | Severity | Location | Category | Expires |');
    lines.push('|---|---|---|---|---|---|');
    for (const p of suppressed) {
      const s = p.suppressedByAllowlist;
      lines.push(
        `| ${escapeMd(statusLabel(p.classification.status))} | ${escapeMd(p.kind)} | ` +
          `${escapeMd(p.severity ?? '—')} | ${escapeMd(locatorProse(p) || '—')} | ` +
          `${escapeMd(s?.category ?? '—')} | ${escapeMd(s?.expiresAt ?? '—')} |`,
      );
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  lines.push(...markdownExpiryProjection(result.suppressionExpiry));

  if (warning.length > 0) {
    // Collapse the envelope-drift wall (gh #157): the drift group becomes one
    // summary line above the table, and only the specific warnings are tabled.
    const driftWarn = warning.filter((p) => p.classification.status === 'config_drift');
    // Tooling drift collapses per KIND (VERIFY-39 F-6) — a brownfield upgrade
    // demotes the whole backlog at once, and a PR body must not carry an
    // 18k-row warnings table.
    const toolingDriftWarn = warning.filter((p) => p.classification.status === 'tooling_drift');
    const specificWarn = warning.filter(
      (p) =>
        p.classification.status !== 'config_drift' && p.classification.status !== 'tooling_drift',
    );
    if (toolingDriftWarn.length > 0) {
      const byKind = new Map<string, number>();
      for (const p of toolingDriftWarn) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
      const perKind = [...byKind.entries()].map(([k, n]) => `${n} ${k}`).join(', ');
      lines.push(
        `> **${toolingDriftWarn.length} finding${toolingDriftWarn.length === 1 ? '' : 's'} demoted ` +
          `to TOOLING-DRIFT** (${perKind}) — what dxkit can see for these kinds changed between ` +
          `the baseline and this scan, so they cannot be attributed to this diff. They warn and ` +
          `never block; see \`--json\` for each, and re-baseline (from CI) to restore attribution.`,
      );
      lines.push('');
    }
    if (driftWarn.length > 0) {
      const gateEnabled = driftWarn.filter((p) =>
        p.classification.reasons.some((r) => r.code === 'dimension-newly-measured'),
      ).length;
      const cause =
        gateEnabled > 0
          ? gateEnabled === driftWarn.length
            ? 'a gate/dimension was newly enabled, so its pre-existing findings read as net-new'
            : `${gateEnabled} are from a newly-enabled gate/dimension`
          : 'a dxkit upgrade or policy/config change shifted the envelope';
      lines.push(
        `> **${driftWarn.length} finding${driftWarn.length === 1 ? '' : 's'} unmatched after an ` +
          `envelope change** — ${cause}. Not necessarily net-new; inspect each with \`--json\` ` +
          `or re-capture the baseline if it is stale.`,
      );
      lines.push('');
    }
    lines.push('<details>');
    lines.push(`<summary>Warnings (${warning.length})</summary>`);
    lines.push('');
    if (specificWarn.length > 0) {
      lines.push('| Status | Kind | Severity | Location | Fingerprint | Reason |');
      lines.push('|---|---|---|---|---|---|');
      for (const p of specificWarn) lines.push(markdownPairRow(p));
      lines.push('');
    }
    if (driftWarn.length > 0 || toolingDriftWarn.length > 0) {
      const parts: string[] = [];
      if (toolingDriftWarn.length > 0) parts.push(`${toolingDriftWarn.length} tooling-drift`);
      if (driftWarn.length > 0) parts.push(`${driftWarn.length} envelope-drift`);
      lines.push(`_${parts.join(' + ')} warning(s) collapsed above; see \`--json\` for each._`);
      lines.push('');
    }
    lines.push('</details>');
    lines.push('');
  }

  const driftLines = formatDrift(result.envelopeDrift);
  if (driftLines.length > 0) {
    lines.push('### Envelope drift');
    lines.push('');
    for (const l of driftLines) lines.push(`- ${l}`);
    lines.push('');
  }

  if (resolved.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>Resolved (${resolved.length})</summary>`);
    lines.push('');
    lines.push('| Kind | Location |');
    lines.push('|---|---|');
    // Row cap: GitHub truncates comments at 65,536 bytes, and a large resolved
    // set (a batch cleanup, a re-baseline) once produced a 60k-byte table that
    // crowded out the verdict. The count above is exact; the rows are a sample.
    for (const p of resolved.slice(0, MAX_RESOLVED_ROWS)) {
      lines.push(`| ${escapeMd(p.kind)} | ${escapeMd(locatorProse(p) || '—')} |`);
    }
    if (resolved.length > MAX_RESOLVED_ROWS) {
      lines.push(
        `| … | ${resolved.length - MAX_RESOLVED_ROWS} more — full list in the job log or \`--json\` |`,
      );
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  const allowlistLines = formatAllowlistDelta(result);
  for (const l of allowlistLines) lines.push(l);

  const mdDebtNote = floorDebtNotice(result.baseline);
  if (mdDebtNote) {
    lines.push('');
    lines.push(`> ℹ️ ${mdDebtNote}`);
    lines.push('');
  }

  // D4d: an unreachable side-branch anchor silently gating against a stale
  // tree copy must be loud in the PR comment, not only in the JSON.
  if (result.anchorSource?.used === 'tree-fallback') {
    lines.push('');
    lines.push(`> ⚠️ **Baseline anchor fallback** — ${escapeMd(result.anchorSource.note)}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `_Baseline_: \`${escapeMd(result.baseline.name)}\` @ ${shortSha(result.baseline.repo.commitSha)}` +
      (result.anchorSource
        ? result.anchorSource.used === 'anchor'
          ? ` (anchor: \`${escapeMd(result.anchorSource.anchorRef)}\`)`
          : ' (tree fallback)'
        : '') +
      ` · _Mode_: \`${escapeMd(result.mode.mode)}\`${formatModeRef(result.mode)} · ` +
      `_Current_: ${shortSha(result.current.repoState.commitSha)} · ` +
      `_Matcher_: ${result.matchResult.gitAware ? 'git-aware' : 'degraded'} · ` +
      `_dxkit_: ${escapeMd(result.current.analysisMeta.dxkitVersion)}`,
  );

  return lines.join('\n');
}

/**
 * Markdown for the flow integration gate. Blocking breakages render as a
 * top-level table (they fail the PR); warnings collapse into a `<details>`.
 * Silent when the gate produced no findings.
 */
/**
 * The lapse projection for the PR comment — the surface that actually closes
 * the delivery gap, since a reviewer reads this and nobody runs `doctor`.
 *
 * A lapse that will BLOCK gets a warning callout (it is about to become
 * somebody's problem, and the somebody is whoever opens the next PR); a
 * warn-only lapse gets an informational one. Detail collapses into `<details>`
 * so a 21-entry deferral does not bury the findings above it. Silent when
 * nothing expires inside the horizon.
 */
function markdownExpiryProjection(projection: ExpiryProjection): string[] {
  const headline = describeExpiryProjection(projection);
  if (!headline) return [];
  const lines: string[] = [];
  const icon = projection.willBlock > 0 ? '⚠️' : 'ℹ️';
  lines.push(`> ${icon} **${escapeMd(headline)}**`);
  lines.push(`> - Remedy: ${escapeMd(EXPIRY_PROJECTION_REMEDY)}`);
  lines.push('');
  lines.push('<details>');
  lines.push(`<summary>Suppressions expiring (${projection.lapsing.length})</summary>`);
  lines.push('');
  lines.push('| Source | Finding | Category | Expires | In | On lapse |');
  lines.push('|---|---|---|---|---|---|');
  for (const l of projection.lapsing) {
    const effect = l.consequence === 'block' ? '**blocks**' : l.consequence;
    lines.push(
      `| ${escapeMd(l.source)} | ${escapeMd(l.subject)} | ${escapeMd(l.category)} | ` +
        `${escapeMd(l.expiresAt)} | ${l.daysRemaining}d | ${effect} |`,
    );
  }
  lines.push('');
  lines.push('</details>');
  lines.push('');
  return lines;
}

/** A markdown line for a fail-open gate that errored — the PR-comment mirror of
 *  `formatGateFailure`. Never silent on an error; empty otherwise. */
function markdownGateFailure(
  label: string,
  gate: { skipped?: string; error?: GateFailure } | undefined,
): string[] {
  if (!gate || gate.skipped !== 'error') return [];
  const at = gate.error?.step ? ` at \`${gate.error.step}\`` : '';
  const why = gate.error?.message ? `: ${escapeMd(gate.error.message)}` : '';
  return [`> ⚠️ **${label} gate did not run** — error${at}${why} (fail-open; did not block).`, ''];
}

/** The PR-comment mirror of `formatGateSkip` — a configured-on gate that can
 *  never run as configured is disclosed, never silent. Empty otherwise. */
function markdownGateSkip(label: string, gate: { skipped?: string } | undefined): string[] {
  if (!gate?.skipped) return [];
  const why = STRUCTURAL_GATE_SKIPS[gate.skipped];
  if (!why) return [];
  return [
    `> ⚠️ **${label} gate is configured but did not run** — \`${escapeMd(gate.skipped)}\`: ${escapeMd(why)}`,
    '',
  ];
}

function markdownFlowGate(flow: FlowGateOutcome | undefined): string[] {
  if (!flow) return [];
  const failure = markdownGateFailure('Flow', flow);
  if (failure.length > 0) return failure;
  const structuralSkip = markdownGateSkip('Flow', flow);
  if (structuralSkip.length > 0) return structuralSkip;
  const suppressed = flow.suppressed ?? [];
  if (flow.findings.length === 0 && suppressed.length === 0) return [];
  const out: string[] = [];
  const blocking = flow.findings.filter((f) => f.verdict === 'block');
  const warning = flow.findings.filter((f) => f.verdict === 'warn');
  // The fingerprint column mirrors the pair tables — a reviewer copies `f.id`
  // straight into `allowlist add --fingerprint=<id>` from the PR comment.
  const row = (f: FlowGateOutcome['findings'][number]): string =>
    `| ${escapeMd(`${f.method} ${f.path}`)} | ${escapeMd(f.reason)} | ` +
    `${escapeMd(`${f.file}:${f.line}`)} | ${f.confidence.toFixed(2)} | \`${escapeMd(f.id)}\` |`;
  if (blocking.length > 0) {
    out.push('### Broken integrations');
    out.push('');
    out.push('| Endpoint | Reason | Consumer | Confidence | Fingerprint |');
    out.push('|---|---|---|---|---|');
    for (const f of blocking) out.push(row(f));
    out.push('');
  }
  if (warning.length > 0) {
    out.push('<details>');
    out.push(`<summary>Integration warnings (${warning.length})</summary>`);
    out.push('');
    out.push('| Endpoint | Reason | Consumer | Confidence | Fingerprint |');
    out.push('|---|---|---|---|---|');
    for (const f of warning) out.push(row(f));
    out.push('');
    out.push('</details>');
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push('<details>');
    out.push(
      `<summary>Integration findings suppressed by allowlist (${suppressed.length})</summary>`,
    );
    out.push('');
    out.push('These would block/warn, but an active allowlist entry accepted them.');
    out.push('');
    out.push('| Endpoint | Reason | Consumer | Category | Expires |');
    out.push('|---|---|---|---|---|');
    for (const s of suppressed) {
      const f = s.finding;
      out.push(
        `| ${escapeMd(`${f.method} ${f.path}`)} | ${escapeMd(f.reason)} | ` +
          `${escapeMd(`${f.file}:${f.line}`)} | ${escapeMd(s.category)} | ` +
          `${escapeMd(s.expiresAt ?? '—')} |`,
      );
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  return out;
}

/**
 * Markdown for the model-schema drift gate. Blocking drift renders as a
 * top-level table (it fails the PR); warnings and the disclosure-only info
 * class collapse into `<details>`. Silent when the gate produced nothing.
 */
function markdownSchemaDriftGate(gate: SchemaDriftGateOutcome | undefined): string[] {
  if (!gate) return [];
  const failure = markdownGateFailure('Schema drift', gate);
  if (failure.length > 0) return failure;
  const structuralSkip = markdownGateSkip('Schema drift', gate);
  if (structuralSkip.length > 0) return structuralSkip;
  const suppressed = gate.suppressed ?? [];
  if (gate.findings.length === 0 && suppressed.length === 0) return [];
  const out: string[] = [];
  const blocking = gate.findings.filter((f) => f.verdict === 'block');
  const warning = gate.findings.filter((f) => f.verdict === 'warn');
  const info = gate.findings.filter((f) => f.verdict === 'info');
  const subject = (f: { model: string; field: string | null }): string =>
    f.field ? `${f.model}.${f.field}` : f.model;
  const row = (f: SchemaDriftGateOutcome['findings'][number]): string =>
    `| ${escapeMd(subject(f))} | ${escapeMd(f.changeClass)} | ` +
    `${escapeMd(f.from ?? '—')} → ${escapeMd(f.to ?? '—')} | ` +
    `${escapeMd(`${f.file}:${f.line}`)} | ${f.confidence.toFixed(2)} | \`${escapeMd(f.id)}\` |`;
  const header = [
    '| Model / field | Change | From → To | Location | Confidence | Fingerprint |',
    '|---|---|---|---|---|---|',
  ];
  if (blocking.length > 0) {
    out.push('### Breaking schema drift');
    out.push('');
    out.push(...header);
    for (const f of blocking) out.push(row(f));
    out.push('');
    out.push(
      '_A deliberate breaking change ships with its migration and an expiring ' +
        '`accepted-risk` allowlist entry (`allowlist add --fingerprint=<id> ' +
        '--kind=model-schema-drift --category=accepted-risk`)._',
    );
    out.push('');
  }
  if (warning.length > 0) {
    out.push('<details>');
    out.push(`<summary>Schema drift warnings (${warning.length})</summary>`);
    out.push('');
    out.push(...header);
    for (const f of warning) out.push(row(f));
    out.push('');
    out.push('</details>');
    out.push('');
  }
  if (info.length > 0) {
    out.push('<details>');
    out.push(`<summary>Schema changes (informational, ${info.length})</summary>`);
    out.push('');
    out.push(...header);
    for (const f of info) out.push(row(f));
    out.push('');
    out.push('</details>');
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push('<details>');
    out.push(`<summary>Schema drift suppressed by allowlist (${suppressed.length})</summary>`);
    out.push('');
    out.push('These would block/warn, but an active allowlist entry accepted them.');
    out.push('');
    out.push('| Model / field | Change | Location | Category | Expires |');
    out.push('|---|---|---|---|---|');
    for (const s of suppressed) {
      const f = s.finding;
      out.push(
        `| ${escapeMd(subject(f))} | ${escapeMd(f.changeClass)} | ` +
          `${escapeMd(`${f.file}:${f.line}`)} | ${escapeMd(s.category)} | ` +
          `${escapeMd(s.expiresAt ?? '—')} |`,
      );
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  return out;
}

/** Markdown for the structural-duplicate (seam) gate. All warn-tier, so a
 *  single collapsed section names each twin, its similarity, and fingerprint. */
function markdownPairedGate(gate: PairedGateOutcome | undefined): string[] {
  if (!gate) return [];
  const failure = markdownGateFailure('Paired-change', gate);
  if (failure.length > 0) return failure;
  const structuralSkip = markdownGateSkip('Paired-change', gate);
  if (structuralSkip.length > 0) return structuralSkip;
  const out: string[] = [];
  for (const w of gate.warnings) out.push(`> ⚠️ paired-change config: ${escapeMd(w)}`, '');
  const suppressed = gate.suppressed ?? [];
  if (gate.findings.length === 0 && suppressed.length === 0) return out;
  if (gate.findings.length > 0) {
    const blocking = gate.findings.filter((f) => f.blocking).length;
    out.push(
      `### Paired-change ${blocking > 0 ? 'violations — blocking' : 'warnings'} (${gate.findings.length})`,
    );
    out.push('');
    out.push(
      '_A declared pairing (`.dxkit/policy.json:pairedChecks`) requires a companion ' +
        'change this diff does not carry. Add the companion change, or defer time-boxed ' +
        'with `allowlist add --fingerprint=<id> --kind=paired-change --category=deferred ' +
        '--expires=+7d`._',
    );
    out.push('');
    out.push('| Rule | Verdict | Changed (`if`) | Missing (`then`) | Fingerprint |');
    out.push('|---|---|---|---|---|');
    for (const f of gate.findings) {
      const rule = f.message ? `${escapeMd(f.check)} — ${escapeMd(f.message)}` : escapeMd(f.check);
      out.push(
        `| ${rule} | ${f.blocking ? '**block**' : 'warn'} | ${f.ifMatched.map(escapeMd).join('<br>')} | ` +
          `${f.thenGlobs.map((g) => `\`${escapeMd(g)}\``).join('<br>')} | \`${escapeMd(f.id)}\` |`,
      );
    }
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push('<details>');
    out.push(
      `<summary>Paired-change violations suppressed by allowlist (${suppressed.length})</summary>`,
    );
    out.push('');
    out.push('| Rule | Category | Expires |');
    out.push('|---|---|---|');
    for (const s of suppressed) {
      out.push(
        `| ${escapeMd(s.finding.check)} | ${escapeMd(s.category)} | ${escapeMd(s.expiresAt ?? '—')} |`,
      );
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  return out;
}

function markdownDupGate(gate: DupGateOutcome | undefined): string[] {
  if (!gate) return [];
  const failure = markdownGateFailure('Structural duplicate', gate);
  if (failure.length > 0) return failure;
  const structuralSkip = markdownGateSkip('Structural duplicate', gate);
  if (structuralSkip.length > 0) return structuralSkip;
  const suppressed = gate.suppressed ?? [];
  if (gate.findings.length === 0 && suppressed.length === 0) return [];
  const out: string[] = [];
  const loc = (x: DuplicateFinding['anchors'][number]) =>
    `${escapeMd(x.symbol)} @ ${escapeMd(`${x.file}:${x.line}`)}`;
  const pairCell = (f: DuplicateFinding): string => {
    const [a, b] = f.anchors;
    if (f.changed) {
      const [aNew, bNew] = f.changed;
      if (aNew && !bNew) return `**added** ${loc(a)} ≈ existing ${loc(b)}`;
      if (bNew && !aNew) return `**added** ${loc(b)} ≈ existing ${loc(a)}`;
    }
    return `${loc(a)} ≈ ${loc(b)}`;
  };
  if (gate.findings.length > 0) {
    out.push('<details>');
    out.push(`<summary>Structural duplicates (${gate.findings.length})</summary>`);
    out.push('');
    out.push(
      '_A net-new function that structurally duplicates another (same helpers, ' +
        'same name shape). Extract the shared routine, or accept a by-design ' +
        'parallel with `allowlist add --fingerprint=<id> --kind=code-reimplementation ' +
        '--category=false-positive`._',
    );
    out.push('');
    out.push('| Duplicate pair | Similarity | Fingerprint |');
    out.push('|---|---|---|');
    for (const f of gate.findings) {
      out.push(`| ${pairCell(f)} | ${f.score.toFixed(2)} | \`${escapeMd(f.id)}\` |`);
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  if (suppressed.length > 0) {
    out.push('<details>');
    out.push(
      `<summary>Structural duplicates suppressed by allowlist (${suppressed.length})</summary>`,
    );
    out.push('');
    out.push('These would warn, but an active allowlist entry accepted them.');
    out.push('');
    out.push('| Duplicate pair | Category | Expires |');
    out.push('|---|---|---|');
    for (const s of suppressed) {
      out.push(
        `| ${pairCell(s.finding)} | ${escapeMd(s.category)} | ${escapeMd(s.expiresAt ?? '—')} |`,
      );
    }
    out.push('');
    out.push('</details>');
    out.push('');
  }
  return out;
}

/** Append ` (ref: <ref>)` to the mode label when running ref-based,
 *  so PR reviewers see WHICH ref the diff anchored to. Empty for
 *  committed modes. */
function formatModeRef(mode: GuardrailCheckResult['mode']): string {
  return mode.mode === 'ref-based' && mode.ref ? ` (ref: \`${escapeMd(mode.ref)}\`)` : '';
}

function summarySentence(
  result: GuardrailCheckResult,
  blockingCount: number,
  warningCount: number,
  resolvedCount: number,
): string {
  const parts: string[] = [];
  if (blockingCount > 0) {
    parts.push(`${blockingCount} new regression${blockingCount === 1 ? '' : 's'}`);
  }
  const unattributableCount = result.attributionGaps.reduce((n, g) => n + g.findingCount, 0);
  if (unattributableCount > 0) {
    parts.push(
      `${unattributableCount} unattributable finding${unattributableCount === 1 ? '' : 's'} on block-rule kinds`,
    );
  }
  if (warningCount > 0) parts.push(`${warningCount} warning${warningCount === 1 ? '' : 's'}`);
  if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
  if (parts.length === 0) {
    return `No changes from baseline (${result.pairs.length} pair${result.pairs.length === 1 ? '' : 's'} checked).`;
  }
  return parts.join(', ') + '.';
}

function markdownPairRow(p: ClassifiedPair): string {
  const status = escapeMd(statusLabel(p.classification.status));
  const kind = escapeMd(p.kind);
  const sev = escapeMd(p.severity ?? '—');
  const loc = escapeMd(locatorProse(p) || '—');
  const reasonProse = p.classification.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ');
  // Fingerprint in a `code` span so it's copy-pasteable into `allowlist add
  // --fingerprint=<id>` straight from the PR comment.
  const fp = pairFingerprint(p);
  const fpCell = fp ? `\`${fp}\`` : '—';
  return `| ${status} | ${kind} | ${sev} | ${loc} | ${fpCell} | ${escapeMd(reasonProse) || '—'} |`;
}

function escapeMd(s: string): string {
  // Pipe and backtick are the table-breaking characters; escape only
  // those to keep the rendered output readable. Backslash-escape
  // doesn't survive inside table cells in some renderers, so use a
  // visually-similar replacement for pipes.
  return s.replace(/\|/g, '\\|').replace(/`/g, "'");
}

/**
 * Render the allowlist delta as a PR-comment section. Returns an
 * empty array when there's nothing useful to show (no delta + the
 * baseline SHA was reachable, meaning the file is genuinely
 * unchanged). When the SHA was unreachable, emits a one-line note
 * so the customer can see review signal is missing.
 */
function formatAllowlistDelta(result: GuardrailCheckResult): string[] {
  const delta = result.allowlistDelta;
  if (!delta) return [];

  if (!delta.baselineAccessible) {
    // Don't emit a section for the "definitely empty" case when
    // there are also no current entries — too noisy. Only surface
    // when something's actually obscured.
    return [];
  }

  if (delta.added.length === 0 && delta.removed.length === 0) return [];

  const lines: string[] = [];
  const total = delta.added.length + delta.removed.length;
  lines.push(`### Allowlist activity (${total})`);
  lines.push('');
  lines.push(
    `Suppressions changed between baseline @ ${shortSha(result.baseline.repo.commitSha)} ` +
      `and current. Review each entry's category + reason + expiry before approving.`,
  );
  lines.push('');

  if (delta.added.length > 0) {
    lines.push(`**Added (${delta.added.length})** — new suppressions on this branch:`);
    lines.push('');
    lines.push('| Fingerprint | Kind | Category | Expires | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const e of delta.added) {
      lines.push(
        `| \`${escapeMd(e.fingerprint)}\` | ${escapeMd(e.kind)} | ` +
          `${escapeMd(e.category)} | ${escapeMd(e.expiresAt ?? '—')} | ` +
          `${escapeMd(e.reason ?? '—')} |`,
      );
    }
    lines.push('');
  }

  if (delta.removed.length > 0) {
    lines.push(`**Removed (${delta.removed.length})** — suppressions deleted on this branch:`);
    lines.push('');
    lines.push('| Fingerprint | Kind | Category |');
    lines.push('|---|---|---|');
    for (const e of delta.removed) {
      lines.push(
        `| \`${escapeMd(e.fingerprint)}\` | ${escapeMd(e.kind)} | ${escapeMd(e.category)} |`,
      );
    }
    lines.push('');
  }

  return lines;
}
