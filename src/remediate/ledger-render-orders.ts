/**
 * The per-order sections of the remediate verification ledger (the recipe
 * tier and the agent-order dispatches), split from `ledger-render.ts` at
 * the module-size bar; the ledger renderer is their only consumer.
 *
 * ONE renderer, two modes (#374): `full` is the committed ledger and the
 * job step summary (every order, one line each); `summary` is the PR body,
 * where an applied recipe order that verified and KEPT is counted rather
 * than listed once the count passes a small threshold, and refused orders
 * are grouped by reason. Everything a reviewer must act on (a failed,
 * dropped, or unverifiable order, an envelope drop, an invariant, a paused
 * order) is listed in both modes. The mode changes what is collapsed, never
 * the wording of a line, so the two outputs cannot drift.
 */
import { describeTreeInvariantOutcome, type TreeInvariantOutcome } from '../lanes/tree-invariants';
import type { OrderDisposition } from './outcome';
import {
  recipeCounts,
  type RecipeOrderRecord,
  type RecipePhaseSummary,
} from './recipes/run-recipes';
import type { OrdersPhaseSummary } from './outcome';

export type LedgerMode = 'full' | 'summary';

/** Above this many quiet kept-applied (or refused) recipe orders, the PR
 *  body counts them instead of listing them one per line. */
export const PR_BODY_ORDER_LINE_THRESHOLD = 25;

/** What a section renderer reports back: its lines, and whether summary
 *  mode collapsed anything (a body that collapsed nothing is the full
 *  ledger verbatim, so the caller can hand that over unchanged). */
export interface SectionLines {
  readonly lines: string[];
  readonly collapsed: boolean;
}

/** An applied order with nothing a reviewer must act on: verified, kept
 *  (or never subject to a per-order placement), no envelope drop, no
 *  invariant, no disclosure. The only kind the PR body may count. */
function isQuietKept(rec: RecipeOrderRecord): boolean {
  return (
    rec.outcome.kind === 'applied' &&
    (rec.disposition === undefined || rec.disposition.kind === 'kept') &&
    !(rec.droppedPaths && rec.droppedPaths.length > 0) &&
    !(rec.invariants && rec.invariants.length > 0) &&
    !(rec.invariantDisclosures && rec.invariantDisclosures.length > 0)
  );
}

/** A refused order with nothing else attached: countable by reason. */
function isPlainRefusal(rec: RecipeOrderRecord): boolean {
  return (
    rec.outcome.kind === 'refused' &&
    !(rec.droppedPaths && rec.droppedPaths.length > 0) &&
    !(rec.invariants && rec.invariants.length > 0) &&
    !(rec.invariantDisclosures && rec.invariantDisclosures.length > 0) &&
    rec.disposition === undefined
  );
}

function renderRecipeRecord(rec: RecipeOrderRecord): string[] {
  const lines: string[] = [];
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
  return lines;
}

/** The deterministic-recipe section: one line per order (applied / refused /
 *  failed with the reason), the tier split, and every disclosure: a $0
 *  refusal is only worth its price if the reader can see WHY. */
export function renderRecipeSection(recipes: RecipePhaseSummary, mode: LedgerMode): SectionLines {
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
    return { lines, collapsed: false };
  }
  if (recipes.planError) {
    lines.push(
      `Work-order planning failed (${recipes.planError}); no recipe ran, and the agent path ` +
        'proceeded as before.',
      '',
    );
    return { lines, collapsed: false };
  }
  const counts = recipeCounts(recipes);
  lines.push(
    `Selected orders: ${recipes.selectedRecipeTier} recipe-tier, ` +
      `${recipes.selectedAgentTier} agent-tier` +
      (recipes.records.length > 0
        ? `: ${counts.applied} applied, ${counts.refused} refused, ${counts.failed} failed.`
        : '.'),
  );
  // Summary mode counts the quiet majority (#374): a 698-order run listed
  // one line per kept order and the body blew GitHub's cap. Only the two
  // countable kinds collapse, and only past the threshold; every line
  // still exists in the committed ledger, which the body names.
  const quietKept = recipes.records.filter(isQuietKept);
  const countKept = mode === 'summary' && quietKept.length > PR_BODY_ORDER_LINE_THRESHOLD;
  const plainRefused = recipes.records.filter(isPlainRefusal);
  const countRefused = mode === 'summary' && plainRefused.length > PR_BODY_ORDER_LINE_THRESHOLD;
  for (const rec of recipes.records) {
    if (countKept && isQuietKept(rec)) continue;
    if (countRefused && isPlainRefusal(rec)) continue;
    lines.push(...renderRecipeRecord(rec));
  }
  if (countKept) {
    lines.push(
      `- ${quietKept.length} applied recipe orders verified and KEPT (each named, with its ` +
        'changed files and revert, in the committed ledger; not listed here).',
    );
  }
  if (countRefused) {
    const byReason = new Map<string, number>();
    for (const rec of plainRefused) {
      const reason = rec.outcome.kind === 'refused' ? rec.outcome.reason : '';
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    lines.push(
      `- ${plainRefused.length} recipe orders refused (each named in the committed ledger), ` +
        'by reason:',
    );
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  - ${n}: ${reason}`);
    }
  }
  if (recipes.groupVerification) {
    const g = recipes.groupVerification;
    const contained = recipes.records.filter(
      (r) => r.disposition?.kind === 'dropped' && r.disposition.step === 'guardrail',
    ).length;
    lines.push(
      g.kind === 'kept'
        ? '- recipe group verified as one unit (install + floor); ' +
            (contained > 0
              ? `${contained} of its applied order(s) were later dropped by guardrail ` +
                'containment (each says so above); the rest land'
              : 'it lands')
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
  return { lines, collapsed: countKept || countRefused };
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
 *  to and what the runner dropped. Every dispatched order is listed in both
 *  modes: the agent tier is bounded by `remediate.maxOrdersPerRun`. */
export function renderOrdersSection(orders: OrdersPhaseSummary): string[] {
  const lines: string[] = ['### Work-order dispatches (one order per agent run)', ''];
  lines.push(
    orders.cap <= 0
      ? // The agent tier was disabled by policy (#393): the section names
        // the policy and the count so the open queue is never mistaken for
        // a dispatch that happened.
        `Agent tier disabled by policy (\`remediate.maxOrdersPerRun: 0\`); ${orders.queued} ` +
          'agent-tier order(s) not dispatched (each listed below, still open).'
      : `Queued ${orders.queued} agent-tier order(s); per-run cap ${orders.cap} ` +
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
