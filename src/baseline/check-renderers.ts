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
import type { ClassifiedPair, EnvelopeDrift, GuardrailCheckResult } from './check';
import type { BrownfieldPolicy } from './policy';
import type { FindingStatus, MatchReason } from './types';

// ─── Console renderer ─────────────────────────────────────────────────────

/**
 * Render the check result as a human-readable text block. Returns a
 * single multi-line string; callers route it to stdout.
 */
export function renderConsole(result: GuardrailCheckResult): string {
  const lines: string[] = [];

  // Verdict banner. Single line at the top so a developer skimming
  // terminal output sees pass/fail without scrolling.
  lines.push(verdictBanner(result));
  lines.push('');

  // Provenance: what was compared against what. Inline so the user
  // can verify they're checking against the intended baseline.
  lines.push(logger.bold('Baseline'));
  lines.push(`  Path:        ${result.baselinePath}`);
  lines.push(`  Name:        ${result.baseline.name}`);
  lines.push(`  Captured:    ${result.baseline.createdAt}`);
  lines.push(
    `  Commit:      ${shortSha(result.baseline.repo.commitSha)} (${result.baseline.repo.branch || 'detached'})`,
  );
  lines.push(`  Findings:    ${result.baseline.findings.length}`);
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
  const blocking = result.pairs.filter((p) => p.classification.blocks);
  const warning = result.pairs.filter((p) => !p.classification.blocks && p.classification.warns);
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
    lines.push('');
  }
  if (warning.length > 0) {
    lines.push(logger.bold(`Warnings (${warning.length})`));
    for (const p of warning) lines.push(...formatPairLines(p, '  '));
    lines.push('');
  }
  if (removed.length > 0) {
    lines.push(logger.bold(`Resolved (${removed.length})`));
    for (const p of removed) lines.push(...formatPairLines(p, '  '));
    lines.push('');
  }

  // Always show a summary footer — sets expectations for what
  // happens next (exit code, what to read on a fail).
  lines.push(logger.bold('Summary'));
  lines.push(
    `  Pairs:       ${result.pairs.length} (blocking: ${blocking.length}, ` +
      `warning: ${warning.length}, persisted: ${persisted.length}, ` +
      `resolved: ${removed.length})`,
  );
  lines.push(
    `  Verdict:     ${result.blocks ? 'BLOCKED' : result.warns ? 'PASSED (with warnings)' : 'PASSED'}`,
  );
  lines.push(`  Exit code:   ${result.blocks ? 1 : 0}`);
  if (result.blocks) {
    lines.push('');
    lines.push(
      `  Re-run with --json for a machine-readable payload, or --markdown to capture a PR-comment-friendly report.`,
    );
  }
  return lines.join('\n');
}

function verdictBanner(result: GuardrailCheckResult): string {
  if (result.blocks) {
    const count = result.pairs.filter((p) => p.classification.blocks).length;
    return logger.bold(`Guardrail BLOCKED — ${count} new regression${count === 1 ? '' : 's'}`);
  }
  if (result.warns) {
    const count = result.pairs.filter((p) => p.classification.warns).length;
    return logger.bold(`Guardrail PASSED — ${count} warning${count === 1 ? '' : 's'}`);
  }
  return logger.bold('Guardrail PASSED');
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
  return out;
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
    case 'newly_detected':
      return 'NEWLY-DETECTED';
    case 'probable_existing':
      return 'PROBABLE-EXISTING';
    case 'uncertain':
      return 'UNCERTAIN';
    case 'fixed':
      return 'FIXED';
  }
}

function locatorProse(p: ClassifiedPair): string {
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
    out.push(
      `tool drift: ${d.tool} ${d.baselineVersion ?? '(absent)'} → ${d.currentVersion ?? '(absent)'}`,
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
    readonly exitCode: 0 | 1;
  };
  readonly baseline: {
    /** Absent when the run used `ref-based` mode (no on-disk
     *  baseline file). */
    readonly path?: string;
    readonly name: string;
    readonly createdAt: string;
    readonly commitSha: string;
    readonly branch: string;
    readonly findingsCount: number;
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
    readonly warning: number;
    readonly persisted: number;
    readonly resolved: number;
  };
  readonly pairs: ReadonlyArray<{
    readonly status: FindingStatus;
    readonly blocks: boolean;
    readonly warns: boolean;
    readonly priorId?: string;
    readonly currentId?: string;
    readonly confidence: number;
    readonly kind: string;
    readonly severity?: string;
    readonly file?: string;
    readonly line?: number;
    readonly overlapsChangedLines?: boolean;
    readonly reasons: ReadonlyArray<MatchReason>;
  }>;
}

