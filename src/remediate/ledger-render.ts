/**
 * The remediate verification ledger — deterministic, identifier-free
 * markdown (the PR body / job step summary). Split from the runner
 * (`run.ts`) purely for module size; the runner is its only producer. The
 * type dependency is type-only, so there is no runtime cycle.
 */
import { renderFloorVerification, renderGuardrailVerdict } from '../lanes/verification-render';
import { describeInstall } from '../lanes/verify-tree';
import { describeTreeInvariantOutcome, type TreeInvariantOutcome } from '../lanes/tree-invariants';
import type { OrderDisposition } from './outcome';
import { renderScoreHinge } from './score-hinge';
import { recipeCounts, type RecipePhaseSummary } from './recipes/run-recipes';
import type { GuardrailContainment, OrdersPhaseSummary, RemediateResult } from './outcome';

/** The deterministic-recipe section: one line per order (applied / refused /
 *  failed with the reason), the tier split, and every disclosure: a $0
 *  refusal is only worth its price if the reader can see WHY. */
function renderRecipeSection(recipes: RecipePhaseSummary): string[] {
  const lines: string[] = ['### Deterministic recipes', ''];
  if (recipes.disabled) {
    lines.push('Recipes are disabled by policy (`remediate.recipes.enabled: false`).');
    if (recipes.planError) {
      // Disabled AND broken planning: both facts render — the disabled note
      // must not hide why no order queue exists for the agent tier.
      lines.push(
        `Work-order planning failed (${recipes.planError}); no orders were queued for the ` +
          'agent tier.',
      );
    }
    lines.push(...renderPausedOrders(recipes));
    lines.push('');
    return lines;
  }
  if (recipes.planError) {
    lines.push(
      `Work-order planning failed (${recipes.planError}); no recipe ran, and the agent path ` +
        'proceeded as before.',
      '',
    );
    return lines;
  }
  const counts = recipeCounts(recipes);
  lines.push(
    `Selected orders: ${recipes.selectedRecipeTier} recipe-tier, ` +
      `${recipes.selectedAgentTier} agent-tier` +
      (recipes.records.length > 0
        ? `: ${counts.applied} applied, ${counts.refused} refused, ${counts.failed} failed.`
        : '.'),
  );
  for (const rec of recipes.records) {
    const o = rec.outcome;
    if (o.kind === 'applied') {
      lines.push(
        `- \`${rec.orderId}\` (${rec.recipe}): APPLIED, changed ${o.changedFiles.join(', ')}` +
          (o.notes && o.notes.length > 0 ? ` (${o.notes.join('; ')})` : '') +
          (o.revert ? `. To revert: ${o.revert}` : ''),
      );
    } else if (o.kind === 'refused') {
      lines.push(`- \`${rec.orderId}\` (${rec.recipe}): refused, ${o.reason}`);
    } else {
      lines.push(`- \`${rec.orderId}\` (${rec.recipe}): FAILED at ${o.step}, ${o.output}`);
    }
    if (rec.droppedPaths && rec.droppedPaths.length > 0) {
      lines.push(
        `  - discarded out-of-envelope change(s), disclosed: ${rec.droppedPaths.join(', ')}`,
      );
    }
    lines.push(...renderInvariants(rec.invariants));
    lines.push(...renderInvariantDisclosures(rec.invariantDisclosures));
    lines.push(...renderDisposition(rec.disposition));
  }
  if (recipes.groupVerification) {
    const g = recipes.groupVerification;
    lines.push(
      g.kind === 'kept'
        ? '- recipe group verified as one unit before the agent tier (install + floor); it lands'
        : g.kind === 'dropped'
          ? `- recipe group DROPPED before the agent tier at ${g.step}: ${g.reason} ` +
            `(its own committed paths were reverted, other changes untouched; orders still ` +
            `open: ${g.droppedOrderIds.join(', ')})`
          : `- recipe group UNVERIFIABLE (verification infrastructure failed: ${g.reason}); ` +
            'its commits stay on the branch, nothing lands',
    );
  }
  for (const d of recipes.disclosures) lines.push(`- plan disclosure: ${d}`);
  lines.push(...renderPausedOrders(recipes));
  lines.push('');
  return lines;
}

/** Circuit-breaker pauses (3F): a paused order is planned and selected but
 *  dispatched by NO tier — the ledger names each one, the reason, and what
 *  lifts the pause. Never a silent skip. */
function renderPausedOrders(recipes: RecipePhaseSummary): string[] {
  const paused = recipes.paused ?? [];
  if (paused.length === 0) return [];
  const lines: string[] = ['', '**Paused by the circuit breaker (not dispatched):**'];
  for (const p of paused) {
    lines.push(`- \`${p.orderId}\` (${p.class}, ${p.findings} finding(s)): ${p.reason}`);
  }
  lines.push(`- unpause: ${paused[0].unpause}`);
  return lines;
}

/** The frame-owned invariants an order tripped, one line each (4.4.6). */
function renderInvariants(outcomes: readonly TreeInvariantOutcome[] | undefined): string[] {
  if (!outcomes || outcomes.length === 0) return [];
  return outcomes.map((o) => `  - frame invariant: ${describeTreeInvariantOutcome(o)}`);
}

/** Collector/step disclosures for one order's invariant step. */
function renderInvariantDisclosures(disclosures: readonly string[] | undefined): string[] {
  if (!disclosures || disclosures.length === 0) return [];
  return disclosures.map((d) => `  - frame invariant disclosure: ${d}`);
}

