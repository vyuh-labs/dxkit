/**
 * The remediate verification ledger — deterministic, identifier-free
 * markdown (the PR body / job step summary). Split from the runner
 * (`run.ts`) purely for module size; the runner is its only producer. The
 * type dependency is type-only, so there is no runtime cycle.
 *
 * ONE renderer, two outputs (#374, Rule 2.30): `renderRemediateLedger` is
 * the FULL ledger (every order line; the committed run-ledger file and the
 * job step summary), `renderRemediatePrBody` is the SUMMARY the PR body
 * carries plus the link to that file. Both walk the same sections through
 * `renderLedgerLines`; the mode only decides what the per-order sections
 * collapse (`ledger-render-orders.ts`), so the two cannot drift in wording.
 * The byte cap itself is downstream, at the one gh boundary
 * (`openOrUpdateStandingPr`), so the summary is a size DISCIPLINE and the
 * cap is the size GUARANTEE.
 */
import { renderFloorVerification, renderGuardrailVerdict } from '../lanes/verification-render';
import { describeInstall } from '../lanes/verify-tree';
import { describeTreeInvariantOutcome } from '../lanes/tree-invariants';
import { renderScoreHinge } from './score-hinge';
import {
  PR_BODY_ORDER_LINE_THRESHOLD,
  renderOrdersSection,
  renderRecipeSection,
  type LedgerMode,
  type SectionLines,
} from './ledger-render-orders';
import type { RecipePhaseSummary } from './recipes/run-recipes';
import type { ContainmentRound, GuardrailContainment, RemediateResult } from './outcome';

/** The one wording of a round's re-verify: the tree verdict, the
 *  guardrail's word, and what it blocked on (capped by the engine). */
function describeReverify(r: ContainmentRound['reverify']): string {
  const head =
    `re-verify: ${r.verdict}` +
    (r.guardrailVerdict !== undefined ? ` (${r.guardrailVerdict})` : '');
  const blocking =
    r.blocking.length > 0
      ? `, blocking: ${r.blocking.join('; ')}` +
        (r.moreBlocking > 0 ? `; and ${r.moreBlocking} more` : '')
      : r.failure !== undefined
        ? `: ${r.failure}`
        : '';
  return head + blocking;
}

/**
 * ONE block per executed round (#373), the record every renderer reads: the
 * units the round dropped, then its re-verify. `summary` mode counts the
 * per-unit evidence lines once a round dropped more units than the PR body
 * lists one per line (the L4 discipline); the committed ledger has every
 * line. The wording of a line never changes with the mode.
 */
function renderContainmentRounds(
  rounds: readonly ContainmentRound[],
  mode: LedgerMode,
): SectionLines {
  const lines: string[] = [];
  let collapsed = false;
  for (const r of rounds) {
    const ids = r.dropped.flatMap((d) => d.orderIds);
    lines.push(
      `- round ${r.round}: dropped ${ids.length === 0 ? 'nothing' : `\`${ids.join('`, `')}\``}; ` +
        describeReverify(r.reverify),
    );
    if (mode === 'summary' && r.dropped.length > PR_BODY_ORDER_LINE_THRESHOLD) {
      collapsed = true;
      lines.push(
        `  - ${r.dropped.length} units dropped this round, each named with its attribution ` +
          'evidence in the committed ledger',
      );
      continue;
    }
    for (const d of r.dropped) {
      lines.push(
        `  - \`${d.orderIds.join('`, `')}\` (${d.unit}): attribution: ${d.evidence}; ` +
          `blocking: ${d.blocking.join('; ')}`,
      );
    }
  }
  return { lines, collapsed };
}

/** Guardrail-red containment (4.4.7): what was attributed and dropped, or
 *  why containment was refused: the reader sees exactly why an order the
 *  run dispatched is not in the landing set. A refusal keeps every round it
 *  ran (#373): what each round dropped, on what evidence, what its re-verify
 *  reported, and which round refused on what. */
