/**
 * Work-order rendering: the agent-facing prompt (section 3C) and the
 * one-line plan summary. The shared ground rules every remediation prompt
 * carries (`SHARED_RULES`) are appended here, never restated. Prose here is
 * human-toned and uses no em-dashes.
 */
import { SHARED_RULES } from '../tasks';
import type { WorkOrder, WorkOrderFinding } from './types';
import { WORK_ORDER_CLASSES, isBuiltinWorkOrderClass } from './types';

function describeFinding(f: WorkOrderFinding): string {
  const e = f.evidence;
  switch (e.type) {
    case 'floor':
      return e.specifier
        ? `${f.id}: '${e.specifier}' does not resolve` +
            (e.importingFiles && e.importingFiles.length > 0
              ? ` (imported by ${e.importingFiles.join(', ')})`
              : '')
        : `${f.id}: ${e.pack} ${e.label} fails (repro: ${e.command || 'see the floor check'})`;
    case 'dep-vuln':
      return (
        `${f.id}: ${e.package}${e.installedVersion ? `@${e.installedVersion}` : ''} ${e.advisoryId}` +
        (e.severity ? ` (${e.severity})` : '') +
        (e.fixedVersion ? `, fixed in ${e.fixedVersion}` : ', no fixed version known here') +
        (e.reachable === true ? ', reachable from your code' : '') +
        (e.expiresAt ? `, deferred until ${e.expiresAt}` : '')
      );
    case 'custom-check':
      return (
        `${f.id}: ${e.file ?? e.check}${e.line !== undefined ? `:${e.line}` : ''} ` +
        `${e.rule ?? e.check}${e.message ? `: ${e.message}` : ''}`
      );
    case 'none':
      return `${f.id} (${f.kind}; identity only)`;
  }
}

/** The attribution split sentence: which findings are the change's own,
 *  which are grandfathered, which are deferred. */
export function attributionSentence(order: WorkOrder): string {
  const counts = { 'net-new': 0, 'pre-existing': 0, unattributed: 0, deferred: 0 };
  for (const f of order.findings) counts[f.attribution] += 1;
  const parts: string[] = [];
  if (counts['net-new'] > 0)
    parts.push(`${counts['net-new']} of these are net-new (introduced by the current change)`);
  if (counts.deferred > 0)
    parts.push(`${counts.deferred} are deferred advisories that re-block on their expiry date`);
  if (counts['pre-existing'] > 0)
    parts.push(`${counts['pre-existing']} are pre-existing debt this order asks you to close`);
  if (counts.unattributed > 0)
    parts.push(`${counts.unattributed} could not be attributed (no base to compare against)`);
  return (
    parts.join('; ') +
    '. Everything else in the repo is grandfathered: do not touch findings outside this list.'
  );
}

/** The agent-facing prompt for one order. */
export function renderWorkOrderPrompt(order: WorkOrder): string {
  const classSummary = isBuiltinWorkOrderClass(order.class)
    ? WORK_ORDER_CLASSES[order.class].summary
    : order.class;
  const lines: string[] = [];
  lines.push(`Work order ${order.id} (${order.class}: ${classSummary}).`);
  lines.push('');
  lines.push(`Findings to close (${order.findings.length}):`);
  for (const f of order.findings) lines.push(`- ${describeFinding(f)}`);
  lines.push('');
  lines.push(`Attribution: ${attributionSentence(order)}`);
  if (order.outputTail) {
    lines.push('');
    lines.push('Captured output of the failing command:');
    lines.push(order.outputTail);
  }
  lines.push('');
  lines.push('Envelope (the only paths you may change):');
  for (const p of order.envelope.paths) lines.push(`- ${p === '' ? '(repo root)' : p}`);
  lines.push(
    order.envelope.manifests
      ? '- dependency manifests and lockfiles inside the envelope may change'
      : '- dependency manifests and lockfiles must NOT change',
  );
  lines.push('');
  lines.push('Constraints:');
  if (order.constraints.install) {
    const { bin, args } = order.constraints.install;
    lines.push(
      `- the repo installs with: ${[bin, ...args].join(' ')} (the frame runs it; use exactly this form if you must reproduce)`,
    );
  } else if (order.envelope.manifests) {
    lines.push(
      '- no install command is known for this repo (no active language pack declares one); ' +
        'do not install anything, write what a human must run in docs/DXKIT-REMEDIATION-NOTES.md',
    );
  }
  for (const f of order.constraints.forbidden) lines.push(`- do not: ${f}`);
  lines.push('');
  lines.push(
    `Done when: every id above is absent and no net-new finding appears inside the envelope. ` +
      `Check with: ${order.done.command}`,
  );
  lines.push(
    `Budget: ${order.budget.turns} turns, ${order.budget.minutes} minutes, ` +
      `$${order.budget.usd} (${order.budget.derivation}). Hitting the cap early is a signal, not a spend.`,
  );
  return lines.join('\n') + '\n' + SHARED_RULES;
}

/** One line per order for the plan surface. */
export function renderWorkOrderSummary(order: WorkOrder): string {
  const tier =
    order.tier === 'recipe' ? `recipe ${order.recipe} (declared, not yet executable)` : 'agent';
  const attribution = order.findings.some((f) => f.attribution === 'net-new')
    ? 'net-new'
    : order.findings.some((f) => f.attribution === 'deferred')
      ? 'deferred'
      : 'debt';
  return (
    `${order.id}: ${order.findings.length} finding(s), ${attribution}, tier ${tier}, ` +
    `${order.budget.turns} turns / ${order.budget.minutes} min / $${order.budget.usd}, ` +
    `done via ${order.done.verifier}`
  );
}
