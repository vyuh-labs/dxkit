/**
 * The remediate verification ledger — deterministic, identifier-free
 * markdown (the PR body / job step summary). Split from the runner
 * (`run.ts`) purely for module size; the runner is its only producer. The
 * type dependency is type-only, so there is no runtime cycle.
 */
import { renderFloorVerification, renderGuardrailVerdict } from '../lanes/verification-render';
import { renderScoreHinge } from './score-hinge';
import type { RemediateResult } from './run';

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

  lines.push('### Verification', '');
  lines.push(...renderFloorVerification(r.floor, r.floorAttribution, 'the pre-agent entry run'));
  lines.push(...renderGuardrailVerdict(r.guardrailVerdict));
  if (r.scoreHinge) lines.push(renderScoreHinge(r.scoreHinge));
  lines.push(
    "_Agentic lane inside the verified frame: the agent's own claim of success is never " +
      'trusted — the entry-attributed floor and the guardrail ran before anything lands, ' +
      'and everything not verified is named above._',
  );
  return lines.join('\n');
}