function renderContainment(
  c: GuardrailContainment,
  recipes: RecipePhaseSummary | undefined,
  mode: LedgerMode,
): SectionLines {
  const lines: string[] = ['### Guardrail containment', ''];
  if (c.refused !== undefined) {
    lines.push(
      `The final guardrail was red and per-order containment was attempted (bounded at ` +
        `${c.maxRounds} unwind round(s)) but REFUSED after ${c.rounds} executed round(s). No ` +
        `order was dropped on a guess; every unwind below was restored to the pre-containment ` +
        `head, and the whole attempt follows the guardrail-red salvage policy.`,
    );
    const rounds = renderContainmentRounds(c.roundEvidence, mode);
    lines.push(...rounds.lines);
    lines.push(
      `- refused ${c.refusedAtRound !== undefined ? `in round ${c.refusedAtRound}` : 'before any round'}: ` +
        c.refused,
      '',
    );
    return { lines, collapsed: rounds.collapsed };
  }
  lines.push(
    `The final guardrail was red; each blocking finding was attributed to one order ` +
      `(envelope and committed-diff overlap), the attributed orders were dropped, and the ` +
      `remainder re-verified green in ${c.rounds} of at most ${c.maxRounds} round(s).`,
  );
  for (const d of c.dropped) {
    lines.push(
      `- dropped \`${d.orderIds.join('`, `')}\` (${d.unit}, round ${d.round}): ` +
        `attribution: ${d.evidence}`,
    );
    for (const b of d.blocking) lines.push(`  - blocking: ${b}`);
  }
  lines.push(...renderRecipeContainmentCounts(recipes));
  lines.push('');
  return { lines, collapsed: false };
}

/** Per recipe, how much of its applied work containment dropped vs lands
 *  (4.4.8: a file-scoped recipe drops one order at a time, so the reader
 *  sees "dropped 7 of 218; 211 land", never a whole tier gone). */
function renderRecipeContainmentCounts(recipes: RecipePhaseSummary | undefined): string[] {
  if (!recipes) return [];
  const byRecipe = new Map<string, { applied: number; dropped: number }>();
  for (const r of recipes.records) {
    if (r.outcome.kind !== 'applied') continue;
    const row = byRecipe.get(r.recipe) ?? { applied: 0, dropped: 0 };
    row.applied += 1;
    if (r.disposition?.kind === 'dropped' && r.disposition.step === 'guardrail') row.dropped += 1;
    byRecipe.set(r.recipe, row);
  }
  return [...byRecipe.entries()]
    .filter(([, row]) => row.dropped > 0)
    .map(
      ([recipe, row]) =>
        `- ${recipe}: dropped ${row.dropped} of ${row.applied} applied order(s); ` +
        `${row.applied - row.dropped} land`,
    );
}

/** The full ledger: every order, one line each. */
export function renderRemediateLedger(r: Omit<RemediateResult, 'ledger'>): string {
  return renderLedgerLines(r, 'full').lines.join('\n');
}

/**
 * The PR body (#374): the summary, plus where the full ledger lives. When
 * summary mode collapsed nothing, the body IS the run's ledger verbatim
 * (`r.ledger`, the contractual record) apart from the added link line, so
 * a small run's PR reads exactly as before. `ledgerFile` is the committed
 * run-ledger path on the branch, or null when it could not be written
 * (the body then points at the job step summary).
 */
export function renderRemediatePrBody(
  r: RemediateResult,
  opts: { readonly ledgerFile: string | null },
): string {
  const summary = renderLedgerLines(r, 'summary');
  const body = summary.collapsed ? summary.lines.join('\n') : r.ledger;
  const where = opts.ledgerFile
    ? `committed on this branch at \`${opts.ledgerFile}\``
    : 'in the job step summary of the run that opened this PR';
  return (
    `${body}\n\n_Full ledger (every order, one line each): ${where}. This body is the summary; ` +
    `it is capped to GitHub's PR body size._`
  );
}

/** The ONE walk over the ledger's sections; the mode is threaded to the
 *  per-order sections only. `collapsed` reports whether summary mode
 *  shortened anything (see `renderRemediatePrBody`). */
