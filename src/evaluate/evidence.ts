/**
 * The evaluate evidence document — `dxkit.evaluate-evidence.v1`.
 *
 * The versioned, shareable record of a zero-write trial: per-landing gate
 * verdicts plus everything an honest reader needs to weigh them — what was
 * watched (scanners, preset), what was structurally excluded (ref-mode
 * kinds), what could not be measured (missing dep scanner), and the
 * anachronism caveat (advisory data is current-day; a historical landing
 * can "block" on a CVE disclosed after it merged).
 *
 * Append-only discipline per `src/evidence/conventions.ts`: an
 * incompatible shape change is a NEW schema id, and the v1 builder stays.
 * The full per-landing guardrail payload (`dxkit.guardrail-check.v1`) is
 * embedded verbatim — evaluate lifts summary fields out of it but never
 * re-derives a verdict (one concept, one code path).
 */
import type { GuardrailCheckResult } from '../baseline/check';
import { type GuardrailJsonPayload, renderJson } from '../baseline/check-renderers';
import type { ScanCoverage } from '../baseline/coverage';
import type { LoopPreset } from '../baseline/presets';
import { type EvidenceEnvelope, evidenceEnvelope } from '../evidence/conventions';
import type { LandingPair } from './pr-ranges';

export const EVALUATE_EVIDENCE_SCHEMA = 'dxkit.evaluate-evidence.v1' as const;

/** One landing (PR merge / squash / commit) replayed through the gate. */
export interface EvaluateRunEvidence {
  /** Display label: "#123" when a PR number was parsed, else short SHA. */
  readonly label: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly subject?: string;
  readonly committedAt?: string;
  readonly prNumber?: number;
  /** The gate verdict, lifted from the embedded payload. */
  readonly verdict: { readonly blocks: boolean; readonly warns: boolean };
  /** Blocking pairs, lifted for summary rendering (allowlist-suppressed
   *  pairs excluded — mirrors the payload's verdict). */
  readonly blocking: ReadonlyArray<{
    readonly kind: string;
    readonly severity?: string;
    readonly file?: string;
    readonly line?: number;
  }>;
  readonly warningCount: number;
  /** Kinds structurally excluded from a ref-vs-ref diff (duplication,
   *  test-gap, custom-check, secret-hmac) with the head-side counts that
   *  were dropped — the trial cannot demo gating these; say so. */
  readonly refExcludedKinds: ReadonlyArray<{
    readonly kind: string;
    readonly currentCount: number;
  }>;
  /** Present when the dependency audit was requested but could not run —
   *  a clean landing is then NOT a clean bill of dependency health. */
  readonly depVulnsUnmeasured?: { readonly reason: string };
  /** Scanner availability for the head-side gather. */
  readonly coverage: ScanCoverage;
  /** Exact tool versions on each side of the diff. */
  readonly toolVersions: {
    readonly base: Readonly<Record<string, string>>;
    readonly head: Readonly<Record<string, string>>;
  };
  readonly matcher: { readonly gitAware: boolean; readonly degradedReason?: string };
  /** The full versioned guardrail payload for this landing. Absent only
   *  on an errored landing (see `error`). */
  readonly guardrail?: GuardrailJsonPayload;
  readonly durationMs: number;
  /** Set when this landing could not be evaluated (unresolvable ref,
   *  worktree failure). The trial continues with the other landings. */
  readonly error?: { readonly message: string; readonly hint?: string };
}

