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

/** The full text report. */
export function renderEvaluateText(doc: EvaluateEvidenceDoc): string {
  const sections: string[][] = [];
  sections.push([headline(doc)]);
  sections.push(doc.runs.map(landingLine));
  if (doc.totals.blocked === 0) {
    const framing = cleanFraming(doc);
    if (framing.length) sections.push(framing);
  }
  sections.push(watchedSection(doc));
  sections.push(costsSection(doc));
  if (doc.notes.length) sections.push(['Notes:', ...doc.notes.map((n) => `  ${n}`)]);
  sections.push(nextSteps(doc));
  sections.push(['Nothing was written to your repo.']);
  return sections.map((s) => s.join('\n')).join('\n\n');
}