export function renderJson(result: GuardrailCheckResult): GuardrailJsonPayload {
  const blocking = result.pairs.filter((p) => p.classification.blocks).length;
  const warning = result.pairs.filter(
    (p) => !p.classification.blocks && p.classification.warns,
  ).length;
  const persisted = result.pairs.filter(
    (p) =>
      !p.classification.blocks &&
      !p.classification.warns &&
      (p.classification.status === 'persisted' || p.classification.status === 'relocated'),
  ).length;
  const resolved = result.pairs.filter((p) => p.classification.status === 'removed').length;

  return {
    schema: GUARDRAIL_JSON_SCHEMA,
    verdict: { blocks: result.blocks, warns: result.warns, exitCode: result.blocks ? 1 : 0 },
    baseline: {
      ...(result.baselinePath !== undefined ? { path: result.baselinePath } : {}),
      name: result.baseline.name,
      createdAt: result.baseline.createdAt,
      commitSha: result.baseline.repo.commitSha,
      branch: result.baseline.repo.branch,
      findingsCount: result.baseline.findings.length,
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
      warning,
      persisted,
      resolved,
    },
    pairs: result.pairs.map((p) => ({
      status: p.classification.status,
      blocks: p.classification.blocks,
      warns: p.classification.warns,
      ...(p.pair.priorId !== undefined ? { priorId: p.pair.priorId } : {}),
      ...(p.pair.currentId !== undefined ? { currentId: p.pair.currentId } : {}),
      confidence: p.pair.confidence,
      kind: p.kind,
      ...(p.severity !== undefined ? { severity: p.severity } : {}),
      ...(p.file !== undefined ? { file: p.file } : {}),
      ...(p.line !== undefined ? { line: p.line } : {}),
      ...(p.overlapsChangedLines !== undefined
        ? { overlapsChangedLines: p.overlapsChangedLines }
        : {}),
      reasons: p.classification.reasons,
    })),
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
  const blocking = result.pairs.filter((p) => p.classification.blocks);
  const warning = result.pairs.filter((p) => !p.classification.blocks && p.classification.warns);
  const resolved = result.pairs.filter((p) => p.classification.status === 'removed');

  const verdict = result.blocks ? 'BLOCKED' : result.warns ? 'PASSED (with warnings)' : 'PASSED';
  lines.push(`## Guardrail: ${verdict}`);
  lines.push('');
  lines.push(summarySentence(result, blocking.length, warning.length, resolved.length));
  lines.push('');

  if (blocking.length > 0) {
    lines.push('### Blocking findings');
    lines.push('');
    lines.push('| Status | Kind | Severity | Location | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const p of blocking) lines.push(markdownPairRow(p));
    lines.push('');
  }

  if (warning.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>Warnings (${warning.length})</summary>`);
    lines.push('');
    lines.push('| Status | Kind | Severity | Location | Reason |');
    lines.push('|---|---|---|---|---|');
    for (const p of warning) lines.push(markdownPairRow(p));
    lines.push('');
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
    for (const p of resolved) {
      lines.push(`| ${escapeMd(p.kind)} | ${escapeMd(locatorProse(p) || '—')} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }

  const allowlistLines = formatAllowlistDelta(result);
  for (const l of allowlistLines) lines.push(l);

  lines.push('---');
  lines.push('');
  lines.push(
    `_Baseline_: \`${escapeMd(result.baseline.name)}\` @ ${shortSha(result.baseline.repo.commitSha)} · ` +
      `_Mode_: \`${escapeMd(result.mode.mode)}\`${formatModeRef(result.mode)} · ` +
      `_Current_: ${shortSha(result.current.repoState.commitSha)} · ` +
      `_Matcher_: ${result.matchResult.gitAware ? 'git-aware' : 'degraded'} · ` +
      `_dxkit_: ${escapeMd(result.current.analysisMeta.dxkitVersion)}`,
  );

  return lines.join('\n');
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
  return `| ${status} | ${kind} | ${sev} | ${loc} | ${escapeMd(reasonProse) || '—'} |`;
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