export interface EvaluateEvidenceDoc extends EvidenceEnvelope {
  readonly schema: typeof EVALUATE_EVIDENCE_SCHEMA;
  readonly repo: { readonly branch: string; readonly ref: string };
  readonly policy: {
    readonly preset: LoopPreset;
    /** Where the preset came from: an explicit flag or the default. */
    readonly source: 'flag' | 'default';
    /** Where the base policy came from: the repo's committed
     *  `.dxkit/policy.json` or the compiled-in defaults. */
    readonly base: 'repo-policy' | 'defaults';
  };
  readonly options: { readonly incremental: boolean; readonly untrusted: boolean };
  /** The zero-write attestation: the trial created no files, refs, or
   *  hooks in the repository. Pinned by `test/evaluate/zero-write.test.ts`. */
  readonly zeroWrite: true;
  readonly runs: ReadonlyArray<EvaluateRunEvidence>;
  readonly totals: {
    readonly landings: number;
    readonly blocked: number;
    readonly warned: number;
    readonly clean: number;
    readonly errored: number;
  };
  /** Honesty notes rendered with the results (dep-advisory anachronism,
   *  ref-mode exclusions, redaction marker). */
  readonly notes: ReadonlyArray<string>;
  /** What enabling dxkit would cost on THIS repo — measured from the trial
   *  itself wherever possible, static facts otherwise. Answers "the gate
   *  would have blocked X, but at what price?" */
  readonly costs: EvaluateCosts;
  /** The seam VISIBILITY lane — what dxkit SEES in the repo right now, computed
   *  once on the trial head, INDEPENDENT of the gate verdict. Surfaces the
   *  structural-duplicate + dead-surface + convergence signals so the trial shows
   *  dxkit's differentiator even on a repo that hasn't enabled those gates.
   *  Absent when the head could not be analyzed (fail-open). */
  readonly seams?: SeamVisibility;
}

/** The seam-visibility summary attached to an evaluate doc. Counts + the ranked
 *  convergence, kept compact (the full per-route inventory lives in `flow`). */
export interface SeamVisibility {
  /** Structural duplicates the graph surfaced at the trial head. */
  readonly duplicates: number;
  /** Dead-surface counts by tier. */
  readonly dead: { readonly removable: number; readonly likely: number; readonly expected: number };
  /** Whether every route consumer was visible (an explicit mesh or co-located
   *  UI) — when false, the `removable` tier is suppressed and deadness is
   *  unconfirmed cross-repo. */
  readonly crossRepoConsumersVisible: boolean;
  /** The ranked "removable slop": routes that are BOTH dead AND a copy-paste,
   *  each with the duplicate twin's symbols. The highest-confidence seam signal. */
  readonly converged: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly file: string;
    readonly twin: ReadonlyArray<string>;
  }>;
  /** A few top structural duplicates (score-ranked) for the visibility lane. */
  readonly topDuplicates: ReadonlyArray<{
    readonly a: string;
    readonly b: string;
    readonly score: number;
  }>;
}

/**
 * The adoption-cost card. Provenance discipline: `gateReplayMs` and
 * `interruptions` are MEASURED by this trial on this repo; `setup.writes`
 * is the static, versioned list of what `init` creates (all reversible via
 * `uninstall`); `setup.missingScanners` is the trial's own tool probe.
 * Anything modeled rather than measured goes in `notes`, never in a
 * number field.
 */
export interface EvaluateCosts {
  /** Wall-clock cost of one gate replay on this repo (the honest upper
   *  bound for a per-PR CI gate run; the installed Stop-gate is typically
   *  faster — verdict cache, preset-scoped gather). */
  readonly gateReplayMs: {
    readonly median: number;
    readonly p95: number;
    readonly max: number;
  };
  /** How often the gate would have interrupted this repo's recent history —
   *  the friction number. Zero interruptions = the gate would have stayed
   *  out of the way. */
  readonly interruptions: {
    readonly blockedLandings: number;
    readonly landings: number;
  };
  /** Warning pairs across the replay: reported, never blocking. The
   *  ongoing-noise indicator. */
  readonly warnNoise: number;
  readonly setup: {
    /** Scanners the trial found missing on this machine — what
     *  `tools install` would provision. */
    readonly missingScanners: ReadonlyArray<string>;
    /** What `init --claude-loop` writes (static; every entry reversible
     *  with `uninstall`). */
    readonly writes: ReadonlyArray<string>;
  };
  /** Derivation honesty for the numbers above. */
  readonly notes: ReadonlyArray<string>;
}

/** The static list of what the default install writes. Kept here (not in
 *  the renderer) so JSON consumers see the same facts as the text view. */
