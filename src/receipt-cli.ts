/**
 * `vyuh-dxkit receipt [--since <ref>]` — the PR "dxkit signals" block as a
 * command (feedback #26), computed not narrated.
 *
 * Every PR run hand-assembles the same section: the guardrail verdict, the
 * allowlist delta (new suppressions, with category + reason), and — optionally
 * — the health-score movement since the base branch. Emitting it as one
 * ready-to-paste markdown block guarantees the PR body never misrepresents gate
 * state, and folds in the redundant-scan fix (#24/#93): the verdict comes from
 * the session's verdict cache when the tree is unchanged, so the third gather of
 * a feature session (feature-verify → pre-push → this) costs nothing.
 *
 * The verdict + allowlist come straight from the guardrail's own renderer
 * (`renderMarkdown`, Rule 2 — one source for the block). Score movement is
 * OPT-IN via `--since`, because it runs a full health analysis at the base ref
 * (a `git worktree` gather) on top of the one at HEAD; it degrades gracefully to
 * an omitted section when a ref can't be analyzed. `receipt` is informational —
 * it never sets a failing exit code; `guardrail check` is the gate.
 */
import { loadPolicyFromCwd } from './baseline/policy';
import { readFreshVerdict, writeVerdict } from './baseline/verdict-cache';
import type { DimensionScore } from './analyzers/types';

export interface ReceiptOptions {
  /** Base ref for score movement (e.g. `origin/main`). Omit to skip that section. */
  readonly since?: string;
  readonly json?: boolean;
  /** Force a fresh guardrail run, ignoring any cached verdict. */
  readonly refresh?: boolean;
}

export interface VerdictView {
  readonly markdown: string;
  readonly blocks: boolean;
  readonly warns: boolean;
  readonly blocking: number;
  readonly warning: number;
  readonly cached: boolean;
  readonly ranAt: string;
}

interface DimDelta {
  readonly id: string;
  readonly label: string;
  readonly base: number;
  readonly head: number;
  readonly delta: number;
}
export interface ScoreMovement {
  readonly ref: string;
  readonly overall: DimDelta;
  readonly dimensions: readonly DimDelta[];
}

/** Human labels for the six dimensions, in the display order the receipt uses. */
const DIMENSIONS: ReadonlyArray<{ id: keyof HealthDims; label: string }> = [
  { id: 'security', label: 'Security' },
  { id: 'testing', label: 'Tests' },
  { id: 'quality', label: 'Code Quality' },
  { id: 'documentation', label: 'Documentation' },
  { id: 'maintainability', label: 'Maintainability' },
  { id: 'developerExperience', label: 'Developer Experience' },
];
type HealthDims = {
  testing: DimensionScore;
  quality: DimensionScore;
  documentation: DimensionScore;
  security: DimensionScore;
  maintainability: DimensionScore;
  developerExperience: DimensionScore;
};

/** The computed receipt — the verdict view, optional score movement, and the
 *  ready-to-paste markdown block. Shared by `runReceipt` (prints it) and
 *  `vyuh-dxkit pr` (embeds the markdown in the PR body) — Rule 2, one source
 *  for the "dxkit signals" block. */
export interface Receipt {
  readonly verdict: VerdictView;
  readonly movement: ScoreMovement | null;
  readonly markdown: string;
}

/**
 * Compute the receipt without printing: the guardrail verdict (from the session
 * verdict cache when fresh, else a fresh gather), the optional health-score
 * movement vs `since`, and the assembled markdown block. The one place the block
 * is produced — callers render or embed it.
 */
export async function buildReceipt(cwd: string, opts: ReceiptOptions = {}): Promise<Receipt> {
  const policy = loadPolicyFromCwd(cwd);
  const verdict = await resolveVerdict(cwd, policy, !!opts.refresh);
  const movement = opts.since ? await computeScoreMovement(cwd, opts.since) : null;
  return { verdict, movement, markdown: assembleMarkdown(verdict, movement, opts.since) };
}

export async function runReceipt(cwd: string, opts: ReceiptOptions = {}): Promise<void> {
  const { verdict, movement, markdown } = await buildReceipt(cwd, opts);

  if (opts.json) {
    process.stdout.write(
      JSON.stringify(
        {
          schema: 'receipt.v1',
          verdict: verdict.blocks ? 'BLOCKED' : verdict.warns ? 'PASSED (with warnings)' : 'PASSED',
          blocks: verdict.blocks,
          warns: verdict.warns,
          blocking: verdict.blocking,
          warning: verdict.warning,
          cached: verdict.cached,
          ranAt: verdict.ranAt,
          scoreMovement: movement,
          markdown,
        },
        null,
        2,
      ) + '\n',
    );
    return;
  }

  // Default output is pure, ready-to-paste markdown on stdout (no console
  // chrome), mirroring `guardrail check --markdown`.
  process.stdout.write(markdown + '\n'); // slop-ok
}