function renderLedgerLines(
  r: Omit<RemediateResult, 'ledger'>,
  mode: LedgerMode,
): { readonly lines: string[]; readonly collapsed: boolean } {
  let collapsed = false;
  const lines: string[] = ['## dxkit agentic remediation', ''];
  lines.push(`Task: **${r.task ?? '(none)'}** — outcome: **${r.outcome}**`);
  if (r.legacyTaskPath) {
    // The legacy path names itself (#393): an order-driven run and a
    // single-prompt run must never read identically in the ledger.
    lines.push(
      '',
      'Agent path: legacy single-prompt task run: no work-order plan applies to this task ' +
        `(${r.legacyTaskPath}).`,
    );
  }
  if (r.partial)
    lines.push(
      '',
      'Budget-bounded, not finished: the work below is real and verified, but the task was cut short.',
    );
  if (r.note) lines.push('', r.note);
  lines.push('');

  if (r.envelope) {
    const e = r.envelope;
    lines.push('### Agent envelope', '');
    const modelWhy =
      e.modelSource === 'auto-tier'
        ? 'auto tier'
        : e.modelSource === 'pinned-tier'
          ? 'tier pinned by policy'
          : 'pinned by policy';
    lines.push(
      `- driver: \`${e.driver}\`` +
        (e.cliVersion ? ` — agent CLI ${e.cliVersion}` : ' — agent CLI version not reported'),
    );
    lines.push(
      `- model: \`${e.model}\` (${modelWhy})` +
        (e.resolvedModelId
          ? ` — ran as \`${e.resolvedModelId}\``
          : ' — concrete id not reported by driver'),
    );
    if (e.modelWarning) lines.push(`- model warning: ${e.modelWarning}`);
    // Under subscription auth a reported cost is a NOTIONAL API-equivalent,
    // not billed spend — printing it as "spend" makes a benchmark table read
    // as a bill (and a $0 lane look free when it is quota).
    const spendLabel = e.auth === 'subscription' ? 'API-equivalent cost' : 'spend';
    lines.push(
      `- auth: ${
        e.auth === 'subscription'
          ? 'subscription (stored login — costs shown are API-equivalents, not billed spend)'
          : 'api-key (billed API spend)'
      }`,
    );
    lines.push(
      `- ${spendLabel}: ${e.costUsd !== undefined ? `$${e.costUsd.toFixed(2)}` : 'not reported'} over ` +
        `${e.turns !== undefined ? `${e.turns} turns` : 'an unreported turn count'} ` +
        `(caps: ${e.budget.maxTurns} turns, ${e.budget.maxMinutes} min, $${e.budget.maxUsd})`,
    );
    // The in-loop gate disclosure (#305): a run whose Stop-gate never loaded
    // must not read identically to one where it did — the burn-budget-then-
    // red shape starts exactly here.
    lines.push(
      e.inLoopGate.mode === 'in-loop-gated'
        ? `- in-loop gate: ARMED — ${e.inLoopGate.reason}`
        : `- in-loop gate: BACKSTOP-ONLY — ${e.inLoopGate.reason}`,
    );
    // The tool policy applied to order-driven runs — how the driver
    // narrowed tools, or the disclosed fact that it could not.
    if (e.toolPolicy) {
      lines.push(
        e.toolPolicy.mechanism === 'disallowed-tools'
          ? `- tool policy: disallowed-tools — denied: ${e.toolPolicy.disallowed.join(', ')} ` +
              `(${e.toolPolicy.cliRequirement})`
          : `- tool policy: NOT applied — ${e.toolPolicy.reason}`,
      );
    }
    if (e.failure) lines.push(`- driver-reported failure: ${e.failure}`);
    if (e.turns !== undefined && e.turns > e.budget.maxTurns) {
      // The 81-vs-80 confusion: the driver's reported count can exceed the
      // cap it enforced (its accounting includes the closing turn). Say so —
      // an over-cap count otherwise reads as broken enforcement.
      lines.push(
        `- note: the driver reported ${e.turns} turns against its ${e.budget.maxTurns}-turn ` +
          `cap — the driver's own count includes the run's closing turn; the cap did enforce.`,
      );
    }
    for (const cap of e.unenforceableCaps) {
      lines.push(`- disclosed limitation: ${cap}`);
    }
    lines.push('');
  }

  if (r.resume) {
    lines.push(
      `Resumed budget-bounded attempt #${r.resume.attempt} — continuing the salvage branch; ` +
        'the entry floor was captured on the pristine base, so a broken partial can never ' +
        'grandfather its own breakage.',
      '',
    );
  }

  if (r.scrubbedArtifacts && r.scrubbedArtifacts.length > 0) {
    lines.push(
      `Dropped from the attempt (regenerable dxkit scan state the agent committed mid-run — ` +
        `never part of the delivery): ${r.scrubbedArtifacts.length} path(s): ` +
        r.scrubbedArtifacts.slice(0, 8).join(', ') +
        (r.scrubbedArtifacts.length > 8 ? ', …' : ''),
      '',
    );
  }

  if (r.dispatch) {
    lines.push('### Dispatch campaign', '');
    lines.push(
      `- dispatched by: ${r.dispatch.actor ? `\`${r.dispatch.actor}\`` : 'not reported (no GITHUB_ACTOR)'}`,
    );
    for (const c of r.dispatch.clamped) lines.push(`- clamped: ${c}`);
    if (r.dispatch.prompt !== undefined) {
      lines.push(
        '- no score hinge exists for a custom goal — verification is the floor + the ' +
          'guardrail + the human reviewing this PR against the prompt below.',
      );
      lines.push('', 'Prompt (verbatim):', '', '```', r.dispatch.prompt, '```');
    }
    lines.push('');
  }

  if (
    r.recipes &&
    (r.recipes.ran ||
      r.recipes.disabled ||
      r.recipes.planError ||
      (r.recipes.paused?.length ?? 0) > 0)
  ) {
    const recipes = renderRecipeSection(r.recipes, mode);
    lines.push(...recipes.lines);
    collapsed = collapsed || recipes.collapsed;
  }

  if (r.orders) {
    lines.push(...renderOrdersSection(r.orders));
  }

  if (r.containment) {
    const containment = renderContainment(r.containment, r.recipes, mode);
    lines.push(...containment.lines);
    collapsed = collapsed || containment.collapsed;
  }

  lines.push('### Verification', '');
  if (r.frameInvariants) {
    for (const o of r.frameInvariants.applied) {
      lines.push(`- frame invariant: ${describeTreeInvariantOutcome(o)}`);
    }
    for (const d of r.frameInvariants.disclosures) {
      lines.push(`- frame invariant disclosure: ${d}`);
    }
    if (r.frameInvariants.applied.length > 0 || r.frameInvariants.disclosures.length > 0) {
      lines.push('');
    }
  }
  if (r.outcome === 'verification-unavailable') {
    lines.push(
      'Verification infrastructure failed: no verdict was reached on the tree. All committed ' +
        'work stays on the local branch (nothing was reset and nothing lands); the branch is ' +
        'left for inspection or resume.',
      '',
    );
  }
  if (r.outcome === 'partially-landed') {
    lines.push(
      'Per-order landing: the orders marked KEPT above verified and land together; the ' +
        'orders marked DROPPED were reverted with the reason named and remain open.',
      '',
    );
  }
  // The install line comes first: it is what CI's own install step will do
  // with this tree, verified on a clean checkout (4.4.5).
  const install = describeInstall(r.install);
  if (install) lines.push(install, '');
  // Tolerance-resolution warnings (an unknown dependencies.tolerate entry, a
  // policy opt-out conflicting with observed .npmrc config): disclosed here,
  // beside the install they governed.
  for (const w of r.installToleranceWarnings ?? []) lines.push(`Warning: ${w}`, '');
  lines.push(
    ...renderFloorVerification(
      r.floor,
      r.floorAttribution,
      'the pre-agent entry run',
      r.floorSkipped,
    ),
  );
  lines.push(...renderGuardrailVerdict(r.guardrailVerdict, r.guardrailImpact));
  if (r.scoreHinge) lines.push(renderScoreHinge(r.scoreHinge));
  lines.push(
    "_Agentic lane inside the verified frame: the agent's own claim of success is never " +
      'trusted — the entry-attributed floor and the guardrail ran before anything lands, ' +
      'and everything not verified is named above._',
  );
  return { lines, collapsed };
}
