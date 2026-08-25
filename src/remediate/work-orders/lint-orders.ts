/**
 * Located lint orders (`lint-located`): ONE order per file, unioning
 * blocking, deferred, and grandfathered findings (a file in two sources is
 * one unit of work; per-finding attribution records which is which). Large
 * sets are cut into slices of at most `maxSliceSize` (suffix `#n` from the
 * second slice, so ids never collide). Rank: a slice carrying a deferral
 * sits in the expiring band by soonest expiry; one carrying a net-new
 * finding in the blocking band; pure debt in the debt band.
 *
 * Binary (whole-command) custom-check findings carry no file to scope an
 * order to and are reported undispatchable with the one shared reason.
 */
import type { RichBaselineEntry } from '../../baseline/types';
import type { UndispatchableGroup, WorkOrderFinding } from './types';
import {
  BINARY_CUSTOM_CHECK_REASON,
  VALUE_BAND,
  byteOrder,
  deriveBudget,
  doneFor,
  undispatch,
  type BudgetCapFor,
  type Ranked,
} from './shared';

export type CustomCheckEntry = Extract<RichBaselineEntry, { kind: 'custom-check' }>;

export interface LintOrderContext {
  readonly maxSliceSize: number;
  readonly capFor: BudgetCapFor;
}

export interface LintSource {
  readonly entry: CustomCheckEntry;
  readonly attribution: WorkOrderFinding['attribution'];
  /** Present for a deferred finding: the day it re-blocks. */
  readonly expiresAt?: string;
}

export function lintFinding(src: LintSource): WorkOrderFinding {
  const { entry } = src;
  return {
    kind: 'custom-check',
    id: entry.id,
    attribution: src.attribution,
    evidence: {
      type: 'custom-check',
      check: entry.check,
      ...(entry.rule !== undefined ? { rule: entry.rule } : {}),
      ...(entry.file !== undefined ? { file: entry.file } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
      ...(entry.message !== undefined ? { message: entry.message } : {}),
      ...(src.expiresAt !== undefined ? { expiresAt: src.expiresAt } : {}),
    },
  };
}

const ATTRIBUTION_ORDER: Record<WorkOrderFinding['attribution'], number> = {
  'net-new': 0,
  deferred: 1,
  unattributed: 2,
  'pre-existing': 3,
};

function sliceRank(
  file: string,
  index: number,
  findings: readonly WorkOrderFinding[],
): Ranked['rank'] {
  const expiries = findings
    .map((f) => (f.evidence.type === 'custom-check' ? f.evidence.expiresAt : undefined))
    .filter((e): e is string => typeof e === 'string')
    .sort(byteOrder);
  if (expiries.length > 0) return [VALUE_BAND.expiringDeferral, expiries[0]];
  if (findings.some((f) => f.attribution === 'net-new'))
    return [VALUE_BAND.otherBlocking, `${file}#${index}`];
  return [VALUE_BAND.debt, `${file}#${index}`];
}

/** One order per file over every source; slices capped by `maxSliceSize`. */
export function lintOrders(
  sources: readonly LintSource[],
  ctx: LintOrderContext,
  into: UndispatchableGroup[],
): Ranked[] {
  const byFile = new Map<string, LintSource[]>();
  const binary: WorkOrderFinding[] = [];
  for (const src of sources) {
    if (!src.entry.file) {
      binary.push(lintFinding(src));
      continue;
    }
    const list = byFile.get(src.entry.file) ?? [];
    list.push(src);
    byFile.set(src.entry.file, list);
  }
  undispatch(into, BINARY_CUSTOM_CHECK_REASON, binary);

  const max = Math.max(1, ctx.maxSliceSize);
  const out: Ranked[] = [];
  for (const [file, list] of [...byFile.entries()].sort(([a], [b]) => byteOrder(a, b))) {
    // Attributed findings first (they are the order's point), then debt by
    // rule + line so a slice is one rule's worth of work wherever possible.
    const sorted = [...list].sort(
      (a, b) =>
        ATTRIBUTION_ORDER[a.attribution] - ATTRIBUTION_ORDER[b.attribution] ||
        byteOrder(a.entry.rule ?? '', b.entry.rule ?? '') ||
        (a.entry.line ?? 0) - (b.entry.line ?? 0),
    );
    const slices: LintSource[][] = [];
    for (let i = 0; i < sorted.length; i += max) slices.push(sorted.slice(i, i + max));
    slices.forEach((slice, index) => {
      const findings = slice.map(lintFinding);
      const blocking = findings.filter((f) => f.attribution === 'net-new').length;
      const deferredCount = findings.filter((f) => f.attribution === 'deferred').length;
      out.push({
        rank: sliceRank(file, index + 1, findings),
        draft: {
          id: `lint-located:${file}${slices.length > 1 ? `#${index + 1}` : ''}`,
          class: 'lint-located',
          findings,
          envelope: { paths: [file], manifests: false },
          constraints: { forbidden: [] },
          done: doneFor('guardrail', findings),
          budget: deriveBudget(findings.length, ctx.capFor('lint-located')),
          provenance: {
            source: 'debt-slice',
            file,
            slice: index + 1,
            of: slices.length,
            ...(blocking > 0 ? { blocking } : {}),
            ...(deferredCount > 0 ? { deferred: deferredCount } : {}),
          },
        },
      });
    });
  }
  return out;
}