/** Reuse a fresh cached verdict, else run the guardrail and cache the result. */
async function resolveVerdict(
  cwd: string,
  policy: ReturnType<typeof loadPolicyFromCwd>,
  refresh: boolean,
): Promise<VerdictView> {
  if (!refresh) {
    const cached = readFreshVerdict(cwd, policy);
    if (cached) {
      return {
        markdown: cached.markdown,
        blocks: cached.blocks,
        warns: cached.warns,
        blocking: cached.blockingCount,
        warning: cached.warningCount,
        cached: true,
        ranAt: cached.ranAt,
      };
    }
  }
  const { runGuardrailCheck } = await import('./baseline/check');
  const { renderMarkdown, verdictCounts } = await import('./baseline/check-renderers');
  const result = await runGuardrailCheck({ cwd });
  const markdown = renderMarkdown(result);
  const counts = verdictCounts(result);
  const ranAt = new Date().toISOString();
  writeVerdict(cwd, result.policy, {
    blocks: result.blocks,
    warns: result.warns,
    blockingCount: counts.blocking,
    warningCount: counts.warning,
    markdown,
    ranAt,
  });
  return {
    markdown,
    blocks: result.blocks,
    warns: result.warns,
    blocking: counts.blocking,
    warning: counts.warning,
    cached: false,
    ranAt,
  };
}

/**
 * Health-score delta between `ref` and HEAD. Runs the full health analysis at
 * both, the base side inside a throwaway worktree via the canonical
 * `withRefWorktree` primitive (Rule 11). Best-effort on any failure (unreachable
 * ref, analysis error) returns null so the receipt simply omits the section.
 */
async function computeScoreMovement(cwd: string, ref: string): Promise<ScoreMovement | null> {
  try {
    const { analyzeHealth } = await import('./analyzers/health');
    const { withRefWorktree } = await import('./baseline/ref-baseline');
    const head = await analyzeHealth(cwd);
    const base = await withRefWorktree({ cwd, ref }, (wt) => analyzeHealth(wt));
    const delta = (b: number, h: number): number => Math.round((h - b) * 10) / 10;
    const dims = DIMENSIONS.map(({ id, label }) => {
      const b = base.dimensions[id].score;
      const h = head.dimensions[id].score;
      return { id, label, base: b, head: h, delta: delta(b, h) };
    });
    return {
      ref,
      overall: {
        id: 'overall',
        label: 'Overall',
        base: base.summary.overallScore,
        head: head.summary.overallScore,
        delta: delta(base.summary.overallScore, head.summary.overallScore),
      },
      dimensions: dims,
    };
  } catch {
    return null;
  }
}

/** Assemble the ready-to-paste block: the guardrail markdown, an optional score
 *  section, and a provenance HTML comment (invisible in rendered markdown). */
function assembleMarkdown(
  verdict: VerdictView,
  movement: ScoreMovement | null,
  since: string | undefined,
): string {
  const parts: string[] = [verdict.markdown.trimEnd()];
  if (movement) {
    parts.push('', ...renderScoreMovement(movement));
  } else if (since) {
    parts.push('', `_Health score movement since \`${since}\` unavailable (ref not analyzable)._`);
  }
  parts.push(
    '',
    `<!-- dxkit receipt: ${verdict.cached ? 'reused cached' : 'fresh'} verdict @ ${verdict.ranAt} -->`,
  );
  return parts.join('\n');
}

function renderScoreMovement(m: ScoreMovement): string[] {
  const sign = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `${n}` : '±0');
  const lines = [
    `## Health score movement (since \`${m.ref}\`)`,
    '',
    '| Dimension | Base | Head | Δ |',
    '|---|---:|---:|---:|',
    `| **Overall** | ${m.overall.base} | ${m.overall.head} | ${sign(m.overall.delta)} |`,
  ];
  for (const d of m.dimensions) {
    lines.push(`| ${d.label} | ${d.base} | ${d.head} | ${sign(d.delta)} |`);
  }
  return lines;
}

/** Surface a run failure (no baseline, etc.) helpfully. Called by the CLI when
 *  `runReceipt` throws — kept here so the guidance lives with the command. */
export function receiptFailureHint(err: Error): string {
  return (
    `Could not produce a receipt: ${err.message}\n` +
    `A receipt needs a baseline to diff against — run \`vyuh-dxkit baseline create\` first, ` +
    `or run \`vyuh-dxkit guardrail check\` to see the underlying error.`
  );
}
