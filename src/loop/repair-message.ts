/**
 * Guardrail-JSON → block analysis for the loop Stop-gate: which pairs block,
 * the per-category interception breakdown (#117), and the repair-friendly
 * message the model reads when blocked. Split out of `stop-gate.ts` to keep each
 * module a cohesive unit — the Stop-gate imports these; `demo.ts` and the tests
 * reuse `buildRepairMessage` (re-exported from `stop-gate.ts` for compatibility).
 */
import * as path from 'path';
import { LEDGER_DIR } from './ledger';
import type { GuardrailJsonPayload } from '../baseline/check-renderers';

/** Blocking pairs (classifier blocks AND not waived by an allowlist). */
export function blockingPairs(json: GuardrailJsonPayload): GuardrailJsonPayload['pairs'] {
  return json.pairs.filter((p) => p.blocks && p.suppressedByAllowlist === undefined);
}

/**
 * Per-category detail for the metrics interception series (#117). Splits the
 * live (non-allowlisted) net-new pairs into a blocked-by-category histogram
 * (sums to `net_new_findings`) and a warned-by-category one. Recorded on every
 * post-guardrail ledger event so `vyuh-dxkit metrics` can attribute
 * interceptions to a finding kind without re-gathering.
 */
export function findingBreakdown(json: GuardrailJsonPayload): {
  categories: Record<string, number>;
  warn_findings: number;
  warn_categories: Record<string, number>;
} {
  const categories: Record<string, number> = {};
  const warn_categories: Record<string, number> = {};
  let warn_findings = 0;
  for (const p of json.pairs) {
    if (p.suppressedByAllowlist !== undefined) continue; // waived — not a live finding
    if (p.blocks) {
      categories[p.kind] = (categories[p.kind] ?? 0) + 1;
    } else if (p.warns) {
      warn_findings++;
      warn_categories[p.kind] = (warn_categories[p.kind] ?? 0) + 1;
    }
  }
  return { categories, warn_findings, warn_categories };
}

/**
 * Build the repair-friendly message the model reads when blocked. Lists
 * each net-new finding with the location it must fix, and is explicit
 * about the two anti-patterns (refresh baseline / fix grandfathered debt)
 * so the loop stays scoped to what IT introduced.
 */
export function buildRepairMessage(json: GuardrailJsonPayload): string {
  const blocking = blockingPairs(json);
  const n = blocking.length;
  const lines: string[] = [];
  lines.push(
    `dxkit blocked completion because this branch introduces ${n} net-new ` +
      `finding${n === 1 ? '' : 's'}.`,
  );
  lines.push('');
  lines.push('Do not refresh the baseline.');
  lines.push('Do not fix unrelated grandfathered debt.');
  lines.push('Fix only the net-new findings below, then try to stop again.');
  lines.push('');
  blocking.forEach((p, i) => {
    const loc = p.file ? `${p.file}${p.line !== undefined ? `:${p.line}` : ''}` : '(no location)';
    const sev = p.severity ? ` [${p.severity}]` : '';
    lines.push(`${i + 1}. ${p.kind}${sev}`);
    lines.push(`   location: ${loc}`);
    const detail = p.reasons.find((r) => r.detail)?.detail;
    if (detail) lines.push(`   reason: ${detail}`);
  });
  lines.push('');
  lines.push(
    `Full machine-readable detail: ${path.join(LEDGER_DIR, 'last-guardrail.json')} ` +
      `(read it and fix only these net-new findings).`,
  );
  return lines.join('\n');
}