export const INIT_WRITES: ReadonlyArray<string> = Object.freeze([
  '.dxkit/ (policy, baseline)',
  '.claude/settings.json Stop hook (merged additively)',
  'devDependency @vyuhlabs/dxkit',
  'AGENTS.md + agent skills (optional surfaces: git hooks, CI workflows, with --full)',
]);

function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function buildCosts(runs: ReadonlyArray<EvaluateRunEvidence>): EvaluateCosts {
  const evaluated = runs.filter((r) => !r.error);
  const durations = evaluated.map((r) => r.durationMs).sort((a, b) => a - b);
  const missing = new Set<string>();
  for (const run of evaluated) {
    for (const scanner of run.coverage.scanners) {
      if (!scanner.available) missing.add(scanner.tool);
    }
  }
  return {
    gateReplayMs: {
      median: percentile(durations, 50),
      p95: percentile(durations, 95),
      max: durations.length ? durations[durations.length - 1] : 0,
    },
    interruptions: {
      blockedLandings: evaluated.filter((r) => r.verdict.blocks).length,
      landings: evaluated.length,
    },
    warnNoise: evaluated.reduce((sum, r) => sum + r.warningCount, 0),
    setup: {
      missingScanners: [...missing].sort(),
      writes: INIT_WRITES,
    },
    notes: [
      'gateReplayMs is measured by this trial on this repo (both sides gathered per landing). ' +
        'The installed Stop-gate is typically faster: it reuses the committed baseline and a verdict cache.',
      'Creating the initial baseline costs roughly one full scan (the same order as one replayed landing).',
      'Every install write is reversible: `vyuh-dxkit uninstall` restores the pre-dxkit state.',
    ],
  };
}

/** Everything `buildRunEvidence` needs besides the gate result. */
export interface RunEvidenceMeta {
  readonly pair: LandingPair;
  readonly durationMs: number;
}

export function runLabel(pair: LandingPair): string {
  return pair.prNumber !== undefined ? `#${pair.prNumber}` : pair.headSha.slice(0, 8);
}

/** Lift one landing's evidence out of a completed gate run. */
export function buildRunEvidence(
  result: GuardrailCheckResult,
  meta: RunEvidenceMeta,
): EvaluateRunEvidence {
  const payload = renderJson(result);
  const blocking = payload.pairs
    .filter((p) => p.blocks && !p.suppressedByAllowlist)
    .map((p) => ({ kind: p.kind, severity: p.severity, file: p.file, line: p.line }));
  return {
    label: runLabel(meta.pair),
    baseSha: meta.pair.baseSha,
    headSha: meta.pair.headSha,
    subject: meta.pair.subject || undefined,
    committedAt: meta.pair.committedAt || undefined,
    prNumber: meta.pair.prNumber,
    verdict: { blocks: payload.verdict.blocks, warns: payload.verdict.warns },
    blocking,
    warningCount: payload.summary.warning,
    refExcludedKinds: result.refExcludedKinds,
    depVulnsUnmeasured: result.depVulnsUnmeasured,
    coverage: result.current.coverage,
    toolVersions: { base: result.baseline.tools, head: result.current.tools },
    matcher: {
      gitAware: payload.matcher.gitAware,
      degradedReason: payload.matcher.degradedReason,
    },
    guardrail: payload,
    durationMs: meta.durationMs,
  };
}

/** The evidence entry for a landing that could not be evaluated. */
export function buildErrorEvidence(
  pair: LandingPair,
  durationMs: number,
  error: { message: string; hint?: string },
): EvaluateRunEvidence {
  return {
    label: runLabel(pair),
    baseSha: pair.baseSha,
    headSha: pair.headSha,
    subject: pair.subject || undefined,
    committedAt: pair.committedAt || undefined,
    prNumber: pair.prNumber,
    verdict: { blocks: false, warns: false },
    blocking: [],
    warningCount: 0,
    refExcludedKinds: [],
    coverage: { scanners: [] },
    toolVersions: { base: {}, head: {} },
    matcher: { gitAware: false },
    durationMs,
    error,
  };
}

/** The dep-advisory anachronism disclosure, present whenever a historical
 *  landing produced dependency-vulnerability findings. */
