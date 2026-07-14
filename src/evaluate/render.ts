/**
 * Text rendering for the zero-write trial. Pure functions returning plain
 * strings (no ANSI, no I/O) so the funnel copy is unit-testable — the
 * `buildNextSteps` discipline from the demo command applied to evaluate.
 *
 * The empty result is a first-class outcome, not an empty screen: a clean
 * replay renders the trust framing (existing debt grandfathered, the gate
 * would have stayed out of the way), what was WATCHED, what it would COST,
 * and the next step — because on a well-maintained repo, clean is the
 * common case and it has to carry the story.
 */
import type { EvaluateEvidenceDoc, EvaluateRunEvidence } from './evidence';

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Group identical kind+severity findings: "secret high ×2, dep-vuln critical". */
function summarizeBlocking(blocking: EvaluateRunEvidence['blocking']): string {
  const counts = new Map<string, number>();
  for (const b of blocking) {
    const key = b.severity ? `${b.kind} ${b.severity}` : b.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, n]) => (n > 1 ? `${key} ×${n}` : key)).join(', ');
}

function landingLine(run: EvaluateRunEvidence): string {
  const subject = run.subject ? `  ${run.subject.slice(0, 64)}` : '';
  if (run.error) return `  error    ${run.label}${subject}\n           ${run.error.message}`;
  if (run.verdict.blocks) {
    return `  BLOCKED  ${run.label}${subject}\n           net-new: ${summarizeBlocking(run.blocking)}`;
  }
  if (run.verdict.warns) return `  warned   ${run.label}${subject}`;
  return `  clean    ${run.label}${subject}`;
}

/** The headline sentence — the first thing a reader (or a screenshot) sees. */
export function headline(doc: EvaluateEvidenceDoc): string {
  const { blocked, landings, errored } = doc.totals;
  const evaluated = landings - errored;
  const unit = doc.repo.ref === 'HEAD' ? 'landings' : 'range';
  if (doc.repo.ref !== 'HEAD') {
    return blocked > 0
      ? `dxkit would have blocked this ${unit}.`
      : `dxkit would not have blocked this ${unit}.`;
  }
  return blocked > 0
    ? `dxkit would have blocked ${blocked} of your last ${evaluated} landings.`
    : `None of your last ${evaluated} landings would have been blocked.`;
}

/** The trust framing for a clean replay — the common case on a
 *  well-maintained repo, and the false-block story: the gate would have
 *  stayed out of the way. */
function cleanFraming(doc: EvaluateEvidenceDoc): string[] {
  const latest = doc.runs.find((r) => !r.error && r.guardrail);
  const lines: string[] = [];
  if (latest?.guardrail) {
    const existing = latest.guardrail.baseline.findingsCount;
    if (existing > 0) {
      lines.push(
        `Your repo carries ${existing} pre-existing findings in the gated classes — all ` +
          `grandfathered. The gate blocks only what a change adds, and your recent ` +
          `changes added nothing it blocks on.`,
      );
    } else {
      lines.push(
        `No pre-existing findings in the gated classes, and no landing added one — ` +
          `the gate would have stayed silent throughout.`,
      );
    }
  }
  return lines;
}

function watchedSection(doc: EvaluateEvidenceDoc): string[] {
  const lines: string[] = [`Watched (preset: ${doc.policy.preset}):`];
  const latest = doc.runs.find((r) => !r.error);
  if (latest) {
    const available = latest.coverage.scanners.filter((s) => s.available).map((s) => s.tool);
    const missing = latest.coverage.scanners.filter((s) => !s.available).map((s) => s.tool);
    if (available.length) lines.push(`  scanners ran: ${available.join(', ')}`);
    if (missing.length) {
      lines.push(
        `  scanners missing on this machine (their classes were NOT watched): ${missing.join(', ')}`,
      );
    }
    if (latest.depVulnsUnmeasured) {
      lines.push(`  dependency audit could not run: ${latest.depVulnsUnmeasured.reason}`);
    }
  }
  return lines;
}

function costsSection(doc: EvaluateEvidenceDoc): string[] {
  const c = doc.costs;
  const lines: string[] = ['What enabling dxkit costs on this repo (measured by this trial):'];
  if (c.gateReplayMs.median > 0) {
    lines.push(
      `  gate run: ${seconds(c.gateReplayMs.median)} median, ${seconds(c.gateReplayMs.p95)} p95 ` +
        `per change (the installed Stop-gate is typically faster — it reuses the baseline ` +
        `and a verdict cache)`,
    );
  }
  const unit = c.interruptions.landings === 1 ? 'landing' : 'landings';
  lines.push(
    c.interruptions.blockedLandings === 0
      ? `  interruptions: none across the ${c.interruptions.landings} evaluated ${unit}`
      : `  interruptions: ${c.interruptions.blockedLandings} of the ` +
          `${c.interruptions.landings} evaluated ${unit} would have paused for a repair`,
  );
  if (c.warnNoise > 0) {
    lines.push(`  warnings (reported, never blocking): ${c.warnNoise} across the replay`);
  }
  if (c.setup.missingScanners.length > 0) {
    lines.push(`  setup: \`tools install\` would provision ${c.setup.missingScanners.join(', ')}`);
  }
  lines.push(`  install writes: ${c.setup.writes.join('; ')}`);
  lines.push('  everything is reversible: `vyuh-dxkit uninstall` restores the pre-dxkit state');
  return lines;
}