/** Where the order's commits ended up (4.4.6): kept, dropped, or
 *  unverifiable (infrastructure; commits preserved, nothing lands). */
function renderDisposition(d: OrderDisposition | undefined): string[] {
  if (!d) return [];
  return [
    d.kind === 'kept'
      ? '  - landing: KEPT (verified on top of the previously verified head; lands)'
      : d.kind === 'dropped'
        ? `  - landing: DROPPED at ${d.step}, commits reverted, the order stays open: ${d.reason}`
        : `  - landing: UNVERIFIABLE (verification infrastructure failed: ${d.reason}); ` +
          'the commits stay on the branch, nothing lands',
  ];
}

/** The order-driven agent section: one entry per order — derived budget
 *  (with its derivation) vs spend, envelope enforcement outcomes, and the
 *  done disclosure. The reviewer sees exactly what each dispatch was scoped
 *  to and what the runner dropped. */
function renderOrdersSection(orders: OrdersPhaseSummary): string[] {
  const lines: string[] = ['### Work-order dispatches (one order per agent run)', ''];
  lines.push(
    `Queued ${orders.queued} agent-tier order(s); per-run cap ${orders.cap} ` +
      `(\`remediate.maxOrdersPerRun\`).`,
  );
  if (orders.priorBlockingApplied) {
    lines.push(
      'A prior BLOCKED attempt was not resumed; its blocking findings rode every order ' +
        'prompt as a negative constraint.',
    );
  }
  for (const rec of orders.records) {
    lines.push('');
    lines.push(`- \`${rec.orderId}\` (${rec.class}, ${rec.findings} finding(s)): ${rec.outcome}`);
    if (rec.detail) lines.push(`  - ${rec.detail}`);
    if (rec.outcome !== 'not-dispatched') {
      lines.push(`  - budget (derived, became the driver budget): ${rec.budget.derivation}`);
      if (rec.clamped) lines.push(`  - ${rec.clamped}`);
      const spent = rec.spent;
      lines.push(
        `  - spent: ${spent?.costUsd !== undefined ? `$${spent.costUsd.toFixed(2)}` : 'cost not reported'} over ` +
          `${spent?.turns !== undefined ? `${spent.turns} turns` : 'an unreported turn count'}`,
      );
      lines.push(
        rec.droppedPaths && rec.droppedPaths.length > 0
          ? `  - envelope enforcement DROPPED out-of-envelope or manifest-excluded ` +
              `change(s), disclosed: ` +
              rec.droppedPaths.join(', ')
          : '  - envelope enforcement: every change stayed inside the order envelope',
      );
      lines.push(...renderInvariants(rec.invariants));
      lines.push(...renderInvariantDisclosures(rec.invariantDisclosures));
      lines.push(...renderDisposition(rec.disposition));
      if (
        rec.disposition?.kind === 'kept' &&
        (rec.outcome === 'failed' || rec.outcome === 'partial')
      ) {
        // Driver-failure hygiene (4.4.7): a kept order whose driver failed
        // or overran its budget lands on the VERIFICATION's evidence, never
        // on any agent claim, and it is first in line for containment
        // attribution if the final guardrail goes red. Disclosed per order.
        lines.push(
          `  - driver-failure disclosure: the driver reported this order's run ` +
            (rec.outcome === 'failed' ? 'failed' : 'cut short (budget overrun)') +
            `, but the committed work passed per-order verification and lands on that ` +
            `evidence (the agent's claim counts for nothing); if the final guardrail goes ` +
            `red, this order is first in line for containment attribution.`,
        );
      }
      lines.push(
        rec.doneAfterVerify
          ? `  - done (${rec.done.verifier} verifier, ${rec.done.absentIds} target id(s)): ` +
              `${rec.doneAfterVerify.closed} closed, ${rec.doneAfterVerify.open} still open` +
              (rec.doneAfterVerify.undecided > 0
                ? `, ${rec.doneAfterVerify.undecided} undecided (the producing check was ` +
                  `not observed by the verification — not claimed closed)`
                : '') +
              ` per the verified floor`
          : `  - done (${rec.done.verifier} verifier, ${rec.done.absentIds} target id(s)): ` +
              `closure is arbitrated by the verification below and the next plan`,
      );
    }
  }
  lines.push('');
  return lines;
}

/** Guardrail-red containment (4.4.7): what was attributed and dropped, or
 *  why containment was refused: the reader sees exactly why an order the
 *  run dispatched is not in the landing set. */
function renderContainment(c: GuardrailContainment): string[] {
  const lines: string[] = ['### Guardrail containment', ''];
  if (c.refused !== undefined) {
    lines.push(
      `The final guardrail was red and per-order containment was attempted (bounded at ` +
        `${c.maxRounds} unwind round(s)) but REFUSED: ${c.refused}. No order was dropped on ` +
        `a guess; the whole attempt follows the guardrail-red salvage policy.`,
      '',
    );
    return lines;
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
  lines.push('');
  return lines;
}

export function renderRemediateLedger(r: Omit<RemediateResult, 'ledger'>): string {
  const lines: string[] = ['## dxkit agentic remediation', ''];
  lines.push(`Task: **${r.task ?? '(none)'}** — outcome: **${r.outcome}**`);
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
    lines.push(...renderRecipeSection(r.recipes));
  }

  if (r.orders) {
    lines.push(...renderOrdersSection(r.orders));
  }

  if (r.containment) {
    lines.push(...renderContainment(r.containment));
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
  return lines.join('\n');
}