export const ANACHRONISM_NOTE =
  'Dependency advisories are current-day: a historical landing can show a block ' +
  'for a CVE disclosed after it merged. The live gate never has this skew.';

export function buildEvidenceDoc(input: {
  readonly branch: string;
  readonly ref: string;
  readonly preset: LoopPreset;
  readonly presetSource: 'flag' | 'default';
  readonly policyBase: 'repo-policy' | 'defaults';
  readonly incremental: boolean;
  readonly untrusted: boolean;
  readonly runs: ReadonlyArray<EvaluateRunEvidence>;
  /** The seam-visibility summary for the trial head (optional — absent when the
   *  head could not be analyzed). */
  readonly seams?: SeamVisibility;
}): EvaluateEvidenceDoc {
  const evaluated = input.runs.filter((r) => !r.error);
  const blocked = evaluated.filter((r) => r.verdict.blocks).length;
  const warned = evaluated.filter((r) => !r.verdict.blocks && r.verdict.warns).length;
  const notes: string[] = [];
  // `secret-hmac` is an internal matcher-assist companion of the located
  // `secret` kind (which IS gated here) — disclosing it would read as
  // "secrets were not watched". It stays in each run's refExcludedKinds for
  // fidelity but is never a user-facing exclusion.
  const excluded = new Set(
    evaluated
      .flatMap((r) => r.refExcludedKinds.map((k) => k.kind))
      .filter((k) => k !== 'secret-hmac'),
  );
  if (excluded.size > 0) {
    notes.push(
      `Not gated in this trial (ref-vs-ref replay cannot gather them comparably): ` +
        `${[...excluded].sort().join(', ')}. The installed gate covers them in committed mode.`,
    );
  }
  const hasDepFindings = evaluated.some((r) => r.blocking.some((b) => b.kind === 'dep-vuln'));
  if (hasDepFindings) notes.push(ANACHRONISM_NOTE);
  return {
    ...evidenceEnvelope(EVALUATE_EVIDENCE_SCHEMA),
    schema: EVALUATE_EVIDENCE_SCHEMA,
    repo: { branch: input.branch, ref: input.ref },
    policy: {
      preset: input.preset,
      source: input.presetSource,
      base: input.policyBase,
    },
    options: { incremental: input.incremental, untrusted: input.untrusted },
    zeroWrite: true,
    runs: input.runs,
    totals: {
      landings: input.runs.length,
      blocked,
      warned,
      clean: evaluated.length - blocked - warned,
      errored: input.runs.length - evaluated.length,
    },
    notes,
    costs: buildCosts(input.runs),
    ...(input.seams ? { seams: input.seams } : {}),
  };
}

/** Project a gathered `SeamInventory` to the compact `SeamVisibility` summary the
 *  evidence doc carries. Pure. */
export function seamVisibilityFrom(inv: {
  duplicates: ReadonlyArray<{
    anchors: readonly [{ file: string; symbol: string }, { file: string; symbol: string }];
    score: number;
  }>;
  dead: {
    crossRepoConsumersVisible: boolean;
    byTier: { removable: number; likely: number; expected: number };
  };
  converged: ReadonlyArray<{
    route: { method: string; path: string; file: string };
    duplicate: { anchors: readonly [{ symbol: string }, { symbol: string }] };
  }>;
}): SeamVisibility {
  const anchorLabel = (a: { file: string; symbol: string }) => `${a.symbol} @ ${a.file}`;
  return {
    duplicates: inv.duplicates.length,
    dead: inv.dead.byTier,
    crossRepoConsumersVisible: inv.dead.crossRepoConsumersVisible,
    converged: inv.converged.map((c) => ({
      method: c.route.method,
      path: c.route.path,
      file: c.route.file,
      twin: c.duplicate.anchors.map((a) => a.symbol),
    })),
    topDuplicates: [...inv.duplicates]
      .sort((x, y) => y.score - x.score)
      .slice(0, 5)
      .map((d) => ({
        a: anchorLabel(d.anchors[0]),
        b: anchorLabel(d.anchors[1]),
        score: d.score,
      })),
  };
}