function nextSteps(doc: EvaluateEvidenceDoc): string[] {
  const lines: string[] = ['Next:'];
  if (doc.totals.blocked === 0) {
    lines.push(
      '  see a real block → repair → clean cycle in ~20s (fixture repo, yours untouched):',
      '    npx -y @vyuhlabs/dxkit@latest demo loop-guardrail',
    );
  }
  lines.push(
    '  arm the gate for real (one command, reversible):',
    '    npm init @vyuhlabs/dxkit -- --claude-loop --yes',
  );
  return lines;
}

/**
 * The seam-visibility lane — what dxkit SEES in the repo (structural duplicates,
 * dead surfaces, and the convergence between them), shown INDEPENDENT of the
 * gate verdict. This is the trial's differentiator: on a repo where the gate is
 * clean (the common case), it is the one thing that separates dxkit's output
 * from "your CI is fine" — the structural insight a linter, CI, and a token
 * duplicate-checker do not surface at all. So it speaks even when the scan is
 * clean (mirror of the clean-gate framing), and stays silent only when the seam
 * scan could not run (no head / analysis failed → `doc.seams` absent).
 */
function seamsSection(doc: EvaluateEvidenceDoc): string[] {
  const s = doc.seams;
  if (!s) return []; // the seam scan did not run — nothing honest to say
  const deadTotal = s.dead.removable + s.dead.likely + s.dead.expected;
  const hasSignal = s.converged.length > 0 || s.duplicates > 0 || deadTotal > 0;

  // Computed, nothing surfaced — the value lens still speaks: dxkit looked at a
  // class no linter/CI covers, and the repo read structurally clean.
  if (!hasSignal) {
    return [
      'What dxkit sees beyond the verdict (structural seams):',
      '  dxkit mapped the call graph for copy-paste re-implementations and served ' +
        'surfaces with no consumer — none surfaced at the trial head.',
      '  (no linter or CI sees this class; `vyuh-dxkit flow` / `quality` show the full inventory)',
    ];
  }

  // A content-aware header so a loud signal (a removable copy-paste-and-dead
  // route) reads as the headline it is, not a footnote.
  const header =
    s.converged.length > 0
      ? `What dxkit sees beyond the verdict — ${s.converged.length} structural seam(s) worth removing:`
      : 'What dxkit sees beyond the verdict (structural seams):';
  const lines: string[] = [header];
  if (s.duplicates > 0) {
    // Lead on the high-confidence VERIFIED copies, CLUSTERED into distinct
    // patterns — so one framework CRUD verb recurring across 50 controllers reads
    // as one pattern, not 1000 pairs. The lane stays signal, not a firehose.
    if (s.verifiedClusters > 0) {
      lines.push(
        `  ${s.verifiedClusters} verified duplicated pattern(s) — near-identical copies` +
          (s.largestCluster > 2 ? `, the largest across ${s.largestCluster} functions` : '') +
          ':',
      );
    } else {
      lines.push(`  ${s.duplicates} function(s) with similar structure (no exact copy):`);
    }
    for (const d of s.topDuplicates.slice(0, 3)) {
      lines.push(`    ${d.a}  ≈  ${d.b}  (similarity ${d.score.toFixed(2)})`);
    }
  }
  if (deadTotal > 0) {
    lines.push(
      `  ${deadTotal} served-but-unconsumed route(s) — ` +
        `${s.dead.removable} removable, ${s.dead.likely} likely, ${s.dead.expected} expected` +
        (s.consumerVisibilityNote ? ` (${s.consumerVisibilityNote})` : ''),
    );
  }
  if (s.converged.length > 0) {
    lines.push(
      `  ⛔ ${s.converged.length} converged — a route that is BOTH unconsumed AND a copy-paste (remove or consolidate):`,
    );
    for (const c of s.converged.slice(0, 5)) {
      lines.push(`    ${c.method} ${c.path}  (twin: ${c.twin.join(' ≈ ')})`);
    }
  }
  lines.push('  Run `vyuh-dxkit flow` for the full tiered inventory.');
  return lines;
}

/**
 * The full text report, in three acts:
 *   1. THE VERDICT — would the gate have blocked your recent work? (the safety
 *      promise + the brownfield "existing debt is grandfathered" framing).
 *   2. WHAT DXKIT SEES — the seam-visibility lane, elevated to right after the
 *      verdict because on a clean gate it is the differentiator (structural
 *      insight no linter/CI shows), not a footnote below the plumbing.
 *   3. SUPPORTING — what was watched (coverage honesty), what it costs, next.
 */
export function renderEvaluateText(doc: EvaluateEvidenceDoc): string {
  const sections: string[][] = [];
  // Act 1 — the verdict.
  sections.push([headline(doc)]);
  sections.push(doc.runs.map(landingLine));
  if (doc.totals.blocked === 0) {
    const framing = cleanFraming(doc);
    if (framing.length) sections.push(framing);
  }
  // Act 2 — the differentiator.
  const seams = seamsSection(doc);
  if (seams.length) sections.push(seams);
  // Act 3 — supporting detail.
  sections.push(watchedSection(doc));
  sections.push(costsSection(doc));
  if (doc.notes.length) sections.push(['Notes:', ...doc.notes.map((n) => `  ${n}`)]);
  sections.push(nextSteps(doc));
  sections.push(['Nothing was written to your repo.']);
  return sections.map((s) => s.join('\n')).join('\n\n');
}
